import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ServiceRunner, inspectRunner, probePanelActivity, requestRunner, probeNativeActivity, argumentValue } from '../src/service-runner.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

function workspace() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'kwg-runner-'));
  roots.push(root);
  return { root, stateDir: path.join(root, 'state'), entry: path.join(root, 'state', 'panel-entry.json') };
}

// A child stand-in: it emits exit only when killed, and records the signal.
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.signals = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    child.signals.push(signal);
    setTimeout(() => child.emit('exit', 0, signal), 1);
    return true;
  };
  return child;
}

function spawner() {
  const spawned = [];
  const spawn = () => {
    const child = fakeChild(4000 + spawned.length);
    spawned.push(child);
    return child;
  };
  spawn.children = spawned;
  return spawn;
}

const respond = body => async () => ({ ok: true, status: 200, json: async () => body });
const fail = () => async () => { throw Error('no panel'); };
const idleProbe = () => ({ state: 'idle', generationId: 'g1', pid: 1 });

function writeEntry(entry, mode = 0o600) {
  fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entry, JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:3427',
    entryURL: 'http://127.0.0.1:3427/#key=' + 'b'.repeat(64) }), { mode });
}

const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

// Polls until `predicate` is true, so a test waits for the behaviour it asserts
// instead of guessing a delay.
async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) throw Error('condition_not_met');
    await tick(25);
  }
}

function readState(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'service-runner.json'), 'utf8')); }
  catch { return {}; }
}

// `quietMs: 0` makes the first quiet pass enough, so a drain is one panel
// sample plus one native probe; `drainTimeoutMs` stays short for tests. The
// native probe is stubbed by default: no test opens a Kimi socket or reads a
// live installation.
function runner(options = {}) {
  const space = options.space ?? workspace();
  return new ServiceRunner({ stateDir: space.stateDir, launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
    argv: ['panel', '--config', '/x/gateway.json'], env: {}, quietMs: 0, drainTimeoutMs: 3000,
    restartDelayMs: 0, spawnImpl: options.spawn ?? spawner(), fetchImpl: options.fetch ?? respond({ gateway: { activeRequests: 0 } }),
    kimiDir: '/kimi', workProbe: options.workProbe ?? idleProbe, ...options.extra });
}

// Counts the 12 s exit-race timers this file's stops create, so a leaked handle
// is visible without depending on the loop's global handle list.
function spyLongTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const created = new Set();
  const cleared = new Set();
  globalThis.setTimeout = function (fn, ms, ...rest) {
    const handle = realSet(fn, ms, ...rest);
    if (ms === 12345) created.add(handle);
    return handle;
  };
  globalThis.clearTimeout = function (handle) { cleared.add(handle); return realClear(handle); };
  return {
    created: () => created.size,
    leaked: () => [...created].filter(handle => !cleared.has(handle)).length,
    restore: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; },
  };
}

describe('child lifecycle', () => {
  test('the panel child is restarted after an unexpected exit', async () => {
    const spawn = spawner();
    const service = runner({ spawn });
    service.spawnChild();
    expect(spawn.children).toHaveLength(1);
    // A crash is not a stop request: the runner brings the panel back.
    spawn.children[0].emit('exit', 1, null);
    expect(service.restartTimer).not.toBeNull();
    // Assert only after the delay has really elapsed: the bug this guards is a
    // second spawn from a timer that fires after the explicit restart.
    await tick(30);
    expect(service.restartTimer).toBeNull();
    expect(spawn.children).toHaveLength(2);
    expect(service.child).toBe(spawn.children[1]);
    expect(service.lastExit.code).toBe(1);
  }, 20000);

  test('an unexpected exit followed by an explicit restart leaves exactly one child', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, extra: { restartDelayMs: 60 } });
    service.spawnChild();
    spawn.children[0].emit('exit', 1, null);
    // The restart drains while the crash timer is still pending; both would
    // spawn if the timer only checked `stopping`.
    const outcome = await service.restartChild();
    expect(outcome.state).toBe('restarted');
    expect(spawn.children).toHaveLength(2);
    // Past the original crash delay: no third child may appear.
    await tick(120);
    expect(spawn.children).toHaveLength(2);
    expect(service.child).toBe(spawn.children[1]);
    expect(service.child.pid).toBe(4001);
  }, 20000);

  test('a late exit from a replaced child does not clear or restart the new one', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space });
    service.spawnChild();
    await service.restartChild();
    const first = spawn.children[0];
    const second = spawn.children[1];
    expect(service.child).toBe(second);
    // The old child's exit arrives after its replacement is already running.
    first.emit('exit', 0, 'SIGTERM');
    expect(service.child).toBe(second);
    expect(service.restartTimer).toBeNull();
    expect(spawn.children).toHaveLength(2);
  }, 20000);

  test('an expected exit is not treated as a crash', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space });
    service.spawnChild();
    const outcome = await service.stopChild();
    expect(outcome.state).toBe('stopped');
    expect(service.child).toBeNull();
    // Nothing is scheduled: a stop is deliberate, so no restart may follow.
    expect(service.restartTimer).toBeNull();
    await tick(30);
    expect(spawn.children).toHaveLength(1);
  }, 20000);

  test('a child pid is not reused by a restart that never spawned', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const stubborn = fakeChild(4999);
    stubborn.kill = signal => { stubborn.signals.push(signal); return true; };
    const service = runner({ space, spawn: () => stubborn, extra: { drainTimeoutMs: 100 } });
    service.spawnChild();
    const outcome = await service.restartChild();
    expect(outcome).toEqual({ state: 'waiting', reason: 'panel_exit_timeout' });
    // The panel is still the one that did not exit, and it is still supervised.
    expect(service.child).toBe(stubborn);
    expect(service.restartTimer).toBeNull();
  }, 20000);
});

describe('draining before a signal', () => {
  test('a restart drains a quiet panel before signalling it', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space });
    service.spawnChild();
    const outcome = await service.restartChild();
    expect(outcome.state).toBe('restarted');
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
    expect(spawn.children).toHaveLength(2);
    // The stale entry is removed so `service status` never advertises a dead link.
    expect(fs.existsSync(space.entry)).toBe(false);
  }, 20000);

  test('a restart with a request in flight reports waiting and kills nothing', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, fetch: respond({ gateway: { activeRequests: 2 } }) });
    service.spawnChild();
    const outcome = await service.restartChild();
    expect(outcome).toEqual({ state: 'waiting', reason: 'panel_busy' });
    expect(spawn.children[0].signals).toEqual([]);
    expect(spawn.children).toHaveLength(1);
    const state = JSON.parse(fs.readFileSync(path.join(space.stateDir, 'service-runner.json'), 'utf8'));
    expect(state.state).toBe('waiting');
  }, 20000);

  test('a restart without a live activity reading reports unknown instead of guessing', async () => {
    const space = workspace();
    // No entry file: the panel has not published a link, so nothing is known.
    const spawn = spawner();
    const service = runner({ spawn, space });
    service.spawnChild();
    expect(await service.restartChild()).toEqual({ state: 'waiting', reason: 'panel_activity_unknown' });
    expect(spawn.children[0].signals).toEqual([]);
  }, 20000);

  test('a probe failure never authorises a stop', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, fetch: fail() });
    service.spawnChild();
    expect(await service.restartChild()).toEqual({ state: 'waiting', reason: 'panel_activity_unknown' });
    expect(spawn.children[0].signals).toEqual([]);
  }, 20000);

  test('a stale entry file and an old timestamp are not proof of death', async () => {
    const space = workspace();
    writeEntry(space.entry);
    // Observe the record before this runner object is created: creating one does
    // not write state, but spawnChild() does, and the point is an old record.
    fs.mkdirSync(space.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(space.stateDir, 'service-runner.json'), JSON.stringify({ schemaVersion: 1,
      pid: process.pid, child: 999999, updatedAt: '2020-01-01T00:00:00.000Z', at: '2020-01-01T00:00:00.000Z' }), { mode: 0o600 });
    const view = inspectRunner({ stateDir: space.stateDir });
    expect(view.runnerAlive).toBe(true);
    expect(view.at).toBe('2020-01-01T00:00:00.000Z');

    const spawn = spawner();
    const service = runner({ spawn, space, fetch: respond({ gateway: { activeRequests: 1 } }) });
    service.spawnChild();
    expect((await service.restartChild()).state).toBe('waiting');
    expect(spawn.children[0].signals).toEqual([]);
  }, 20000);

  test('a panel that does not exit in time is reported, never killed harder', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const stubborn = fakeChild(4999);
    stubborn.kill = signal => { stubborn.signals.push(signal); return true; };
    const service = runner({ space, spawn: () => stubborn });
    service.spawnChild();
    const outcome = await service.stopChild({ timeoutMs: 30 });
    expect(outcome).toEqual({ state: 'waiting', reason: 'panel_exit_timeout' });
    expect(stubborn.signals).toEqual(['SIGTERM']);
    // The child never exited, so it is still supervised and its exit remains
    // unexpected rather than absorbed by the abandoned signal.
    expect(service.child).toBe(stubborn);
  }, 20000);

  test('a stop drains first and reports waiting while a turn is running', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, fetch: respond({ gateway: { activeRequests: 1 } }) });
    service.spawnChild();
    const outcome = await service.shutdown();
    expect(outcome).toEqual({ state: 'waiting', reason: 'panel_busy' });
    expect(spawn.children[0].signals).toEqual([]);
    expect(service.stopping).toBe(false);
  }, 20000);

  test('a stop stops a quiet panel and leaves nothing scheduled', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space });
    service.spawnChild();
    expect(await service.shutdown()).toEqual({ state: 'stopped' });
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
    expect(service.child).toBeNull();
    expect(service.restartTimer).toBeNull();
  }, 20000);

  test('a clean stop releases its exit-race timer', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spy = spyLongTimers();
    try {
      const service = runner({ spawn: spawner(), space });
      service.spawnChild();
      const outcome = await service.stopChild({ timeoutMs: 12345 });
      expect(outcome.state).toBe('stopped');
      expect(spy.created()).toBe(1);
      // The timer that lost the race is cleared, so no handle outlives a stop.
      expect(spy.leaked()).toBe(0);
    } finally { spy.restore(); }
  }, 20000);
});

describe('native activity', () => {
  test('a quiet gateway with a busy Work turn is never signalled', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, workProbe: () => ({ state: 'busy', reason: 'native_idle_conversation_busy' }) });
    service.spawnChild();
    const outcome = await service.restartChild();
    expect(outcome).toEqual({ state: 'waiting', reason: 'native_busy' });
    expect(spawn.children[0].signals).toEqual([]);
    expect(spawn.children).toHaveLength(1);
  }, 20000);

  test('an unreadable Work state is unknown, not idle', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, workProbe: () => ({ state: 'unknown', reason: 'native_idle_control_failed' }) });
    service.spawnChild();
    const outcome = await service.restartChild();
    expect(outcome).toEqual({ state: 'waiting', reason: 'native_activity_unknown' });
    expect(spawn.children[0].signals).toEqual([]);
  }, 20000);

  test('a throwing work probe is unknown and still never signals', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, workProbe: () => { throw Error('boom'); } });
    service.spawnChild();
    expect((await service.restartChild()).reason).toBe('native_activity_unknown');
    expect(spawn.children[0].signals).toEqual([]);
  }, 20000);

  test('a gateway that never goes quiet is not probed for Work at all', async () => {
    const space = workspace();
    writeEntry(space.entry);
    let probes = 0;
    const service = runner({ space, fetch: respond({ gateway: { activeRequests: 1 } }),
      workProbe: () => { probes++; return idleProbe(); } });
    service.spawnChild();
    expect((await service.restartChild()).reason).toBe('panel_busy');
    expect(probes).toBe(0);
  }, 20000);

  test('the work probe receives the resolved kimi directory and platform', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const seen = [];
    const service = runner({ space, workProbe: options => { seen.push(options); return idleProbe(); } });
    service.spawnChild();
    await service.restartChild();
    expect(seen).toEqual([{ kimiDir: '/kimi', platform: process.platform, env: {} }]);
  }, 20000);

  test('--no-native skips the Work probe and also disables native integration in the child', async () => {
    const space = workspace();
    writeEntry(space.entry);
    let probes = 0;
    const childArgv = [];
    const spawn = () => { const child = fakeChild(4100 + childArgv.length); childArgv.push(null); return child; };
    const service = new ServiceRunner({ stateDir: space.stateDir, launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
      argv: ['panel', '--config', '/x/gateway.json', '--no-native'], env: {}, quietMs: 0, drainTimeoutMs: 3000,
      spawnImpl: (nodePath, argv) => { childArgv[childArgv.length - 1] = argv; return spawn(); },
      fetchImpl: respond({ gateway: { activeRequests: 0 } }),
      kimiDir: '/kimi', workProbe: () => { probes++; return { state: 'busy' }; } });
    service.spawnChild();
    expect(await service.restartChild()).toMatchObject({ state: 'restarted' });
    expect(probes).toBe(0);
    expect(service.nativeEnabled).toBe(false);
    expect(childArgv[0]).toEqual(['/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs', 'panel', '--config', '/x/gateway.json', '--no-native']);
  }, 20000);

  test('the kimi directory comes from --kimi-dir, then from the platform default', () => {
    expect(argumentValue(['panel', '--kimi-dir', '/k/one'], '--kimi-dir')).toBe('/k/one');
    expect(argumentValue(['panel', '--kimi-dir=/k/two'], '--kimi-dir')).toBe('/k/two');
    expect(argumentValue(['panel'], '--kimi-dir')).toBeNull();
    const space = workspace();
    const explicit = new ServiceRunner({ stateDir: space.stateDir, launcherPath: '/x/y.mjs',
      argv: ['panel', '--kimi-dir', '/k/one'], kimiDir: '/k/explicit' });
    expect(explicit.kimiDir).toBe(path.resolve('/k/explicit'));
    const fromArgv = new ServiceRunner({ stateDir: space.stateDir, launcherPath: '/x/y.mjs',
      argv: ['panel', '--kimi-dir', '/k/one'] });
    expect(fromArgv.kimiDir).toBe(path.resolve('/k/one'));
    const fallback = new ServiceRunner({ stateDir: space.stateDir, launcherPath: '/x/y.mjs', argv: ['panel'], platform: 'linux' });
    expect(fallback.kimiDir).toBe(path.resolve(path.join(path.join(process.env.HOME || tmpdir(), '.config'),
      'kimi-desktop', 'daimon-share', 'daimon')));
  }, 20000);

  test('the native probe needs two agreeing idle readings', async () => {
    const candidates = [idleProbe(), { ...idleProbe() }];
    let calls = 0;
    const idle = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ ...candidates[Math.min(calls++, 1)], consecutive: 2 }) });
    expect(idle).toMatchObject({ state: 'idle', generationId: 'g1' });

    const single = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_not_confirmed' }),
      locate: () => ({ application: '/Applications/Kimi.app/Contents/MacOS/Kimi' }),
      inspect: () => ({ pids: [4321], nameMatches: 1, total: 400 }) });
    expect(single).toEqual({ state: 'unknown', reason: 'native_activity_unknown', detail: 'native_idle_not_confirmed' });
  }, 20000);

  test('a Kimi that is not running at all may still be restarted', async () => {
    const absent = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_runner_absent' }),
      locate: () => ({ application: '/Applications/Kimi.app/Contents/MacOS/Kimi' }),
      inspect: () => ({ pids: [], nameMatches: 0, total: 400 }) });
    expect(absent).toEqual({ state: 'not_running', reason: 'native_kimi_not_running', detail: 'native_idle_runner_absent' });
  }, 20000);

  test('an ambiguous or failing process check stays unknown', async () => {
    const ambiguous = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_control_failed' }),
      locate: () => ({ application: '/Applications/Kimi.app/Contents/MacOS/Kimi' }),
      inspect: () => ({ pids: [], nameMatches: 1, total: 400 }) });
    expect(ambiguous).toEqual({ state: 'unknown', reason: 'native_activity_unknown', detail: 'native_process_ambiguous' });

    const failing = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_control_failed' }),
      locate: () => ({ application: '/Applications/Kimi.app/Contents/MacOS/Kimi' }),
      inspect: () => { throw Error('translation_process_check_failed'); } });
    expect(failing).toEqual({ state: 'unknown', reason: 'native_activity_unknown', detail: 'native_process_check_failed' });

    const running = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_control_failed' }),
      locate: () => ({ application: '/Applications/Kimi.app/Contents/MacOS/Kimi' }),
      inspect: () => ({ pids: [123], nameMatches: 1, total: 400 }) });
    expect(running).toEqual({ state: 'unknown', reason: 'native_activity_unknown', detail: 'native_idle_control_failed' });

    const unlocatable = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_runner_absent' }),
      locate: () => { throw Error('translation_kimi_unavailable'); },
      archives: () => ['/Applications/Kimi.app/Contents/Resources/app.asar'] });
    expect(unlocatable).toEqual({ state: 'unknown', reason: 'native_activity_unknown', detail: 'native_idle_runner_absent' });

    // No Kimi installed at all: nothing can be in flight, so a restart is safe.
    const absent = await probeNativeActivity({ kimiDir: '/kimi',
      confirm: async () => ({ state: 'unknown', reason: 'native_idle_runner_absent' }),
      locate: () => { throw Error('translation_kimi_unavailable'); },
      archives: () => [path.join(tmpdir(), 'kwg-not-installed', 'app.asar')] });
    expect(absent).toEqual({ state: 'not_running', reason: 'native_kimi_not_installed', detail: 'native_idle_runner_absent' });
  }, 20000);
});

describe('control requests', () => {
  test('a control request is answered with a receipt and a stable id', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const service = runner({ space });
    service.spawnChild();
    const pending = requestRunner({ stateDir: space.stateDir, action: 'restart', id: 'a'.repeat(32),
      timeoutMs: 3000, pollMs: 20 });
    // The loop the runner would run: observe the request and answer it.
    for (let attempt = 0; attempt < 100; attempt++) {
      await tick(10);
      const request = service.readRequest();
      if (request) { await service.handleRequest(request); fs.rmSync(service.requestFile, { force: true }); break; }
    }
    const receipt = await pending;
    expect(receipt.id).toBe('a'.repeat(32));
    expect(receipt.action).toBe('restart');
    expect(receipt.state).toBe('restarted');
  }, 20000);

  test('an unanswered request times out as waiting without side effects', async () => {
    const space = workspace();
    const receipt = await requestRunner({ stateDir: space.stateDir, action: 'stop', timeoutMs: 60, pollMs: 10 });
    expect(receipt).toEqual({ id: receipt.id, action: 'stop', state: 'waiting', reason: 'runner_receipt_timeout' });
    expect(receipt.id).toMatch(/^[a-f0-9]{32}$/);
  }, 20000);

  test('a stop request carries the drain reason on a busy panel', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ spawn, space, fetch: respond({ gateway: { activeRequests: 3 } }) });
    service.spawnChild();
    fs.mkdirSync(space.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(service.requestFile, JSON.stringify({ action: 'stop', id: 'f'.repeat(32) }), { mode: 0o600 });
    const receipt = await service.handleRequest(service.readRequest());
    expect(receipt).toMatchObject({ action: 'stop', state: 'waiting', reason: 'panel_busy' });
    expect(spawn.children[0].signals).toEqual([]);
    // The receipt is what the CLI reads, and it exists on disk with the same id.
    const stored = JSON.parse(fs.readFileSync(service.receiptFile, 'utf8'));
    expect(stored.id).toBe('f'.repeat(32));
  }, 20000);

  test('only a well-formed control file is accepted', async () => {
    const space = workspace();
    const service = runner({ space });
    expect(service.readRequest()).toBeNull();
    fs.mkdirSync(space.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(service.requestFile, JSON.stringify({ action: 'rm -rf', id: 'c'.repeat(32) }), { mode: 0o600 });
    expect(service.readRequest()).toBeNull();
    fs.writeFileSync(service.requestFile, JSON.stringify({ action: 'restart', id: 'not-a-hex' }), { mode: 0o600 });
    expect(service.readRequest()).toBeNull();
    fs.writeFileSync(service.requestFile, JSON.stringify({ action: 'restart', id: 'd'.repeat(32) }), { mode: 0o600 });
    expect(service.readRequest()).toEqual({ action: 'restart', id: 'd'.repeat(32) });
  }, 20000);
});

describe('activity probe and run loop', () => {
  test('the activity probe reads the in-flight count from the private entry', async () => {
    const space = workspace();
    const entry = space.entry;
    expect(await probePanelActivity({ entryFile: entry })).toEqual({ state: 'unavailable', reason: 'panel_entry_absent' });
    writeEntry(entry);
    let seen;
    const result = await probePanelActivity({ entryFile: entry, fetchImpl: async (url, init) => {
      seen = { url, authorization: init.headers.Authorization };
      return { ok: true, status: 200, json: async () => ({ gateway: { activeRequests: 3 } }) };
    } });
    expect(result).toEqual({ state: 'ok', requests: 3 });
    expect(seen.url).toBe('http://127.0.0.1:3427/api/state');
    expect(seen.authorization).toBe('Bearer ' + 'b'.repeat(64));
    // A world-readable entry is not a session key this tool may use.
    if (process.platform !== 'win32') {
      writeEntry(entry, 0o644);
      expect((await probePanelActivity({ entryFile: entry })).state).toBe('unavailable');
    }
  }, 20000);

  test('the runner records stopped and asks to end after a stop request', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ space, spawn, extra: { exitOnStop: true } });
    const exits = [];
    const original = process.exit;
    // The runner must end the process itself; a resident runner would make the
    // platform report a stopped service as running.
    // setImmediate runs after run() resolves, so this must record, not throw.
    process.exit = code => { exits.push(code); };
    const loop = service.run();
    try {
      await tick(1200);
      fs.writeFileSync(service.requestFile, JSON.stringify({ action: 'stop', id: 'e'.repeat(32) }), { mode: 0o600 });
      const result = await loop;
      // run() reports 0 and then ends the process on the next tick.
      expect(result).toBe(0);
      await tick(30);
      expect(exits).toEqual([0]);
    } finally { process.exit = original; }
    const state = JSON.parse(fs.readFileSync(path.join(space.stateDir, 'service-runner.json'), 'utf8'));
    expect(state.state).toBe('stopped');
    expect(fs.existsSync(service.entryFile)).toBe(false);
    expect(spawn.children[0].signals).toEqual(['SIGTERM']);
  }, 30000);

  test('a termination signal while the panel is busy defers the stop', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    let active = 2;
    const service = runner({ space, spawn, fetch: async () => ({ ok: true, status: 200, json: async () => ({ gateway: { activeRequests: active } }) }),
      extra: { exitOnStop: false, drainTimeoutMs: 150 } });
    const original = process.exit;
    process.exit = () => {};
    const loop = service.run();
    try {
      await tick(1100);
      process.emit('SIGTERM');
      await until(() => readState(space.stateDir).state === 'waiting');
      // The turn is still running: nothing was signalled and the runner lives on.
      const state = readState(space.stateDir);
      expect(state.reason).toBe('panel_busy');
      expect(service.stopping).toBe(true);
      expect(spawn.children[0].signals).toEqual([]);
      // The runner keeps retrying instead of ending while a turn is in flight.
      await tick(1200);
      expect(service.child).toBe(spawn.children[0]);
      expect(spawn.children[0].signals).toEqual([]);
      // Once the turn ends, the same recorded signal finishes the stop.
      active = 0;
      expect(await loop).toBe(0);
      expect(spawn.children[0].signals).toEqual(['SIGTERM']);
    } finally { process.exit = original; }
    expect(readState(space.stateDir).state).toBe('stopped');
  }, 30000);

  test('a termination signal on a quiet panel stops the child and ends the loop', async () => {
    const space = workspace();
    writeEntry(space.entry);
    const spawn = spawner();
    const service = runner({ space, spawn, extra: { exitOnStop: false } });
    const original = process.exit;
    process.exit = () => {};
    try {
      const loop = service.run();
      await tick(1100);
      process.emit('SIGTERM');
      expect(await loop).toBe(0);
      expect(spawn.children[0].signals).toEqual(['SIGTERM']);
    } finally { process.exit = original; }
    const state = JSON.parse(fs.readFileSync(path.join(space.stateDir, 'service-runner.json'), 'utf8'));
    expect(state.state).toBe('stopped');
  }, 30000);

  test('a loaded service is restarted when the runner recorded that it exited', () => {
    // Covered against GatewayService in service-manager.test.mjs; this guards the
    // shared state file name both modules read.
    const space = workspace();
    fs.mkdirSync(space.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(space.stateDir, 'service-runner.json'),
      JSON.stringify({ schemaVersion: 1, pid: 999999, child: null, state: 'stopped' }), { mode: 0o600 });
    const view = inspectRunner({ stateDir: space.stateDir });
    // The recorded pid is gone, so the runner is reported stopped whatever the
    // record's own `state` says.
    expect(view.state).toBe('stopped');
    expect(view.pid).toBe(999999);
  }, 20000);
});

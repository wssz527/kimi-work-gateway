import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranslationRuntime, installationChanged, installationIdentity, inspectApplicationProcesses, remoteRuntimeRevision } from '../src/translation-runtime.mjs';
import { TranslationSupervisor, runnerEvidence, requestQuit, translationSupervisorFile } from '../src/translation-supervisor.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const roots = [];
const HOST_PID = 5555;
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function installation(root, version = '3.2.21') {
  return { application: path.join(root, 'MacOS', 'Kimi'), archive: path.join(root, 'Resources', 'app.asar'),
    version, platform: 'darwin' };
}

// Every dependency that would touch the real machine — process inspection, quit,
// relaunch, gateway load, the live idle probe — is injected, so the whole
// lifecycle is exercised without starting, closing or observing anything real.
function fixture({ version = '3.2.21', settings = { enabled: true }, pids = [], quitResult = { ok: true },
  probe = () => ({ state: 'idle', generationId: 'synthetic-generation-1' }), gatewayLoad = 0 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-supervisor-')));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const kimiDir = path.join(root, 'kimi');
  const located = installation(root, version);
  const runtime = new TranslationRuntime({ stateDir, kimiDir, locate: () => located, isAlive: pid => pid === HOST_PID,
    spawnHost: () => { throw Error('must not spawn'); } });
  runtime.configure({ enabled: true, ...settings });
  const calls = { quit: [], launch: [], pids: 0, probe: 0 };
  let running = [...pids];
  // `autoExit: false` models reality: a close request is acknowledged long before
  // the process is actually gone. The test decides when the app really exits.
  let autoExit = true;
  let probeResult = probe;
  const supervisor = new TranslationSupervisor({
    stateDir, kimiDir, runtime,
    inspector: { runningPids: app => { calls.pids += 1; calls.application = app; return [...running]; } },
    quit: pid => {
      calls.quit.push(pid);
      if (quitResult.ok && autoExit) running = running.filter(value => value !== pid);
      return { ...quitResult };
    },
    relaunch: async options => { calls.launch.push(options); return { state: 'starting', pid: 9001, version }; },
    gatewayBusy: () => gatewayLoad,
    probe: options => { calls.probe += 1; return probeResult(options); },
    now: () => Date.now(),
  });
  const receipt = value => writeSubagentJSON(runtime.receiptFile, { schemaVersion: 1, id: crypto.randomUUID(),
    pid: value.pid ?? HOST_PID, homeDir: runtime.homeDir, version, revision: 'sync', state: value.state || 'exited',
    ...(value.applicationPid === undefined ? {} : { applicationPid: value.applicationPid }),
    ...(value.exit === undefined ? {} : { exit: value.exit }), at: value.at ?? Date.now() });
  const setRunning = value => { running = [...value]; };
  return { root, stateDir, kimiDir, runtime, supervisor, calls, setRunning, receipt, located,
    setProbe: value => { probeResult = value; },
    setAutoExit: value => { autoExit = value; } };
}

// Two passes are needed before a quit: the probe has to agree twice.
async function settleIdle(supervisor) {
  await supervisor.ensure();
  return supervisor.ensure();
}

test('runner evidence requires every activity collection and ignores snapshot age', () => {
  const base = { lifecycleStatus: 'running', updatedAt: '2020-01-01T00:00:00.000Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [] };
  // Age is deliberately not evidence: an idle snapshot may be hours old.
  expect(runnerEvidence(base)).toEqual({ state: 'idle' });
  expect(runnerEvidence(null)).toEqual({ state: 'unavailable' });
  expect(runnerEvidence({ lifecycleStatus: 'running' })).toMatchObject({ state: 'unavailable', missing: 'activeKernelTurns' });
  expect(runnerEvidence({ ...base, activeKernelTurns: 1 })).toEqual({ state: 'busy', active: 1 });
  expect(runnerEvidence({ ...base, activeKernelToolCalls: [{ id: 'tool' }] })).toEqual({ state: 'busy', active: 1 });
  expect(runnerEvidence({ ...base, activePendingInteractions: [{}] })).toEqual({ state: 'busy', active: 1 });
  expect(runnerEvidence({ ...base, lifecycleStatus: 'stopping' })).toMatchObject({ state: 'busy' });
  // A required collection that is missing or not a valid non-negative count is
  // unknown, never zero: the file must not be read as "nothing is running".
  for (const missing of [{ activeKernelTurns: undefined }, { activeKernelToolCalls: undefined },
    { activeOperations: undefined }, { activePendingInteractions: undefined },
    { activeKernelTurns: -1 }, { activeKernelTurns: 1.5 }, { activeKernelTurns: '0' }]) {
    expect(runnerEvidence({ ...base, ...missing })).toMatchObject({ state: 'unavailable' });
  }
  // No collection is optional: the daemon writes all four, so one missing means
  // the snapshot cannot be trusted as a complete activity picture.
  const partial = { ...base };
  delete partial.activeOperations;
  expect(runnerEvidence(partial)).toMatchObject({ state: 'unavailable', missing: 'activeOperations' });
});

test('installation identity treats a rebuilt build as a change and never gates on the version string alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-identity-'));
  roots.push(root);
  const archive = path.join(root, 'Resources', 'app.asar');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, 'first build');
  const before = installationIdentity(installation(root));
  expect(before).toMatchObject({ archive, application: installation(root).application, version: '3.2.21' });
  expect(installationChanged({ ...before }, installation(root))).toBe(false);
  // Same version, different bytes: an in-place update must still be seen.
  fs.writeFileSync(archive, 'second build, longer');
  expect(installationChanged({ ...before }, installation(root))).toBe(true);
  expect(installationIdentity(null)).toBe(null);
  expect(installationChanged(null, installation(root))).toBe(false);
});

test('remote readiness follows the live managed session and clears when that application exits', async () => {
  const f = fixture({ pids: [4321] });
  f.receipt({ state: 'active', applicationPid: 4321 });
  writeSubagentJSON(f.runtime.receiptFile, { ...readSubagentJSON(f.runtime.receiptFile),
    remote: { state: 'ready', catalog: 'catalog-extended', added: 6, token: 'private-token' } });
  f.supervisor.write({ enabled: true, state: 'starting' });
  try {
    await f.supervisor.ensure();
    expect(f.supervisor.inspect().remote).toEqual({ state: 'ready', catalog: 'catalog-extended', added: 6 });
    expect(JSON.stringify(f.supervisor.read())).not.toContain('private-token');
    f.setRunning([]);
    f.receipt({ state: 'exited', applicationPid: 4321 });
    await f.supervisor.ensure();
    expect(f.supervisor.inspect().remote).toBeUndefined();
    expect(f.supervisor.read().remote).toBeUndefined();
    expect(f.calls.launch).toHaveLength(0);
  } finally { f.supervisor.close(); }
});

test('remote migration waits for live idle evidence once and does not retry an already attempted entry point', async () => {
  const f = fixture({ pids: [4321] });
  f.receipt({ state: 'active', applicationPid: 4321 });
  const receipt = readSubagentJSON(f.runtime.receiptFile);
  const launch = { ...f.located, schemaVersion: 1, id: receipt.id, homeDir: f.runtime.homeDir,
    pid: HOST_PID, discoveredApplication: f.located.application };
  writeSubagentJSON(f.runtime.launchFile, launch);
  f.supervisor.launchOptions = { remoteModels: true };
  f.supervisor.write({ enabled: true, allowTakeover: true, state: 'active' });
  try {
    await f.supervisor.ensure();
    expect(f.calls.quit).toHaveLength(0);
    await f.supervisor.ensure();
    expect(f.calls.quit).toEqual([4321]);
    f.receipt({ state: 'exited', applicationPid: 4321 });
    await f.supervisor.ensure();
    expect(f.calls.launch).toHaveLength(1);
    expect(f.calls.launch[0].remoteModels).toBe(true);
    f.setRunning([6543]);
    f.receipt({ state: 'active', applicationPid: 6543 });
    writeSubagentJSON(f.runtime.launchFile, { ...launch, id: readSubagentJSON(f.runtime.receiptFile).id,
      remoteModels: true, remoteRevision: remoteRuntimeRevision() });
    await f.supervisor.ensure(); await f.supervisor.ensure();
    expect(f.calls.quit).toEqual([4321]);
    expect(f.supervisor.read().reason).toBeUndefined();
  } finally { f.supervisor.close(); }
});

test('official-only supervision migrates a live remote session instead of reusing it', async () => {
  const f = fixture({ pids: [4321] });
  f.receipt({ state: 'active', applicationPid: 4321 });
  const receipt = readSubagentJSON(f.runtime.receiptFile);
  writeSubagentJSON(f.runtime.launchFile, { ...f.located, schemaVersion: 1, id: receipt.id,
    homeDir: f.runtime.homeDir, pid: HOST_PID, discoveredApplication: f.located.application,
    remoteModels: true, remoteRevision: remoteRuntimeRevision() });
  f.supervisor.launchOptions = { controlOnly: true };
  f.supervisor.write({ enabled: true, allowTakeover: true, state: 'active' });
  try {
    await f.supervisor.ensure();
    expect(f.calls.quit).toHaveLength(0);
    await f.supervisor.ensure();
    expect(f.calls.quit).toEqual([4321]);
    f.receipt({ state: 'exited', applicationPid: 4321 });
    await f.supervisor.ensure();
    expect(f.calls.launch).toHaveLength(1);
    expect(f.calls.launch[0].controlOnly).toBe(true);
    expect(f.calls.launch[0].remoteModels).not.toBe(true);
  } finally { f.supervisor.close(); }
});

test('an enabled supervisor leaves a healthy managed session completely alone', async () => {
  const f = fixture({ pids: [4321] });
  f.receipt({ state: 'active', applicationPid: 4321 });
  const started = f.supervisor.write({ enabled: true, state: 'waiting-kimi-exit', reason: 'translation_waiting_quit' });
  expect(started.enabled).toBe(true);
  const result = await f.supervisor.ensure();
  expect(result.state).toBe('active');
  expect(f.calls.quit).toEqual([]);
  expect(f.calls.launch).toEqual([]);
  expect(f.supervisor.inspect()).toMatchObject({ state: 'active', enabled: true, applicationPid: 4321 });
  // Re-running the pass must not disturb the healthy session either.
  expect((await f.supervisor.ensure()).state).toBe('active');
  expect(f.calls.quit).toEqual([]);
  expect(f.calls.launch).toEqual([]);
});

test('nothing is relaunched when Kimi is not running, so a user quit never becomes an endless restart', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.write({ enabled: true, state: 'active' });
  for (let index = 0; index < 3; index += 1) {
    const result = await f.supervisor.ensure();
    expect(result).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_not_running' });
  }
  expect(f.calls.launch).toEqual([]);
});

test('a Kimi the user started on their own is never hijacked', async () => {
  const f = fixture({ pids: [7777] });
  f.supervisor.write({ enabled: true, state: 'active' });
  const result = await f.supervisor.ensure();
  expect(result).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_running' });
  expect(f.calls.quit).toEqual([]);
  expect(f.calls.launch).toEqual([]);
});

test('a replacement instance is only adopted inside the window after our own managed session ended', async () => {
  const f = fixture({ pids: [7777] });
  f.receipt({ state: 'exited', applicationPid: 4321, exit: { kind: 'application-exit', code: 0 }, at: Date.now() - 60 * 60 * 1000 });
  f.supervisor.write({ enabled: true, state: 'active' });
  const stale = await f.supervisor.ensure();
  expect(stale).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_running' });
  expect(f.calls.quit).toEqual([]);

  f.receipt({ state: 'exited', applicationPid: 4321, exit: { kind: 'application-exit', code: 0 }, at: Date.now() });
  const adopted = await settleIdle(f.supervisor);
  expect(adopted.state).toBe('waiting-quit');
  expect(f.calls.quit).toEqual([7777]);
});

test('a managed session that failed on its own never justifies quitting the instance now running', async () => {
  const f = fixture({ pids: [7777] });
  // The host is gone and its session had failed before Kimi was even started:
  // this instance is not a replacement for ours, so it must be left alone.
  f.receipt({ state: 'failed', pid: 9999, applicationPid: 4321, exit: { kind: 'start-failed' }, at: Date.now() });
  f.supervisor.write({ enabled: true, state: 'active' });
  const result = await f.supervisor.ensure();
  expect(result).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_running' });
  expect(f.calls.quit).toEqual([]);
});

test('an update is re-attached only after a normal quit, idle evidence and a real exit', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0' });
  f.setAutoExit(false);
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  // First pass only collects evidence: one idle reading is not enough.
  const first = await f.supervisor.ensure();
  expect(first).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_runner_evidence_unavailable' });
  expect(f.calls.quit).toEqual([]);
  const asked = await settleIdle(f.supervisor);
  expect(asked).toMatchObject({ state: 'waiting-quit', reason: 'translation_waiting_quit' });
  expect(f.calls.quit).toEqual([4321]);

  // The close was requested but the process has not exited yet: the state stays
  // waiting-quit and the request is not repeated.
  const waiting = await f.supervisor.ensure();
  expect(waiting).toMatchObject({ state: 'waiting-quit', reason: 'translation_waiting_quit' });
  expect(f.calls.quit).toEqual([4321]);
  expect(f.calls.launch).toEqual([]);

  f.setRunning([]);
  const relaunched = await f.supervisor.ensure();
  expect(relaunched.state).toBe('starting');
  expect(f.calls.launch).toHaveLength(1);
  expect(f.calls.launch[0].protectedEnvNames).toEqual([]);
  // The supervisor already proved no application is running, so the launch is
  // told to skip its own (possibly expensive) process check.
  expect(f.calls.launch[0].isRunning()).toBe(false);
  expect(f.supervisor.inspect()).toMatchObject({ state: 'starting', version: '4.0.0' });
});

test('a changed daemon generation in the final idle check must collect fresh evidence before quit', async () => {
  let probes = 0;
  const f = fixture({ pids: [4321], probe: () => ({ state: 'idle', generationId: ++probes <= 2 ? 'old' : 'new' }) });
  f.supervisor.write({ enabled: true, allowTakeover: true, state: 'active' });
  try {
    await f.supervisor.ensure(); await f.supervisor.ensure();
    expect(f.calls.quit).toHaveLength(0);
    expect(f.supervisor.read().idleEvidence).toBeUndefined();
    await f.supervisor.ensure();
    expect(f.calls.quit).toHaveLength(0);
    await f.supervisor.ensure();
    expect(f.calls.quit).toEqual([4321]);
  } finally { f.supervisor.close(); }
});

test('busy, unconfirmed or unreachable idle evidence keeps waiting instead of quitting Kimi', async () => {
  const busy = fixture({ pids: [4321], version: '4.0.0',
    probe: () => ({ state: 'busy', reason: 'native_idle_conversation_busy' }) });
  busy.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(busy.root, '3.2.21')) });
  for (let index = 0; index < 3; index += 1) {
    const result = await busy.supervisor.ensure();
    expect(result).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_busy' });
  }
  expect(busy.calls.quit).toEqual([]);

  const unknown = fixture({ pids: [4321], version: '4.0.0',
    probe: () => ({ state: 'unknown', reason: 'native_idle_process_identity_unknown' }) });
  unknown.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(unknown.root, '3.2.21')) });
  for (let index = 0; index < 3; index += 1) {
    expect(await unknown.supervisor.ensure()).toMatchObject({ state: 'waiting-kimi-exit',
      reason: 'translation_runner_evidence_unavailable' });
  }
  expect(unknown.calls.quit).toEqual([]);
});

// The whole point of the live probe: the snapshot is not a heartbeat, so a very
// old file that the daemon confirms idle must still allow the re-attach.
test('an hours-old runner file confirmed idle by the live probe is re-attachable', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0' });
  f.setAutoExit(false);
  const file = path.join(f.kimiDir, 'agents', 'main', 'runner.state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSubagentJSON(file, { schemaVersion: 1, lifecycleStatus: 'running',
    // Six hours old, exactly like the production snapshot observed on this Mac.
    updatedAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [] });
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  const asked = await settleIdle(f.supervisor);
  expect(asked).toMatchObject({ state: 'waiting-quit' });
  expect(f.calls.quit).toEqual([4321]);
  expect(f.calls.probe).toBeGreaterThanOrEqual(3);
});

test('gateway load blocks a quit until every request has finished', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0', gatewayLoad: 2 });
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  expect(await settleIdle(f.supervisor)).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_gateway_busy' });
  expect(f.calls.quit).toEqual([]);
});

test('a failed normal quit is reported, never faked and never re-issued in a prompt loop', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0', quitResult: { ok: false, reason: 'translation_quit_unavailable' } });
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  const first = await settleIdle(f.supervisor);
  expect(first).toEqual({ state: 'waiting-kimi-exit', reason: 'translation_quit_unavailable', version: '4.0.0' });
  for (let index = 0; index < 4; index += 1) {
    expect((await f.supervisor.ensure()).state).toBe('waiting-kimi-exit');
  }
  expect(f.calls.quit).toHaveLength(1);
  expect(f.calls.launch).toEqual([]);
});

test('a quit that never produces a real exit is reported as a timeout, not as success', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0', quitResult: { ok: true } });
  // The application accepts the request but stays alive.
  f.supervisor.quit = pid => { f.calls.quit.push(pid); return { ok: true }; };
  f.supervisor.quitTimeout = 0;
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  await settleIdle(f.supervisor);
  const timedOut = await f.supervisor.ensure();
  expect(timedOut).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_quit_timeout' });
  expect(f.calls.quit).toHaveLength(1);
  expect(f.calls.launch).toEqual([]);
  for (let index = 0; index < 3; index += 1) await f.supervisor.ensure();
  expect(f.calls.quit).toHaveLength(1);
  expect(f.calls.launch).toEqual([]);
});

test('concurrent start calls share one pass and never start two hosts', async () => {
  const f = fixture({ pids: [], version: '4.0.0' });
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  let launches = 0;
  f.supervisor.relaunch = async () => {
    launches += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return { state: 'starting', pid: 9001, version: '4.0.0' };
  };
  f.setRunning([]);
  const results = await Promise.all([f.supervisor.start(), f.supervisor.start(), f.supervisor.start()]);
  expect(launches).toBe(1);
  expect(results.map(result => result.state)).toEqual(['starting', 'starting', 'starting']);
  expect(f.supervisor.timer).not.toBe(null);
  f.supervisor.close();
});

function remoteSession(f, applicationPid = 4321) {
  f.receipt({ state: 'active', applicationPid });
  const receipt = readSubagentJSON(f.runtime.receiptFile);
  const revision = 'a'.repeat(32);
  const artifact = path.join(f.stateDir, 'remote-runtime', 'apps', revision);
  const application = path.join(artifact, 'Kimi Work Remote.app', 'Contents', 'MacOS', 'Kimi');
  const payload = path.join(artifact, 'Kimi Work Remote.app', 'Contents', 'Resources', 'app.asar');
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, 'synthetic-remote-bootstrap');
  const manifest = { schemaVersion: 1, revision, application, originalApplication: f.located.application,
    archive: f.located.archive, mainSHA256: 'b'.repeat(64),
    archiveSHA256: crypto.createHash('sha256').update('synthetic-remote-bootstrap').digest('hex') };
  writeSubagentJSON(path.join(artifact, 'manifest.json'), manifest);
  writeSubagentJSON(path.join(f.stateDir, 'remote-runtime', 'config-' + receipt.id + '.json'),
    { sessionID: receipt.id, application: f.located.application, archive: f.located.archive, mainSHA256: manifest.mainSHA256 });
  writeSubagentJSON(f.runtime.launchFile, { ...f.located, schemaVersion: 1, id: receipt.id, homeDir: f.runtime.homeDir,
    pid: HOST_PID, discoveredApplication: f.located.application, remoteModels: true });
  writeSubagentJSON(f.runtime.receiptFile, { ...receipt, runtimeApplication: application });
  return { application };
}

test.skipIf(process.platform !== 'darwin')('stop normally quits the exact verified remote companion without relaunching it', async () => {
  const f = fixture({ pids: [4321] });
  const remote = remoteSession(f);
  f.supervisor.inspector = { inspectApplication: application => ({
    pids: application === remote.application ? [4321] : [], nameMatches: 1 }) };
  f.supervisor.write({ enabled: true, state: 'active' });
  expect(await f.supervisor.stop()).toMatchObject({ state: 'disabled', remoteQuit: 'requested' });
  expect(f.calls.quit).toEqual([4321]);
  expect(f.calls.launch).toEqual([]);
  expect(await f.supervisor.ensure()).toEqual({ state: 'disabled' });
  expect(f.calls.quit).toEqual([4321]);
});

test.skipIf(process.platform !== 'darwin')('stop leaves an official Kimi pid alone even when remote provenance exists', async () => {
  const f = fixture({ pids: [4321] });
  remoteSession(f);
  f.supervisor.inspector = { inspectApplication: application => ({
    pids: application === f.located.application ? [4321] : [], nameMatches: 1 }) };
  f.supervisor.write({ enabled: true, state: 'active' });
  expect(await f.supervisor.stop()).toEqual({ state: 'disabled', enabled: false });
  expect(f.calls.quit).toEqual([]);
  expect(f.calls.launch).toEqual([]);
});

test('an explicit restart reopens a stopped supervisor and clears stale remote evidence', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.write({ enabled: false, state: 'disabled', remote: { state: 'ready', catalog: 'catalog-extended', added: 6 } });
  f.supervisor.close();
  expect(await f.supervisor.start()).toMatchObject({ state: 'starting' });
  expect(f.supervisor.timer).not.toBe(null);
  expect(f.supervisor.read().remote).toBeUndefined();
  expect(f.calls.launch).toHaveLength(1);
  f.supervisor.close();
});

test('stop disables supervision, clears the timer and is not re-enabled by a later tick', async () => {
  const f = fixture({ pids: [] });
  await f.supervisor.start();
  expect(f.supervisor.timer).not.toBe(null);
  const stopped = await f.supervisor.stop();
  expect(stopped.state).toBe('disabled');
  expect(f.supervisor.timer).toBe(null);
  expect(readSubagentJSON(translationSupervisorFile(f.stateDir)).enabled).toBe(false);
  expect(await f.supervisor.ensure()).toEqual({ state: 'disabled' });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(f.supervisor.inspect().state).toBe('disabled');
});

test('disabled translation settings keep supervision off without touching the host', async () => {
  const f = fixture({ pids: [4321] });
  f.runtime.configure({ enabled: false });
  f.supervisor.write({ enabled: true, state: 'active' });
  expect(await f.supervisor.ensure()).toEqual({ state: 'disabled', reason: 'translation_disabled' });
  expect(f.calls.quit).toEqual([]);
});

test('supervisor state is scoped to one Kimi home and rejects a foreign file', async () => {
  const f = fixture();
  f.supervisor.write({ enabled: true, state: 'active' });
  expect(f.supervisor.inspect()).toMatchObject({ enabled: true, state: 'active' });
  writeSubagentJSON(translationSupervisorFile(f.stateDir), { schemaVersion: 1, homeDir: '/another/scope',
    enabled: true, state: 'active' });
  expect(f.supervisor.inspect()).toEqual({ state: 'failed', reason: 'translation_supervisor_conflict' });
});

// The real quit path is a normal application close request, so it must refuse
// anything that is not a concrete pid instead of falling back to a broader
// signal. The macOS branch is scripted and cannot be exercised here.
test('a live host that failed only at the renderer layer still owns its pipe and is not duplicated', async () => {
  const f = fixture({ pids: [4321] });
  f.receipt({ state: 'failed', applicationPid: 4321 });
  f.supervisor.write({ enabled: true, state: 'waiting-kimi-exit' });
  const result = await f.supervisor.ensure();
  expect(result.state).toBe('failed');
  expect(f.calls.quit).toEqual([]);
  expect(f.calls.launch).toEqual([]);
});

test('a host that has not spawned its application yet is reported as starting, not as an exit', async () => {
  const f = fixture({ pids: [] });
  f.receipt({ state: 'starting' });
  f.supervisor.write({ enabled: true, state: 'waiting-kimi-exit' });
  for (let index = 0; index < 3; index += 1) {
    expect((await f.supervisor.ensure()).state).toBe('starting');
  }
  expect(f.calls.launch).toEqual([]);
  expect(f.calls.quit).toEqual([]);
});

test('a quit request without a concrete pid is refused on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const pid of [0, -1, 1.5, null, undefined, '4321']) {
      expect(requestQuit(pid, platform)).toEqual({ ok: false, reason: 'translation_application_pid_invalid' });
    }
    expect(requestQuit(4321, 'linux')).toEqual({ ok: false, reason: 'translation_quit_unavailable' });
  }
});

test('a durable takeover grant lets an ordinary Kimi be closed normally and re-attached', async () => {
  const f = fixture({ pids: [7777] });
  f.setAutoExit(false);
  f.supervisor.write({ enabled: true, state: 'active' });
  // Without the grant the user's own instance is left alone.
  expect(await f.supervisor.ensure()).toMatchObject({ state: 'waiting-kimi-exit', reason: 'translation_kimi_running' });
  expect(f.calls.quit).toEqual([]);

  // A grant is durable, but it still collects live evidence twice before closing.
  await f.supervisor.start({ takeover: true });
  expect(readSubagentJSON(f.supervisor.file).allowTakeover).toBe(true);
  expect(f.calls.quit).toEqual([]);
  const closed = await f.supervisor.ensure();
  expect(closed.state).toBe('waiting-quit');
  expect(f.calls.quit).toEqual([7777]);

  // The grant survives a new process that only has the record on disk, and the
  // in-flight close it started is honoured instead of being issued a second time.
  const later = new TranslationSupervisor({ stateDir: f.stateDir, kimiDir: f.kimiDir, runtime: f.runtime,
    inspector: { runningPids: () => [7777] }, quit: pid => { f.calls.quit.push(pid); return { ok: true }; },
    relaunch: async () => ({ state: 'starting', pid: 9001 }),
    probe: () => ({ state: 'idle', generationId: 'synthetic-generation-1' }) });
  expect(await later.ensure()).toMatchObject({ state: 'waiting-quit' });
  expect(f.calls.quit).toEqual([7777]);
  later.close();
});

test('start({ controlOnly: true }) keeps supervising with translation disabled', async () => {
  const f = fixture({ pids: [], settings: { enabled: false } });
  const started = await f.supervisor.start({ controlOnly: true, takeover: true });
  expect(started.state).toBe('starting');
  expect(readSubagentJSON(f.supervisor.file)).toMatchObject({ controlOnly: true, allowTakeover: true });
  expect(f.calls.launch[0]).toMatchObject({ controlOnly: true, nativeBridge: true });
  f.supervisor.close();
});

test('ensure restores the timer left enabled by a previous process', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.write({ enabled: true, state: 'waiting-kimi-exit' });
  expect(f.supervisor.timer).toBe(null);
  await f.supervisor.ensure();
  expect(f.supervisor.timer).not.toBe(null);
  f.supervisor.close();
  expect(f.supervisor.timer).toBe(null);
  await f.supervisor.ensure();
  expect(f.supervisor.timer).toBe(null);
});

test('repeated start and ensure never drop an in-flight quit request', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0' });
  f.setAutoExit(false);
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  await settleIdle(f.supervisor);
  expect(readSubagentJSON(f.supervisor.file).quit).toMatchObject({ pid: 4321 });
  await f.supervisor.start();
  expect(readSubagentJSON(f.supervisor.file).quit).toMatchObject({ pid: 4321 });
  await f.supervisor.ensure();
  expect(readSubagentJSON(f.supervisor.file).quit).toMatchObject({ pid: 4321 });
  expect(f.calls.quit).toEqual([4321]);
  f.supervisor.close();
});

test('a closed supervisor starts no host even when a tick was still pending', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.write({ enabled: true, state: 'active' });
  const pending = f.supervisor.start();
  f.supervisor.close();
  await pending;
  const launches = f.calls.launch.length;
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(f.calls.launch.length).toBe(launches);
  expect(await f.supervisor.ensure()).toEqual({ state: 'disabled' });
});

test('two processes sharing the executable name make a quit ambiguous instead of picking one', async () => {
  const f = fixture({ pids: [4321] });
  f.supervisor.inspector = { inspectApplication: () => ({ pids: [4321], nameMatches: 2, total: 9 }) };
  f.supervisor.write({ enabled: true, state: 'active', allowTakeover: true });
  expect(await f.supervisor.ensure()).toMatchObject({ state: 'waiting-kimi-exit',
    reason: 'translation_application_ambiguous' });
  expect(f.calls.quit).toEqual([]);
});

test('a renderer DOM contract failure backs off instead of restarting into the same failure', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.relaunch = async () => ({ state: 'failed', reason: 'translation_renderer_unconfirmed' });
  await f.supervisor.start();
  expect(readSubagentJSON(f.supervisor.file).contractFailure).toMatchObject({ reason: 'translation_renderer_unconfirmed' });
  const launches = f.calls.launch.length;
  // Inside the cooldown nothing new is started, even though starting is allowed.
  for (let index = 0; index < 3; index += 1) {
    const result = await f.supervisor.ensure();
    expect(result.state).toBe('failed');
  }
  expect(f.calls.launch.length).toBe(launches);
  f.supervisor.close();
});

test('a session whose pipe closed is recoverable once the idle evidence allows it', async () => {
  const f = fixture({ pids: [] });
  f.receipt({ state: 'failed', pid: 9999, applicationPid: 4321 });
  f.supervisor.write({ enabled: true, state: 'failed', reason: 'translation_pipe_closed' });
  const result = await f.supervisor.ensure();
  expect(result.state).toBe('waiting-kimi-exit');
  expect(f.calls.launch).toEqual([]);
  // With a quit of ours pending, the same evidence re-opens instead of waiting.
  f.supervisor.write({ quit: { pid: 4321, at: Date.now(), deadline: Date.now() + 60000 } });
  expect((await f.supervisor.ensure()).state).toBe('starting');
  expect(f.calls.launch).toHaveLength(1);
});

test('process discovery compares executable paths, not just names', () => {
  const name = process.platform === 'darwin' ? 'Kimi' : 'Kimi.exe';
  const located = inspectApplicationProcesses('/definitely/not/running/' + name);
  // A same-named binary elsewhere must never be reported as this installation,
  // whether or not such a process happens to be running on this machine.
  expect(located.pids).toEqual([]);
  expect(located.nameMatches).toBeGreaterThanOrEqual(located.pids.length);
  expect(located.total).toBeGreaterThan(0);
});

test('a launch failure is reported as failed and leaves supervision enabled for the next tick', async () => {
  const f = fixture({ pids: [] });
  f.supervisor.relaunch = async () => { throw Error('translation_host_start_failed'); };
  expect(await f.supervisor.start()).toEqual({ state: 'failed', reason: 'translation_host_start_failed' });
  expect(f.supervisor.inspect()).toMatchObject({ enabled: true, state: 'failed' });
  // A later tick still refuses to start Kimi by itself and keeps the failure
  // visible instead of silently reporting progress.
  expect((await f.supervisor.ensure()).state).toBe('waiting-kimi-exit');
  f.supervisor.close();
});

test('credentials never reach the supervisor record or its receipts', async () => {
  const f = fixture({ pids: [4321], version: '4.0.0' });
  const secret = 'translation-supervisor-secret';
  f.runtime.env = { ...f.runtime.env, KIMI_WORK_TRANSLATION_API_KEY: secret };
  f.supervisor.write({ enabled: true, state: 'active', identity: installationIdentity(installation(f.root, '3.2.21')) });
  await f.supervisor.ensure();
  for (const file of [translationSupervisorFile(f.stateDir), f.runtime.receiptFile, f.runtime.launchFile]) {
    if (!fs.existsSync(file)) continue;
    expect(fs.readFileSync(file, 'utf8')).not.toContain(secret);
  }
});

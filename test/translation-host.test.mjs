import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { TranslationSession, isTranslationTarget } from '../src/translation-host.mjs';
import { TranslationRuntime, readTranslationSettings } from '../src/translation-runtime.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const dirs = [];
const PAYLOAD = `(() => { const cache=globalThis.__kwgTranslation?.__cache||new Map();
  globalThis.__kwgTranslation={version:1,__cache:cache,status(){return {state:globalThis.__kwgTranslationConfig.enabled?'active':'inactive',version:1}},
  configure(value){globalThis.__kwgTranslationConfig=value;return this.status()}};
  return globalThis.__kwgTranslation.status(); })()`;
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-host-')); dirs.push(dir);
  const runtime = new TranslationRuntime({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  runtime.configure({ enabled: true });
  const id = crypto.randomUUID();
  const application = path.join(dir, ...(process.platform === 'darwin' ? ['MacOS', 'Kimi'] : ['Kimi.exe']));
  const request = { schemaVersion: 1, id, pid: process.pid, homeDir: runtime.homeDir,
    application, version: '3.2.21', archive: path.join(dir, 'Resources', 'app.asar'), discoveredApplication: application };
  writeSubagentJSON(runtime.launchFile, request);
  const context = vm.createContext({ Map });
  const calls = [];
  const pipe = new EventEmitter(); pipe.closed = false; pipe.dispose = () => { pipe.closed = true; };
  pipe.targets = [{ type: 'page', targetId: 'work', url: 'file:///app/kimi-agent.html' }];
  pipe.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: pipe.targets };
    if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
    if (method === 'Runtime.evaluate') return { result: { value: vm.runInContext(params.expression, context) } };
    return {};
  };
  const session = new TranslationSession({ stateDir: dir, id, ...overrides });
  const desired = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  session.request = request; session.settings = desired.settings; session.revision = desired.revision;
  session.payload = PAYLOAD; session.pipe = pipe;
  return { dir, runtime, session, context, pipe, calls, request };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('host remote status is bound to this launch and child without exposing model metadata', () => {
  const f = fixture();
  f.session.child = { pid: 4242 };
  expect(f.session.remoteStatus()).toBeUndefined();
  f.session.request = { ...f.request, remoteModels: true };
  const file = path.join(f.dir, 'remote-runtime', 'status-' + f.session.id + '.json');
  writeSubagentJSON(file, { schemaVersion: 1, sessionID: f.session.id, applicationPid: 4242,
    state: 'ready', catalog: 'catalog-extended', added: 6, updater: 'delegated', token: 'private-token', models: ['private-model'] });
  f.session.record();
  const receipt = readSubagentJSON(f.runtime.receiptFile);
  expect(receipt.remote).toEqual({ state: 'ready', catalog: 'catalog-extended', added: 6, updater: 'delegated' });
  expect(JSON.stringify(receipt)).not.toContain('private');
  f.session.child.pid = 5678;
  expect(f.session.remoteStatus()).toEqual({ state: 'starting' });
  f.session.remotePreparationStatus = { state: 'unverified', reason: 'remote_runtime_unverified', models: ['private'] };
  expect(f.session.remoteStatus()).toEqual({ state: 'unverified', reason: 'remote_runtime_unverified' });
});

test('host only attaches to local Work views and records a current renderer acknowledgement', async () => {
  for (const url of ['https://example.test/kimi-agent.html', 'file:///app/index.html', 'file:///app/kimi-agent.html/extra']) {
    expect(isTranslationTarget({ type: 'page', url })).toBe(false);
  }
  expect(isTranslationTarget({ type: 'worker', url: 'file:///app/kimi-agent.html' })).toBe(false);
  expect(isTranslationTarget({ type: 'page', url: 'file:///app/kimi-agent.html?conversation=synthetic' })).toBe(true);
  const f = fixture();
  await f.session.update();
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');
  expect(f.calls.some(call => call.method === 'Runtime.addBinding' && call.params.name === '__kwgTranslate')).toBe(true);
  vm.runInContext('globalThis.__kwgTranslation.status=()=>({state:"inactive",version:1})', f.context);
  await f.session.update();
  expect(readSubagentJSON(f.runtime.receiptFile).state).not.toBe('active');
});

test('changing a custom model or endpoint cancels old work and invalidates only the in-memory translation cache', async () => {
  const f = fixture();
  f.runtime.configure({ enabled: true, provider: 'custom', customEndpoint: 'https://first.example/chat', customModel: 'first' });
  await f.session.update();
  vm.runInContext('globalThis.__kwgTranslation.__cache.set("old","old translation")', f.context);
  expect(vm.runInContext('globalThis.__kwgTranslation.__cache.size', f.context)).toBe(1);
  const abort = new AbortController(); f.session.jobs.set('synthetic', abort);
  f.runtime.configure({ enabled: true, provider: 'custom', customEndpoint: 'https://second.example/chat', customModel: 'second' });
  await f.session.update();
  expect(abort.signal.aborted).toBe(true);
  expect(vm.runInContext('globalThis.__kwgTranslation.__cache.size', f.context)).toBe(0);
  const source = f.session.source();
  expect(source).not.toContain('second.example'); expect(source).not.toContain('customModel');
  f.runtime.configure({ enabled: false });
  await f.session.update();
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('inactive');
});

test('binding replies are scoped, credential-free and stale setting replies are discarded', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture({ env: { PRIVATE_TRANSLATION_KEY: 'secret-test-value' }, translate: async () => waiting });
  await f.session.update();
  const replies = [];
  f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  const message = { sessionId: 'test-session', params: { name: '__kwgTranslate',
    payload: JSON.stringify({ type: 'translate', id: 'synthetic-1', text: 'Synthetic reasoning', protectedTexts: [] }) } };
  const task = f.session.binding(message);
  expect(f.session.jobs.size).toBe(1);
  f.runtime.configure({ enabled: false }); await f.session.update();
  finish('旧译文'); await task;
  expect(replies).toHaveLength(0);
  await f.session.binding({ ...message, params: { ...message.params, payload: JSON.stringify({ type: 'translate', id: 'disabled', text: 'Synthetic', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'disabled', payload: { error: 'translation_disabled' } }]);
  expect(JSON.stringify(readSubagentJSON(f.runtime.receiptFile))).not.toContain('Synthetic');
  expect(JSON.stringify(readSubagentJSON(f.runtime.receiptFile))).not.toContain('secret-test-value');
});

test('bounded multibyte reasoning reaches the service without a silent binding timeout', async () => {
  let received;
  const f = fixture({ translate: async text => { received = text; return '合成译文'; } });
  await f.session.update();
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  const text = '合成'.repeat(50000);
  const payload = JSON.stringify({ type: 'translate', id: 'unicode', text, protectedTexts: [] });
  expect(Buffer.byteLength(payload)).toBeGreaterThan(256 * 1024);
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', payload } });
  expect(received).toBe(text);
  expect(replies).toEqual([{ id: 'unicode', payload: { text: '合成译文' } }]);
});

test('host rejects invalid binding payloads and returns only safe error codes', async () => {
  const f = fixture({ translate: async () => { throw Error('private URL and credential'); } });
  await f.session.update();
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  const payload = { type: 'translate', id: 'safe-id', text: 'Synthetic', protectedTexts: [] };
  const send = value => f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', payload: JSON.stringify(value) } });
  await send({ ...payload, protectedTexts: [42] });
  await send(payload);
  expect(replies).toEqual([{ id: 'safe-id', payload: { error: 'translation_input_invalid' } },
    { id: 'safe-id', payload: { error: 'translation_session_failed' } }]);
});

test('an explicitly failed remote bootstrap falls back once to the official application', async () => {
  const children = [4242, 4343].map(pid => Object.assign(new EventEmitter(), { pid, stdio: [null, null, null, {}, {}] }));
  const calls = [];
  let prepared = 0, f;
  f = fixture({ prepareRemote: async () => { prepared++; return { application: path.join(f.dir, 'managed/MacOS/Kimi'), args: ['--kwg-remote-config=synthetic'] }; },
    spawnApp: (...args) => { const child = children[calls.length]; calls.push(args); process.nextTick(() => child.emit('spawn')); return child; },
    pipeFactory: () => { f.pipe.closed = false; return f.pipe; } });
  f.pipe.targets = [];
  writeSubagentJSON(f.runtime.launchFile, { ...f.request, remoteModels: true });
  const running = f.session.run();
  await new Promise(resolve => setImmediate(resolve));
  writeSubagentJSON(path.join(f.dir, 'remote-runtime/status-' + f.request.id + '.json'),
    { schemaVersion: 1, sessionID: f.request.id, applicationPid: 4242, state: 'unverified', reason: 'remote_update_helper_unverified' });
  children[0].emit('exit', 78);
  await new Promise(resolve => setImmediate(resolve));
  expect(calls).toHaveLength(2);
  expect(prepared).toBe(1);
  expect(calls[1][0]).toBe(f.request.application);
  expect(calls[1][1]).toEqual(['-remote-debugging-pipe']);
  expect(readSubagentJSON(f.runtime.receiptFile).remote).toEqual({ state: 'unverified', reason: 'remote_update_helper_unverified' });
  children[1].emit('exit', 0); await running;
  expect(calls).toHaveLength(2);
});

test('remote preparation shares the translation pipe and reports a safe fallback without changing credentials', async () => {
  for (const fails of [false, true]) {
    const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
    let launched, preparation, f;
    f = fixture({ prepareRemote: async options => {
      preparation = options;
      if (fails) throw Error('private failure details');
      return { application: path.join(f.dir, 'managed/MacOS/Kimi'), args: ['--kwg-remote-config=synthetic'] };
    }, spawnApp: (...args) => { launched = args; process.nextTick(() => child.emit('spawn')); return child; },
    pipeFactory: () => f.pipe });
    f.pipe.targets = [];
    writeSubagentJSON(f.runtime.launchFile, { ...f.request, remoteModels: true });
    const running = f.session.run();
    await new Promise(resolve => setImmediate(resolve));
    expect(preparation).toMatchObject({ stateDir: f.dir, sessionID: f.request.id, kimiDir: f.runtime.homeDir });
    const receipt = readSubagentJSON(f.runtime.receiptFile);
    if (fails) {
      expect(launched[0]).toBe(f.request.application);
      expect(receipt.remote).toEqual({ state: 'unverified', reason: 'remote_runtime_unverified' });
      expect(JSON.stringify(receipt)).not.toContain('private failure');
      expect(receipt.runtimeApplication).toBeUndefined();
    } else {
      expect(launched[0]).toBe(path.join(f.dir, 'managed/MacOS/Kimi'));
      expect(launched[1]).toEqual(['-remote-debugging-pipe', '--kwg-remote-config=synthetic']);
      expect(receipt.runtimeApplication).toBe(launched[0]);
    }
    child.emit('exit', 0); await running;
  }
});

test('session launches a private pipe, keeps translation credentials in the host and exits without terminating Kimi', async () => {
  const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
  let launch;
  const f = fixture({ env: { KIMI_WORK_TRANSLATION_API_KEY: 'host-only-key', ELECTRON_RUN_AS_NODE: '1', SAFE_TEST: 'yes',
    GATEWAY_UPSTREAM_KEY: 'upstream-secret', KIMI_WORK_GATEWAY_TOKEN: 'panel-secret', PATH: '/usr/bin:/bin' },
    protectedEnvNames: ['GATEWAY_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN'],
    spawnApp: (...args) => { launch = args; process.nextTick(() => child.emit('spawn')); return child; },
    pipeFactory: () => f.pipe });
  f.pipe.targets = [];
  writeSubagentJSON(f.runtime.launchFile, { ...f.request, version: '99.4.0' });
  const run = f.session.run();
  await new Promise(resolve => setImmediate(resolve));
  expect(readSubagentJSON(f.runtime.receiptFile).version).toBe('99.4.0');
  expect(launch[1]).toEqual(['-remote-debugging-pipe']);
  expect(launch[2].stdio).toEqual(['ignore', 'ignore', 'ignore', 'pipe', 'pipe']);
  expect(launch[2].env.KIMI_WORK_TRANSLATION_API_KEY).toBeUndefined();
  expect(launch[2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(launch[2].env.SAFE_TEST).toBe('yes');
  // Gateway credential names are stripped from the Kimi child environment by
  // explicit name; structural variables survive untouched.
  expect(launch[2].env.GATEWAY_UPSTREAM_KEY).toBeUndefined();
  expect(launch[2].env.KIMI_WORK_GATEWAY_TOKEN).toBeUndefined();
  expect(launch[2].env.PATH).toBe('/usr/bin:/bin');
  expect(child.kill).toBeUndefined();
  child.emit('exit', 0); await run;
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('exited');
  expect(readSubagentJSON(f.runtime.receiptFile).exit).toMatchObject({ kind: 'application-exit', code: 0 });
  // The record survives a normal hand-off as installation provenance, but it is
  // no longer a live owner: a later launch must treat it as history.
  const handedOff = readSubagentJSON(f.runtime.launchFile);
  expect(handedOff).toMatchObject({ id: f.request.id, handedOff: true });
  expect(f.runtime.activeLaunch()).toBe(null);
});

// A launch record may only be replayed against the very build it was created
// from. The version string never binds anything; a mismatched application path
// or a record without archive provenance fails closed.
// The native import bridge shares this host's private pipe, so it is created
// from the same pipe object — and only for a launch record that asked for it.
test('the native bridge starts only for a launch record that requested it and stops before the pipe', async () => {
  const makeChild = () => {
    const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
    process.nextTick(() => child.emit('spawn')); return child;
  };
  const bridgeEvents = [];
  let created;
  const bridgeFactory = options => {
    created = options;
    return { start: async () => { bridgeEvents.push('start'); }, close: async () => { bridgeEvents.push('close'); } };
  };
  for (const [nativeBridge, expected] of [[true, 1], [false, 0], [undefined, 0]]) {
    bridgeEvents.length = 0;
    const child = makeChild();
    let f;
    f = fixture({ spawnApp: () => child, pipeFactory: () => f.pipe, bridgeFactory });
    f.pipe.targets = [];
    writeSubagentJSON(f.runtime.launchFile, { ...f.request, ...(nativeBridge === undefined ? {} : { nativeBridge }) });
    const run = f.session.run();
    await new Promise(resolve => setImmediate(resolve));
    expect(bridgeEvents.filter(event => event === 'start')).toHaveLength(expected);
    expect(child.kill).toBeUndefined();
    child.emit('exit', 0); await run;
    if (expected) {
      expect(created).toMatchObject({ kimiDir: f.runtime.homeDir, applicationPid: 4242 });
      expect(created.pipe).toBe(f.pipe);
      expect(bridgeEvents).toEqual(['start', 'close']);
    } else {
      expect(bridgeEvents).toEqual([]);
    }
  }
});

test('a control-only host injects nothing while translation is off and applies it once enabled', async () => {
  const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
  let f;
  f = fixture({ spawnApp: () => { process.nextTick(() => child.emit('spawn')); return child; },
    pipeFactory: () => f.pipe,
    bridgeFactory: () => ({ start: async () => {}, close: async () => {} }) });
  f.runtime.configure({ enabled: false });
  writeSubagentJSON(f.runtime.launchFile, { ...f.request, controlOnly: true, nativeBridge: true });
  f.pipe.targets = [];
  const run = f.session.run();
  await new Promise(resolve => setImmediate(resolve));
  // Maintaining the pipe is the whole job here: no script is added or evaluated.
  expect(f.calls.filter(call => call.method === 'Runtime.addBinding')).toHaveLength(0);
  expect(f.calls.filter(call => call.method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(0);
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('inactive');

  // Enabling translation later applies the renderer in the same host.
  f.pipe.targets = [{ type: 'page', targetId: 'work', url: 'file:///app/kimi-agent.html' }];
  f.runtime.configure({ enabled: true });
  await f.session.update();
  expect(f.calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(true);
  expect(vm.runInContext('typeof globalThis.__kwgTranslation.configure', f.context)).toBe('function');
  expect(vm.runInContext('globalThis.__kwgTranslation.status().state', f.context)).toBe('inactive');
  expect(readSubagentJSON(f.runtime.receiptFile).state).not.toBe('failed');
  child.emit('exit', 0); await run;
});

test('first native takeover inherits only public legacy translation preferences', async () => {
  const f = fixture();
  f.runtime.configure({ enabled: false });
  const desired = readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir);
  f.session.revision = desired.revision;
  f.session.request.inheritLegacyTranslation = true;
  f.context.localStorage = { getItem: name => name === 'kctw:settings:v1' ? JSON.stringify({ enabled: true,
    provider: 'google', targetLanguage: 'ja', view: 'original', customKey: 'never-export-this', cache: 'never-export-cache' }) : null };
  await f.session.update();
  expect(readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir).settings).toMatchObject({
    enabled: true, provider: 'google', targetLanguage: 'ja', view: 'original',
  });
  const saved = fs.readFileSync(f.runtime.settingsFile, 'utf8');
  expect(saved).not.toContain('never-export');
  expect(saved).not.toContain('customKey');
  f.runtime.configure({ enabled: false });
  f.session.request.inheritLegacyTranslation = true;
  await f.session.update();
  expect(readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir).settings.enabled).toBe(false);
});

test('legacy preferences use the old engine defaults for omitted fields', async () => {
  const f = fixture();
  f.runtime.configure({ enabled: false });
  f.session.revision = readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir).revision;
  f.session.request.inheritLegacyTranslation = true;
  f.context.localStorage = { getItem: () => JSON.stringify({ view: 'original' }) };
  await f.session.update();
  expect(readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir).settings).toMatchObject({
    enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'original',
  });
});

test('legacy inheritance preserves a newer explicit setting and refuses unknown providers', async () => {
  for (const provider of ['bing', 'custom']) {
    const f = fixture();
    f.session.request.inheritLegacyTranslation = true;
    f.context.localStorage = { getItem: () => JSON.stringify({ enabled: true, provider, targetLanguage: 'ja', view: 'original' }) };
    f.runtime.configure({ enabled: false });
    await f.session.update();
    expect(readTranslationSettings(f.runtime.settingsFile, f.runtime.homeDir).settings.enabled).toBe(false);
  }
});

test('a launch record is rejected unless it matches the same discovered installation', async () => {
  const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
  const f = fixture({ spawnApp: () => { process.nextTick(() => child.emit('spawn')); return child; }, pipeFactory: () => f.pipe });
  f.pipe.targets = [];
  const run = f.session.run();
  await new Promise(resolve => setImmediate(resolve));
  child.emit('exit', 0); await run;
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('exited');

  for (const mutation of [
    { application: path.join(f.dir, 'elsewhere', 'Kimi') },
    { discoveredApplication: path.join(f.dir, 'elsewhere', 'Kimi') },
    { archive: undefined },
    { version: '' },
  ]) {
    const id = crypto.randomUUID();
    writeSubagentJSON(f.runtime.launchFile, { ...f.request, id, pid: process.pid, at: Date.now(), ...mutation });
    const session = new TranslationSession({ stateDir: f.dir, id, spawnApp: () => child, pipeFactory: () => f.pipe });
    await expect(session.run()).rejects.toThrow('translation_launch_invalid');
  }
});

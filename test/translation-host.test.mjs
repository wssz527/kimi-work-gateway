import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { TranslationSession, classifySurface, isTranslationTarget } from '../src/translation-host.mjs';
import { TranslationRuntime, readTranslationSettings } from '../src/translation-runtime.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const dirs = [];
// Stands in for the shipped renderer: the surface is fixed at boot from the
// document it landed in, exactly as the real payload derives it from location,
// and reconfigure never changes it.
const PAYLOAD = `(() => { const cache=globalThis.__kwgTranslation?.__cache||new Map();
  const surface=globalThis.__kwgTranslationConfig?.surface;
  globalThis.__kwgTranslation={version:1,__cache:cache,status(){return {state:globalThis.__kwgTranslationConfig.enabled?'active':'inactive',version:1,
  surface,top:true,blocks:0,seenBlocks:0,structure:'none'}},
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
  // The pinned world read asks the document where it is. In a browser that is
  // `location`; here it follows the target URL unless a test overrides it, which
  // is also how a same-origin SPA route change is simulated. It is handed to
  // `createContext` so the realm sees it as a real global, not a post-hoc
  // property the payload's own scope resolution can miss.
  const world = { href: 'file:///app/kimi-agent.html' };
  // A browser realm always exposes URL; the renderer parses the location with it.
  const context = vm.createContext({ Map, location: world, top: null, URL });
  context.top = context;
  const calls = [];
  const pipe = new EventEmitter(); pipe.closed = false; pipe.dispose = () => { pipe.closed = true; };
  pipe.targets = [{ type: 'page', targetId: 'work', url: 'file:///app/kimi-agent.html' }];
  // Stands in for the browser's context reporting: `Runtime.enable` reports the
  // main world of the main frame, exactly as a real attach does, and delivers it
  // through the session's own event path. Tests that need a different shape
  // replace `pipe.contexts` before the first update.
  const box = {};
  pipe.mainFrameId = 'main-frame';
  pipe.mainContextId = 7;
  pipe.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') {
      // Only a real target describes the document; an empty tick must not blank
      // the location the pinned world would report.
      if (pipe.targets[0]?.url) world.href = pipe.targets[0].url;
      return { targetInfos: pipe.targets };
    }
    if (method === 'Target.getTargetInfo') {
      if (pipe.targetInfoFails) throw Error('translation_protocol_error');
      const target = pipe.targets.find(value => value.targetId === params.targetId);
      if (!target) throw Error('translation_protocol_error');
      return { targetInfo: { targetId: target.targetId, type: target.type, url: target.url } };
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: pipe.mainFrameId, loaderId: 'loader', url: pipe.targets[0]?.url, securityOrigin: 'https://www.kimi.com' } } };
    }
    if (method === 'Target.attachToTarget') return { sessionId: 'test-session' };
    if (method === 'Runtime.enable') {
      // Real V8 returns success immediately when already enabled and does NOT
      // re-report the existing contexts. Mirroring that is the whole point: a
      // fixture that re-reports would hide the bug where clearing our own record
      // and calling enable again loses a world that is still alive.
      const enabled = box.runtimeEnabled || (box.runtimeEnabled = new Set());
      if (enabled.has(sessionId)) return {};
      enabled.add(sessionId);
      box.contextsSent = box.contextsSent || new Set();
      if (box.contextsSent.has(sessionId)) return {};
      box.contextsSent.add(sessionId);
      for (const context of pipe.contexts || [{ id: pipe.mainContextId, uniqueId: 'unique-main',
        auxData: { isDefault: true, frameId: pipe.mainFrameId } }]) {
        box.session?.handleEvent({ method: 'Runtime.executionContextCreated', sessionId,
          params: { context } });
      }
      return {};
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
    if (method === 'Runtime.evaluate') {

      // The real document answers with its own location. Keep it in step with
      // the target unless the test pinned the route deliberately (a same-origin
      // SPA move keeps the target URL and changes only the document's).
      if (!pipe.worldPinned) world.href = pipe.targets[0]?.url;
      // A replaced document has no engine: the evaluation fails exactly as it
      // does when the execution context the session was bound to is gone.
      if (pipe.gone) throw Error('translation_protocol_error');
      return { result: { value: vm.runInContext(params.expression, context) } };
    }
    return {};
  };
  const session = new TranslationSession({ stateDir: dir, id, ...overrides });
  const desired = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  session.request = request; session.settings = desired.settings; session.revision = desired.revision;
  session.payload = PAYLOAD; session.pipe = pipe;
  box.session = session;
  return { dir, runtime, session, context, pipe, calls, request, world };
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
  const message = { sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'synthetic-1', generation: 1, text: 'Synthetic reasoning', protectedTexts: [] }) } };
  const task = f.session.binding(message);
  // The live page is re-verified before any paid work starts, so the job is
  // registered one tick later than the binding call itself.
  await new Promise(resolve => setImmediate(resolve));
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
  const payload = JSON.stringify({ type: 'translate', id: 'unicode', generation: 1, text, protectedTexts: [] });
  expect(Buffer.byteLength(payload)).toBeGreaterThan(256 * 1024);
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7, payload } });
  expect(received).toBe(text);
  expect(replies).toEqual([{ id: 'unicode', payload: { text: '合成译文' } }]);
});

test('host rejects invalid binding payloads and returns only safe error codes', async () => {
  const f = fixture({ translate: async () => { throw Error('private URL and credential'); } });
  await f.session.update();
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  const payload = { type: 'translate', id: 'safe-id', generation: 1, text: 'Synthetic', protectedTexts: [] };
  const send = value => f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7, payload: JSON.stringify(value) } });
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

// The surface classifier is what decides whether a page ever receives the
// renderer, the binding and the reasoning text. Work stays exactly as it was;
// Chat is the one desktop origin observed serving the Chat page, on the routes
// that page actually occupies. Everything else is refused, including lookalike
// hosts and the neighbouring settings pages of the same origin.
test('the surface classifier separates Work, Chat and everything else', () => {
  const chat = 'https://www.kimi.com';
  for (const url of [`${chat}/chat/7f3c1a2b`, `${chat}/chat/history`, `${chat}/`, `${chat}/chat/A_b-19`]) {
    expect(classifySurface({ type: 'page', url })).toBe('chat');
  }
  // Same origin, but not a page that shows reasoning.
  for (const url of [`${chat}/settings/chat`, `${chat}/membership/pricing`, `${chat}/plugins`, `${chat}/chat`,
    `${chat}/chat/`, `${chat}/chat/abc/def`, `${chat}/chat/${'a'.repeat(129)}`]) {
    expect(classifySurface({ type: 'page', url })).toBe('other');
    expect(isTranslationTarget({ type: 'page', url })).toBe(false);
  }
  // Origins that were never observed are not widened into the allowlist, and a
  // hostname that merely starts with the official one is a different site.
  for (const url of ['https://kimi.com/chat/abc', 'https://www.kimi.ai/chat/abc', 'https://kimi.ai/chat/abc',
    'https://www.kimi.com.evil.test/chat/abc', 'https://evil.test/https://www.kimi.com/chat/abc',
    'http://www.kimi.com/chat/abc', 'https://www.kimi.com:8443/chat/abc', 'javascript:alert(1)//']) {
    expect(classifySurface({ type: 'page', url })).toBe('other');
  }
  // Non-page targets never receive a script.
  for (const type of ['worker', 'iframe', 'service_worker', 'browser']) {
    expect(classifySurface({ type, url: `${chat}/chat/abc` })).toBe('other');
  }
  expect(classifySurface(undefined)).toBe('other');
  expect(classifySurface({ type: 'page' })).toBe('other');

  expect(classifySurface({ type: 'page', url: 'file:///app/kimi-agent.html?conversation=x' })).toBe('work');
  expect(classifySurface({ type: 'page', url: 'file:///app/index.html' })).toBe('other');
  expect(isTranslationTarget({ type: 'page', url: 'file:///app/kimi-agent.html' })).toBe(true);
});

test('a Chat target receives the renderer under its own surface and generation', async () => {
  const f = fixture();
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const receipt = readSubagentJSON(f.runtime.receiptFile);
  expect(receipt.state).toBe('active');
  expect(receipt.surfaces).toEqual({ chat: { state: 'active', structure: 'none', blocks: 0, seenBlocks: 0 } });
  expect(vm.runInContext('globalThis.__kwgTranslationConfig.surface', f.context)).toBe('chat');
  expect(vm.runInContext('globalThis.__kwgTranslationGeneration', f.context)).toBe(1);
  // The page never receives the endpoint, the model or a key name.
  const injected = f.calls.find(call => call.method === 'Page.addScriptToEvaluateOnNewDocument');
  expect(injected.params.source).not.toContain('customEndpoint');
  expect(injected.params.source).not.toContain('apiKey');
});

test('a renderer that reports another surface or runs inside a frame is not accepted', async () => {
  // A page whose own location check disagrees with the host's classification —
  // a navigation that landed between the tick and the injection.
  for (const [surface, top] of [['work', true], ['chat', false], ['other', true]]) {
    const f = fixture();
    f.session.payload = PAYLOAD.replace(
      'globalThis.__kwgTranslationConfig?.surface;',
      JSON.stringify(surface) + ';');
    f.session.payload = f.session.payload.replace('top:true', 'top:' + top);
    f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
    await f.session.update();
    expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('failed');
  }
});

test('leaving the surface retires the entry, its replies and its pending work', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture({ translate: async () => waiting });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const replies = [];
  f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });

  const message = { sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'chat-1', generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } };
  const task = f.session.binding(message);
  await new Promise(resolve => setImmediate(resolve));
  expect(f.session.jobs.size).toBe(1);

  // The user leaves /chat for a settings page of the same origin: a SPA route
  // change, so the target still exists but is no longer a surface at all.
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/settings/chat' }];
  await f.session.update();
  expect(f.session.sessions.size).toBe(0);
  expect(f.session.jobs.size).toBe(0);
  finish('迟到的译文');
  await task;
  expect(replies).toEqual([]);
  expect(f.session.live.size).toBe(0);
});

test('a binding is refused when the page behind the session is no longer the surface', async () => {
  const f = fixture({ translate: async () => '不应到达' });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const replies = [];
  f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });

  // The next tick has not run yet: the target info is already a foreign page.
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com.evil.test/chat/7f3c1a2b' }];
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'late', generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'late', payload: { error: 'translation_not_target' } }]);

  // A request stamped with a generation the live document never received
  // belongs to a page that has already been replaced.
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  for (const entry of f.session.sessions.values()) entry.generation += 1;
  replies.length = 0;
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'stale', generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'stale', payload: { error: 'translation_stale_generation' } }]);

  // An unstamped request cannot be attributed to the live document, so it is
  // refused rather than assumed current. Both shipped surfaces always stamp it.
  replies.length = 0;
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'unstamped', text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'unstamped', payload: { error: 'translation_stale_generation' } }]);
});

test('a document replacement re-injects under a new generation and drops the old reply', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture({ translate: async () => waiting });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const replies = [];
  f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  // Not awaited: the translation is deliberately held open across the reload.
  const task = f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'old-page', generation: 1, text: 'Old page reasoning', protectedTexts: [] }) } });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.session.jobs.size).toBe(1);

  // Page.frameNavigated is the browser telling us the document is gone: the
  // acknowledgement and the world both end with it. The CDP session survives.
  const oldEntry = [...f.session.sessions.values()][0];
  expect(oldEntry.mainContextId).toBe(7);
  f.session.handleEvent({ method: 'Page.frameNavigated', sessionId: 'test-session', params: { frame: { id: 'main-frame', loaderId: 'next' } } });
  await new Promise(resolve => setImmediate(resolve));
  expect(f.session.jobs.size).toBe(0);
  expect(oldEntry.mainContextId).toBeUndefined();
  expect(oldEntry.bindingContextId).toBeUndefined();

  // The reload reports a new world; the same URL re-attaches under a fresh
  // generation rather than trusting the old one.
  // The browser reports the new document's world on its own schedule; the host
  // does not re-enable Runtime (it is already enabled), so the event has to
  // arrive independently — exactly as it does in a real reload.
  f.session.handleEvent({ method: 'Runtime.executionContextCreated', sessionId: 'test-session',
    params: { context: { id: 11, uniqueId: 'unique-next', auxData: { isDefault: true, frameId: 'main-frame' } } } });
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(entry.generation).toBeGreaterThan(1);
  expect(entry.mainContextId).toBe(11);
  expect(entry.state).toBe('active');
  finish('旧文档译文');
  await task;
  expect(replies).toEqual([]);
});

// -- binding scope: which execution world may spend the user's provider --------

test('the binding is scoped to the main world and ignores sub-frame or isolated calls', async () => {
  const text = [];
  const f = fixture({ translate: async value => { text.push(value); return '译文'; } });
  // The page's main world plus a same-origin frame's world and an isolated one.
  f.pipe.contexts = [
    { id: 7, uniqueId: 'unique-main', auxData: { isDefault: true, frameId: 'main-frame' } },
    { id: 8, uniqueId: 'unique-child', auxData: { isDefault: true, frameId: 'ad-frame' } },
    { id: 9, uniqueId: 'unique-isolated', auxData: { isDefault: false, frameId: 'main-frame' } },
  ];
  await f.session.update();
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');

  // The binding is registered for the main world only.
  const binding = f.calls.find(call => call.method === 'Runtime.addBinding');
  expect(binding.params).toEqual({ name: '__kwgTranslate', executionContextId: 7 });
  expect(f.calls.some(call => call.method === 'Page.getFrameTree')).toBe(true);

  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  // The real event carries only name / payload / executionContextId.
  const call = (executionContextId, id) => f.session.binding({ sessionId: 'test-session',
    params: { name: '__kwgTranslate', executionContextId,
      payload: JSON.stringify({ type: 'translate', id, generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } });

  // A child frame's world and an isolated world are dropped without a reply:
  // answering would confirm the engine and hand them the translation.
  await call(8, 'from-child');
  await call(9, 'from-isolated');
  await call(999, 'from-unknown');
  await new Promise(resolve => setImmediate(resolve));
  expect(replies).toEqual([]);
  expect(text).toEqual([]);
  expect(f.session.jobs.size).toBe(0);

  // The main world itself still works.
  await call(7, 'from-main');
  expect(replies).toEqual([{ id: 'from-main', payload: { text: '译文' } }]);
  expect(text).toEqual(['Visible reasoning']);
});

test('a context that never reports does not get a made-up identity', async () => {
  const f = fixture({ translate: async () => '译文' });
  f.pipe.contexts = [];
  // The wait is a real deadline, not a spin, so this is the one test that has to
  // sit it out. Shortening it keeps the failure path honest without a 5 s test.
  f.session.waitForMainContext = (entry, options) => TranslationSession.prototype.waitForMainContext
    .call(f.session, entry, { timeout: 25, ...options });
  await f.session.update();
  // No main-world report means no safe place to register the binding, so the
  // entry fails instead of binding to the session or to an invented id.
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('failed');
  expect(f.calls.some(call => call.method === 'Runtime.addBinding')).toBe(false);
});

test('a sub-frame navigation does not retire a page that is still valid', async () => {
  const f = fixture();
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(entry.state).toBe('active');
  const generation = entry.generation;

  // An embedded frame reloads: a real navigation event, but not this page's.
  f.session.handleEvent({ method: 'Page.frameNavigated', sessionId: 'test-session',
    params: { frame: { id: 'ad-frame', parentId: 'main-frame', loaderId: 'other' } } });
  expect(f.session.live.has(entry)).toBe(true);
  expect(entry.generation).toBe(generation);
  expect(entry.state).toBe('active');

  // The main frame navigating does retire it.
  f.session.handleEvent({ method: 'Page.frameNavigated', sessionId: 'test-session',
    params: { frame: { id: 'main-frame', loaderId: 'next' } } });
  expect(f.session.live.has(entry)).toBe(false);
  expect(entry.generation).toBeGreaterThan(generation);
});

// -- fail-closed target verification ------------------------------------------

test('a target query that fails rejects the request instead of trusting an old URL', async () => {
  const text = [];
  const f = fixture({ translate: async value => { text.push(value); return '不应发生的译文'; } });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');

  // The page navigated off-origin and the protocol query fails — the exact
  // transient a navigation causes, and the moment the old snapshot is wrong.
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com.evil.test/chat/7f3c1a2b' }];
  f.pipe.targetInfoFails = true;
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'fail-closed', generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'fail-closed', payload: { error: 'translation_not_target' } }]);
  expect(text).toEqual([]);
  expect(f.session.jobs.size).toBe(0);
});

test('an answer without a URL is not treated as a verified page', async () => {
  const f = fixture({ translate: async () => '不应发生' });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  f.pipe.targetInfoFails = false;
  const original = f.pipe.send;
  f.pipe.send = async (method, params, sessionId) => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: params.targetId, type: 'page' } };
    return original(method, params, sessionId);
  };
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'no-url', generation: 1, text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'no-url', payload: { error: 'translation_not_target' } }]);
});

// -- job bookkeeping ----------------------------------------------------------

test('a late reply of a retired job cannot free or cancel the newer job with the same id', async () => {
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  let current = old;
  const f = fixture({ translate: async () => current });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  // Each document stamps its own generation; reading the live one keeps the
  // request itself current across the re-injection below.
  const call = id => f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id, generation: [...f.session.sessions.values()][0].generation,
      text: 'Visible reasoning', protectedTexts: [] }) } });

  const first = call('same-id');
  await new Promise(resolve => setImmediate(resolve));
  expect(f.session.jobs.size).toBe(1);
  const oldController = f.session.jobs.get('test-session:same-id');

  // A re-injection retires the job, then the same id is issued again.
  const entry = [...f.session.sessions.values()][0];
  f.session.invalidateAck(entry);
  await f.session.update();
  let finishNew;
  current = new Promise(resolve => { finishNew = resolve; });
  const second = call('same-id');
  await new Promise(resolve => setImmediate(resolve));
  expect(f.session.jobs.size).toBe(1);
  const newController = f.session.jobs.get('test-session:same-id');
  expect(newController).not.toBe(oldController);

  // The retired job settling must not remove the live one.
  finishOld('旧译文');
  await first;
  expect(f.session.jobs.get('test-session:same-id')).toBe(newController);
  expect(newController.signal.aborted).toBe(false);

  finishNew('新译文');
  await second;
  expect(replies.at(-1)).toEqual({ id: 'same-id', payload: { text: '新译文' } });
  expect(f.session.jobs.size).toBe(0);
});

test('the waiting reason names the surface that is still missing', async () => {
  const work = fixture();
  work.pipe.targets = [];
  await work.session.update();
  expect(readSubagentJSON(work.runtime.receiptFile)).toMatchObject({ state: 'attaching', reason: 'translation_waiting_work_view' });

  // The Chat page closed: only an entry was ever attached, and it is gone now.
  const chat = fixture();
  expect(chat.session.waitingReason([{ surface: 'chat' }])).toBe('translation_waiting_chat_view');
  expect(chat.session.waitingReason([{ surface: 'work' }])).toBe('translation_waiting_work_view');
  expect(chat.session.waitingReason([{ surface: 'work' }, { surface: 'chat' }])).toBe('translation_waiting_chat_view');
  chat.pipe.targets = [];
  await chat.session.update();
  expect(readSubagentJSON(chat.runtime.receiptFile)).toMatchObject({ state: 'attaching', reason: 'translation_waiting_work_view' });
});

// -- the execution world outlives the renderer acknowledgement ---------------
//
// V8's Runtime.enable returns immediately when already enabled and does NOT
// re-report the existing contexts. So the world's identity may only be dropped
// on evidence that it ended (executionContextsCleared, context destroyed, a new
// main-frame document). Everything else — a settings save, a load event, a
// same-document route change — invalidates the renderer ack only. Throwing the
// world away there loses a context the browser will never report again, and the
// binding then answers nothing.

test('saving settings re-injects under a new generation in the same world', async () => {
  const f = fixture({ translate: async () => '译文' });
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(entry.mainContextId).toBe(7);
  const generation = entry.generation;
  const enables = f.calls.filter(call => call.method === 'Runtime.enable').length;
  const bindings = f.calls.filter(call => call.method === 'Runtime.addBinding').length;

  // The user saves a new provider: a new revision, same page, same world.
  f.runtime.configure({ enabled: true, provider: 'google' });
  await f.session.update();

  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');
  // Runtime.enable is idempotent, so it is not issued again.
  expect(f.calls.filter(call => call.method === 'Runtime.enable')).toHaveLength(enables);
  // The binding already belongs to this world and is not stacked again.
  expect(f.calls.filter(call => call.method === 'Runtime.addBinding')).toHaveLength(bindings);
  expect(entry.mainContextId).toBe(7);
  expect(entry.generation).toBeGreaterThan(generation);

  // The re-injected renderer still answers the host: a fresh request under the
  // new generation is translated, which is the whole point of the re-injection.
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'after-save', generation: entry.generation,
      text: 'Saved settings reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'after-save', payload: { text: '译文' } }]);
});

test('a load event or a same-document route change keeps the world valid', async () => {
  const f = fixture({ translate: async () => '译文' });
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(entry.mainContextId).toBe(7);

  for (const method of ['Page.loadEventFired', 'Page.navigatedWithinDocument']) {
    f.session.handleEvent({ method, sessionId: 'test-session', params: {} });
    expect(entry.mainContextId).toBe(7);
    expect(entry.bindingContextId).toBe(7);
    expect(f.session.live.has(entry)).toBe(false);
    await f.session.update();
    expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');
    expect(entry.mainContextId).toBe(7);
  }

  // Still reachable after both, without the browser reporting the world again.
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'still-live', generation: entry.generation,
      text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'still-live', payload: { text: '译文' } }]);
});

test('only a cleared or destroyed world ends the context identity', async () => {
  const f = fixture({ translate: async () => '译文' });
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(entry.mainContextId).toBe(7);

  // Closing and reopening the page destroys every context.
  f.session.handleEvent({ method: 'Runtime.executionContextsCleared', sessionId: 'test-session' });
  expect(entry.mainContextId).toBeUndefined();
  expect(entry.bindingContextId).toBeUndefined();
  // The next tick has to wait for a fresh report rather than assume the old id.
  const reopened = f.session.update();
  f.session.handleEvent({ method: 'Runtime.executionContextCreated', sessionId: 'test-session',
    params: { context: { id: 21, uniqueId: 'unique-reopened', auxData: { isDefault: true, frameId: 'main-frame' } } } });
  await reopened;
  expect(entry.mainContextId).toBe(21);
  expect(entry.bindingContextId).toBe(21);
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');

  // A single destroyed context empties the identity without waiting.
  f.session.handleEvent({ method: 'Runtime.executionContextDestroyed', sessionId: 'test-session',
    params: { executionContextId: 21 } });
  expect(entry.mainContextId).toBeUndefined();
  expect(entry.bindingContextId).toBeUndefined();
});

test('a pinned world that reports a foreign location is refused', async () => {
  const text = [];
  const f = fixture({ translate: async value => { text.push(value); return '不应到达'; } });
  f.pipe.targets = [{ type: 'page', targetId: 'chat', url: 'https://www.kimi.com/chat/7f3c1a2b' }];
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('active');

  // The target URL still looks right, but the world the caller lives in has
  // moved off the surface — a same-origin SPA route out of /chat. Only the
  // pinned read can see this.
  f.pipe.worldPinned = true;
  f.world.href = 'https://www.kimi.com/settings/chat';
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'route-left', generation: entry.generation,
      text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'route-left', payload: { error: 'translation_not_target' } }]);
  expect(text).toEqual([]);

  // Back on the surface, the same world is accepted again.
  f.world.href = 'https://www.kimi.com/chat/7f3c1a2b';
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'route-back', generation: entry.generation,
      text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies.at(-1)).toEqual({ id: 'route-back', payload: { text: '不应到达' } });
});

test('a world whose document is not the top-level page is refused', async () => {
  const f = fixture({ translate: async () => '不应到达' });
  await f.session.update();
  const entry = [...f.session.sessions.values()][0];
  // The pinned read reports a frame, not the page.
  f.context.top = {};
  const replies = []; f.context.__kwgTranslationReceive = (id, payload) => replies.push({ id, payload });
  await f.session.binding({ sessionId: 'test-session', params: { name: '__kwgTranslate', executionContextId: 7,
    payload: JSON.stringify({ type: 'translate', id: 'framed', generation: entry.generation,
      text: 'Visible reasoning', protectedTexts: [] }) } });
  expect(replies).toEqual([{ id: 'framed', payload: { error: 'translation_not_target' } }]);
});

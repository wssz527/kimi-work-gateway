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
  const request = { schemaVersion: 1, id, pid: process.pid, homeDir: runtime.homeDir,
    application: path.join(dir, 'Kimi'), version: '3.2.21' };
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

test('session launches a private pipe, keeps translation credentials in the host and exits without terminating Kimi', async () => {
  const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
  let launch;
  const f = fixture({ env: { KIMI_WORK_TRANSLATION_API_KEY: 'host-only-key', ELECTRON_RUN_AS_NODE: '1', SAFE_TEST: 'yes' },
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
  expect(child.kill).toBeUndefined();
  child.emit('exit', 0); await run;
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('exited');
  expect(fs.existsSync(f.runtime.launchFile)).toBe(false);
});

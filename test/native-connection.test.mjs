import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeDesktopRuntime } from '../src/native-desktop-runtime.mjs';
import { EventEmitter } from 'node:events';
import { createNativeConnection, protectedConnectionEnvNames } from '../src/native-connection.mjs';
import { TranslationSession } from '../src/translation-host.mjs';
import { TranslationRuntime } from '../src/translation-runtime.mjs';
import { normalizeTranslationConfig } from '../src/translation-config.mjs';
import { writeSubagentJSON } from '../src/subagent-policy.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-connection-')); roots.push(root);
  const calls = [];
  let enabled = false;
  const supervisor = { inspect: () => ({ enabled }), start: options => { enabled = true; calls.push(['start', options]); return { state: 'starting' }; },
    ensure: () => { calls.push(['ensure']); return { state: 'inactive' }; }, close: () => { calls.push(['close']); }, stop: () => { enabled = false; calls.push(['stop']); } };
  const runtime = { configure: (value, options) => { calls.push(['configure', value, options]); return normalizeTranslationConfig(value); }, desiredSettings() { throw Object.assign(Error(), { code: 'ENOENT' }); } };
  return { stateDir: root, kimiDir: path.join(root, 'kimi'), calls, supervisor, runtime };
}

test('first connection starts once; subsequent recovery preserves intent and does not request another launch', async () => {
  const env = fixture(); const desktop = new NativeDesktopRuntime(env);
  expect((await desktop.ensure()).state).toBe('starting');
  expect(env.calls).toEqual([['configure', { enabled: false }, undefined], ['start', { takeover: true, controlOnly: true }]]);
  env.calls.length = 0;
  expect((await desktop.ensure()).state).toBe('inactive');
  expect(env.calls).toEqual([['ensure']]);
  desktop.close(); expect(desktop.inspect().enabled).toBe(true);
  desktop.stop(); expect(desktop.inspect().enabled).toBe(false);
});

// The desktop wrapper is a pure forwarder: the page's compare-and-swap token
// must reach the runtime unmodified, and a call without options must keep the
// runtime's historical last-writer-wins path byte-for-byte.
test('configure forwards runtime options and keeps the plain settings call unchanged', () => {
  const env = fixture();
  const desktop = new NativeDesktopRuntime(env);
  desktop.configure({ enabled: true, provider: 'bing' });
  expect(env.calls.at(-1)).toEqual(['configure', { enabled: true, provider: 'bing' }, undefined]);
  // The page's compare-and-swap token reaches the runtime unmodified.
  const token = 'synthetic-document-token';
  desktop.configure({ enabled: true, provider: 'google' }, { expectedRevision: token });
  expect(env.calls.at(-1)).toEqual(['configure', { enabled: true, provider: 'google' }, { expectedRevision: token }]);
  // A call without options forwards undefined — the runtime keeps its
  // historical last-writer-wins path — and the runtime's own normalized
  // answer comes back unchanged.
  expect(desktop.configure({ enabled: true })).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'zh',
    view: 'translated', customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' });
  expect(env.calls.at(-1)).toEqual(['configure', { enabled: true }, undefined]);
});

test('the default desktop supervisor never requests a remote companion or credential helper', () => {
  const env = fixture();
  const desktop = new NativeDesktopRuntime({ stateDir: env.stateDir, kimiDir: env.kimiDir });
  expect(desktop.supervisor.launchOptions).toEqual({ controlOnly: true });
  desktop.close();
});

test('a ready remote launch is never reused as the official shared application', async () => {
  for (const launch of [{ remoteModels: true }, { remoteModels: true, remoteRevision: 'stale' }]) {
    const env = fixture();
    env.runtime.activeLaunch = () => launch;
    const desktop = new NativeDesktopRuntime({ ...env,
      request: async () => ({ ok: true, state: 'ready', remote: { state: 'ready', catalog: 'catalog-extended' } }) });
    expect((await desktop.ensure()).state).toBe('starting');
    expect(env.calls.at(-1)).toEqual(['start', { takeover: true, controlOnly: true }]);
    expect(desktop.inspect().remote).toBeUndefined();
  }
});

test('an official ready bridge is shared without starting another application', async () => {
  for (const launch of [undefined, { remoteModels: false }]) {
    const env = fixture();
    env.runtime.activeLaunch = () => launch;
    const desktop = new NativeDesktopRuntime({ ...env, request: async () => ({ ok: true, state: 'ready' }) });
    expect(await desktop.ensure()).toEqual({ state: 'active', shared: true });
    expect(env.calls).toEqual([]);
    expect(desktop.inspect()).toEqual({ state: 'active', shared: true });
  }
});

test('a custom Kimi directory never prepares the system or takes over the default application', async () => {
  const env = fixture(); let preparations = 0;
  const connection = createNativeConnection({ stateDir: env.stateDir, kimiDir: env.kimiDir,
    onboarding: { ensure: async () => { preparations++; return { state: 'ready' }; } },
    config: { upstream: { apiKeyEnv: 'TEST_KEY' }, tokenEnv: 'TEST_TOKEN', dns: { port: 53535 }, translation: { enabled: false } },
    gateway: { inflight: new Set() } });
  expect((await connection.ensure()).reason).toBe('native_scope_unverified');
  expect((await connection.retry()).reason).toBe('native_scope_unverified');
  expect(preparations).toBe(0);
  connection.close();
});

test('cancelled native preparation does not start Kimi; explicit retry resumes the saved connection', async () => {
  const env = fixture(); let state = 'cancelled'; const calls = [];
  const desktop = { configure: value => calls.push(['configure', value]), ensure: async () => { calls.push(['desktop']); return { state: 'starting' }; }, close() {} };
  const onboarding = { ensure: async options => { calls.push(['prepare', options.retry]); return { state }; } };
  const importer = { sync: async input => input, after: 100, retry: false };
  const connection = createNativeConnection({ ...env, desktop, onboarding, importer,
    config: { upstream: { apiKeyEnv: 'TEST_KEY' }, tokenEnv: 'TEST_TOKEN', dns: { port: 53535 }, translation: { enabled: false } },
    gateway: { inflight: new Set() } });
  expect((await connection.ensure()).state).toBe('cancelled');
  expect(calls.some(row => row[0] === 'desktop')).toBe(false);
  state = 'done';
  expect((await connection.retry()).state).toBe('starting');
  expect(importer.after).toBe(0); expect(importer.retry).toBe(true);
  expect(calls).toContainEqual(['prepare', true]); expect(calls).toContainEqual(['desktop']);
});

// The connection's own names are what the Kimi child must never inherit. The
// default constructor is used here on purpose: a test that injects a desktop
// would never build the list this asserts on.
test('a connections-only config builds a native connection without a legacy upstream', () => {
  const env = fixture();
  const connection = createNativeConnection({ stateDir: env.stateDir, kimiDir: env.kimiDir,
    onboarding: { ensure: async () => ({ state: 'ready' }) },
    config: { upstream: null, tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', dns: { port: 53535 }, translation: { enabled: false },
      connections: [
        { id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' },
        { id: 'conn-b', name: 'B', baseURL: 'https://b.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_B_KEY' },
      ] },
    gateway: { inflight: new Set() } });
  expect(connection.desktop.supervisor.protectedEnvNames)
    .toEqual(['KIMI_WORK_CONN_A_KEY', 'KIMI_WORK_CONN_B_KEY', 'KIMI_WORK_GATEWAY_TOKEN']);
  connection.close();
});

test('every upstream credential name is removed from the Kimi child environment, and nothing else is', () => {
  const names = protectedConnectionEnvNames({
    upstream: { apiKeyEnv: 'KIMI_WORK_UPSTREAM_KEY' }, tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN',
    connections: [
      { id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' },
      { id: 'conn-b', name: 'B', baseURL: 'https://b.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_B_KEY' },
    ],
  });
  expect(names).toEqual(['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_CONN_A_KEY', 'KIMI_WORK_CONN_B_KEY',
    'KIMI_WORK_GATEWAY_TOKEN']);
  // A connections-only config protects the same way without a legacy name.
  expect(protectedConnectionEnvNames({ tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN',
    connections: [{ id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' }] }))
    .toEqual(['KIMI_WORK_CONN_A_KEY', 'KIMI_WORK_GATEWAY_TOKEN']);
});

// The names above are only useful if the launcher actually strips them. This
// drives the real session with the exact list the default constructor builds,
// and inspects the environment handed to the Kimi child.
test('the native connection protects every connection key from the Kimi child environment', async () => {
  const env = fixture();
  const config = { upstream: null, tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', dns: { port: 53535 },
    translation: { enabled: false },
    connections: [
      { id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' },
      { id: 'conn-b', name: 'B', baseURL: 'https://b.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_B_KEY' },
    ] };
  const connection = createNativeConnection({ stateDir: env.stateDir, kimiDir: env.kimiDir,
    onboarding: { ensure: async () => ({ state: 'ready' }) }, config, gateway: { inflight: new Set() } });
  const names = protectedConnectionEnvNames(config);
  expect(names).toEqual(['KIMI_WORK_CONN_A_KEY', 'KIMI_WORK_CONN_B_KEY', 'KIMI_WORK_GATEWAY_TOKEN']);
  connection.close();

  // A launch record is what the session replays; it must exist for the child to
  // be spawned at all.
  const runtime = new TranslationRuntime({ stateDir: env.stateDir, kimiDir: env.kimiDir });
  runtime.configure({ enabled: true });
  const application = path.join(env.stateDir, process.platform === 'darwin' ? 'MacOS' : '', 'Kimi');
  const request = { schemaVersion: 1, id: 'session-a', pid: process.pid, homeDir: runtime.homeDir,
    application, version: '3.2.21', archive: path.join(env.stateDir, 'Resources', 'app.asar'),
    discoveredApplication: application };
  writeSubagentJSON(runtime.launchFile, request);

  const child = new EventEmitter(); child.pid = 4242; child.stdio = [null, null, null, {}, {}];
  let launch;
  const pipe = new EventEmitter(); pipe.closed = false; pipe.dispose = () => {};
  // The session asks the browser for the attached targets before it spawns.
  pipe.targets = [{ type: 'page', targetId: 'work', url: 'file:///app/kimi-agent.html' }];
  pipe.mainFrameId = 'main-frame'; pipe.mainContextId = 7;
  pipe.send = async method => method === 'Target.getTargets'
    ? { targetInfos: pipe.targets } : { result: {} };
  const session = new TranslationSession({ stateDir: env.stateDir, id: request.id, protectedEnvNames: names,
    env: { PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example', KIMI_WORK_GATEWAY_TOKEN: 'gateway-token',
      KIMI_WORK_CONN_A_KEY: 'connection-a-key', KIMI_WORK_CONN_B_KEY: 'connection-b-key' },
    spawnApp: (...args) => { launch = args; process.nextTick(() => child.emit('spawn')); return child; },
    pipeFactory: () => pipe });
  const run = session.run();
  await new Promise(resolve => setImmediate(resolve));
  const childEnv = launch[2].env;
  expect(childEnv.KIMI_WORK_CONN_A_KEY).toBeUndefined();
  expect(childEnv.KIMI_WORK_CONN_B_KEY).toBeUndefined();
  expect(childEnv.KIMI_WORK_GATEWAY_TOKEN).toBeUndefined();
  // Ordinary variables are untouched: the protection is by exact name only.
  expect(childEnv.PATH).toBe('/usr/bin');
  expect(childEnv.HTTPS_PROXY).toBe('http://proxy.example');
  child.emit('exit', 0); await run;
});

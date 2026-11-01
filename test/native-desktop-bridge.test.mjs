import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { NativeDesktopBridge, nativeDesktopRequest } from '../src/native-desktop-bridge.mjs';
import { NativeModelImport } from '../src/native-import.mjs';

const roots = [], bridges = [];
afterEach(async () => { for (const bridge of bridges.splice(0)) await bridge.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-desktop-bridge-')); roots.push(root);
  const kimiDir = path.join(root, 'user', 'daimon-share', 'daimon'), stateDir = path.join(root, 'state');
  fs.mkdirSync(kimiDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'user', 'bridge-store'), { recursive: true });
  fs.writeFileSync(path.join(root, 'user', 'bridge-store', 'token-store.json'), '{}');
  fs.writeFileSync(path.join(kimiDir, 'config.json'), JSON.stringify({ credentials: { kimiWeb: { userId: 'test-account' } } }));
  return { root, kimiDir, stateDir, account: hash('test-account') };
}
function pipe(context, { workOnly = false } = {}) {
  const calls = [];
  return { calls, closed: false, async send(method, params, sessionId) {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'page', targetId: 'work', url: 'app://localhost/kimi-agent.html' },
      ...workOnly ? [] : [{ type: 'page', targetId: 'settings', url: 'app://localhost/work-settings.html' }],
      { type: 'page', targetId: 'foreign', url: 'https://example.com/desktopclaw.html' },
    ] };
    if (method === 'Target.attachToTarget') return { sessionId: params.targetId };
    if (method === 'Runtime.evaluate') {
      const scope = sessionId === 'settings' ? context : { kimiAgentAPI: { openSettings: pane => { calls.push({ pane }); } } };
      return { result: { value: await vm.runInNewContext(params.expression, scope) } };
    }
    return {};
  } };
}

test('authenticated fixed import invokes Kimi API and returns no token or profile', async () => {
  const env = fixture(); let received;
  const transport = pipe({ clawBridgeAPI: { importByokModels: async (token, url) => {
    received = { token, url }; return { ok: true, requiresRestart: true, profile: { token: 'native-secret', models: [{ alias: 'test' }] } };
  } } });
  const bridge = new NativeDesktopBridge({ ...env, pipe: transport, applicationPid: 123 }); bridges.push(bridge);
  await bridge.start();
  const result = await nativeDesktopRequest(env.kimiDir, 'import-models', { url: 'http://127.0.0.1:3426/v1', token: 'test-local-token', expectedAccountKey: env.account });
  expect(result).toEqual({ ok: true, models: 1, requiresRestart: true, restartDeferred: false });
  expect(received).toEqual({ token: 'test-local-token', url: 'http://127.0.0.1:3426/v1' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(transport.calls.some(row => row.params?.targetId === 'foreign')).toBe(false);
  const descriptor = JSON.parse(fs.readFileSync(bridge.file, 'utf8'));
  const rejected = await fetch(descriptor.url + '/import-models', { method: 'POST', headers: { Authorization: 'Bearer ' + descriptor.token, Origin: 'https://example.com' }, body: '{}' });
  expect(rejected.status).toBe(401);
  expect(await nativeDesktopRequest(env.kimiDir, 'eval', { expression: '1' })).toMatchObject({ ok: false });
});

test('account mismatch and nonlocal URLs are refused before evaluating native API', async () => {
  const env = fixture(); const transport = pipe({});
  const bridge = new NativeDesktopBridge({ ...env, pipe: transport });
  expect(await bridge.importModels({ url: 'http://127.0.0.1:3426/v1', token: 'test', expectedAccountKey: hash('other') })).toMatchObject({ ok: false, reason: 'native_import_account_changed' });
  expect(await bridge.importModels({ url: 'https://example.com/v1', token: 'test', expectedAccountKey: env.account })).toMatchObject({ ok: false, reason: 'native_bridge_invalid_request' });
  expect(transport.calls).toHaveLength(0);
});

test('missing settings opens the native view then waits for its actual API', async () => {
  const env = fixture(); const transport = pipe({}, { workOnly: true });
  const bridge = new NativeDesktopBridge({ ...env, pipe: transport });
  expect(await bridge.importModels({ url: 'http://127.0.0.1:3426/v1', token: 'test', expectedAccountKey: env.account })).toMatchObject({ ok: false, reason: 'native_bridge_waiting_settings' });
  expect(transport.calls.some(row => row.pane === 'general')).toBe(true);
});

test('native import creates a secret-free receipt, respects disconnect and restores after process change', async () => {
  const env = fixture(); let pid = 123, imports = 0;
  const importer = new NativeModelImport({ ...env, getToken: () => 'synthetic-gateway-secret',
    getContext: () => ({ profileKey: env.account, accountScope: env.account }),
    request: async (dir, operation, input) => {
      if (operation === 'status') return { ok: true, state: 'ready', applicationPid: pid };
      imports++; expect(input.expectedAccountKey).toBe(env.account); return { ok: true };
    } });
  const input = { url: 'http://127.0.0.1:3426/v1', models: ['test'], previousContext: { reason: 'profile_missing' } };
  expect(await importer.sync(input)).toEqual({ ok: true });
  expect(fs.readFileSync(importer.file, 'utf8')).not.toContain('synthetic-gateway-secret');
  importer.after = 0;
  expect(await importer.sync(input)).toMatchObject({ ok: false, reason: 'native_import_disconnected' });
  expect(imports).toBe(1);
  pid = 456; importer.after = 0;
  expect(await importer.sync(input)).toEqual({ ok: true }); expect(imports).toBe(2);
});

test('native import waits for login and never starts another-account import', async () => {
  const env = fixture(); let called = false;
  const importer = new NativeModelImport({ ...env, getToken: () => 'test', getContext: () => ({}), request: async () => { called = true; } });
  expect(await importer.sync({})).toMatchObject({ reason: 'native_import_waiting_login' });
  expect(called).toBe(false);
  importer.getContext = () => ({ profileKey: env.account, accountScope: env.account }); importer.after = 0;
  expect(await importer.sync({ previousContext: { accountDigest: hash('other') } })).toMatchObject({ reason: 'native_import_account_changed' });
  expect(called).toBe(false);
});

test('authenticated status exposes remote readiness without model or credential data', async () => {
  const env = fixture();
  const bridge = new NativeDesktopBridge({ ...env, pipe: pipe({}), applicationPid: 123,
    getRemoteState: () => ({ state: 'ready', catalog: 'catalog-extended', added: 6, updater: 'delegated',
      models: ['private-model'], token: 'private-token', baseUrl: 'https://private.invalid' }) });
  bridges.push(bridge);
  await bridge.start();
  const result = await nativeDesktopRequest(env.kimiDir, 'status');
  expect(result).toEqual({ ok: true, state: 'ready', applicationPid: 123,
    remote: { state: 'ready', catalog: 'catalog-extended', added: 6, updater: 'delegated' } });
  expect(JSON.stringify(result)).not.toContain('private');
});

test('a remote status failure leaves the native import bridge available', async () => {
  const env = fixture();
  const bridge = new NativeDesktopBridge({ ...env, pipe: pipe({}), applicationPid: 123,
    getRemoteState: () => { throw Error('private-status-error'); } });
  bridges.push(bridge);
  await bridge.start();
  expect(await nativeDesktopRequest(env.kimiDir, 'status')).toEqual({ ok: true, state: 'ready', applicationPid: 123,
    remote: { state: 'unverified', reason: 'remote_runtime_state_unavailable' } });
});

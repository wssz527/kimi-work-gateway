import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { SubagentPolicy, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { normalizeTranslationConfig } from '../src/translation-config.mjs';

const fixtures = [];
const intent = action => ({ id: crypto.randomUUID(), at: Date.now(), action });
async function fixture({ force = false, translationRuntime } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-panel-translation-'));
  const file = path.join(dir, 'config.json');
  const document = { upstream: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'TEST_KEY' }, port: 0,
    models: [{ id: 'group/test', protocol: 'responses', tools: true, contextWindow: 128000 }],
    ...(force ? { subagents: { mode: 'force', model: 'group/test' } } : {}), kept: { custom: 'retained' } };
  writeSubagentJSON(file, document);
  const config = readConfig(document);
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: 'test-key', models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: 'test-token', port: 0 });
  const calls = [];
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(config.subagents, backend.models);
  const runtime = { inspect: () => ({ state: 'not-prepared' }),
    launch: async () => { calls.push('adapted-launch'); return { state: 'waiting-kimi-exit' }; },
    launchOriginal: async () => { calls.push('original-launch'); return { state: 'starting', pid: 4242 } } };
  const translation = translationRuntime || {
    configure(value) { this.settings = normalizeTranslationConfig(value); },
    inspect: () => ({ state: 'not-started', internal: 'hidden' }),
    check: () => ({ state: 'not-started', version: '3.2.21' }),
    launch: async options => { calls.push(options); return { state: 'starting', pid: 4242, version: '3.2.21' }; },
  };  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir,
    kimiDir: path.join(dir, 'kimi'), policy, runtime, translationRuntime: translation,
    env: { KIMI_WORK_TRANSLATION_API_KEY: 'private-translation-secret' },
    probe: { check: async () => ({ revealed: false }) } });
  const panel = new GatewayPanel({ controller });
  await panel.start({ port: 0 });
  const f = { dir, file, document, controller, translation, runtime, policy, gateway, panel, calls };
  fixtures.push(f); return f;
}
function api(f, route, body, headers = {}) {
  return fetch(f.panel.url + route, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url, 'Content-Type': 'application/json', ...headers } });
}
async function save(f, value = {}) {
  const { revision } = await f.controller.state();
  return api(f, '/api/translation', { revision, ...normalizeTranslationConfig({ enabled: true, ...value }) });
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel.stop(); await f.controller.close(); await f.gateway.stop(); f.policy.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('translation API preserves unrelated fields and returns only environment availability and actual runtime status', async () => {
  const f = await fixture();
  const response = await save(f, { provider: 'custom', customEndpoint: 'https://translation.example/v1/chat/completions', customModel: 'translator' });
  expect(response.status).toBe(200);
  const text = await response.text(), { state } = JSON.parse(text);
  expect(state.configuration.state).toBe('ready');
  expect(state.translation).toMatchObject({ configured: { enabled: true, provider: 'custom', customModel: 'translator' },
    environment: { keySet: true }, runtime: { state: 'not-started' } });
  expect(state.translation.runtime.internal).toBeUndefined();
  expect(text).not.toContain('private-translation-secret');
  expect(readSubagentJSON(f.file).kept).toEqual(f.document.kept);
  expect(f.translation.settings).toEqual(state.translation.configured);
  expect(f.calls).toHaveLength(0);
});

test('translation writes reject foreign requests, invalid settings and stale revisions without changing files', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const before = fs.readFileSync(f.file, 'utf8');
  const settings = { revision, ...normalizeTranslationConfig({ enabled: true }) };
  expect((await api(f, '/api/translation', settings, { Authorization: 'Bearer wrong' })).status).toBe(401);
  expect((await api(f, '/api/translation', settings, { Origin: 'https://evil.example' })).status).toBe(403);
  for (const value of [{ provider: 'custom' }, { customEndpoint: 'http://remote.example/api' }, { apiKey: 'secret' }]) {
    const response = await api(f, '/api/translation', { ...settings, ...value });
    expect(response.status).toBe(400);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  }
  expect((await save(f)).status).toBe(200);
  expect((await api(f, '/api/translation', settings)).status).toBe(409);
  writeSubagentJSON(f.file, { ...readSubagentJSON(f.file), port: 54321 });
  const changed = await f.controller.state();
  expect((await api(f, '/api/translation', { ...settings, revision: changed.revision })).status).toBe(409);
  expect(readSubagentJSON(f.file).port).toBe(54321);
});

test('both launch actions use the translation host and preserve the force policy without reporting active early', async () => {
  const f = await fixture({ force: true });
  expect((await save(f)).status).toBe(200);
  for (const action of ['launch-translated-kimi', 'launch-kimi']) {
    const request = intent(action);
    expect((await api(f, '/api/actions', request)).status).toBe(202);
    await f.controller.operationTask;
    expect((await f.controller.state()).operation.state).toBe('starting');
    expect((await f.controller.state()).translation.runtime.state).toBe('not-started');
    expect((await api(f, '/api/actions', request)).status).toBe(202);
  }
  expect(f.calls).toHaveLength(2);
  for (const call of f.calls) {
    expect(call).toMatchObject({ force: true, subagentRuntime: f.runtime });
    expect(call.protectedEnvNames).toEqual(['TEST_KEY', 'KIMI_WORK_GATEWAY_TOKEN']);
  }
  const response = await api(f, '/api/actions', intent('check-translation'));
  expect(response.status).toBe(202);
  await f.controller.operationTask;
  expect((await f.controller.state()).operation).toMatchObject({ state: 'not-started', version: '3.2.21' });
  expect(f.calls).toHaveLength(2);
});

test('plain launch starts original Kimi only in inherit mode and never drops a force policy', async () => {
  const inherited = await fixture();
  await api(inherited, '/api/actions', intent('launch-kimi'));
  await inherited.controller.operationTask;
  expect((await inherited.controller.state()).operation).toMatchObject({ state: 'starting' });
  expect(inherited.calls).toEqual(['original-launch']);

  const forced = await fixture({ force: true });
  await api(forced, '/api/actions', intent('launch-kimi'));
  await forced.controller.operationTask;
  expect((await forced.controller.state()).operation.state).toBe('waiting-kimi-exit');
  expect(forced.calls).toEqual(['adapted-launch']);
});

test('saved-but-unapplied translation settings are visible and can be reapplied after a runtime write failure', async () => {
  const f = await fixture();
  const configure = f.translation.configure;
  f.translation.configure = () => { throw Error('private translation write failure'); };
  const response = await save(f);
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({ code: 'translation_apply_failed', saved: true });
  expect(readSubagentJSON(f.file).translation.enabled).toBe(true);
  const failed = await f.controller.state();
  expect(failed.translation.runtime).toEqual({ state: 'failed', reason: 'translation_settings_conflict' });
  expect(JSON.stringify(failed)).not.toContain('private translation write failure');
  f.translation.configure = configure;
  expect((await save(f, { enabled: false })).status).toBe(200);
  expect((await f.controller.state()).translation.configured.enabled).toBe(false);
  expect((await f.controller.state()).translation.runtime.state).toBe('not-started');
});

test('external configuration changes and blocked policy prevent translation launch', async () => {
  const f = await fixture();
  expect((await save(f)).status).toBe(200);
  writeSubagentJSON(f.file, { ...readSubagentJSON(f.file), port: 54321 });
  await api(f, '/api/actions', intent('launch-translated-kimi'));
  await f.controller.operationTask;
  expect((await f.controller.state()).operation).toMatchObject({ state: 'failed', reason: 'configuration_changed' });
  expect(f.calls).toHaveLength(0);
});

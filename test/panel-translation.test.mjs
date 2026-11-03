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
import { SubagentPolicy, currentDocumentRevision, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { normalizeTranslationConfig } from '../src/translation-config.mjs';
import { TranslationRuntime, publicSurfaces, translationRevision } from '../src/translation-runtime.mjs';

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
  const translation = translationRuntime || new TranslationRuntime({
    stateDir: dir, kimiDir: path.join(dir, 'kimi'),
    // The controller never launches a host in these tests; the runtime is
    // here for its real settings file, CAS and desiredSettings. Only the
    // launch and Kimi-location surfaces are replaced, so a save drives the
    // real CAS path against the real file.
    spawnHost: () => { throw Error('translation_runtime_unavailable'); },
  });
  if (!translationRuntime) {
    const realLaunch = translation.launch.bind(translation);
    translation.launch = async options => {
      calls.push(options);
      return { state: 'starting', pid: 4242, version: '3.2.21' };
    };
    translation.check = () => ({ state: 'not-started', version: '3.2.21' });
    translation.locate = () => ({ application: path.join(dir, 'kimi', 'Kimi'), version: '3.2.21' });
  }
  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir,
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
  const state = await f.controller.state();
  return api(f, '/api/translation', { revision: state.revision,
    translationRevision: state.translation.revision,
    ...normalizeTranslationConfig({ enabled: true, ...value }) });
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel.stop(); await f.controller.close(); await f.gateway.stop(); f.policy.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('legacy remote evidence is not published through the desktop integration state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-panel-remote-'));
  const file = path.join(dir, 'config.json');
  const document = { upstream: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'TEST_KEY' }, port: 0,
    models: [{ id: 'group/test', protocol: 'responses', tools: true, contextWindow: 128000 }] };
  writeSubagentJSON(file, document);
  const config = readConfig(document);
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: 'test-key', models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: 'test-token', port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(config.subagents, backend.models);
  const remoteInspect = { state: 'active', enabled: true, version: '3.2.21',
    secret: 'synthetic-desktop-secret',
    remote: { state: 'ready', catalog: 'catalog-extended', added: 7,
      reason: 'remote_runtime_scope_unverified', apiKey: 'synthetic-remote-secret', extra: 'nope' } };
  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir,
    kimiDir: path.join(dir, 'kimi'), policy,
    runtime: { inspect: () => ({ state: 'not-prepared' }) },
    translationRuntime: { configure() {}, inspect: () => ({ state: 'not-started' }), check: () => ({ state: 'not-started' }),
      launch: async () => ({ state: 'starting' }) },
    probe: { check: async () => ({ revealed: false }) },
    nativeConnection: { status: { state: 'ready', stage: 'imported', hidden: 'synthetic-connection-secret' },
      desktop: { inspect: () => remoteInspect },
      retry: async () => ({ state: 'starting' }), close() {} } });
  try {
    const { integration } = await controller.state();
    expect(integration.desktop).toEqual({ state: 'active', enabled: true, version: '3.2.21' });
    const text = JSON.stringify(integration);
    expect(text).not.toContain('synthetic-desktop-secret');
    expect(text).not.toContain('synthetic-remote-secret');
    expect(text).not.toContain('synthetic-connection-secret');
    expect(text).not.toContain('catalog-extended');
    expect(text).not.toContain('nope');
    remoteInspect.remote = { state: 'ready', catalog: 'unheard-of', added: 999 };
    const again = await controller.state();
    expect(again.integration.desktop).toEqual({ state: 'active', enabled: true, version: '3.2.21' });
  } finally {
    await controller.close(); await gateway.stop(); policy.close();
    fs.rmSync(dir, { recursive: true, force: true });
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

// The panel is where "no reasoning on screen yet" and "the selectors drifted"
// have to be told apart; both used to render as a plain "injected". The shape is
// sanitized by TranslationRuntime (see translation-runtime.test.mjs); here it
// has to survive into the panel state and nothing else may come along.
test('the panel exposes per-surface state and never the raw internal status object', async () => {
  const f = await fixture({ translationRuntime: { configure() {}, check: () => ({ state: 'not-started' }),
    inspect: () => ({ state: 'active', internal: 'hidden',
      surfaces: publicSurfaces({ chat: { state: 'active', structure: 'none', blocks: 0, seenBlocks: 0 },
        work: { state: 'active', structure: 'partial', blocks: 1, seenBlocks: 3, internal: 'hidden' } }) }) } });
  const state = await f.controller.state();
  expect(state.translation.runtime).toEqual({ state: 'active', surfaces: {
    chat: { state: 'active', structure: 'none', blocks: 0, seenBlocks: 0 },
    work: { state: 'active', structure: 'partial', blocks: 1, seenBlocks: 3 } } });
  expect(state.translation.runtime.surfaces.work.internal).toBeUndefined();
  expect(state.translation.runtime.internal).toBeUndefined();

  // An older runtime with no surfaces field keeps the previous shape.
  const plain = await fixture({ translationRuntime: { configure() {}, check: () => ({ state: 'not-started' }),
    inspect: () => ({ state: 'active' }) } });
  expect((await plain.controller.state()).translation.runtime).toEqual({ state: 'active' });
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
    expect(call).toMatchObject({ force: false, subagentRuntime: undefined });
    expect(f.policy.value).toMatchObject({ mode: 'force', transport: 'native-config' });
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
  expect((await forced.controller.state()).operation.state).toBe('starting');
  expect(forced.calls).toEqual(['original-launch']);
  expect(forced.policy.value).toMatchObject({ mode: 'force', transport: 'native-config' });
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
  // The real runtime reports the saved-but-never-started settings honestly.
  expect((await f.controller.state()).translation.runtime.state).toBe('disabled');
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

// Two locks protect a translation save, and both stay real. `revision` is the
// historical whole-document gateway.json CAS: an old client that sends it (or
// omits it) keeps exactly the behaviour it always had. `translationRevision`
// is the narrower settings token the state publishes — the digest of the whole
// translation-settings.json document, the same token the runtime's CAS checks.
// When sent it must match, and it is handed down to `configure` so the write
// re-checks the file immediately before the rename.
test('translation saves keep the document CAS and pass the settings token down to the runtime', async () => {
  const f = await fixture();
  const before = await f.controller.state();
  expect(typeof before.translation.revision).toBe('string');
  expect(before.translation.revision).not.toBe(before.revision);
  // The published token is the settings file's document digest, not the
  // payload digest stored inside the document.
  expect(before.translation.revision)
    .toBe(currentDocumentRevision(path.join(f.dir, 'translation-settings.json')));

  expect((await save(f)).status).toBe(200);
  const saved = await f.controller.state();
  expect(typeof saved.translation.revision).toBe('string');
  expect(saved.translation.revision).not.toBe(before.translation.revision);
  expect(saved.translation.revision)
    .toBe(currentDocumentRevision(path.join(f.dir, 'translation-settings.json')));

  // The old whole-document lock still works on its own: a stale gateway.json
  // revision is the historical 409 configuration_conflict, not a settings
  // conflict, and nothing is written.
  const staleDocument = await api(f, '/api/translation', {
    revision: before.revision, ...normalizeTranslationConfig({ enabled: true }) });
  expect(staleDocument.status).toBe(409);
  expect((await staleDocument.json()).error.code).toBe('configuration_conflict');
  expect(readSubagentJSON(f.file).translation.enabled).toBe(true);

  // A stale settings token is refused before any write.
  const staleSettings = await api(f, '/api/translation', {
    translationRevision: before.translation.revision, ...normalizeTranslationConfig({ enabled: true }) });
  expect(staleSettings.status).toBe(409);
  const { error } = await staleSettings.json();
  expect(error.code).toBe('translation_settings_conflict');
  expect(error.expectedRevision).toBe(saved.translation.revision);
  expect(readSubagentJSON(f.file).translation.enabled).toBe(true);

  // A save with neither lock is refused: it could overwrite anything blindly.
  const bare = await api(f, '/api/translation', { ...normalizeTranslationConfig({ enabled: true }) });
  expect(bare.status).toBe(409);
  expect(readSubagentJSON(f.file).translation.enabled).toBe(true);

  // A document-only save (the old client shape) still succeeds.
  const current = await f.controller.state();
  const documentOnly = await api(f, '/api/translation', { revision: current.revision,
    ...normalizeTranslationConfig({ enabled: false }) });
  expect(documentOnly.status).toBe(200);
  expect(readSubagentJSON(f.file).translation.enabled).toBe(false);
  expect((await f.controller.state()).translation.configured.enabled).toBe(false);
});

test('a first save carrying the current settings revision is accepted and republished', async () => {
  const f = await fixture();
  const current = await f.controller.state();
  const response = await api(f, '/api/translation', { revision: current.revision,
    translationRevision: current.translation.revision,
    ...normalizeTranslationConfig({ enabled: true }) });
  expect(response.status).toBe(200);
  const { state } = await response.json();
  expect(state.translation.revision)
    .toBe(currentDocumentRevision(path.join(f.dir, 'translation-settings.json')));
});

// 审查项 P2-1 的实证：settings 文件缺失时 state 必须发布 null（不是对草稿或
// 默认值算摘要），首次保存（无 translationRevision 令牌）放行并落盘，之后
// 状态恢复发布真实修订；带陈旧令牌的重试被拒。走真实 TranslationRuntime 的
// 完整文件路径，删除文件模拟「状态目录被外部清掉」的场景。
test('a missing settings file publishes null, lets the first save through, then resumes revisions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-panel-translation-enoent-'));
  const file = path.join(dir, 'config.json');
  const document = { upstream: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'TEST_KEY' }, port: 0,
    models: [{ id: 'group/test', protocol: 'responses', tools: true, contextWindow: 128000 }] };
  writeSubagentJSON(file, document);
  const config = readConfig(document);
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: 'test-key', models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: 'test-token', port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(config.subagents, backend.models);
  const settingsFile = path.join(dir, 'translation-settings.json');
  const runtime = new TranslationRuntime({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir,
    kimiDir: path.join(dir, 'kimi'), policy,
    translationRuntime: runtime, env: {},
    probe: { check: async () => ({ revealed: false }) } });
  const panel = new GatewayPanel({ controller });
  await panel.start({ port: 0 });
  fixtures.push({ dir, file, controller, policy, gateway, panel });
  const call = body => api({ panel }, '/api/translation', body);

  try {
    // The constructor seeded the settings file from the saved config.
    expect(fs.existsSync(settingsFile)).toBe(true);
    // Simulate the state directory being wiped: no settings file at all.
    fs.rmSync(settingsFile, { force: true });
    const state = await controller.state();
    expect(state.translation.revision).toBeNull();

    // The first save carries no settings token (the page saw null) and must
    // go through, recreating the file.
    const seededRevision = currentDocumentRevision(file);
    const first = await call({ revision: seededRevision,
      ...normalizeTranslationConfig({ enabled: true }) });
    expect(first.status).toBe(200);
    expect(fs.existsSync(settingsFile)).toBe(true);
    const republished = (await controller.state()).translation.revision;
    expect(typeof republished).toBe('string');

    // A retry naming the *previous* settings token (the file it saw was wiped
    // and republished under a new revision) is refused before any write.
    const staleRetry = await call({ revision: currentDocumentRevision(file),
      translationRevision: '0'.repeat(64), ...normalizeTranslationConfig({ enabled: false }) });
    expect(staleRetry.status).toBe(409);
    const { error } = await staleRetry.json();
    expect(error.code).toBe('translation_settings_conflict');
    // A document-only retry — the old-client shape — still succeeds: the
    // historical whole-document lock alone protects it.
    const legacyRetry = await call({ revision: currentDocumentRevision(file),
      ...normalizeTranslationConfig({ enabled: false }) });
    expect(legacyRetry.status).toBe(200);
    expect(readSubagentJSON(settingsFile).settings.enabled).toBe(false);
  } finally {
    await panel.stop(); await controller.close(); await gateway.stop(); policy.close();
  }
});

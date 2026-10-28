import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli.mjs';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { SubagentPolicy, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const KEY = 'panel-test-upstream-secret';
const TOKEN = 'panel-test-gateway-secret';
const CHILD = 'group/deepseek-v4-1-flash';
const MODELS = [
  { id: 'kimi-test-parent', name: 'Parent', protocol: 'chat', contextWindow: 128000, tools: true },
  { id: CHILD, name: 'DeepSeek V4.1 Flash', protocol: 'responses', contextWindow: 256000,
    tools: true, reasoning: true, reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'no-tools', protocol: 'responses', contextWindow: 64000 },
];
const fixtures = [];
const intent = action => ({ id: crypto.randomUUID(), at: Date.now(), action });
const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
};

async function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-panel-'));
  const file = path.join(dir, 'gateway.json');
  const document = { upstream: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'PANEL_TEST_KEY' },
    tokenEnv: 'PANEL_TEST_TOKEN', port: 0, dns: { enabled: false }, models: MODELS,
    retained: { value: 'keep this field' } };
  fs.writeFileSync(file, JSON.stringify(document));
  const config = readConfig(document);
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: KEY, models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: TOKEN, port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(config.subagents, backend.models);
  const calls = [];
  const runtime = { inspect: () => ({ state: 'not-prepared' }),
    prepare: () => { calls.push('prepare'); return { state: 'prepared', version: '3.2.21', bundleDir: '/private/bundle' }; },
    launch: async () => { calls.push('launch'); return { state: 'waiting-kimi-exit' }; } };
  const controllerOptions = { configFile: file, config, gateway, backend, stateDir: dir, kimiDir: path.join(dir, 'kimi'), policy,
    runtime, probe: { check: async () => ({ revealed: false, intranet: { passed: false, error: 'dns_unavailable' } }) },
    setup: { run: async (request, port) => { calls.push({ request, port }); return { state: 'done' }; } },
    copyToken: async request => { calls.push(request); return 'copied'; }, ...overrides };
  const controller = new PanelController(controllerOptions);
  const uiDir = path.join(dir, '界面 assets');
  fs.mkdirSync(uiDir);
  for (const [name, content] of Object.entries({ 'index.html': '<!doctype html><title>Panel fixture</title>',
    'app.js': 'document.title = "Panel";', 'styles.css': 'body { color: black; }' })) {
    fs.writeFileSync(path.join(uiDir, name), content);
  }
  const panel = new GatewayPanel({ controller, uiDir });
  await panel.start({ port: 0 });
  const result = { dir, file, document, config, backend, gateway, policy, controller, controllerOptions, panel, calls };
  fixtures.push(result);
  return result;
}

function api(f, route, body, options = {}) {
  return fetch(f.panel.url + route, { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    ...options, headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
}

function raw(f, { route = '/api/state', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(f.panel.url + route, { method, headers }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function complete(f) {
  await f.controller.operationTask;
  return (await f.controller.state()).operation;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel.stop();
    await f.controller.close();
    await f.gateway.stop();
    f.policy.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('panel binds loopback, serves only its assets and requires a separate API key', async () => {
  const f = await fixture();
  expect(f.panel.server.address().address).toBe('127.0.0.1');
  expect(f.panel.entryURL).toBe(f.panel.url + '/#key=' + f.panel.key);
  const page = await fetch(f.panel.url + '/');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('Panel fixture');
  expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(page.headers.get('x-frame-options')).toBe('DENY');
  expect(page.headers.get('cache-control')).toBe('no-store');
  for (const route of ['/app.js', '/styles.css']) expect((await fetch(f.panel.url + route)).status).toBe(200);
  expect((await fetch(f.panel.url + '/src/panel.mjs')).status).toBe(404);
  expect((await fetch(f.panel.url + '/api/state')).status).toBe(401);
  expect((await api(f, '/api/state', undefined, { headers: { Authorization: 'Bearer ' + TOKEN } })).status).toBe(401);
  expect((await api(f, '/api/state')).status).toBe(200);
});

test('panel refuses DNS rebinding, foreign origins, cross-site requests and JSON-less writes', async () => {
  const f = await fixture();
  const auth = { Authorization: 'Bearer ' + f.panel.key };
  for (const headers of [{ ...auth, Host: 'evil.example' }, { ...auth, Origin: 'https://evil.example' },
    { ...auth, 'Sec-Fetch-Site': 'cross-site' }]) {
    expect((await raw(f, { headers })).status).toBe(403);
  }
  expect((await raw(f, { route: '/api/subagents', method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
  expect((await api(f, '/api/subagents', {}, { headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  expect((await api(f, '/api/subagents', undefined, { method: 'OPTIONS' })).status).toBe(405);
  const large = await api(f, '/api/subagents', { padding: 'x'.repeat(33000) });
  expect(large.status).toBe(413);
  const broken = await api(f, '/api/subagents', {}, { body: '{broken' });
  expect(broken.status).toBe(400);
  expect((await broken.json()).error.code).toBe('invalid_json');
  const inference = await fetch(f.gateway.url + '/responses', { method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, Origin: f.panel.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: CHILD, input: 'hello' }) });
  expect(inference.status).toBe(403);
});

test('state reports actual selection and runtime evidence without credentials or internal paths', async () => {
  const f = await fixture({ runtime: { inspect: () => ({ state: 'loaded', version: '3.2.21', mode: 'inherit',
    pid: 4242, bundleDir: '/private/bundle', secret: KEY,
    lastSpawn: { modelAlias: 'byok-kth-kimi/kimi-test-parent', at: 100, secret: TOKEN } }) } });
  const response = await api(f, '/api/state');
  const text = await response.text();
  const state = JSON.parse(text);
  expect(state.schemaVersion).toBe(1);
  expect(state.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(state.configuration).toEqual({ state: 'ready', file: 'gateway.json' });
  expect(state.gateway).toEqual({ state: 'running', url: f.gateway.url, modelCount: 3, activeRequests: 0 });
  expect(state.models.map(row => row.id)).toEqual(MODELS.map(row => row.id));
  expect(state.subagents.configured).toEqual({ mode: 'inherit' });
  expect(state.subagents.policy).toEqual({ mode: 'inherit' });
  expect(state.subagents.runtime.lastSpawn).toEqual({ modelAlias: 'byok-kth-kimi/kimi-test-parent', at: 100 });
  expect(state.connection.active.upstream.apiKeyEnv).toBe('PANEL_TEST_KEY');
  expect(state.connection.environment).toEqual({ apiKeySet: false, tokenSet: false });
  for (const hidden of [KEY, TOKEN, f.panel.key, '/private/bundle', f.dir, f.policy.ownerID]) expect(text).not.toContain(hidden);
});

test('apply persists force model and effort, updates live policy, and survives a restart', async () => {
  const f = await fixture();
  const before = await f.controller.state();
  const response = await api(f, '/api/subagents', { revision: before.revision, mode: 'force', model: CHILD, effort: 'low' });
  expect(response.status).toBe(200);
  const { state } = await response.json();
  const selected = { mode: 'force', model: CHILD, modelAlias: 'byok-kth-resp/' + CHILD, effort: 'low' };
  expect(state.subagents.policy).toEqual(selected);
  expect(state.subagents.runtime.state).toBe('not-prepared');
  expect(readSubagentJSON(f.file).retained).toEqual(f.document.retained);
  expect(readSubagentJSON(f.policy.file)).toMatchObject(selected);
  expect(state.revision).not.toBe(before.revision);
  const stored = readConfig(readSubagentJSON(f.file));
  const nextPolicy = new SubagentPolicy({ stateDir: f.dir, kimiDir: path.join(f.dir, 'kimi') });
  nextPolicy.configure(stored.subagents, f.backend.models);
  const restarted = new PanelController({ ...f.controllerOptions, config: stored, policy: nextPolicy });
  try {
    expect((await restarted.state()).subagents.configured).toEqual(selected);
    const inherited = await restarted.apply({ revision: state.revision, mode: 'inherit' });
    expect(inherited.subagents.policy).toEqual({ mode: 'inherit' });
    expect(readSubagentJSON(f.file).subagents).toEqual({ mode: 'inherit' });
  } finally { await restarted.close(); nextPolicy.close(); }
});

test('concurrent selections have one winner and stale drafts cannot overwrite the winner', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const responses = await Promise.all(['low', 'high'].map(effort => api(f, '/api/subagents', { revision, mode: 'force', model: CHILD, effort })));
  expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
  const rejected = await responses.find(row => row.status === 409).json();
  expect(rejected.error.code).toBe('configuration_conflict');
  const saved = readSubagentJSON(f.file);
  expect((await f.controller.state()).subagents.policy.effort).toBe(saved.subagents.effort);
});

test('invalid models and efforts do not change configuration or policy', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const before = fs.readFileSync(f.file, 'utf8');
  for (const [input, code] of [[{ mode: 'force', model: 'missing' }, 'subagent_model_unavailable'],
    [{ mode: 'force', model: 'no-tools' }, 'subagent_model_tools_required'],
    [{ mode: 'force', model: CHILD, effort: 'xhigh' }, 'invalid_subagent_effort'], [{ mode: 'other' }, 'invalid_subagent_policy']]) {
    const response = await api(f, '/api/subagents', { revision, ...input });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(code);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect(readSubagentJSON(f.policy.file).mode).toBe('inherit');
  }
});

test('external base configuration changes require restart and are never overwritten', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  writeSubagentJSON(f.file, { ...f.document, port: 43521 });
  expect((await f.controller.state()).configuration.state).toBe('changed');
  const response = await api(f, '/api/subagents', { revision, mode: 'inherit' });
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('configuration_changed');
  expect(readSubagentJSON(f.file).port).toBe(43521);
});

test('null effort uses the model default without persisting a null value', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const state = await f.controller.apply({ revision, mode: 'force', model: CHILD, effort: null });
  expect(readSubagentJSON(f.file).subagents).toEqual({ mode: 'force', model: CHILD });
  expect(state.subagents.policy.effort).toBe('high');
});

test('removing the configured selection externally is shown separately from the live policy', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  await f.controller.apply({ revision, mode: 'force', model: CHILD });
  writeSubagentJSON(f.file, f.document);
  const state = await f.controller.state();
  expect(state.configuration.state).toBe('ready');
  expect(state.subagents.configured).toEqual({ mode: 'inherit' });
  expect(state.subagents.policy.mode).toBe('force');
});

test('malformed configuration and policy files are reported and left intact', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  fs.writeFileSync(f.file, '{bad');
  expect((await f.controller.state()).configuration.state).toBe('unavailable');
  expect((await api(f, '/api/subagents', { revision, mode: 'inherit' })).status).toBe(409);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('{bad');
  fs.writeFileSync(f.file, JSON.stringify(f.document));
  const policy = readSubagentJSON(f.policy.file);
  writeSubagentJSON(f.policy.file, { ...policy, revision: '0'.repeat(64) });
  expect((await f.controller.state()).subagents.policy).toEqual({ mode: 'blocked', reason: 'subagent_policy_unavailable' });
  expect((await api(f, '/api/subagents', { revision, mode: 'force', model: CHILD })).status).toBe(409);
  expect(readSubagentJSON(f.file).subagents).toBeUndefined();
  expect(readSubagentJSON(f.policy.file).revision).toBe('0'.repeat(64));
});

test('policy validation observes the exact stored mode and alias before reporting a selection', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const inherited = readSubagentJSON(f.policy.file);
  const missingMode = { ...inherited };
  delete missingMode.mode;
  writeSubagentJSON(f.policy.file, missingMode);
  expect((await f.controller.state()).subagents.policy.reason).toBe('subagent_policy_unavailable');
  expect((await api(f, '/api/subagents', { revision, mode: 'inherit' })).status).toBe(409);
  writeSubagentJSON(f.policy.file, inherited);
  f.policy.configure({ mode: 'force', model: CHILD }, f.backend.models);
  writeSubagentJSON(f.policy.file, { ...readSubagentJSON(f.policy.file), modelAlias: 'byok-kth-kimi/kimi-test-parent' });
  expect((await f.controller.state()).subagents.policy.reason).toBe('subagent_policy_unavailable');
  expect((await api(f, '/api/actions', intent('launch-kimi'))).status).toBe(409);
  expect(f.calls).toEqual([]);
});

test('a newer owner prevents this panel from modifying policy or launching Kimi', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const replacement = new SubagentPolicy({ stateDir: f.dir, kimiDir: path.join(f.dir, 'kimi') });
  replacement.configure({ mode: 'force', model: CHILD }, f.backend.models);
  const before = fs.readFileSync(f.policy.file, 'utf8');
  expect((await f.controller.state()).subagents.policy.reason).toBe('subagent_policy_owner_conflict');
  expect((await api(f, '/api/subagents', { revision, mode: 'inherit' })).status).toBe(409);
  expect((await api(f, '/api/actions', intent('launch-kimi'))).status).toBe(409);
  expect(fs.readFileSync(f.policy.file, 'utf8')).toBe(before);
  expect(f.calls).toEqual([]);
  replacement.close();
});

test('a saved selection is not reported applied when the policy write fails', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  f.policy.configure = () => { throw Error('subagent_file_conflict'); };
  const response = await api(f, '/api/subagents', { revision, mode: 'force', model: CHILD });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({ code: 'subagent_policy_apply_failed', saved: true });
  expect(readSubagentJSON(f.file).subagents.model).toBe(CHILD);
  expect((await f.controller.state()).subagents.policy.mode).toBe('inherit');
});

test('long operations keep state readable, reject another action, and deduplicate retries', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let count = 0;
  const f = await fixture({ setup: { run: async () => { count++; return waiting; } } });
  const request = intent('prepare-native');
  try {
    expect((await api(f, '/api/actions', request)).status).toBe(202);
    expect((await f.controller.state()).operation.state).toBe('running');
    expect((await api(f, '/api/state')).status).toBe(200);
    expect((await api(f, '/api/actions', request)).status).toBe(202);
    expect(count).toBe(1);
    const busy = await api(f, '/api/actions', intent('remove-dns'));
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe('panel_action_busy');
    finish({ state: 'done' });
    expect((await complete(f)).state).toBe('done');
    expect((await api(f, '/api/actions', request)).status).toBe(202);
    expect(count).toBe(1);
    expect((await api(f, '/api/actions', { ...request, action: 'remove-dns' })).status).toBe(409);
  } finally { finish({ state: 'done' }); }
});

test('prepare, launch, resolver and clipboard use core operations without returning tokens', async () => {
  const f = await fixture();
  for (const action of ['prepare-runtime', 'launch-kimi', 'remove-dns', 'copy-token']) {
    const response = await api(f, '/api/actions', intent(action));
    expect(response.status).toBe(202);
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
    const result = await complete(f);
    expect(result.state).toBe({ 'prepare-runtime': 'prepared', 'launch-kimi': 'waiting-kimi-exit', 'remove-dns': 'done', 'copy-token': 'copied' }[action]);
    expect(JSON.stringify(result)).not.toContain('/private/bundle');
  }
  expect(f.calls.filter(row => row === 'launch')).toHaveLength(1);
  expect(f.calls.find(row => row.request?.action === 'remove-dns').port).toBe(53535);
  expect(f.calls.find(row => row.key === TOKEN)).toBeDefined();
  expect(fs.readFileSync(f.controller.receiptFile, 'utf8')).not.toContain(TOKEN);
});

test('interrupted operations are not replayed after restarting the controller', async () => {
  const f = await fixture();
  const request = intent('launch-kimi');
  writeSubagentJSON(f.controller.receiptFile, { schemaVersion: 1, history: [request] });
  const fresh = new PanelController(f.controllerOptions);
  try {
    expect(await fresh.action(request)).toMatchObject({ state: 'interrupted', id: request.id });
    expect((await fresh.state()).operation.state).toBe('interrupted');
    expect(f.calls).toEqual([]);
    await expect(fresh.action({ ...request, at: Date.now() + 1 })).rejects.toThrow('panel_action_conflict');
    await expect(fresh.action({ ...request, id: crypto.randomUUID(), at: Date.now() - 310000 })).rejects.toThrow('invalid_panel_action');
  } finally { await fresh.close(); }
});

test('action errors are recorded without leaking raw exceptions or replaying', async () => {
  let count = 0;
  const f = await fixture({ copyToken: async () => { count++; throw Error('private failure: ' + KEY); } });
  const request = intent('copy-token');
  await api(f, '/api/actions', request);
  expect(await complete(f)).toMatchObject({ state: 'failed', reason: 'panel_operation_failed' });
  await api(f, '/api/actions', request);
  expect(count).toBe(1);
  expect(JSON.stringify(await f.controller.state())).not.toContain(KEY);
});

test('panel CLI rejects stdin and invalid ports before starting listeners', async () => {
  for (const args of [['panel', '--config', '-'], ['panel', '--config', 'unused', '--ui-port', '-1'],
    ['panel', '--config', 'unused', '--ui-port', '65536']]) {
    const io = capture();
    expect(await run(args, {}, io)).toBe(1);
    expect(io.lines.out).toEqual([]);
  }
});

test('panel CLI serves its delivered UI and live API, then releases both listeners and its policy', async () => {
  const f = await fixture();
  const io = capture();
  let gatewayURL, panelURL;
  const statusFile = path.join(f.dir, 'cli-state', 'status.json');
  const code = await run(['panel', '--config', f.file, '--ui-port', '0', '--state-dir', path.dirname(statusFile), '--kimi-dir', path.join(f.dir, 'cli-kimi')],
    { PANEL_TEST_KEY: KEY, PANEL_TEST_TOKEN: TOKEN }, io, {
      waitForShutdown: async () => {
        const status = readSubagentJSON(statusFile);
        gatewayURL = status.url; panelURL = status.panel.url;
        const entry = io.lines.out.find(line => line.startsWith('panel ')).slice(6);
        const key = new URL(entry).hash.slice(5);
        expect((await fetch(panelURL + '/')).status).toBe(200);
        const state = await fetch(panelURL + '/api/state', { headers: { Authorization: 'Bearer ' + key } });
        expect(state.status).toBe(200);
        const initial = await state.json();
        expect(initial.subagents.policy.mode).toBe('inherit');
        const applied = await fetch(panelURL + '/api/subagents', { method: 'POST',
          headers: { Authorization: 'Bearer ' + key, Origin: panelURL, 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: initial.revision, mode: 'force', model: CHILD, effort: 'high' }) });
        expect(applied.status).toBe(200);
        expect(readSubagentJSON(statusFile).subagents).toMatchObject({ mode: 'force', model: CHILD, effort: 'high' });
        expect(fs.readFileSync(statusFile, 'utf8')).not.toContain(key);
      },
    });
  expect(code).toBe(0);
  expect(io.lines.err).toEqual([]);
  expect(fs.existsSync(statusFile)).toBe(false);
  expect(readSubagentJSON(path.join(path.dirname(statusFile), 'subagent-policy.json')).mode).toBe('inherit');
  for (const url of [gatewayURL + '/models', panelURL + '/']) await expect(fetch(url)).rejects.toThrow();
});

test('a panel port conflict fails cleanly without leaving the gateway listener behind', async () => {
  const f = await fixture();
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const file = path.join(f.dir, 'conflict.json');
  fs.writeFileSync(file, JSON.stringify({ ...f.document, port }));
  const io = capture();
  const stateDir = path.join(f.dir, 'conflict-state');
  expect(await run(['panel', '--config', file, '--ui-port', String(f.panel.server.address().port), '--state-dir', stateDir],
    { PANEL_TEST_KEY: KEY, PANEL_TEST_TOKEN: TOKEN }, io)).toBe(3);
  expect(io.lines.err.join('\n')).toContain('panel_port_unavailable');
  expect(io.lines.out).toEqual([]);
  expect(fs.existsSync(path.join(stateDir, 'status.json'))).toBe(false);
  expect(readSubagentJSON(path.join(stateDir, 'subagent-policy.json')).mode).toBe('inherit');
  const rebound = http.createServer();
  await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => rebound.close(resolve));
});

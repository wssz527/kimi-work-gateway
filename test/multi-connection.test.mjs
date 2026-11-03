import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run as runCLI } from '../cli.mjs';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway, validateModels } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { normalizeSetupInput, readCredentials, saveSetup, setupPaths, setupState, writePrivateJson } from '../src/setup.mjs';
import { SubagentPolicy, readSubagentJSON } from '../src/subagent-policy.mjs';
import { GatewayService } from '../src/service-manager.mjs';

// Two real HTTP servers stand in for two independent providers. Every assertion
// below is made against what each server actually received, so a request that
// was routed to the wrong connection cannot pass by looking right in the panel.
const fixtures = [];
const KEY_A = 'synthetic-connection-a-key';
const KEY_B = 'synthetic-connection-b-key';
const TOKEN = 'a'.repeat(64);
const DEEPSEEK = 'deepseek-v4-1-flash';
const VENDOR = 'vendor/gpt-5';

async function upstream({ models, reply }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: models }));
        return;
      }
      if (reply) return reply(req, res, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ served: req.url, received: JSON.parse(body || '{}').model }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', requests, server };
}

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
}

const intent = action => ({ id: crypto.randomUUID(), at: Date.now(), action });

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.closed?.();
    await f.panel?.stop();
    await f.controller?.close();
    await f.gateway?.stop();
    f.policy?.close();
    if (f.dir) fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// One configuration, two connections, one model each, with colliding upstream
// ids so a route that falls back to the local id would be caught.
function document(a, b) {
  return {
    connections: [
      { id: 'conn-a', name: 'Provider A', providerPresetId: 'deepseek',
        baseURL: a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY', protocols: ['chat', 'responses'] },
      { id: 'conn-b', name: 'Provider B',
        baseURL: b.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_B_KEY' },
    ],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [
      { id: DEEPSEEK, protocol: 'responses', contextWindow: 131072, tools: true, connectionId: 'conn-a',
        upstreamModelId: 'deepseek-chat' },
      // The same upstream id on the other connection keeps its own local route.
      { id: VENDOR, protocol: 'responses', contextWindow: 128000, connectionId: 'conn-b',
        upstreamModelId: 'deepseek-chat' },
      { id: 'kimi-local-chat', protocol: 'chat', contextWindow: 64000, connectionId: 'conn-a' },
    ],
  };
}

async function fixture() {
  const a = await upstream({ models: [{ id: 'deepseek-chat', context_length: 131072,
    supports_tool_call: true, context_window: 131072 }] });
  const b = await upstream({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat',
    context_length: 128000, reasoning_efforts: ['low', 'high'] }] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-connections-'));
  const file = path.join(dir, 'gateway.json');
  const doc = document(a, b);
  fs.writeFileSync(file, JSON.stringify(doc));
  const config = readConfig(doc);
  const backend = new OpenAIBackend({
    connections: config.connections.map(connection => ({ ...connection,
      apiKey: connection.id === 'conn-a' ? KEY_A : KEY_B })),
    models: config.models,
  });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: TOKEN, port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(undefined, backend.models);
  const credentialsFile = path.join(dir, 'credentials.json');
  writePrivateJson(credentialsFile, { schemaVersion: 2, gatewayToken: TOKEN,
    connectionApiKeys: { 'conn-a': KEY_A, 'conn-b': KEY_B } });
  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir,
    kimiDir: path.join(dir, 'kimi'), policy, credentialsFile,
    env: { KIMI_WORK_CONN_A_KEY: KEY_A, KIMI_WORK_CONN_B_KEY: KEY_B, KIMI_WORK_GATEWAY_TOKEN: TOKEN },
    runtime: { inspect: () => ({ state: 'not-prepared' }) }, probe: { check: async () => ({}) },
    inspectContract: () => ({ state: 'verified', version: '3.2.21', accepted: [], skipped: [] }) });
  const panel = new GatewayPanel({ controller });
  await panel.start({ port: 0 });
  const f = { a, b, dir, file, doc, config, backend, gateway, policy, controller, panel, credentialsFile,
    closed: async () => { await close(a.server); await close(b.server); } };
  fixtures.push(f);
  return f;
}

const api = (f, route, body) => fetch(f.panel.url + route, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url, 'Content-Type': 'application/json' },
});

const infer = (f, route, body) => fetch(f.gateway.url + route, {
  method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('two real upstream servers receive their own key and the exact upstream model id', async () => {
  const f = await fixture();
  const first = await infer(f, '/responses', { model: DEEPSEEK, input: 'hello' });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ served: '/v1/responses', received: 'deepseek-chat' });
  expect(f.a.requests).toHaveLength(1);
  expect(f.a.requests[0].authorization).toBe('Bearer ' + KEY_A);
  expect(f.a.requests[0].body).toBe(JSON.stringify({ model: 'deepseek-chat', input: 'hello' }));
  expect(f.b.requests).toHaveLength(0);

  // The second route shares the upstream id but must reach the other server.
  const second = await infer(f, '/responses', { model: VENDOR, input: 'hello' });
  expect(second.status).toBe(200);
  expect(await second.json()).toEqual({ served: '/v1/responses', received: 'deepseek-chat' });
  expect(f.b.requests).toHaveLength(1);
  expect(f.b.requests[0].authorization).toBe('Bearer ' + KEY_B);
  expect(f.a.requests).toHaveLength(1);

  // A route without `upstreamModelId` keeps its own id, on its own endpoint.
  const third = await infer(f, '/chat/completions', { model: 'kimi-local-chat', messages: [] });
  expect(third.status).toBe(200);
  expect(await third.json()).toEqual({ served: '/v1/chat/completions', received: 'kimi-local-chat' });
  expect(f.a.requests).toHaveLength(2);
  expect(f.b.requests).toHaveLength(1);
});

test('catalog rows stay local while each request carries the upstream id', async () => {
  const f = await fixture();
  const catalog = await (await fetch(f.gateway.url + '/models/api.json',
    { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  expect(Object.keys(catalog.responses.models)).toEqual([DEEPSEEK, VENDOR]);
  expect(catalog.kimi.models['kimi-local-chat'].limit.context).toBe(64000);
  const openai = await (await fetch(f.gateway.url + '/models',
    { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  expect(openai.data.map(row => row.id)).toEqual([DEEPSEEK, VENDOR, 'kimi-local-chat']);
  // The catalog is a local view: neither server was asked for it here.
  expect(f.a.requests).toHaveLength(0);
  expect(f.b.requests).toHaveLength(0);
});

test('a model naming a missing connection is refused at config load, not at request time', async () => {
  const a = await upstream({ models: [] });
  fixtures.push({ closed: () => close(a.server) });
  const doc = document(a, a);
  doc.models[0] = { ...doc.models[0], connectionId: 'gone' };
  expect(() => readConfig(doc)).toThrow('invalid_config');
  // A protocol outside the connection's own list is a contradiction, not a
  // silent rewrite of the model's protocol.
  expect(() => readConfig({
    connections: [{ id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', protocols: ['responses'] }],
    models: [{ id: 'kimi-chat', protocol: 'chat', contextWindow: 4096, connectionId: 'conn-a' }],
  })).toThrow('protocol_conflict');
});

test('legacy single-upstream configurations keep their exact behaviour', async () => {
  const app = await upstream({ models: [] });
  fixtures.push({ closed: () => close(app.server) });
  const doc = { upstream: { baseURL: app.baseURL, apiKeyEnv: 'KIMI_WORK_UPSTREAM_KEY' },
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072 }] };
  const config = readConfig(doc);
  expect(config.upstream).toEqual({ baseURL: app.baseURL, apiKeyEnv: 'KIMI_WORK_UPSTREAM_KEY' });
  expect(config.connections).toEqual([]);
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: KEY_A, models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: TOKEN, port: 0 });
  try {
    const response = await fetch(gateway.url + '/responses', { method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: DEEPSEEK, input: 'hi' }) });
    expect(response.status).toBe(200); await response.text();
    // No connectionId -> the legacy endpoint and the model's own id.
    expect(app.requests[0].authorization).toBe('Bearer ' + KEY_A);
    expect(JSON.parse(app.requests[0].body).model).toBe(DEEPSEEK);
  } finally { await gateway.stop(); }
});

test('state lists active and saved connections with restartRequired and never a key', async () => {
  const f = await fixture();
  const response = await api(f, '/api/state');
  const text = await response.text();
  const state = JSON.parse(text);
  expect(state.connections.active.map(row => row.id)).toEqual(['conn-a', 'conn-b']);
  expect(state.connections.saved.map(row => row.id)).toEqual(['conn-a', 'conn-b']);
  expect(state.connections.restartRequired).toBe(false);
  expect(state.connections.active[0]).toMatchObject({ id: 'conn-a', name: 'Provider A', providerPresetId: 'deepseek',
    baseURL: f.a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY', protocols: ['chat', 'responses'], legacy: false,
    modelCount: 2, apiKeySet: true });
  expect(state.connections.active[1]).toMatchObject({ id: 'conn-b', modelCount: 1, apiKeySet: true });
  for (const secret of [KEY_A, KEY_B, TOKEN, f.panel.key]) expect(text).not.toContain(secret);
  expect(text).not.toContain('apiKey"');
});

test('saving a connection set persists it, reports restartRequired and keeps omitted keys', async () => {
  const f = await fixture();
  const initial = await f.controller.state();
  const next = [
    { id: 'conn-a', name: 'Provider A renamed', baseURL: f.a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY',
      protocols: ['chat', 'responses'] },
    { id: 'conn-c', name: 'Provider C', baseURL: 'https://third.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_C_KEY',
      apiKey: 'conn-c-secret' },
  ];
  // conn-b is still referenced by VENDOR, so removing it must be refused.
  const refused = await api(f, '/api/connections', { revision: initial.revision, connections: next });
  expect(refused.status).toBe(409);
  const refusedBody = await refused.json();
  expect(refusedBody.error).toMatchObject({ code: 'connection_in_use', models: [VENDOR] });
  expect(readSubagentJSON(f.file)).toEqual(f.doc);

  const withVendorRemoved = { revision: initial.revision, connections: next,
    models: f.config.models.filter(model => model.connectionId !== 'conn-b') };
  const modelsFirst = await api(f, '/api/models', withVendorRemoved);
  expect(modelsFirst.status).toBe(200);
  const saved = await api(f, '/api/connections', { revision: (await modelsFirst.json()).state.revision, connections: next });
  expect(saved.status).toBe(200);
  const { state } = await saved.json();
  expect(state.connections.saved.map(row => row.id)).toEqual(['conn-a', 'conn-c']);
  expect(state.connections.active.map(row => row.id)).toEqual(['conn-a', 'conn-b']);
  expect(state.connections.restartRequired).toBe(true);
  // The live backend still serves the old endpoints until the restart.
  expect(f.backend.connectionIds).toEqual(['conn-a', 'conn-b']);
  const stored = readSubagentJSON(f.file);
  expect(stored.connections.map(row => row.id)).toEqual(['conn-a', 'conn-c']);
  // The omitted key for conn-a survived, the new key for conn-c was stored.
  const credentials = readCredentials(f.credentialsFile, { requirePrivate: true });
  expect(credentials.connectionApiKeys).toEqual({ 'conn-a': KEY_A, 'conn-b': KEY_B, 'conn-c': 'conn-c-secret' });
  expect(readCredentials(f.credentialsFile).gatewayToken).toBe(TOKEN);
  // Nothing secret reached the panel response.
  expect(JSON.stringify(state)).not.toContain(KEY_A);
  expect(JSON.stringify(state)).not.toContain('conn-c-secret');
});

test('concurrent connection saves under one revision have exactly one winner', async () => {
  const f = await fixture();
  const { revision } = await f.controller.state();
  const models = f.config.models.filter(model => model.connectionId !== 'conn-b');
  await api(f, '/api/models', { revision, models });
  const next = (await f.controller.state()).revision;
  const responses = await Promise.all(['First', 'Second'].map(name => api(f, '/api/connections', {
    revision: next,
    connections: [{ id: 'conn-a', name, baseURL: f.a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' }],
  })));
  expect(responses.map(row => row.status).sort()).toEqual([200, 409]);
  const rejected = await responses.find(row => row.status === 409).json();
  expect(rejected.error.code).toBe('configuration_conflict');
  const stored = readSubagentJSON(f.file).connections;
  expect(stored).toHaveLength(1);
  expect(['First', 'Second']).toContain(stored[0].name);
});

test('discovery reads only the saved connection catalog with structured capabilities and no inference', async () => {
  const f = await fixture();
  const response = await api(f, '/api/discovery', { revision: (await f.controller.state()).revision, connectionId: 'conn-b' });
  expect(response.status).toBe(200);
  const { discovery } = await response.json();
  expect(discovery).toMatchObject({ connectionId: 'conn-b', state: 'passed', source: 'discovery',
    modelCount: 1, httpStatus: 200, sourceURL: f.b.baseURL + '/models' });
  expect(discovery.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // Structured capabilities survive: context_length is normalized, unknown
  // fields are omitted rather than invented. The protocol list is always
  // present and empty here, because this endpoint declared none — that
  // "unknown" is the answer, not a gap to fill in from elsewhere.
  expect(discovery.models).toHaveLength(1);
  expect(discovery.models[0]).toMatchObject({ id: 'deepseek-chat', name: 'DeepSeek Chat',
    contextWindow: 128000, reasoningEfforts: ['low', 'high'] });
  expect(discovery.models[0].protocols).toEqual([]);
  // Per-model provenance travels with the candidate so a saved budget keeps its
  // evidence instead of inheriting whatever the panel happened to hold.
  expect(discovery.models[0].source.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
  expect(discovery.models[0]).not.toHaveProperty('tools');
  expect(discovery.models[0]).not.toHaveProperty('reasoning');
  // Exactly one GET, with that connection's own key, and no inference anywhere.
  expect(f.b.requests).toEqual([{ method: 'GET', url: '/v1/models', authorization: 'Bearer ' + KEY_B, body: '' }]);
  expect(f.a.requests).toHaveLength(0);
  expect(JSON.stringify(discovery)).not.toContain(KEY_B);
});

test('discovery refuses an unknown connection, a concurrent one and reports failures plainly', async () => {
  const f = await fixture();
  const revision = (await f.controller.state()).revision;
  expect((await api(f, '/api/discovery', { revision, connectionId: 'missing' })).status).toBe(409);
  expect((await api(f, '/api/discovery', { revision })).status).toBe(400);
  // A slow upstream keeps the first discovery in flight so the second is refused.
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  f.controller.discoveryFetch = async () => { await pending; throw Object.assign(Error('boom'), { name: 'TypeError' }); };
  const first = api(f, '/api/discovery', { revision, connectionId: 'conn-a' });
  await new Promise(resolve => setTimeout(resolve, 20));
  const busy = await api(f, '/api/discovery', { revision, connectionId: 'conn-a' });
  expect(busy.status).toBe(409);
  expect((await busy.json()).error.code).toBe('discovery_busy');
  release();
  const failed = await (await first).json();
  expect(failed.discovery).toMatchObject({ connectionId: 'conn-a', state: 'failed', reason: 'discovery_unavailable', models: [] });
});

test('a malformed or oversized discovered catalog is reported without leaking its body', async () => {
  const f = await fixture();
  const revision = (await f.controller.state()).revision;
  for (const [reply, reason] of [
    [(_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"private":"' + KEY_A + '"}'); },
      'discovery_invalid_catalog'],
    [(_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(' '.repeat(1024 * 1024 + 1)); }, 'discovery_too_large'],
    [(_req, res) => { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(KEY_A); },
      'discovery_http_error'],
  ]) {
    f.a.server.removeAllListeners('request');
    f.a.server.on('request', (req, res) => { reply(req, res); });
    const { discovery } = await (await api(f, '/api/discovery', { revision, connectionId: 'conn-a' })).json();
    expect(discovery.state).toBe('failed');
    expect(discovery.reason).toBe(reason);
    expect(JSON.stringify(discovery)).not.toContain(KEY_A);
  }
  expect(f.controller.state).toBeDefined();
});

test('CLI starts a connections-only config from the private credentials file and infers through both', async () => {
  const a = await upstream({ models: [] });
  const b = await upstream({ models: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cli-connections-'));
  const stateDir = path.join(dir, 'state');
  const file = path.join(dir, 'gateway.json');
  fixtures.push({ dir, closed: async () => { await close(a.server); await close(b.server); } });
  const doc = document(a, b);
  fs.writeFileSync(file, JSON.stringify(doc));
  const credentialsFile = path.join(dir, 'credentials.json');
  writePrivateJson(credentialsFile, { schemaVersion: 2, gatewayToken: TOKEN,
    connectionApiKeys: { 'conn-a': KEY_A, 'conn-b': KEY_B } });
  const io = capture();
  let gatewayURL;
  const code = await runCLI(['panel', '--config', file, '--state-dir', stateDir, '--kimi-dir', path.join(dir, 'kimi'),
    '--credentials', credentialsFile, '--ui-port', '0', '--no-native'],
  // No upstream or connection key in the environment at all: only the file.
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, {
    waitForShutdown: async () => {
      const status = readSubagentJSON(path.join(stateDir, 'status.json'));
      gatewayURL = status.url;
      for (const [model, key, expected] of [[DEEPSEEK, KEY_A, '/responses'], [VENDOR, KEY_B, '/responses']]) {
        const response = await fetch(gatewayURL + '/responses', { method: 'POST',
          headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: 'ping' }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ served: '/v1/responses', received: 'deepseek-chat' });
        const received = (expected === '/responses' ? (model === DEEPSEEK ? a : b) : null);
        expect(received.requests.at(-1).authorization).toBe('Bearer ' + key);
      }
    },
  });
  expect(io.lines.err).toEqual([]);
  expect(code).toBe(0);
  expect(io.lines.out.join('\n')).not.toContain(KEY_A);
  expect(io.lines.out.join('\n')).not.toContain(KEY_B);
  expect(fs.existsSync(path.join(stateDir, 'status.json'))).toBe(false);
});

test('CLI names the exact missing connection variable instead of demanding a legacy key', async () => {
  const a = await upstream({ models: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-cli-missing-'));
  fixtures.push({ dir, closed: () => close(a.server) });
  const file = path.join(dir, 'gateway.json');
  const doc = document(a, a);
  // conn-b points at a server that does not need to exist for this check.
  fs.writeFileSync(file, JSON.stringify({ ...doc, connections: [doc.connections[0]] ,
    models: doc.models.filter(model => model.connectionId === 'conn-a') }));
  const io = capture();
  const code = await runCLI(['panel', '--config', file, '--state-dir', path.join(dir, 'state'),
    '--kimi-dir', path.join(dir, 'kimi'), '--ui-port', '0', '--no-native'],
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, { waitForShutdown: async () => {} });
  expect(code).toBe(2);
  expect(io.lines.err.join('\n')).toContain('KIMI_WORK_CONN_A_KEY');
  expect(io.lines.err.join('\n')).not.toContain('KIMI_WORK_UPSTREAM_KEY');
  expect(io.lines.out).toEqual([]);
});

test('setup first run saves connections-only with per-connection keys and reports no secret', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-setup-connections-'));
  fixtures.push({ dir, closed: async () => {} });
  const paths = setupPaths({ stateDir: path.join(dir, 'state') });
  const { config, connectionApiKeys } = normalizeSetupInput({
    connections: [
      { id: 'conn-a', name: 'Provider A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY',
        protocols: ['responses'], apiKey: KEY_A },
      { id: 'conn-b', name: 'Provider B', baseURL: 'https://b.example/v1', apiKey: KEY_B },
    ],
    models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072, connectionId: 'conn-a',
      upstreamModelId: 'deepseek-chat' }],
    port: 3426, dns: false,
  });
  // No legacy upstream was invented for a connections-only save.
  expect(config.upstream).toBeUndefined();
  expect(config.connections.map(row => row.id)).toEqual(['conn-a', 'conn-b']);
  expect(connectionApiKeys).toEqual({ 'conn-a': KEY_A, 'conn-b': KEY_B });
  const saved = saveSetup({ paths, config, connectionApiKeys });
  expect(saved.credentials.connectionApiKeys).toEqual({ 'conn-a': KEY_A, 'conn-b': KEY_B });
  expect(readCredentials(paths.credentials, { requirePrivate: true }).gatewayToken).toMatch(/^[a-f0-9]{64}$/);
  const state = setupState({ paths });
  expect(state.configured).toBe(true);
  expect(state.connections).toEqual([
    { id: 'conn-a', name: 'Provider A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY',
      protocols: ['responses'], apiKeySet: true },
    { id: 'conn-b', name: 'Provider B', baseURL: 'https://b.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_B_KEY',
      apiKeySet: true },
  ]);
  expect(JSON.stringify(state)).not.toContain(KEY_A);
  expect(JSON.stringify(state)).not.toContain(KEY_B);
  // The legacy single-upstream payload still works and keeps its own shape.
  const legacy = normalizeSetupInput({ baseURL: 'https://legacy.example/v1', apiKey: KEY_A,
    models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072 }] });
  expect(legacy.config.upstream).toEqual({ baseURL: 'https://legacy.example/v1', apiKeyEnv: 'KIMI_WORK_UPSTREAM_KEY' });
  expect(legacy.config.connections).toBeUndefined();
  expect(legacy.connectionApiKeys).toEqual({});
  // A second save that omits a connection key keeps the stored one.
  const { config: again } = normalizeSetupInput({ connections: [
    { id: 'conn-a', name: 'Provider A', baseURL: 'https://a.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' },
    { id: 'conn-b', name: 'Provider B', baseURL: 'https://b.example/v1' }],
  models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072, connectionId: 'conn-a' }], dns: false });
  saveSetup({ paths, config: again });
  expect(readCredentials(paths.credentials).connectionApiKeys).toEqual({ 'conn-a': KEY_A, 'conn-b': KEY_B });
});

test('protocol and connection constraints are enforced, never silently converted', async () => {
  // The local id still decides the family; a connection that cannot speak that
  // protocol is a conflict rather than a rewrite to the other one.
  expect(() => readConfig({
    connections: [{ id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1', protocols: ['responses'] }],
    models: [{ id: 'kimi-chat', protocol: 'chat', contextWindow: 4096, connectionId: 'conn-a' }],
  })).toThrow('protocol_conflict');
  expect(() => validateModels([{ id: DEEPSEEK, protocol: 'chat', contextWindow: 4096 }])).toThrow('protocol_conflict');
  // Connection ids are unique and cannot be duplicated to shadow one another.
  expect(() => readConfig({
    connections: [{ id: 'conn-a', name: 'A', baseURL: 'https://a.example/v1' },
      { id: 'conn-a', name: 'B', baseURL: 'https://b.example/v1' }],
    models: [],
  })).toThrow('invalid_config');
  // Every model keeps its local id in the catalog even when two share an upstream id.
  const models = validateModels([
    { id: DEEPSEEK, protocol: 'responses', contextWindow: 4096, connectionId: 'conn-a', upstreamModelId: 'shared' },
    { id: VENDOR, protocol: 'responses', contextWindow: 4096, connectionId: 'conn-b', upstreamModelId: 'shared' },
  ]);
  expect(models.map(row => row.id)).toEqual([DEEPSEEK, VENDOR]);
  expect(models.map(row => row.upstreamModelId)).toEqual(['shared', 'shared']);
  // A duplicate local route id is still refused, because Kimi routes by it.
  expect(() => validateModels([
    { id: DEEPSEEK, protocol: 'responses', contextWindow: 4096, connectionId: 'conn-a' },
    { id: DEEPSEEK, protocol: 'responses', contextWindow: 4096, connectionId: 'conn-b' },
  ])).toThrow('invalid_models');
});

test('a catalog cannot be saved against a connection the file no longer has', async () => {
  const f = await fixture();
  const current = await f.controller.state();
  const models = f.config.models.map(model => model.id === VENDOR
    ? { ...model, connectionId: 'conn-missing' } : model);
  const response = await api(f, '/api/models', { revision: current.revision, models });
  expect(response.status).toBe(409);
  expect((await response.json()).error).toMatchObject({ code: 'connection_unavailable', models: [VENDOR] });
  expect(readSubagentJSON(f.file)).toEqual(f.doc);
  expect(f.backend.connectionIds).toEqual(['conn-a', 'conn-b']);
});

test('discovery needs a connection that is actually saved, not a live endpoint alone', async () => {
  const f = await fixture();
  // conn-b is live but not referenced by any remaining model after its removal
  // from the file; discovery reads the saved file, so it must still resolve it
  // from there and never from the running backend's endpoint map.
  const current = await f.controller.state();
  const models = f.config.models.filter(model => model.connectionId !== 'conn-b');
  const saved = await api(f, '/api/models', { revision: current.revision, models });
  expect(saved.status).toBe(200);
  const next = await api(f, '/api/connections', { revision: (await saved.json()).state.revision,
    connections: [f.doc.connections[0], f.doc.connections[1]] });
  expect(next.status).toBe(200);
  const { discovery } = await (await api(f, '/api/discovery',
    { revision: (await f.controller.state()).revision, connectionId: 'conn-b' })).json();
  expect(discovery).toMatchObject({ connectionId: 'conn-b', state: 'passed', source: 'discovery' });
  expect(f.b.requests.at(-1).authorization).toBe('Bearer ' + KEY_B);
});

// The service and the gateway must agree on which configuration is startable.
// A connection no model uses is allowed to have no key: it stays saved and
// simply cannot serve until a key is added. What must never happen is install
// succeeding and the spawned process dying at backend construction.
test('a service installs and starts with an unused keyless connection, and the routed one still serves', async () => {
  const a = await upstream({ models: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-service-connections-'));
  fixtures.push({ dir, closed: () => close(a.server) });
  const file = path.join(dir, 'gateway.json');
  const document = {
    connections: [
      { id: 'conn-a', name: 'Provider A', baseURL: a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' },
      // Saved but unused, and deliberately without a key.
      { id: 'conn-b', name: 'Provider B', baseURL: 'https://b.example/v1', apiKeyEnv: 'KIMI_WORK_CONN_B_KEY' },
    ],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072, connectionId: 'conn-a',
      upstreamModelId: 'deepseek-chat' }],
  };
  fs.writeFileSync(file, JSON.stringify(document));
  const credentialsFile = path.join(dir, 'credentials.json');
  writePrivateJson(credentialsFile, { schemaVersion: 2, gatewayToken: TOKEN,
    connectionApiKeys: { 'conn-a': KEY_A } });

  // The service preflight and install plan accept this state: no shell
  // environment, only the private file, and no key for the unused connection.
  const service = new GatewayService({ home: dir, stateDir: path.join(dir, 'service-state'), configPath: file,
    credentialsFile, platform: 'linux', env: {}, uid: process.getuid?.() ?? 0,
    launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
    runner: () => ({ code: 0, stdout: '', stderr: '' }) });
  expect(service.preflight()).toEqual({ models: 1 });

  // The same state must actually boot. No native, no network beyond the local
  // fixture upstream, and no key in the environment at all.
  const io = capture();
  let gatewayURL;
  const code = await runCLI(['panel', '--config', file, '--state-dir', path.join(dir, 'run-state'),
    '--kimi-dir', path.join(dir, 'kimi'), '--credentials', credentialsFile, '--ui-port', '0', '--no-native'],
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, {
    waitForShutdown: async () => {
      gatewayURL = readSubagentJSON(path.join(dir, 'run-state', 'status.json')).url;
      const response = await fetch(gatewayURL + '/responses', { method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: DEEPSEEK, input: 'ping' }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ served: '/v1/responses', received: 'deepseek-chat' });
      expect(a.requests.at(-1).authorization).toBe('Bearer ' + KEY_A);
      expect(JSON.parse(a.requests.at(-1).body)).toEqual({ model: 'deepseek-chat', input: 'ping' });
    },
  });
  expect(io.lines.err).toEqual([]);
  expect(code).toBe(0);
  // The unused keyless connection remains saved exactly as written.
  expect(readSubagentJSON(file).connections.map(row => row.id)).toEqual(['conn-a', 'conn-b']);
  expect(readCredentials(credentialsFile, { requirePrivate: true }).connectionApiKeys).toEqual({ 'conn-a': KEY_A });
});

test('a model routed to a keyless connection still stops startup with the exact variable name', async () => {
  const a = await upstream({ models: [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-keyless-routed-'));
  fixtures.push({ dir, closed: () => close(a.server) });
  const file = path.join(dir, 'gateway.json');
  fs.writeFileSync(file, JSON.stringify({
    connections: [{ id: 'conn-a', name: 'Provider A', baseURL: a.baseURL, apiKeyEnv: 'KIMI_WORK_CONN_A_KEY' }],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [{ id: DEEPSEEK, protocol: 'responses', contextWindow: 131072, connectionId: 'conn-a' }],
  }));
  const io = capture();
  const code = await runCLI(['panel', '--config', file, '--state-dir', path.join(dir, 'state'),
    '--kimi-dir', path.join(dir, 'kimi'), '--ui-port', '0', '--no-native'],
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, { waitForShutdown: async () => {} });
  // Refused up front rather than silently starting without that route.
  expect(code).toBe(2);
  expect(io.lines.err.join('\n')).toContain('KIMI_WORK_CONN_A_KEY');
  expect(io.lines.out).toEqual([]);
  expect(a.requests).toHaveLength(0);
});

// check-upstream 按行检查：connectionId 命中哪个已配置连接就探测哪个端点，
// 结果带回同一个 id；legacy 单上游显式用 null（省略字段），绝不按模型数量
// 或列表顺序隐式挑选。
test('check-upstream probes the named configured connection and reports its id', async () => {
  const f = await fixture();
  const request = (connectionId) => ({ ...intent('check-upstream'),
    ...(connectionId === undefined ? {} : { connectionId }) });

  const named = await api(f, '/api/actions', request('conn-b'));
  expect(named.status).toBe(202);
  await f.controller.operationTask;
  let op = (await f.controller.state()).operation;
  expect(op).toMatchObject({ state: 'passed', connectionId: 'conn-b' });
  expect(op.modelCount).toBe(1);
  expect(JSON.stringify(op)).not.toContain(KEY_B);
  expect(f.b.requests.at(-1)).toEqual({ method: 'GET', url: '/v1/models',
    authorization: 'Bearer ' + KEY_B, body: '' });
  expect(f.a.requests).toHaveLength(0);

  // A second row: exactly one probe lands on the right server.
  await api(f, '/api/actions', request('conn-a'));
  await f.controller.operationTask;
  op = (await f.controller.state()).operation;
  expect(op).toMatchObject({ state: 'passed', connectionId: 'conn-a' });
  expect(f.a.requests.at(-1).authorization).toBe('Bearer ' + KEY_A);
  expect(f.b.requests).toHaveLength(1);

  // The legacy upstream is reached by omitting the field, not by guessing.
  const legacy = await api(f, '/api/actions', request());
  expect(legacy.status).toBe(409);
  expect((await legacy.json()).error.code).toBe('connection_unavailable');

  // An id that is not configured is refused instead of silently re-routing.
  const missing = await api(f, '/api/actions', request('conn-z'));
  expect(missing.status).toBe(409);
  const missingBody = await missing.json();
  expect(missingBody.error.code).toBe('connection_unavailable');
  expect(missingBody.error.message).not.toContain(KEY_B);
});

test('a replayed check-upstream id with a different connection is a conflict, not a rerun', async () => {
  const f = await fixture();
  const shared = intent('check-upstream');
  const first = await api(f, '/api/actions', { ...shared, connectionId: 'conn-a' });
  expect(first.status).toBe(202);
  await f.controller.operationTask;
  const probesAfterFirst = f.a.requests.length + f.b.requests.length;

  // Same id, same payload: the recorded result is returned, no new request.
  const replay = await api(f, '/api/actions', { ...shared, connectionId: 'conn-a' });
  expect(replay.status).toBe(202);
  const replayed = (await replay.json()).operation;
  expect(replayed).toMatchObject({ state: 'passed', connectionId: 'conn-a' });
  expect(f.a.requests.length + f.b.requests.length).toBe(probesAfterFirst);

  // Same id, different connection: refused, and nothing is probed.
  const conflict = await api(f, '/api/actions', { ...shared, connectionId: 'conn-b' });
  expect(conflict.status).toBe(409);
  expect((await conflict.json()).error.code).toBe('panel_action_conflict');
  expect(f.a.requests.length + f.b.requests.length).toBe(probesAfterFirst);

  // Same id without the field is equally a different payload.
  const dropped = await api(f, '/api/actions', shared);
  expect(dropped.status).toBe(409);
  expect(f.a.requests.length + f.b.requests.length).toBe(probesAfterFirst);
});

// state.service 只做只读判定：service.json 与本配置匹配才报 service 模式，
// 页面据此展示 service restart/status 找回入口；没有安装记录时为 null，
// 前台 Ctrl+C 文案保留。这里从不执行系统服务命令，也不暴露凭据或入口链接。
test('state.service names the background service only for a matching record', async () => {
  const f = await fixture();
  expect((await f.controller.state()).service).toBeNull();

  const service = new GatewayService({ home: f.dir, stateDir: f.dir, configPath: f.file,
    credentialsFile: f.credentialsFile, platform: 'linux', env: {},
    launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
    runner: () => ({ code: 1, stdout: '', stderr: '' }) });
  // No record yet: nothing to claim.
  expect((await f.controller.state()).service).toBeNull();

  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(path.join(f.dir, 'service.json'), JSON.stringify({
    schemaVersion: 1, label: 'dev.kimi-work-gateway', platform: 'linux',
    launcher: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs', node: process.execPath,
    config: f.file, credentials: f.credentialsFile, entry: path.join(f.dir, 'panel-entry.json'),
    log: path.join(f.dir, 'service.log'), panelPort: 3427, environment: [], version: '0.9.0',
    installedAt: new Date().toISOString() }));
  // A live runner makes the panel child observable; only its bounded fields
  // reach the page.
  f.controller.service = { record: () => service.record(), runnerState: () => ({ state: 'running', pid: 4242 }) };
  const withService = await f.controller.state();
  expect(withService.service).toEqual({ mode: 'service', label: 'dev.kimi-work-gateway',
    config: f.file, log: path.join(f.dir, 'service.log'), pid: 4242 });
  expect(JSON.stringify(withService.service)).not.toContain(TOKEN);
  expect(JSON.stringify(withService.service)).not.toContain('panel-entry');

  // A record naming another config must not be adopted for this process.
  fs.writeFileSync(path.join(f.dir, 'service.json'), JSON.stringify({
    schemaVersion: 1, label: 'dev.kimi-work-gateway', platform: 'linux',
    launcher: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs', node: process.execPath,
    config: path.join(f.dir, 'other-gateway.json'), credentials: f.credentialsFile,
    entry: path.join(f.dir, 'panel-entry.json'), log: path.join(f.dir, 'service.log'),
    panelPort: 3427, environment: [], version: '0.9.0', installedAt: new Date().toISOString() }));
  expect((await f.controller.state()).service).toEqual({ mode: 'unrecognized' });
});

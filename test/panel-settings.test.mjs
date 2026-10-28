import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { readSubagentJSON, SubagentPolicy, writeSubagentJSON } from '../src/subagent-policy.mjs';

const fixtures = [];
const KEY = 'synthetic-upstream-secret';
const TOKEN = 'synthetic-gateway-secret';
const CHILD = 'group/vision-model';
const model = () => ({ id: CHILD, protocol: 'responses', contextWindow: 128000,
  tools: true, reasoning: true, reasoningEfforts: ['low', 'high'], defaultEffort: 'high' });
const intent = action => ({ id: crypto.randomUUID(), at: Date.now(), action });

async function fixture({ upstreamReply, inspectContract } = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: req.url, method: req.method, body, authorization: req.headers.authorization });
    if (upstreamReply) return upstreamReply(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.method === 'GET' ? JSON.stringify({ data: [{ id: CHILD }] }) : JSON.stringify({ output: 'synthetic reply' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-settings-'));
  const file = path.join(dir, 'gateway.json');
  const document = { upstream: { baseURL: 'http://127.0.0.1:' + upstream.address().port + '/v1', apiKeyEnv: 'UPSTREAM_TEST_KEY', retained: true },
    tokenEnv: 'GATEWAY_TEST_KEY', port: 0, dns: { enabled: false, port: 53535, retained: true },
    models: [{ ...model(), retained: { label: 'keep model metadata' } }], retained: true };
  writeSubagentJSON(file, document);
  const config = readConfig(document);
  const backend = new OpenAIBackend({ baseURL: config.upstream.baseURL, apiKey: KEY, models: config.models });
  const gateway = new KimiWorkGateway({ backend, recordRequests: true });
  await gateway.configure({ key: TOKEN, port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(undefined, backend.models);
  const controller = new PanelController({ configFile: file, config, backend, gateway, stateDir: dir, kimiDir: path.join(dir, 'kimi'), policy,
    env: { UPSTREAM_TEST_KEY: KEY, GATEWAY_TEST_KEY: TOKEN },
    runtime: { inspect: () => ({ state: 'not-prepared' }) }, probe: { check: async () => ({}) },
    inspectContract: inspectContract || (() => ({ state: 'verified', version: '3.2.21', accepted: [CHILD], skipped: [] })) });
  const panel = new GatewayPanel({ controller });
  await panel.start({ port: 0 });
  const f = { dir, file, document, config, backend, gateway, policy, controller, panel, upstream, requests };
  fixtures.push(f);
  return f;
}

const api = (f, route, body, headers = {}) => fetch(f.panel.url + route, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url, 'Content-Type': 'application/json', ...headers },
});
const infer = (f, body) => fetch(f.gateway.url + '/responses', {
  method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const revision = async f => (await f.controller.state()).revision;

async function action(f, name) {
  const request = intent(name);
  expect((await api(f, '/api/actions', request)).status).toBe(202);
  await f.controller.operationTask;
  return { request, state: await f.controller.state() };
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel.stop(); await f.controller.close(); await f.gateway.stop();
    f.policy.close(); f.upstream.closeAllConnections?.();
    await new Promise(resolve => f.upstream.close(resolve));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('model editing updates the native catalog, custom reasoning selection and image request forwarding end to end', async () => {
  const f = await fixture();
  const updated = { ...model(), name: 'Vision custom', inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'balanced'], defaultEffort: 'balanced', maxOutputTokens: 8192 };
  const response = await api(f, '/api/models', { revision: await revision(f), models: [updated] });
  expect(response.status).toBe(200);
  const { state } = await response.json();
  expect(state.configuration.state).toBe('ready');
  expect(state.models[0]).toEqual(updated);
  const saved = readSubagentJSON(f.file);
  expect(saved.retained).toBe(true);
  expect(saved.models[0].retained).toEqual({ label: 'keep model metadata' });
  const catalog = await (await fetch(f.gateway.url + '/models/api.json', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  expect(catalog.responses.models[CHILD].modalities.input).toEqual(['text', 'image']);
  expect(catalog.responses.models[CHILD].support_efforts).toContain('balanced');
  const child = await api(f, '/api/subagents', { revision: state.revision, mode: 'force', model: CHILD, effort: 'balanced' });
  expect(child.status).toBe(200);
  expect((await child.json()).state.subagents.policy.effort).toBe('balanced');
  const input = [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,synthetic-image' }] }];
  const result = await infer(f, { model: 'byok-kth-resp/' + CHILD, input, reasoning: { effort: 'balanced' } });
  expect(result.status).toBe(200); await result.text();
  const forwarded = JSON.parse(f.requests.at(-1).body);
  expect(forwarded).toEqual({ model: CHILD, input, reasoning: { effort: 'balanced' } });
  expect((await f.controller.state()).metrics).toMatchObject({ requests: 1, failures: 0,
    recent: [{ model: CHILD, protocol: 'responses', status: 200 }] });
  expect(JSON.stringify((await f.controller.state()).metrics)).not.toContain('synthetic-image');
});

test('catalog changes protect the active child and preserve the previous configuration on validation failure', async () => {
  const f = await fixture();
  await f.controller.apply({ revision: await revision(f), mode: 'force', model: CHILD, effort: 'low' });
  const before = fs.readFileSync(f.file, 'utf8');
  for (const models of [[], [{ ...model(), tools: false }], [{ ...model(), reasoningEfforts: ['high'] }]]) {
    const response = await api(f, '/api/models', { revision: await revision(f), models });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('subagent_model_in_use');
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  }
  for (const invalid of [{ ...model(), protocol: 'chat' }, { ...model(), reasoningEfforts: ['HIGH'] },
    { ...model(), reasoning: false }, { ...model(), inputModalities: ['image'] }]) {
    const response = await api(f, '/api/models', { revision: await revision(f), models: [invalid] });
    expect(response.status).toBe(400);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  }
  await f.controller.apply({ revision: await revision(f), mode: 'inherit' });
  expect((await api(f, '/api/models', { revision: await revision(f), models: [] })).status).toBe(200);
  expect(f.backend.models).toEqual([]);
});

test('catalog revisions prevent simultaneous overwrite, foreign ownership and untrusted browser writes', async () => {
  const f = await fixture();
  const rev = await revision(f);
  const writes = await Promise.all(['One', 'Two'].map(name => api(f, '/api/models', { revision: rev, models: [{ ...model(), name }] })));
  expect(writes.map(row => row.status).sort()).toEqual([200, 409]);
  const replacement = new SubagentPolicy({ stateDir: f.dir, kimiDir: path.join(f.dir, 'kimi') });
  replacement.configure(undefined, f.backend.models);
  expect((await api(f, '/api/models', { revision: await revision(f), models: [] })).status).toBe(409);
  for (const route of ['/api/models', '/api/connection']) {
    expect((await api(f, route, {}, { Authorization: 'Bearer ' + TOKEN })).status).toBe(401);
    expect((await api(f, route, {}, { Origin: 'https://foreign.example' })).status).toBe(403);
  }
  replacement.close();
});

test('connection changes save only variable references and explicitly wait for restart with a reversible pending draft', async () => {
  const f = await fixture();
  const initial = await f.controller.state();
  expect(initial.connection.environment).toEqual({ apiKeySet: true, tokenSet: true });
  const input = { ...initial.connection.active, upstream: { baseURL: 'https://upstream.example/v1/', apiKeyEnv: 'NEW_UPSTREAM_KEY' }, port: 4444 };
  const response = await api(f, '/api/connection', { revision: initial.revision, ...input });
  expect(response.status).toBe(200);
  const { state } = await response.json();
  expect(state.configuration.state).toBe('changed');
  expect(state.connection.active).toEqual(initial.connection.active);
  expect(state.connection.saved.upstream.baseURL).toBe('https://upstream.example/v1');
  expect(state.connection.environment.apiKeySet).toBe(false);
  expect(readSubagentJSON(f.file).upstream.retained).toBe(true);
  expect(readSubagentJSON(f.file).dns.retained).toBe(true);
  expect(f.backend.baseURL).toBe(initial.connection.active.upstream.baseURL);
  expect((await api(f, '/api/models', { revision: state.revision, models: [model()] })).status).toBe(409);
  const restored = await api(f, '/api/connection', { revision: state.revision, ...initial.connection.active });
  expect((await restored.json()).state.configuration.state).toBe('ready');
  for (const secret of [KEY, TOKEN, f.panel.key]) expect(JSON.stringify(state)).not.toContain(secret);
});

test('invalid connection writes and externally injected credential URLs cannot expose or overwrite secrets', async () => {
  const f = await fixture();
  const initial = await f.controller.state();
  for (const change of [{ upstream: { baseURL: 'https://user:password@api.example/v1', apiKeyEnv: 'UPSTREAM_KEY' } },
    { upstream: { baseURL: 'http://remote.example/v1', apiKeyEnv: 'UPSTREAM_KEY' } },
    { upstream: { baseURL: 'https://api.example/v1', apiKeyEnv: 'not a variable' } }, { port: 99999 },
    { upstream: { ...initial.connection.active.upstream, apiKey: 'a-literal-secret' } }]) {
    const response = await api(f, '/api/connection', { revision: initial.revision, ...initial.connection.active, ...change });
    expect(response.status).toBe(400);
    expect(readSubagentJSON(f.file)).toEqual(f.document);
  }
  writeSubagentJSON(f.file, { ...f.document, upstream: { ...f.document.upstream, baseURL: 'https://user:injected-secret@api.example' } });
  const state = await f.controller.state();
  expect(state.configuration.state).toBe('unavailable');
  expect(state.connection.saved).toBeNull();
  expect(JSON.stringify(state)).not.toContain('injected-secret');
});

test('diagnostics make authenticated catalog requests without inference and return only safe summaries', async () => {
  const f = await fixture({ inspectContract: () => ({ state: 'verified', version: '3.2.21',
    accepted: [CHILD], skipped: [], archive: '/private/runtime', secret: KEY }) });
  const { request, state } = await action(f, 'check-upstream');
  expect(state.diagnostics.upstream).toMatchObject({ state: 'passed', httpStatus: 200, modelCount: 1 });
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toEqual({ path: '/v1/models', method: 'GET', body: '', authorization: 'Bearer ' + KEY });
  await api(f, '/api/actions', request);
  expect(f.requests).toHaveLength(1);
  const checked = (await action(f, 'check-compat')).state;
  expect(checked.diagnostics.compat).toMatchObject({ state: 'verified', acceptedCount: 1, skippedCount: 0 });
  expect(checked.metrics.requests).toBe(0);
  for (const secret of [KEY, TOKEN, '/private/runtime']) expect(JSON.stringify(checked)).not.toContain(secret);
});

test('failed or malformed upstream catalogs report evidence without leaking their response body', async () => {
  for (const variant of ['unauthorized', 'invalid-json', 'invalid-list', 'oversized']) {
    const f = await fixture({ upstreamReply: (_req, res) => {
      res.writeHead(variant === 'unauthorized' ? 401 : 200, { 'Content-Type': 'application/json' });
      res.end(variant === 'invalid-json' ? KEY : variant === 'oversized' ? ' '.repeat(1024 * 1024 + 1)
        : JSON.stringify(variant === 'invalid-list' ? { data: [null] } : { private: KEY }));
    } });
    const { state } = await action(f, 'check-upstream');
    expect(state.diagnostics.upstream.state).toBe('failed');
    expect(JSON.stringify(state)).not.toContain(KEY);
  }
});

test('request history is bounded metadata and preserves upstream HTTP failures without recording conversation content', async () => {
  const f = await fixture({ upstreamReply: (_req, res) => {
    res.writeHead(429); res.end('synthetic upstream response');
  } });
  for (let i = 0; i < 22; i++) {
    const response = await infer(f, { model: CHILD, input: 'private synthetic prompt ' + i });
    expect(response.status).toBe(429); await response.text();
  }
  const state = await f.controller.state();
  expect(state.metrics.requests).toBe(22);
  expect(state.metrics.failures).toBe(22);
  expect(state.metrics.recent).toHaveLength(20);
  expect(state.metrics.recent.every(row => row.status === 429 && row.ms >= 0)).toBe(true);
  expect(JSON.stringify(state)).not.toContain('private synthetic prompt');
  expect(JSON.stringify(state)).not.toContain('synthetic upstream response');
});

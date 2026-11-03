import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run as runCLI } from '../cli.mjs';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway } from '../src/gateway.mjs';
import { NativeContextPolicy } from '../src/native-context-policy.mjs';
import { NativeMcpManager } from '../src/native-mcp-manager.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { GatewayService } from '../src/service-manager.mjs';
import { searchCatalog } from '../src/panel-settings.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { normalizeSetupInput, readCredentials, saveSetup, setupPaths, setupState, writePrivateJson } from '../src/setup.mjs';
import { SubagentPolicy } from '../src/subagent-policy.mjs';
import { providerPresets } from '../src/provider-catalog.mjs';

// This file is the end-to-end contract for the integrated panel: every
// assertion is made over real loopback HTTP against a real panel process shape
// (controller + server), real fake upstreams that record what they received,
// and an isolated native home. Nothing here contacts a vendor, a real Kimi
// installation, or Magpie.

const fixtures = [];
const TOKEN = 'a'.repeat(64);
const KEY_A = 'synthetic-openai-key';
const KEY_B = 'synthetic-kimi-key';

async function upstream({ models, reply } = {}) {
  const requests = [];
  const state = { models, reply };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      if (state.reply) return state.reply(req, res, body);
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: state.models }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ served: req.url, received: JSON.parse(body || '{}').model }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', requests, server,
    // Swapping the reply keeps the recorder in front of it, so "what did this
    // upstream receive" stays answerable after a scenario re-programs it.
    setReply(next) { state.reply = next; },
    setModels(next) { state.models = next; } };
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel?.stop();
    await f.setupServer?.stop();
    await f.controller?.close();
    await f.gateway?.stop();
    f.policy?.close();
    await closeServer(f.a?.server);
    await closeServer(f.b?.server);
    if (f.dir) fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

const api = (f, route, body, headers = {}) => fetch(f.panel.url + route, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
});

const infer = (f, route, body) => fetch(f.gateway.url + route, {
  method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// An isolated native home with a real config.toml, so the context policy has a
// file to edit and the assertions read back actual bytes.
function nativeHome(root) {
  const kimiDir = path.join(root, 'kimi');
  const homeDir = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const configPath = path.join(homeDir, 'config.toml');
  fs.writeFileSync(configPath, 'theme = "dark"\n\n[loop_control]\nunrelated = 1\n');
  return { kimiDir, homeDir, configPath };
}

// The installed-kernel MCP surface, faked at the seam the manager uses: the
// manager still validates, serialises, redacts and projects exactly as it does
// against the real kernel, and the fake records every call so "list does not
// launch, only test does" is provable rather than asserted.
function fakeKernel(initial = {}) {
  const servers = new Map(Object.entries(initial).map(([name, value]) => [name, { name, ...value }]));
  const calls = [];
  let listed = 0;
  let tested = 0;
  const client = {
    async listGlobalMcpServers() { listed++; return [...servers.values()].map(entry => ({ ...entry })); },
    async addGlobalMcpServer(server) {
      calls.push('add');
      if (servers.has(server.name)) throw Object.assign(Error('exists'), { code: 'request.invalid' });
      servers.set(server.name, { ...server });
      return [...servers.values()];
    },
    async updateGlobalMcpServer(server) {
      calls.push('update');
      if (!servers.has(server.name)) throw Object.assign(Error('missing'), { code: 'mcp.server_not_found' });
      servers.set(server.name, { ...server });
      return [...servers.values()];
    },
    async removeGlobalMcpServer(name) { calls.push('remove'); servers.delete(name); return [...servers.values()]; },
    async testGlobalMcpServer(name) {
      calls.push('test');
      tested++;
      if (!servers.has(name)) throw Object.assign(Error('missing'), { code: 'mcp.server_not_found' });
      return { success: true, output: 'Connected.\nAvailable tools: 2\n- echo: Echo text\n- status: Health' };
    },
    async close() { calls.push('close'); },
  };
  const load = async () => ({ createKernelClient: () => client });
  return { calls, servers, load, counts: () => ({ listed, tested }) };
}

async function fixture({ kernel = fakeKernel(), contextOverrides = {} } = {}) {
  const openai = await upstream({ models: [
    { id: 'gpt-6-astra', context_length: 1050000, supports_tool_call: true, input_modalities: ['text', 'image'] },
    { id: 'gpt-6.1-sol', context_length: 1050000, supports_tool_call: true },
  ] });
  const kimi = await upstream({ models: [
    { id: 'k3', context_window: 262144, supports_tool_call: true, protocols: ['chat', 'responses'] },
  ] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiplus-integration-'));
  const { kimiDir, homeDir, configPath } = nativeHome(dir);
  const file = path.join(dir, 'gateway.json');
  const document = {
    connections: [
      { id: 'openai', name: 'OpenAI', providerPresetId: 'openai',
        baseURL: openai.baseURL, apiKeyEnv: 'KIMI_WORK_OPENAI_KEY', protocols: ['chat', 'responses'] },
      { id: 'kimi-code', name: 'Kimi Code', providerPresetId: 'kimi-code-cn',
        baseURL: kimi.baseURL, apiKeyEnv: 'KIMI_WORK_KIMI_CODE_KEY', protocols: ['chat', 'responses'] },
    ],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [
      { id: 'resp-gpt-6-astra', protocol: 'responses', contextWindow: 1050000,
        connectionId: 'openai', upstreamModelId: 'gpt-6-astra', contextLimit: 1050000,
        metadataSource: { kind: 'preset', url: 'https://developers.openai.com/api/docs/models', checkedAt: '2026-11-02' } },
      { id: 'kimi-k3', protocol: 'chat', contextWindow: 262144, connectionId: 'kimi-code', upstreamModelId: 'k3' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(document));
  const config = readConfig(document);
  const backend = new OpenAIBackend({
    connections: config.connections.map(connection => ({ ...connection,
      apiKey: connection.id === 'openai' ? KEY_A : KEY_B })),
    models: config.models,
  });
  const gateway = new KimiWorkGateway({ backend, recordRequests: true });
  await gateway.configure({ key: TOKEN, port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir });
  policy.configure(undefined, backend.models);
  const credentialsFile = path.join(dir, 'credentials.json');
  writePrivateJson(credentialsFile, { schemaVersion: 2, gatewayToken: TOKEN,
    connectionApiKeys: { openai: KEY_A, 'kimi-code': KEY_B } });
  const contextPolicy = new NativeContextPolicy({ stateDir: dir, kimiDir, ...contextOverrides });
  const mcpManager = new NativeMcpManager({ kimiDir, stateDir: dir, kernelPath: path.join(kimiDir, 'kernel.mjs'),
    loadKernel: kernel.load });
  fs.writeFileSync(path.join(kimiDir, 'kernel.mjs'), '// stand-in kernel\n');
  const controller = new PanelController({ configFile: file, config, gateway, backend, stateDir: dir, kimiDir, policy,
    credentialsFile, contextPolicy, mcpManager,
    env: { KIMI_WORK_OPENAI_KEY: KEY_A, KIMI_WORK_KIMI_CODE_KEY: KEY_B, KIMI_WORK_GATEWAY_TOKEN: TOKEN },
    runtime: { inspect: () => ({ state: 'not-prepared' }) }, probe: { check: async () => ({}) },
    inspectContract: () => ({ state: 'verified', version: '3.2.21', accepted: [], skipped: [] }) });
  const panel = new GatewayPanel({ controller });
  await panel.start({ port: 0 });
  const f = { a: openai, b: kimi, dir, file, document, config, backend, gateway, policy, controller, panel,
    kimiDir, homeDir, configPath, kernel };
  fixtures.push(f);
  return f;
}

test('providers and model search serve the shipped catalog behind the panel session', async () => {
  const f = await fixture();
  const anonymous = await fetch(f.panel.url + '/api/providers');
  expect(anonymous.status).toBe(401);
  const foreign = await api(f, '/api/providers', undefined, { Origin: 'https://example.com' });
  expect(foreign.status).toBe(403);

  const providers = await (await api(f, '/api/providers')).json();
  expect(providers.presets.map(preset => preset.id)).toEqual(providerPresets().map(preset => preset.id));
  const openai = providers.presets.find(preset => preset.id === 'openai');
  expect(openai.baseURL).toBe('https://api.openai.com/v1');
  expect(openai.source.url).toContain('openai.com');
  // The ranking is the shipped matcher: "GPT6 aster" and "GPT6.1 sol" are the
  // two queries the mission names, and neither may return a neighbouring model.
  const aster = await (await api(f, '/api/model-search', { query: 'GPT6 aster', presetId: 'openai' })).json();
  expect(aster.query).toBe('GPT6 aster');
  expect(aster.models.map(model => model.id)).toEqual(['gpt-6-astra']);
  expect(aster.models[0].contextWindow).toBe(1050000);
  const sol = await (await api(f, '/api/model-search', { query: 'GPT6.1 sol', presetId: 'openai' })).json();
  expect(sol.models.map(model => model.id)).toEqual(['gpt-6.1-sol']);
  expect(sol.models[0].protocols).toEqual(['chat', 'responses']);
  // Nothing is saved by a search.
  expect((await f.controller.state()).models).toHaveLength(2);
  expect((await api(f, '/api/model-search', { query: 'x', presetId: 'nope' })).status).toBe(400);
  expect((await api(f, '/api/model-search', { query: 5 })).status).toBe(400);
});

test('discovery feeds the search of that connection and unknown protocols stay unknown', async () => {
  const f = await fixture();
  // The fake Kimi endpoint declares protocols, and the id survives verbatim.
  const revision = (await f.controller.state()).revision;
  const discovered = await (await api(f, '/api/discovery', { revision, connectionId: 'kimi-code' })).json();
  expect(discovered.discovery).toMatchObject({ connectionId: 'kimi-code', state: 'passed', source: 'discovery' });
  expect(discovered.discovery.models.map(model => model.id)).toEqual(['k3']);
  expect(f.b.requests).toHaveLength(1);
  expect(f.b.requests[0].authorization).toBe('Bearer ' + KEY_B);

  const merged = await (await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code' })).json();
  // The preset offers both k3 variants and the endpoint confirmed k3, so the
  // endpoint's own catalog is merged in rather than replacing the preset.
  expect(merged.models[0].id).toBe('k3');
  expect(merged.models.map(model => model.id)).toContain('k3-256k');
  // The preset documents 1M for k3; the endpoint declared 262144, so the
  // endpoint's own number wins and the preset does not overwrite it.
  expect(merged.models[0].contextWindow).toBe(262144);
  expect(merged.models[0].tools).toBe(true);

  // An endpoint that declares no protocol inherits the preset's, and the
  // search marks that list as preset-sourced rather than discovered.
  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'k3' }] }));
  });
  const revision2 = (await f.controller.state()).revision;
  const silent = await (await api(f, '/api/discovery', { revision: revision2, connectionId: 'kimi-code' })).json();
  // The shared parser lets an undeclared protocol list fall back to the
  // preset's, which is the documented "no statement, preset source" case.
  expect(silent.discovery.models[0].protocols).toEqual(['chat', 'responses']);
  const inherited = await (await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code' })).json();
  expect(inherited.models[0].protocols).toEqual(['chat', 'responses']);

  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'k3', protocols: [] }] }));
  });
  const revision3 = (await f.controller.state()).revision;
  await api(f, '/api/discovery', { revision: revision3, connectionId: 'kimi-code' });
  const searched = await (await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code' })).json();
  expect(searched.models[0].protocols).toEqual([]);

  // A connection the file does not have is refused instead of being invented.
  expect((await api(f, '/api/model-search', { query: 'k3', connectionId: 'ghost' })).status).toBe(409);
});

test('an empty query browses the catalog and an explicit empty protocol list stays empty', async () => {
  const f = await fixture();
  const file = fs.readFileSync(f.file, 'utf8');
  // No preset and no connection is still not a bag of every vendor.
  expect((await (await api(f, '/api/model-search', { query: '' })).json()).models).toEqual([]);

  // The endpoint explicitly declares no protocol for k3. The browse list is
  // the whole connection-bound catalog, and that empty list must survive it
  // instead of being backfilled from the preset.
  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'k3', protocols: [] }] }));
  });
  const sent = f.b.requests.length;
  await api(f, '/api/discovery', { revision: (await f.controller.state()).revision, connectionId: 'kimi-code' });
  const browsed = await (await api(f, '/api/model-search', { query: '', connectionId: 'kimi-code' })).json();
  expect(browsed.query).toBe('');
  expect(browsed.models.map(model => model.id).sort())
    .toEqual(['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
  const k3 = browsed.models.find(model => model.id === 'k3');
  expect(k3.protocols).toEqual([]);
  expect(k3.metadataSource).toMatchObject({ kind: 'preset' });
  // Browsing is a read of the assembled catalog: no request, no save.
  expect(f.b.requests).toHaveLength(sent + 1);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(file);
  expect((await f.controller.state()).models).toHaveLength(2);

  // A nonempty query keeps the shipped ranking, and the browse list is bounded
  // by the same limit rules the ranked search uses.
  const ranked = await (await api(f, '/api/model-search', { query: 'GPT6 aster', presetId: 'openai' })).json();
  expect(ranked.models.map(model => model.id)).toEqual(['gpt-6-astra']);
  const preset = providerPresets().find(row => row.id === 'openai');
  expect(searchCatalog({ preset, query: '', limit: 0 })).toEqual([]);
  expect(searchCatalog({ preset, query: '   ', limit: 2 }).map(model => model.id))
    .toEqual(['gpt-6-astra', 'gpt-6.1-sol']);
  expect(searchCatalog({ preset, query: '', limit: 10000 })).toHaveLength(preset.models.length);
});

test('a candidate keeps its aliases, its provenance, and the provenance of contextWindow itself', async () => {
  const f = await fixture();
  // "Astra" is a preset alias, not part of the id or name, so ranking on it
  // proves the alias survived the merge instead of being dropped there.
  const byAlias = await (await api(f, '/api/model-search', { query: 'Astra', presetId: 'openai' })).json();
  expect(byAlias.models.map(model => model.id)).toEqual(['gpt-6-astra']);
  expect(byAlias.models[0].aliases).toContain('Astra');
  // A preset-only candidate is attributable to preset, with its date.
  expect(byAlias.models[0].metadataSource).toMatchObject({ kind: 'preset' });
  expect(byAlias.models[0].sources.preset.kind).toBe('preset');

  // Now the endpoint reports a context size for one of its models while saying
  // nothing else about k3's capabilities.
  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'k3', context_window: 131072 }] }));
  });
  const revision = (await f.controller.state()).revision;
  const discovered = await (await api(f, '/api/discovery', { revision, connectionId: 'kimi-code' })).json();
  expect(discovered.discovery.models[0].contextWindow).toBe(131072);
  const merged = await (await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code' })).json();
  const k3 = merged.models.find(model => model.id === 'k3');
  expect(k3.contextWindow).toBe(131072);
  // The context number came from the endpoint, so the budget's provenance is
  // the endpoint — while the protocols came from the preset and are attributed
  // to the preset separately.
  expect(k3.metadataSource.kind).toBe('discovery');
  expect(k3.metadataSource.url).toContain('/models');
  expect(k3.sources.discovery.kind).toBe('discovery');
  expect(k3.sources.preset.kind).toBe('preset');

  // A discovery that reports no context size must NOT relabel the preset's
  // number as discovered: the provenance follows the value it belongs to.
  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'k3', supports_tool_call: true }] }));
  });
  await api(f, '/api/discovery', { revision, connectionId: 'kimi-code' });
  const fallback = await (await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code' })).json();
  const presetK3 = fallback.models.find(model => model.id === 'k3');
  expect(presetK3.contextWindow).toBe(1048576);
  expect(presetK3.metadataSource).toMatchObject({ kind: 'preset' });
  // k3 has no per-model source page, so the preset's root page is the evidence
  // — the documented fallback, not a guess.
  expect(presetK3.metadataSource.url).toBe('https://www.kimi.ai/zh-hans/help/kimi-code/models');
  // The endpoint did state something (tools), so both sources are recorded.
  expect(presetK3.sources.discovery).toBeDefined();
  expect(presetK3.sources.preset).toBeDefined();
});

test('a preset budget cites the page that documents that model, not the plan landing page', async () => {
  const f = await fixture();
  // These presets root at a plan/pricing/membership page while each model
  // carries its own documentation page. The evidence saved with a budget must
  // be the model's own page: a plan page cannot document a model's limit.
  for (const [presetId, modelId] of [['qwen-coding', 'qwen3.7-plus'], ['zhipu-coding-cn-chat', 'glm-5.3'],
    ['deepseek', 'deepseek-flash']]) {
    const preset = providerPresets().find(row => row.id === presetId);
    const model = preset.models.find(row => row.id === modelId);
    expect(model.source.url).toBeDefined();
    expect(model.source.url).not.toBe(preset.source.url);
    const found = await (await api(f, '/api/model-search', { query: modelId, presetId })).json();
    const candidate = found.models.find(row => row.id === modelId);
    expect(candidate.metadataSource.kind).toBe('preset');
    // The URL is asserted, not just the kind: this is the exact defect the
    // reviewer found, and a kind-only assertion cannot see it.
    expect(candidate.metadataSource.url).toBe(model.source.url);
    expect(candidate.metadataSource.url).not.toBe(preset.source.url);
    expect(candidate.metadataSource.checkedAt).toBe(model.source.checkedAt);
    // The per-model page survives on the candidate as well.
    expect(candidate.source.url).toBe(model.source.url);
  }
  // The contrast case: kimi-code models carry no per-model page, so the root
  // page is the only evidence there is, and it is used.
  const kimi = providerPresets().find(row => row.id === 'kimi-code-cn');
  expect(kimi.models.every(model => model.source === undefined)).toBe(true);
  const rooted = await (await api(f, '/api/model-search', { query: 'k3', presetId: 'kimi-code-cn' })).json();
  const kimiK3 = rooted.models.find(row => row.id === 'k3');
  expect(kimiK3.metadataSource.url).toBe(kimi.source.url);
});

test('a preset that contradicts the saved connection is refused, and a changed endpoint drops the old catalog', async () => {
  const f = await fixture();
  // `kimi-code` declares the `kimi-code-cn` preset; asking for the OpenAI
  // catalog against it would mislabel every candidate it returned.
  const mismatched = await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code', presetId: 'openai' });
  expect(mismatched.status).toBe(400);
  expect((await mismatched.json()).error.code).toBe('preset_connection_mismatch');
  // Naming the connection's own preset is fine.
  const matching = await api(f, '/api/model-search', { query: 'k3', connectionId: 'kimi-code', presetId: 'kimi-code-cn' });
  expect(matching.status).toBe(200);

  // Discover on this endpoint, then re-point the same connection id at another
  // base URL: the old catalog described an endpoint that is no longer there.
  f.b.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'legacy-endpoint-model' }] }));
  });
  await api(f, '/api/discovery', { revision: (await f.controller.state()).revision, connectionId: 'kimi-code' });
  const before = await (await api(f, '/api/model-search', { query: 'legacy', connectionId: 'kimi-code' })).json();
  expect(before.models.map(model => model.id)).toContain('legacy-endpoint-model');

  const current = f.controller.readConfiguration();
  const moved = await f.controller.saveConnections({ revision: current.revision,
    connections: current.document.connections.map(connection => connection.id === 'kimi-code'
      ? { ...connection, baseURL: 'http://127.0.0.1:9/v1' } : connection) });
  expect(moved.connections.active.find(row => row.id === 'kimi-code').baseURL).toBe(f.b.baseURL);
  expect(moved.connections.saved.find(row => row.id === 'kimi-code').baseURL).toBe('http://127.0.0.1:9/v1');
  const after = await (await api(f, '/api/model-search', { query: 'legacy', connectionId: 'kimi-code' })).json();
  expect(after.models.map(model => model.id)).not.toContain('legacy-endpoint-model');
});

test('discovery uses the key saved just now, not the older value in this process', async () => {
  const f = await fixture();
  const fresh = '{{SECRET_3pxq8znc}}';
  // The running process carries KEY_B; the private file is rewritten with a new
  // key for the same connection, which is exactly what saving a connection does.
  writePrivateJson(f.controller.credentialsFile, { schemaVersion: 2, gatewayToken: TOKEN,
    connectionApiKeys: { openai: KEY_A, 'kimi-code': fresh } });
  expect(f.controller.env.KIMI_WORK_KIMI_CODE_KEY).toBe(KEY_B);
  const revision = (await f.controller.state()).revision;
  const discovered = await (await api(f, '/api/discovery', { revision, connectionId: 'kimi-code' })).json();
  expect(discovered.discovery.state).toBe('passed');
  expect(f.b.requests.at(-1).authorization).toBe('Bearer ' + fresh);
});

test('a budget above the known hard limit is refused, and both fields survive save and reload', async () => {
  const f = await fixture();
  const { revision, models } = await f.controller.state();
  const budget = { ...models[1], contextWindow: 350000, contextLimit: 262144 };
  const over = await api(f, '/api/models', { revision, models: [models[0], budget] });
  expect(over.status).toBe(400);
  expect((await over.json()).error.code).toBe('context_window_exceeds_limit');
  expect(fs.readFileSync(f.file, 'utf8')).not.toContain('350000');

  // 350000 / 600000 are user choices either way; what is refused is exceeding
  // the limit, never a smaller budget than the vendor allows.
  const smaller = { ...models[1], contextWindow: 200000, contextLimit: 262144 };
  const saved = await api(f, '/api/models', { revision, models: [models[0], smaller] });
  expect(saved.status).toBe(200);
  const stored = JSON.parse(fs.readFileSync(f.file, 'utf8')).models[1];
  expect(stored).toMatchObject({ contextWindow: 200000, contextLimit: 262144 });
  const reloaded = readConfig(JSON.parse(fs.readFileSync(f.file, 'utf8')));
  expect(reloaded.models[1]).toMatchObject({ contextWindow: 200000, contextLimit: 262144 });
  // The native catalog advertises the budget, never the hard limit.
  const catalog = await (await fetch(f.gateway.url + '/models/api.json', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  expect(catalog.kimi.models['kimi-k3'].limit.context).toBe(200000);
  expect(JSON.stringify(catalog)).not.toContain('contextLimit');
});

test('the context policy writes the isolated native config and reports observed adoption', async () => {
  const f = await fixture();
  const before = await (await api(f, '/api/state')).json();
  expect(before.context).toMatchObject({ policy: { mode: 'inherit' }, status: 'inherit' });

  // The contract is one decimal range and a plain integer; a percentage is not
  // silently converted, it is refused.
  expect((await api(f, '/api/context', { policy: { mode: 'custom', triggerRatio: 85 } })).status).toBe(400);
  expect((await api(f, '/api/context', { policy: { mode: 'custom', triggerRatio: 0.3 } })).status).toBe(400);
  expect((await api(f, '/api/context', { policy: { mode: 'custom', reservedTokens: -1 } })).status).toBe(400);

  const applied = await (await api(f, '/api/context', {
    policy: { mode: 'custom', triggerRatio: 0.5, reservedTokens: 30000 } })).json();
  expect(Object.keys(applied)).toContain('context');
  expect(applied.context.status).toBe('applied');
  expect(applied.context.policy).toEqual({ mode: 'custom', triggerRatio: 0.5, reservedTokens: 30000 });
  const text = fs.readFileSync(f.configPath, 'utf8');
  expect(text).toContain('compaction_trigger_ratio = 0.50');
  expect(text).toContain('reserved_context_size = 30000');
  // Foreign bytes in the file are untouched.
  expect(text).toContain('theme = "dark"');
  expect(text).toContain('unrelated = 1');

  const state = await (await api(f, '/api/state')).json();
  expect(state.context.status).toBe('applied');
  expect(state.context.observed).toEqual({ triggerRatio: 0.5, reservedTokens: 30000 });

  // Reading state is not a write: a foreign change is reported, not overwritten.
  fs.writeFileSync(f.configPath, text.replace('0.50', '0.70'));
  const conflicted = await (await api(f, '/api/state')).json();
  expect(conflicted.context.status).toBe('conflict');
  expect(conflicted.context.reason).toBe('foreign_value');
  expect(fs.readFileSync(f.configPath, 'utf8')).toContain('0.70');

  // Inherit hands the file back.
  fs.writeFileSync(f.configPath, text);
  const inherited = await (await api(f, '/api/context', { policy: { mode: 'inherit' } })).json();
  expect(inherited.context.policy).toEqual({ mode: 'inherit' });
  expect(fs.readFileSync(f.configPath, 'utf8')).not.toContain('compaction_trigger_ratio');
  expect(fs.readFileSync(f.configPath, 'utf8')).toContain('theme = "dark"');
});

test('native tool operations are the fixed list only, keep secrets, and only test launches', async () => {
  const f = await fixture();
  const initial = await (await api(f, '/api/tools')).json();
  expect(initial.available).toBe(true);
  expect(initial.servers).toEqual([]);

  const added = await (await api(f, '/api/tools', { action: 'add', server: { name: 'local',
    transport: 'stdio', command: 'npx', args: ['-y', 'server', '--token', '{{SECRET_9k2m4t7p}}'],
    env: { API_TOKEN: '{{SECRET_9k2m4t7p}}' } } })).json();
  expect(added.result).toMatchObject({ ok: true, state: 'added' });
  expect(added.tools.servers.map(row => row.name)).toEqual(['local']);
  const row = added.tools.servers[0];
  expect(row.argsCount).toBe(4);
  expect(row.envNames).toEqual(['API_TOKEN']);
  expect(JSON.stringify(added)).not.toContain('{{SECRET_9k2m4t7p}}');

  // Listing never launched anything, and no operation but `test` does.
  expect(f.kernel.counts()).toEqual({ listed: expect.any(Number), tested: 0 });
  expect(f.kernel.calls).not.toContain('test');

  const patched = await (await api(f, '/api/tools', { action: 'update', name: 'local',
    patch: { enabled: false } })).json();
  expect(patched.result).toMatchObject({ ok: true, state: 'updated' });
  // An omitted secret field keeps the stored value rather than clearing it.
  expect(f.kernel.servers.get('local').env).toEqual({ API_TOKEN: '{{SECRET_9k2m4t7p}}' });

  const tested = await (await api(f, '/api/tools', { action: 'test', name: 'local' })).json();
  expect(tested.result.state).toBe('connected');
  expect(tested.result.summary).toEqual({ toolCount: 2, declaredToolCount: 2 });
  expect(tested.result.tools).toEqual(['echo', 'status']);
  // The kernel's raw output is not part of the product surface.
  expect(tested.result.detail).toBeUndefined();
  expect(f.kernel.counts().tested).toBe(1);

  const removed = await (await api(f, '/api/tools', { action: 'remove', name: 'local' })).json();
  expect(removed.result).toMatchObject({ ok: true, state: 'removed' });
  expect(removed.tools.servers).toEqual([]);
  const absent = await (await api(f, '/api/tools', { action: 'remove', name: 'local' })).json();
  expect(absent.result.state).toBe('absent');

  // Only the four fixed operations exist; nothing reaches a shell or an eval.
  for (const body of [{ action: 'run' }, { action: 'add', server: { name: 'bad', transport: 'stdio',
    command: 'node', shell: true } }, { action: 'add', server: { name: '../escape', transport: 'stdio', command: 'node' } }]) {
    const response = await api(f, '/api/tools', body);
    expect([400, 200]).toContain(response.status);
    const payload = await response.json();
    if (response.status === 400) expect(payload.error.code).toBe('invalid_tool_action');
    else expect(payload.result.ok).toBe(false);
  }
  expect(f.kernel.servers.size).toBe(0);
});

test('two upstreams keep exact routes and the records carry real route, timing and usage', async () => {
  const f = await fixture();
  f.a.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ output: 'ok', usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240,
      prompt_tokens_details: { cached_tokens: 200 } } }));
  });
  const response = await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'hello' });
  expect(response.status).toBe(200);
  await response.text();
  expect(f.a.requests).toHaveLength(1);
  expect(JSON.parse(f.a.requests[0].body).model).toBe('gpt-6-astra');
  expect(f.b.requests).toHaveLength(0);

  const { metrics } = await f.controller.state();
  expect(metrics.recent[0]).toMatchObject({ model: 'resp-gpt-6-astra', protocol: 'responses',
    connectionId: 'openai', upstreamModelId: 'gpt-6-astra', status: 200,
    usage: { inputTokens: 1200, outputTokens: 40, totalTokens: 1240, cachedInputTokens: 200 } });
  expect(Number.isInteger(metrics.recent[0].firstByteMs)).toBe(true);
  expect(metrics.recent[0].firstByteMs).toBeLessThanOrEqual(metrics.recent[0].ms);
  expect(metrics.recent[0].context).toEqual({ usedTokens: 1200, limitTokens: 1050000,
    ratio: 0.001, source: 'upstream_usage' });
  // A prompt never enters the record.
  expect(JSON.stringify(metrics)).not.toContain('hello');
  expect(JSON.stringify(metrics)).not.toContain(KEY_A);
});

test('a stream is forwarded byte for byte while usage is read from its events', async () => {
  const f = await fixture();
  const events = [
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'hi' },
    { type: 'response.completed', response: { usage: { input_tokens: 800, output_tokens: 12, total_tokens: 812 } } },
  ];
  const wire = events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')
    + 'data: [DONE]\n\n';
  f.a.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Split mid-event to prove the scanner copes with chunk boundaries while
    // the client still receives the concatenation unchanged.
    const bytes = Buffer.from(wire, 'utf8');
    const first = Math.floor(bytes.length / 3);
    res.write(bytes.subarray(0, first));
    res.write(bytes.subarray(first));
    res.end();
  });
  const response = await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x', stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe(wire);
  const record = (await f.controller.state()).metrics.recent[0];
  expect(record.usage).toEqual({ inputTokens: 800, outputTokens: 12, totalTokens: 812 });
  expect(record.firstByteMs).toBeGreaterThanOrEqual(0);
});

test('a cancelled request is recorded as cancelled and keeps its unknown usage unknown', async () => {
  const f = await fixture();
  let released;
  const pending = new Promise(resolve => { released = resolve; });
  f.a.setReply(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"type":"response.created"}\n\n');
    await pending;
    res.end();
  });
  const controller = new AbortController();
  const attempt = fetch(f.gateway.url + '/responses', { method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x', stream: true }) });
  // The first upstream byte proves the gateway is mid-stream before the abort,
  // so this measures a real cancellation rather than racing the connection.
  for (let attemptCount = 0; attemptCount < 100 && f.a.requests.length === 0; attemptCount++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(f.a.requests).toHaveLength(1);
  controller.abort();
  await attempt.catch(() => {});
  // The upstream stays open on purpose: a cancelled stream must be detected
  // while it is still running, not only once the vendor finally answers.
  let record;
  try {
    for (let attemptCount = 0; attemptCount < 200; attemptCount++) {
      record = (await f.controller.state()).metrics.recent[0];
      if (record?.status === 499) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    released();
  }
  expect(record.status).toBe(499);
  expect(record.error).toBe('request_cancelled');
  expect(record.usage).toBeUndefined();
  expect(record.context).toBeUndefined();
});

test('a large SSE answer still reports its terminal usage, and bytes stay identical', async () => {
  const f = await fixture();
  // Comfortably past the JSON budget: a long, ordinary answer must not lose the
  // usage that only arrives on the final event.
  const filler = 'x'.repeat(1024 * 1024);
  const events = [
    { type: 'response.output_text.delta', delta: filler },
    { type: 'response.output_text.delta', delta: 'tail' },
    { type: 'response.completed', response: { usage: { input_tokens: 900, output_tokens: 2048, total_tokens: 2948 } } },
  ];
  const wire = events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join('')
    + 'data: [DONE]\n\n';
  f.a.setReply((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // Chunked at awkward boundaries, including inside an event.
    const bytes = Buffer.from(wire, 'utf8');
    for (let at = 0; at < bytes.length; at += 7919) res.write(bytes.subarray(at, Math.min(at + 7919, bytes.length)));
    res.end();
  });
  const response = await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x', stream: true });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(wire);
  const record = (await f.controller.state()).metrics.recent[0];
  expect(record.usage).toEqual({ inputTokens: 900, outputTokens: 2048, totalTokens: 2948 });
  expect(record.rate.basis).toBe('total_request_time');
  expect(record.rate.averageOutputTokensPerSecond).toBeGreaterThan(0);
});

test('the average output rate is reported only for a real measured success', async () => {
  const f = await fixture();
  // A small delay makes the measured duration non-zero, which is what a real
  // request always has; the rate is still the whole-request average.
  f.a.setReply((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: 'ok', usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    }, 40);
  });
  const ok = await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x' });
  await ok.text();
  const record = (await f.controller.state()).metrics.recent[0];
  expect(record.rate.basis).toBe('total_request_time');
  // The rate is the whole-request average, so it includes the first-byte wait
  // and can never claim to be faster than the tokens divided by total time.
  expect(record.rate.averageOutputTokensPerSecond)
    .toBeCloseTo(Math.round((50 / (record.ms / 1000)) * 100) / 100, 2);
  // A sub-second request legitimately yields a large average; what must hold is
  // that the number is the whole-request average and never a claim about a
  // shorter window such as time-to-first-token.
  expect(record.rate.averageOutputTokensPerSecond * (record.ms / 1000)).toBeCloseTo(50, 1);
  expect(record.firstByteMs).toBeLessThanOrEqual(record.ms);

  // No usage in the payload means no rate — never a fabricated number.
  f.a.setReply((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: 'ok' }));
    }, 40);
  });
  await (await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x' })).text();
  expect((await f.controller.state()).metrics.recent[0].rate).toBeUndefined();

  // An upstream failure carries no rate either.
  f.a.setReply((req, res) => {
    setTimeout(() => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); }, 40);
  });
  await (await infer(f, '/responses', { model: 'byok-kth-resp/resp-gpt-6-astra', input: 'x' })).text();
  const failed = (await f.controller.state()).metrics.recent[0];
  expect(failed.status).toBe(500);
  expect(failed.rate).toBeUndefined();
});

test('a saved context policy comes back after the desktop rewrites config.toml', async () => {
  const f = await fixture();
  const applied = await (await api(f, '/api/context', {
    policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 20000 } })).json();
  expect(applied.context.status).toBe('applied');
  expect(fs.readFileSync(f.configPath, 'utf8')).toContain('compaction_trigger_ratio = 0.60');

  // The desktop rewrites the whole file: our keys are gone, its own settings
  // are there. The watch runs a reconcile without any state read.
  fs.writeFileSync(f.configPath, 'theme = "light"\nmodel = "k3"\n');
  f.controller.startContextWatch({ intervalMs: 20, debounceMs: 5 });
  let restored = '';
  for (let attempt = 0; attempt < 100; attempt++) {
    restored = fs.readFileSync(f.configPath, 'utf8');
    if (restored.includes('compaction_trigger_ratio')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(restored).toContain('compaction_trigger_ratio = 0.60');
  expect(restored).toContain('reserved_context_size = 20000');
  // The desktop's own settings survive the restore.
  expect(restored).toContain('theme = "light"');
  expect(restored).toContain('model = "k3"');
  // And the state read still only reads: the value it observed is the restored one.
  expect((await f.controller.state()).context.status).toBe('applied');

  // A value someone else set is never overwritten, even by the watch. Editing
  // inside the managed block breaks its recorded body hash, which is reported
  // as a conflict rather than silently rewritten.
  fs.writeFileSync(f.configPath, restored.replace('0.60', '0.75'));
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(fs.readFileSync(f.configPath, 'utf8')).toContain('compaction_trigger_ratio = 0.75');
  const conflicted = await f.controller.state();
  expect(conflicted.context.status).toBe('conflict');
  expect(['block_modified', 'foreign_value']).toContain(conflicted.context.reason);
  f.controller.stopContextWatch();
});

test('a foreign value written into an owned table is reported, never replaced', async () => {
  const f = await fixture();
  // A plain `[loop_control]` table (not a managed block) is edited key by key,
  // so here the "someone else changed it" path is directly observable.
  fs.writeFileSync(f.configPath, 'theme = "dark"\n\n[loop_control]\nunrelated = 1\n');
  await (await api(f, '/api/context', { policy: { mode: 'custom', triggerRatio: 0.6 } })).json();
  const owned = fs.readFileSync(f.configPath, 'utf8');
  expect(owned).toContain('compaction_trigger_ratio = 0.60');
  fs.writeFileSync(f.configPath, owned.replace('0.60', '0.75'));
  f.controller.startContextWatch({ intervalMs: 20, debounceMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(fs.readFileSync(f.configPath, 'utf8')).toContain('compaction_trigger_ratio = 0.75');
  const state = await f.controller.state();
  expect(state.context.status).toBe('conflict');
  expect(state.context.reason).toBe('foreign_value');
  f.controller.stopContextWatch();
});

test('first-run setup saves connections-only, keeps the new model fields and search stays static', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiplus-setup-'));
  fixtures.push({ dir: root });
  const paths = setupPaths({ stateDir: root });
  const openai = await upstream({ models: [] });
  fixtures.at(-1).a = openai;
  const input = {
    connections: [{ id: 'openai', name: 'OpenAI', providerPresetId: 'openai',
      baseURL: openai.baseURL, apiKeyEnv: 'KIMI_WORK_OPENAI_KEY', protocols: ['chat', 'responses'], apiKey: KEY_A }],
    models: [{ id: 'resp-gpt-6-astra', protocol: 'responses', contextWindow: 350000, contextLimit: 1050000,
      connectionId: 'openai', upstreamModelId: 'gpt-6-astra',
      metadataSource: { kind: 'preset', url: 'https://developers.openai.com/api/docs/models', checkedAt: '2026-11-02' } }],
    port: 3426, dns: false,
  };
  const normalized = normalizeSetupInput(input);
  // A connections-only save must not repeat the first key at the legacy top.
  expect(normalized.config.upstream).toBeUndefined();
  expect(normalized.connectionApiKeys).toEqual({ openai: KEY_A });
  await saveSetup({ paths, config: normalized.config, apiKey: normalized.apiKey,
    connectionApiKeys: normalized.connectionApiKeys });
  const saved = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  expect(saved.models[0]).toMatchObject({ contextWindow: 350000, contextLimit: 1050000,
    metadataSource: { kind: 'preset' } });
  expect(saved.upstream).toBeUndefined();
  const state = setupState({ paths });
  expect(state.models[0]).toMatchObject({ contextLimit: 1050000, metadataSource: { kind: 'preset' } });
  expect(state.connections[0].apiKeySet).toBe(true);
  expect(JSON.stringify(state)).not.toContain(KEY_A);
  expect(readCredentials(paths.credentials, { requirePrivate: true }).connectionApiKeys).toEqual({ openai: KEY_A });

  // The same budget rule applies to the very first save.
  expect(() => normalizeSetupInput({ ...input, models: [{ ...input.models[0], contextWindow: 2000000 }] }))
    .toThrow('context_window_exceeds_limit');
});

test('the first-run server answers static catalog search only under its own session', async () => {
  const { SetupServer } = await import('../src/setup.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiplus-setup-server-'));
  const uiDir = path.join(root, 'ui');
  fs.mkdirSync(uiDir);
  fs.writeFileSync(path.join(uiDir, 'setup.html'), '<!doctype html><title>setup</title><script>/*__SETUP_NONCE__*/</script>');
  const server = new SetupServer({ stateDir: root, uiDir });
  await server.start({ port: 0 });
  fixtures.push({ dir: root, setupServer: server });
  const call = (route, body, headers = {}) => fetch(server.url + route, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { Authorization: 'Bearer ' + server.key, Origin: server.url,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
  });
  expect((await call('/api/providers')).status).toBe(200);
  const providers = await (await call('/api/providers')).json();
  expect(providers.presets.some(preset => preset.id === 'openai')).toBe(true);
  const search = await (await call('/api/model-search', { query: 'GPT6 aster', presetId: 'openai' })).json();
  expect(search.models.map(model => model.id)).toEqual(['gpt-6-astra']);
  // The first-run page opens the picker before the user types anything: the
  // empty query lists that preset's documented models with their capability
  // metadata, so the page never has to know the ids in advance.
  const browse = await (await call('/api/model-search', { query: '', presetId: 'openai' })).json();
  expect(browse.models.map(model => model.id))
    .toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
  expect(browse.models[0].metadataSource).toMatchObject({ kind: 'preset' });
  expect(browse.models[0].protocols).toEqual(['chat', 'responses']);
  // The blank browse is static too: nothing is written by it.
  expect(fs.existsSync(path.join(root, 'gateway.json'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'credentials.json'))).toBe(false);
  // No preset means no candidates: the first-run page cannot search a bag of
  // every vendor, and it cannot ask this server to reach the network.
  const anonymousPreset = await (await call('/api/model-search', { query: 'gpt' })).json();
  expect(anonymousPreset.models).toEqual([]);
  expect((await (await call('/api/model-search', { query: '' })).json()).models).toEqual([]);
  expect((await call('/api/model-search', { query: 'gpt', presetId: 'nope' })).status).toBe(400);
  // MCP and the saved-connection discovery are not available before a save.
  expect((await call('/api/tools')).status).toBe(404);
  expect((await call('/api/discovery', { connectionId: 'openai' })).status).toBe(404);
  expect((await fetch(server.url + '/api/providers', { headers: { Authorization: 'Bearer ' + server.key } })).status).toBe(200);
  const foreign = await call('/api/model-search', { query: 'x' }, { Origin: 'https://example.com' });
  expect(foreign.status).toBe(403);
});

test('the CLI panel exposes the integrated endpoints and closes the native manager on exit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiplus-cli-'));
  const openai = await upstream({ models: [{ id: 'gpt-6-astra', context_length: 1050000 }] });
  fixtures.push({ dir: root, a: openai });
  const { kimiDir } = nativeHome(root);
  const kernel = fakeKernel();
  fs.writeFileSync(path.join(kimiDir, 'kernel.mjs'), '// stand-in kernel\n');
  const file = path.join(root, 'gateway.json');
  fs.writeFileSync(file, JSON.stringify({
    connections: [{ id: 'openai', name: 'OpenAI', baseURL: openai.baseURL,
      apiKeyEnv: 'KIMI_WORK_OPENAI_KEY', protocols: ['chat', 'responses'] }],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [{ id: 'resp-gpt-6-astra', protocol: 'responses', contextWindow: 1050000,
      connectionId: 'openai', upstreamModelId: 'gpt-6-astra' }],
  }));
  const credentials = path.join(root, 'credentials.json');
  writePrivateJson(credentials, { schemaVersion: 2, gatewayToken: TOKEN, connectionApiKeys: { openai: KEY_A } });
  const entryFile = path.join(root, 'panel-entry.json');
  const lines = { out: [], err: [] };
  const io = { out: line => lines.out.push(line), err: line => lines.err.push(line) };
  const manager = new NativeMcpManager({ kimiDir, stateDir: root,
    kernelPath: path.join(kimiDir, 'kernel.mjs'), loadKernel: kernel.load });
  const code = await runCLI(['panel', '--config', file, '--state-dir', root, '--kimi-dir', kimiDir,
    '--credentials', credentials, '--ui-port', '0', '--entry-file', entryFile, '--no-native'],
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, {
    waitForShutdown: async () => {
      expect(fs.existsSync(entryFile)).toBe(true);
      const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
      const key = new URL(entry.entryURL).hash.replace('#key=', '');
      const panelUrl = entry.url;
      const call = (route, body) => fetch(panelUrl + route, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: { Authorization: 'Bearer ' + key, Origin: panelUrl,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
      const providers = await (await call('/api/providers')).json();
      expect(providers.presets.length).toBeGreaterThan(0);
      expect((await call('/api/state')).status).toBe(200);
      const state = await (await call('/api/state')).json();
      expect(state.context).toBeDefined();
      expect(state.tools).toMatchObject({ available: true, servers: [] });
      const tools = await (await call('/api/tools')).json();
      expect(tools.servers).toEqual([]);
      const search = await (await call('/api/model-search', { query: 'GPT6 aster', presetId: 'openai' })).json();
      expect(search.models[0].id).toBe('gpt-6-astra');
      // The CLI wires the controller to the same state directory the service
      // commands use. Without an installed record the panel must say so — the
      // page then keeps the terminal restart steps — and the construction of
      // the read-only view must not have created or started anything.
      expect(state.service).toBeNull();
      expect(fs.existsSync(path.join(root, 'service.json'))).toBe(false);
    },
    mcpManager: manager,
  });
  expect(lines.err).toEqual([]);
  expect(code).toBe(0);
  // Shutdown released the kernel client exactly once.
  expect(kernel.calls.filter(call => call === 'close')).toHaveLength(1);
});

// 行内连接检查走真实面板进程与真实假上游：按行 connectionId 命中各自的
// 端点，结果带回该 id；未配置的 id 被拒，且任何结果都不携带 Key。
test('a per-connection check probes exactly its named upstream and reports its id', async () => {
  const f = await fixture();
  const check = async (connectionId) => {
    const request = { id: crypto.randomUUID(), at: Date.now(), action: 'check-upstream',
      ...(connectionId === undefined ? {} : { connectionId }) };
    const response = await api(f, '/api/actions', request);
    if (response.status !== 202) {
      // An unknown connection is refused before an operation exists at all.
      const { error } = await response.json();
      return { state: 'failed', reason: error.code };
    }
    await f.controller.operationTask;
    return (await f.controller.state()).operation;
  };

  const openai = await check('openai');
  expect(openai).toMatchObject({ state: 'passed', connectionId: 'openai', httpStatus: 200 });
  expect(openai.modelCount).toBe(2);
  expect(f.a.requests.at(-1)).toEqual({ method: 'GET', url: '/v1/models',
    authorization: 'Bearer ' + KEY_A, body: '' });
  expect(f.b.requests).toHaveLength(0);

  const kimiCode = await check('kimi-code');
  expect(kimiCode).toMatchObject({ state: 'passed', connectionId: 'kimi-code' });
  expect(kimiCode.modelCount).toBe(1);
  expect(f.b.requests.at(-1).authorization).toBe('Bearer ' + KEY_B);
  // Only one probe per check: the first row's server was not asked again.
  expect(f.a.requests).toHaveLength(1);

  // An unknown id is refused before any probe: the operation fails with the
  // connection code and neither server sees a request.
  const before = f.a.requests.length + f.b.requests.length;
  const missing = await check('no-such-connection');
  expect(missing).toMatchObject({ state: 'failed', reason: 'connection_unavailable' });
  expect(f.a.requests.length + f.b.requests.length).toBe(before);
  const summary = JSON.stringify((await f.controller.state()).operation);
  expect(summary).not.toContain(KEY_A);
  expect(summary).not.toContain(KEY_B);
});

// CLI 的 panel 命令必须把与 service 命令一致的 GatewayService 只读视图交给
// controller：service.json 存在且指向本配置时，页面能拿到 service 模式（并
// 显示 service restart/status 找回入口）；没有安装记录时为 null，前台 Ctrl+C
// 文案保留。构造只读视图从不执行 launchctl/schtasks。
test('the CLI panel reports the installed service record through the read-only service view', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimiplus-cli-service-'));
  const openai = await upstream({ models: [{ id: 'gpt-6-astra', context_length: 1050000 }] });
  fixtures.push({ dir: root, a: openai });
  const { kimiDir } = nativeHome(root);
  fs.writeFileSync(path.join(kimiDir, 'kernel.mjs'), '// stand-in kernel\n');
  const file = path.join(root, 'gateway.json');
  fs.writeFileSync(file, JSON.stringify({
    connections: [{ id: 'openai', name: 'OpenAI', baseURL: openai.baseURL,
      apiKeyEnv: 'KIMI_WORK_OPENAI_KEY', protocols: ['chat', 'responses'] }],
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 0, dns: { enabled: false },
    models: [{ id: 'resp-gpt-6-astra', protocol: 'responses', contextWindow: 1050000,
      connectionId: 'openai', upstreamModelId: 'gpt-6-astra' }],
  }));
  const credentials = path.join(root, 'credentials.json');
  writePrivateJson(credentials, { schemaVersion: 2, gatewayToken: TOKEN, connectionApiKeys: { openai: KEY_A } });
  const entryFile = path.join(root, 'panel-entry.json');
  const lines = { out: [], err: [] };
  const io = { out: line => lines.out.push(line), err: line => lines.err.push(line) };
  // The install plan is written directly: writing service.json is a file
  // operation, not a system command, so this fixture never reaches launchd.
  const runnerCalls = [];
  const service = new GatewayService({ stateDir: root, configPath: file, credentialsFile: credentials,
    entryFile, env: {}, platform: 'linux',
    launcherPath: path.join(root, 'bin', 'kimi-work-gateway.mjs'),
    runner: (bin, args) => { runnerCalls.push([bin, args]); return { code: 0, stdout: '', stderr: '' }; } });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'kimi-work-gateway.mjs'), '// launcher\n');
  fs.writeFileSync(path.join(root, 'service.json'), JSON.stringify({
    ...service.buildRecord(), kind: 'scheduled-task', definition: null,
    definitionDigest: null }));
  const code = await runCLI(['panel', '--config', file, '--state-dir', root, '--kimi-dir', kimiDir,
    '--credentials', credentials, '--ui-port', '0', '--entry-file', entryFile, '--no-native'],
  { KIMI_WORK_GATEWAY_TOKEN: TOKEN }, io, {
    waitForShutdown: async () => {
      const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
      const key = new URL(entry.entryURL).hash.replace('#key=', '');
      const state = await (await fetch(entry.url + '/api/state', {
        headers: { Authorization: 'Bearer ' + key, Origin: entry.url } })).json();
      expect(state.service).toMatchObject({ mode: 'service', label: 'dev.kimi-work-gateway',
        config: file });
      expect(JSON.stringify(state.service)).not.toContain(TOKEN);
      expect(JSON.stringify(state.service)).not.toContain('panel-entry');
    },
  });
  expect(lines.err).toEqual([]);
  expect(code).toBe(0);
  // Nothing ran the service manager: constructing the view is read-only.
  expect(runnerCalls).toEqual([]);
});

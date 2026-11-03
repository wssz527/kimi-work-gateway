import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

// These tests drive the delivered `ui/app.js` in a DOM stand-in, the same way
// the existing panel tests do. They cover the Kimi++ additions specifically:
// routing IDs, named connections without echoed secrets, the context policy
// contract, and the native MCP operation shapes. Nothing here proves layout.

const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

function element() {
  return { dataset: {}, style: {}, textContent: '', value: '', checked: false, disabled: false,
    hidden: false, scrollTop: 0, firstChild: null, id: '', type: '', attrs: {}, children: [],
    events: new Map(), classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this.events.set(name, handler); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    append(...appended) { this.children.push(...appended); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); },
    /* A group element may be seeded with children so `[data-budget]` lookups
       work; everything else answers "nothing matched", as before. */
    querySelectorAll(selector) {
      if (selector !== '[data-budget]' || !this.children) return [];
      return this.children.filter((child) => child.dataset && child.dataset.budget !== undefined);
    },
    querySelector: () => null, closest: () => null, focus() {} };
}

const CONNECTION = {
  id: 'deepseek', name: 'DeepSeek 官方', baseURL: 'https://api.deepseek.com/v1',
  apiKeyEnv: 'KIMI_WORK_CONN_DEEPSEEK_KEY', legacy: false, modelCount: 2, apiKeySet: true,
};

function stateWith(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 'a'.repeat(64),
    configuration: { state: 'ready', file: 'gateway.json' },
    gateway: { state: 'running', url: 'http://127.0.0.1:3426/v1', modelCount: 2, activeRequests: 0 },
    models: [
      { id: 'deepseek/resp/deepseek-chat', protocol: 'responses', contextWindow: 262144, contextLimit: 600000,
        connectionId: 'deepseek', upstreamModelId: 'deepseek-chat', tools: true },
      { id: 'legacy/model', protocol: 'responses', contextWindow: 8192, tools: false },
    ],
    subagents: {
      configured: { mode: 'force', model: 'deepseek/resp/deepseek-chat', effort: null },
      policy: { mode: 'force', model: 'deepseek/resp/deepseek-chat', effort: null },
      runtime: { state: 'loaded', mode: 'force', modelAlias: 'deepseek/resp/deepseek-chat' },
    },
    connection: {
      active: { upstream: { baseURL: 'https://api.deepseek.com/v1', apiKeyEnv: 'KIMI_WORK_CONN_DEEPSEEK_KEY' },
        tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 3426, dns: { enabled: false, port: 53535 } },
      saved: null,
      environment: { apiKeySet: true, tokenSet: true },
    },
    connections: {
      active: [CONNECTION],
      saved: [CONNECTION],
      restartRequired: false,
    },
    context: {
      policy: { mode: 'custom', triggerRatio: 0.75, reservedTokens: 16000 },
      status: 'applied',
      observed: { triggerRatio: 0.75, reservedTokens: 16000 },
    },
    tools: {
      available: true,
      servers: [
        { name: 'filesystem', transport: 'stdio', enabled: true, command: 'npx', args: ['-y', '[redacted]'],
          envNames: ['TOKEN'], argsCount: 2 },
        { name: 'legacy-unknown', transport: 'unknown', enabled: true },
      ],
    },
    metrics: { startedAt: Date.now() - 1000, requests: 1, failures: 0, recent: [
      { at: Date.now(), model: 'deepseek/resp/deepseek-chat', upstreamModelId: 'deepseek-chat',
        connectionId: 'deepseek', protocol: 'responses', status: 200, firstByteMs: 240, ms: 1800,
        usage: { inputTokens: 120, outputTokens: 30 } },
      { at: Date.now(), model: 'legacy/model', protocol: 'responses', status: 200, ms: 900 },
    ] },
    diagnostics: {},
    setup: {},
    operation: null,
    ...overrides,
  };
}

function panel({ routes = {}, state = null } = {}) {
  const nodes = new Map();
  const requests = [];
  const stored = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  const window = { location: { hash: '#key=unit-panel-session', pathname: '/', search: '' },
    addEventListener() {}, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1,
    clearTimeout() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const respond = (status, body) => ({ ok: status < 400, status,
    headers: { get: () => 'application/json' }, json: async () => body });
  const fetch = async (path, init = {}) => {
    const entry = { path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(entry);
    const route = routes[path];
    const handler = typeof route === 'function' ? route : route ? () => route : () => ({ status: 200, body: stateWith() });
    const out = (await handler(entry, requests)) || { status: 200, body: stateWith() };
    return respond(out.status ?? 200, out.body ?? out);
  };
  const context = vm.createContext({
    document: { readyState: 'loading', hidden: false, documentElement: element(),
      getElementById: get, addEventListener() {}, querySelectorAll: () => [],
      createElement: element, createElementNS: element, createTextNode: (text) => ({ textContent: text }) },
    window, localStorage: storage, sessionStorage: storage,
    history: { replaceState() {} }, URL, URLSearchParams, requestAnimationFrame() {},
    fetch, IntersectionObserver: class { observe() {} disconnect() {} },
  });
  vm.runInContext(source + `
globalThis.panelUI = { state, adoptState, routeIdFor, routingOf, connectionDraftFrom, connectionsSignature,
  connectionsDirty, connectionPayload, validateConnectionDraft, contextDraftFrom, normalizedRatio,
  ratioToPercent, percentToRatio, validateContextDraft, evaluateContext, contextDirty, rankedCandidates,
  connectionScore, mcpServerPayload, toolsResultText, parseEnvLines, parseHeaderLines, toolsState, toolsAvailable,
  renderConnections, renderContext, renderTools, renderOverview, renderModels, saveConnections,
  saveContextPolicy, submitTools, openEditor, readEditorFields, renderEditor, validateEditor,
  buildModel, connectionDraftFrom: connectionDraftFrom, editorDirty: editorDirty, modelFamilyFor,
  pickCandidate, candidateProtocols, renderPicker, chooseProtocol, preferredProtocol,
  openPicker, searchCandidates, runDiscovery, pickerScope, applyBudgetPreset };`, context);
  return { ...context.panelUI, nodes, requests, get, state: context.panelUI.state };
}

// --- routing IDs -------------------------------------------------------------

test('a route ID encodes the real upstream ID and the protocol is readable from it', () => {
  const ui = panel();
  // The contract is connectionId + "/" + ("kimi-"|"resp-") + encodeURIComponent(upstream).
  // The encoded tail keeps IDs with slashes unambiguous.
  expect(ui.routeIdFor('deepseek', 'deepseek-chat')).toBe('deepseek/resp-deepseek-chat');
  expect(ui.routeIdFor('moonshot', 'kimi-k2')).toBe('moonshot/kimi-kimi-k2');
  expect(ui.routeIdFor('vendor', 'glm/5.3')).toBe('vendor/resp-glm%2F5.3');
  expect(ui.routeIdFor('', 'm')).toBe('');
  expect(ui.routeIdFor('deepseek', '')).toBe('');
  // Whatever the upstream ID, the generated last segment keeps the family rule the
  // gateway enforces: kimi- prefix means Chat, everything else Responses.
  for (const upstream of ['kimi-k2', 'deepseek-chat', 'glm/5.3', 'GLM-5.3']) {
    const id = ui.routeIdFor('c', upstream);
    const family = ui.modelFamilyFor(id);
    const expected = upstream.startsWith('kimi-') ? 'chat' : 'responses';
    expect(family).toBe(expected);
  }
});

test('routing keeps the upstream model ID exactly as the upstream reported it', () => {
  const ui = panel();
  const model = { id: 'c/resp/GLM-5.3-Flash', upstreamModelId: 'GLM-5.3-Flash', connectionId: 'c' };
  expect(ui.routingOf(model)).toEqual({ connectionId: 'c', connection: 'c', upstream: 'GLM-5.3-Flash', legacy: false });
  // A legacy model without a connection reports the local ID as the upstream ID.
  expect(ui.routingOf({ id: 'plain/model' }).upstream).toBe('plain/model');
});

// --- named connections -------------------------------------------------------

test('a connection payload omits an untouched key and never carries an empty one', () => {
  const ui = panel();
  const rows = [
    { ...ui.connectionDraftFrom(stateWith())[0], apiKey: 'sk-new' },
    { id: 'other', name: 'Other', baseURL: 'https://api.example.com/v1', apiKeyEnv: '', protocols: null,
      apiKey: '', legacy: false, secretSet: true },
  ];
  const payload = ui.connectionPayload(rows);
  expect(payload[0].apiKey).toBe('sk-new');
  expect(payload[1]).not.toHaveProperty('apiKey');
  expect(payload[1]).not.toHaveProperty('apiKeyEnv');
  // The legacy row is never sent: the whole-set replacement is named connections only.
  expect(ui.connectionPayload([...rows, { ...rows[0], legacy: true }])).toHaveLength(2);
});

test('saving a paste-in key marks the draft dirty without exposing the stored value', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.state.conns.base = ui.connectionsSignature(ui.connectionDraftFrom(data));
  ui.state.conns.draft = ui.connectionDraftFrom(data);
  expect(ui.connectionsDirty()).toBe(false);

  ui.state.conns.draft = ui.state.conns.draft.map((row) => ({ ...row, apiKey: 'sk-typed' }));
  expect(ui.connectionsDirty()).toBe(true);
  // The saved row never learns the secret: it is write-only in the UI.
  const saved = ui.connectionDraftFrom(data)[0];
  expect(saved.apiKey).toBe('');
  expect(saved.secretSet).toBe(false);
});

test('a new connection without a key is refused while an existing one may keep its key', () => {
  const ui = panel();
  const existing = ui.connectionDraftFrom(stateWith())[0];
  const base = { name: 'X', baseURL: 'https://api.example.com/v1', protocols: null };

  const kept = ui.validateConnectionDraft({ ...base, id: 'x', apiKey: '', secretSet: true }, [existing],
    { originalId: 'x' });
  expect(kept.errors.filter((error) => error.includes('API Key'))).toEqual([]);

  const missing = ui.validateConnectionDraft({ ...base, id: 'x', apiKey: '' }, [existing]);
  expect(missing.errors.join(' ')).toContain('API Key');

  const duplicate = ui.validateConnectionDraft({ ...base, id: 'deepseek', apiKey: 'sk-1' }, [existing]);
  expect(duplicate.errors.join(' ')).toContain('同名标识');

  const badId = ui.validateConnectionDraft({ ...base, id: 'has space', apiKey: 'sk-1' }, [existing]);
  expect(badId.errors.join(' ')).toContain('标识');

  const reuseEnv = ui.validateConnectionDraft({ ...base, id: 'y', apiKeyEnv: existing.apiKeyEnv, apiKey: 'sk-1' },
    [existing]);
  expect(reuseEnv.errors.join(' ')).toContain('变量名');
});

// --- context policy ----------------------------------------------------------

test('the trigger ratio is a decimal between 0.5 and 0.99 and never silently rescaled', () => {
  const ui = panel();
  expect(ui.normalizedRatio(0.5)).toBe(0.5);
  expect(ui.normalizedRatio(0.99)).toBe(0.99);
  expect(ui.normalizedRatio(0.49)).toBeNull();
  expect(ui.normalizedRatio(1)).toBeNull();
  // A percentage that leaked through the contract must not be reinterpreted.
  expect(ui.normalizedRatio(75)).toBeNull();
  expect(ui.normalizedRatio(undefined)).toBeNull();

  expect(ui.ratioToPercent(0.75)).toBe(75);
  expect(ui.ratioToPercent(0.755)).toBe(75.5);
  expect(ui.ratioToPercent(2)).toBeNull();
  expect(ui.percentToRatio('75')).toBe(0.75);
  expect(ui.percentToRatio('99')).toBe(0.99);
  expect(ui.percentToRatio('49')).toBeNull();
  expect(ui.percentToRatio('100')).toBeNull();
});

test('a custom context policy saves a decimal ratio and an integer reservation', () => {
  const ui = panel();
  const draft = { mode: 'custom', ratio: '80', reserved: '32000' };
  expect(ui.validateContextDraft(draft)).toMatchObject({ errors: [],
    value: { mode: 'custom', triggerRatio: 0.8, reservedTokens: 32000 } });
  // An empty reservation is zero rather than an error: it is the native default.
  expect(ui.validateContextDraft({ mode: 'custom', ratio: '60', reserved: '' }).value)
    .toEqual({ mode: 'custom', triggerRatio: 0.6, reservedTokens: 0 });
  expect(ui.validateContextDraft({ mode: 'custom', ratio: '40', reserved: '0' }).errors.join(' '))
    .toContain('50');
  expect(ui.validateContextDraft({ mode: 'custom', ratio: '75', reserved: '-1' }).errors.join(' '))
    .toContain('预留');
  // Inherit sends no ratio at all, so it cannot overwrite a native default.
  expect(ui.validateContextDraft({ mode: 'inherit' }).value).toEqual({ mode: 'inherit' });
});

test('an applied context policy is worded as written configuration, not a live adoption', () => {
  const ui = panel();
  const applied = ui.evaluateContext(stateWith());
  expect(applied.word).toBe('已写入原生配置');
  expect(applied.note).toContain('新会话');

  for (const status of ['inherit', 'waiting-config', 'conflict']) {
    const data = stateWith({ context: { policy: { mode: 'inherit' }, status, observed: {} } });
    expect(ui.evaluateContext(data).word).not.toBe('已写入原生配置');
  }
  const missing = ui.evaluateContext(stateWith({ context: undefined }));
  expect(missing.word).toBe('不可用');
});

test('the saved draft distinguishes an out-of-contract ratio from a real one', () => {
  const ui = panel();
  expect(ui.contextDraftFrom(stateWith()).ratio).toBe('75');
  // 0.75 read back from an unknown future shape stays visible as pending, not as 75%.
  const weird = stateWith({ context: { policy: { mode: 'custom', triggerRatio: 75 }, status: 'applied' } });
  expect(ui.contextDraftFrom(weird).ratio).toBe('');
});

test('saving the context policy posts the fixed shape and reports a written file honestly', async () => {
  let posted = null;
  const ui = panel({ routes: {
    '/api/context': (entry) => {
      posted = entry.body;
      return { status: 200, body: { context: { policy: { mode: 'custom', triggerRatio: 0.8, reservedTokens: 0 },
        status: 'applied', observed: { triggerRatio: 0.8 } } } };
    },
  } });
  const data = stateWith();
  ui.state.data = data;
  ui.state.context.base = JSON.stringify([ui.contextDraftFrom(data).mode, ui.contextDraftFrom(data).ratio,
    ui.contextDraftFrom(data).reserved]);
  ui.state.context.draft = { mode: 'custom', ratio: '80', reserved: '0' };
  ui.state.context.dirty = true;

  await ui.saveContextPolicy();
  expect(posted).toEqual({ policy: { mode: 'custom', triggerRatio: 0.8, reservedTokens: 0 } });
  expect(ui.state.data.context.status).toBe('applied');
});

// --- native MCP --------------------------------------------------------------

test('an MCP patch never replaces a stored secret with a redacted or empty value', () => {
  const ui = panel();
  const server = { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y'] };
  const built = ui.mcpServerPayload(server).server;
  expect(built).toEqual({ name: 'fs', transport: 'stdio', enabled: true, command: 'npx', args: ['-y'] });
  // No env key at all, so the native implementation keeps whatever is stored.
  expect(built).not.toHaveProperty('env');

  const rejected = ui.mcpServerPayload({ name: 'bad name', transport: 'stdio' }).errors;
  expect(rejected.join(' ')).toContain('名称');
  expect(ui.mcpServerPayload({ name: 'x', transport: 'stdio' }).errors.join(' ')).toContain('命令');
  expect(ui.mcpServerPayload({ name: 'x', transport: 'http', url: 'https://u:p@example.com/mcp' })
    .errors.join(' ')).toContain('账号');
});

test('environment and header lines become bounded maps and report malformed rows', () => {
  const ui = panel();
  const env = ui.parseEnvLines('TOKEN=abc\nBROKEN\n1BAD=x');
  expect(env.env).toEqual({ TOKEN: 'abc' });
  expect(env.invalid).toHaveLength(2);

  const headers = ui.parseHeaderLines('Authorization: Bearer abc\nnope');
  expect(headers.headers).toEqual({ Authorization: 'Bearer abc' });
  expect(headers.invalid).toHaveLength(1);
});

test('a test result is described from bounded fields and never echoes raw kernel output', () => {
  const ui = panel();
  const connected = ui.toolsResultText({ ok: true, state: 'connected', name: 'fs',
    tools: ['read', 'write'], summary: { toolCount: 2, declaredToolCount: 2 }, detail: 'RAW-OUTPUT-MARKER' });
  expect(connected).toContain('2 个工具');
  // The kernel's raw detail is deliberately not shown: redaction is best-effort only.
  expect(connected).not.toContain('RAW-OUTPUT-MARKER');

  // A declared/parsed mismatch means the output was truncated, so it cannot read as complete.
  const truncated = ui.toolsResultText({ ok: true, state: 'connected', name: 'fs', tools: ['read'],
    summary: { toolCount: 1, declaredToolCount: 9 }, detail: 'RAW' });
  expect(truncated).toContain('9');
  expect(truncated).toContain('截断');
  expect(truncated).not.toContain('RAW');

  expect(ui.toolsResultText({ ok: false, state: 'timeout', name: 'fs' })).toContain('结果未知');
  expect(ui.toolsResultText({ ok: false, state: 'busy', name: 'fs' })).toContain('尚未结束');
  expect(ui.toolsResultText({ ok: false, state: 'timeout', name: 'fs' })).not.toContain('失败');
  expect(ui.toolsResultText({ ok: false, state: 'not_found', reason: 'native_mcp_server_not_found', name: 'fs' }))
    .toContain('找不到');
  expect(ui.toolsResultText({ ok: false, state: 'invalid', field: 'command' })).toContain('command');
});

test('only an explicit test starts a server, and unknown transports stay read-only', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.renderTools();
  const rows = ui.nodes.get('tools-list').children;
  const stdio = rows.find((row) => row.dataset.mcpName === 'filesystem');
  const unknown = rows.find((row) => row.dataset.mcpName === 'legacy-unknown');
  expect(stdio).toBeTruthy();
  expect(unknown.dataset.transport).toBe('unknown');
  // Rendering the list performs no request: listing must never launch a process.
  expect(ui.requests.filter((entry) => entry.path === '/api/tools')).toHaveLength(0);
});

test('listing servers returns the state shape and never claims an unavailable manager works', () => {
  const ui = panel();
  const available = ui.toolsState(stateWith());
  expect(ui.toolsAvailable(stateWith())).toBe(true);
  expect(available.servers).toHaveLength(2);
  const down = stateWith({ tools: { available: false, reason: 'native_mcp_kernel_unavailable', servers: [] } });
  expect(ui.toolsAvailable(down)).toBe(false);
  expect(ui.toolsState(stateWith({ tools: undefined }))).toBeNull();
});

test('removing a server posts the fixed remove operation', async () => {
  let posted = null;
  const ui = panel({ routes: {
    '/api/tools': (entry) => {
      posted = entry.body;
      return { status: 200, body: { tools: { available: true, servers: [] },
        result: { ok: true, state: 'removed', name: 'filesystem' } } };
    },
  } });
  ui.state.data = stateWith();
  await ui.submitTools({ action: 'remove', name: 'filesystem' });
  expect(posted).toEqual({ action: 'remove', name: 'filesystem' });
});

// --- connections save --------------------------------------------------------

test('saving connections posts the whole set with the revision and reads back restart state', async () => {
  let posted = null;
  const saved = stateWith();
  saved.connections = { active: [CONNECTION], saved: [{ ...CONNECTION, name: 'Renamed' }], restartRequired: true };
  const ui = panel({ routes: {
    '/api/connections': (entry) => {
      posted = entry.body;
      return { status: 200, body: { ok: true, state: saved } };
    },
  } });
  const data = stateWith();
  ui.state.data = data;
  ui.state.conns.base = ui.connectionsSignature(ui.connectionDraftFrom(data));
  ui.state.conns.draft = ui.connectionDraftFrom(data).map((row) => ({ ...row, name: 'Renamed' }));
  ui.state.conns.dirty = true;

  await ui.saveConnections();
  expect(posted.revision).toBe('a'.repeat(64));
  expect(posted.connections).toHaveLength(1);
  expect(posted.connections[0]).toMatchObject({ id: 'deepseek', name: 'Renamed' });
  expect(posted.connections[0]).not.toHaveProperty('apiKey');
  expect(ui.state.data.connections.restartRequired).toBe(true);
});

test('a missing credential file is reported in place and never prints the key', async () => {
  const ui = panel({ routes: {
    '/api/connections': { status: 409, body: { error: { code: 'credentials_file_unavailable',
      message: '凭证文件不可用。' } } },
  } });
  const data = stateWith();
  ui.state.data = data;
  ui.state.conns.base = ui.connectionsSignature(ui.connectionDraftFrom(data));
  ui.state.conns.draft = ui.connectionDraftFrom(data).map((row) => ({ ...row, apiKey: 'sk-secret-value' }));
  ui.state.conns.dirty = true;

  await ui.saveConnections();
  const message = ui.nodes.get('conns-errors').children.map((child) => child.textContent || '').join(' ');
  expect(message).toContain('凭据文件');
  expect(message).not.toContain('sk-secret-value');
  expect(ui.nodes.get('toast').children.map((child) => child.textContent || '').join(' '))
    .not.toContain('sk-secret-value');
});

test('a candidate with no declared protocol stays unconfirmed while multi-protocol auto-fills', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.providerPresetId = '';

  // No protocol field at all and no preset: genuinely unknown, so nothing is inferred.
  ui.state.picker.models = [{ id: 'GLM/5.3', name: 'GLM 5.3', contextWindow: 350000 }];
  ui.state.picker.state = 'passed';
  ui.pickCandidate('GLM/5.3');
  expect(ui.state.editor.draft.upstreamModelId).toBe('GLM/5.3');
  expect(ui.state.editor.draft.id).toBe('');
  expect(ui.state.editor.draft.protocolConfirmed).toBe(false);
  expect(ui.nodes.get('m-protocol-hint').textContent).toContain('没有声明协议');
  expect(ui.state.editor.draft.id).not.toContain('resp-');

  // A single declared protocol confirms automatically.
  ui.state.picker.models = [{ id: 'glm-5.3', protocols: ['responses'] }];
  ui.pickCandidate('glm-5.3');
  expect(ui.state.editor.draft.id).toBe('deepseek/resp-glm-5.3');
  expect(ui.state.editor.draft.protocolConfirmed).toBe(true);
});

// `protocols: []` is the endpoint's own refusal (the parser only emits it when the
// endpoint stated something and denied every protocol). Reusing the preset there
// would overrule a vendor statement with a static table, so it must stay refused
// even when a preset would have supplied a protocol.
test('an explicit empty protocol list never falls back to the preset', () => {
  const ui = panel();
  ui.state.data = stateWith();
  ui.state.providers = { presets: [{ id: 'glm', name: 'GLM 官方', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['chat', 'responses'], models: [] }] };
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.providerPresetId = 'glm';

  ui.state.picker.models = [{ id: 'refused-model', protocols: [], contextWindow: 350000 }];
  ui.state.picker.state = 'passed';
  ui.pickCandidate('refused-model');
  expect(ui.state.editor.draft.id).toBe('');
  expect(ui.state.editor.draft.protocolConfirmed).toBe(false);
  expect(ui.state.editor.draft.protocolSource).toBeNull();
  expect(ui.state.editor.draft.protocolExplicitEmpty).toBe(true);
  // The wording must not read as "the catalog said nothing".
  const hint = ui.nodes.get('m-protocol-hint').textContent;
  expect(hint).toContain('明确声明不支持');
  expect(hint).not.toContain('没有声明协议');

  // The inverse: a missing field is not a statement, so the preset may supply it.
  ui.state.picker.models = [{ id: 'absent-model', contextWindow: 350000 }];
  ui.pickCandidate('absent-model');
  expect(ui.state.editor.draft.id).toBe('deepseek/resp-absent-model');
  expect(ui.state.editor.draft.protocolSource).toBe('preset');
  expect(ui.state.editor.draft.protocolExplicitEmpty).toBe(false);
});

test('a multi-protocol candidate auto-fills preferring Responses and stays switchable', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.providerPresetId = '';

  // Many catalogs (Kimi, DeepSeek, OpenAI) declare both; this is declared, not unknown.
  ui.state.picker.models = [{ id: 'deepseek-chat', protocols: ['chat', 'responses'] }];
  ui.state.picker.state = 'passed';
  ui.pickCandidate('deepseek-chat');
  expect(ui.state.editor.draft.id).toBe('deepseek/resp-deepseek-chat');
  expect(ui.state.editor.draft.protocolConfirmed).toBe(true);
  expect(ui.state.editor.draft.protocolSource).toBe('discovery');
  expect(ui.nodes.get('m-protocol-hint').textContent).toContain('可切换协议');
  // The real upstream ID is untouched by the route-prefix choice.
  expect(ui.state.editor.draft.upstreamModelId).toBe('deepseek-chat');

  // Switching to Chat rewrites only the route family prefix.
  ui.chooseProtocol('chat');
  expect(ui.state.editor.draft.id).toBe('deepseek/kimi-deepseek-chat');
  expect(ui.state.editor.draft.upstreamModelId).toBe('deepseek-chat');
  expect(ui.modelFamilyFor(ui.state.editor.draft.id)).toBe('chat');

  // A chat-only announcement auto-selects chat.
  ui.state.picker.models = [{ id: 'kimi-k2', protocols: ['chat'] }];
  ui.pickCandidate('kimi-k2');
  expect(ui.state.editor.draft.id).toBe('deepseek/kimi-kimi-k2');
  expect(ui.modelFamilyFor(ui.state.editor.draft.id)).toBe('chat');
});

test('a preset protocol is used only when discovery declares none, and it is labelled as preset', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.state.providers = { presets: [{ id: 'glm', name: 'GLM 官方', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['chat'], models: [] }] };
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.providerPresetId = 'glm';
  ui.state.picker.models = [{ id: 'glm-5.3' }];
  ui.pickCandidate('glm-5.3');
  expect(ui.state.editor.draft.id).toBe('deepseek/kimi-glm-5.3');
  expect(ui.state.editor.draft.protocolSource).toBe('preset');
  expect(ui.nodes.get('m-protocol-hint').textContent).toContain('预设');

  // Writing the route ID by hand counts as an explicit protocol choice.
  ui.state.editor.draft.protocolConfirmed = false;
  ui.state.editor.draft.protocolHint = '请手动确认';
  ui.get('m-id').value = 'deepseek/resp-glm-5.3';
  ui.readEditorFields();
  expect(ui.state.editor.draft.protocolConfirmed).toBe(true);
});

// --- budget and routing in the editor ---------------------------------------

test('a budget above a known upstream limit is rejected instead of raising the limit', () => {
  const ui = panel();
  ui.state.data = stateWith();
  const over = ui.buildModel({ id: 'c/resp/m', context: '600000', contextLimit: '262144' });
  expect(over.errors.join(' ')).toContain('超过已知上限');

  const atLimit = ui.buildModel({ id: 'c/resp/m', context: '262144', contextLimit: '262144' });
  expect(atLimit.errors).toEqual([]);
  expect(atLimit.model.contextLimit).toBe(262144);

  // An unknown limit is simply absent: nothing is invented for it.
  const unknown = ui.buildModel({ id: 'c/resp/m', context: '262144' });
  expect(unknown.model).not.toHaveProperty('contextLimit');
});

test('metadata provenance is kept only for the three contract kinds', () => {
  const ui = panel();
  ui.state.data = stateWith();
  const discovered = ui.buildModel({ id: 'c/resp/m', context: '1000',
    metadataSource: { kind: 'discovery', url: 'https://api.example.com/v1/models', checkedAt: '2026-11-02T10:00:00Z' } });
  expect(discovered.model.metadataSource).toEqual({ kind: 'discovery',
    url: 'https://api.example.com/v1/models', checkedAt: '2026-11-02T10:00:00Z' });
  const bogus = ui.buildModel({ id: 'c/resp/m', context: '1000',
    metadataSource: { kind: 'guessed', checkedAt: '2026-11-02T10:00:00Z' } });
  expect(bogus.model).not.toHaveProperty('metadataSource');
});

// The saved budget keeps its evidence, so the provenance recorded for a picked
// candidate has to be the provenance of `contextWindow` — not "whatever this
// search happened to include".
test('picking a candidate records the provenance of its context window only', () => {
  const ui = panel();
  ui.state.data = stateWith();
  ui.state.providers = { presets: [{ id: 'glm', name: 'GLM 官方', baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['chat'], models: [] }] };
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.providerPresetId = 'glm';

  // The backend merged a discovery row into a preset row: the endpoint stated the
  // context window, so `metadataSource` is discovery and that is what gets saved.
  ui.state.picker.models = [{
    id: 'glm-5.3', protocols: ['chat'], contextWindow: 350000,
    metadataSource: { kind: 'discovery', url: 'https://open.bigmodel.cn/api/paas/v4/models',
      checkedAt: '2026-11-02T10:00:00Z' },
    sources: {
      preset: { kind: 'preset', url: 'https://docs.bigmodel.cn/model-overview', checkedAt: '2026-11-02' },
      discovery: { kind: 'discovery', url: 'https://open.bigmodel.cn/api/paas/v4/models',
        checkedAt: '2026-11-02T10:00:00Z' },
    },
  }];
  ui.state.picker.state = 'passed';
  ui.pickCandidate('glm-5.3');
  expect(ui.state.editor.draft.metadataSource).toEqual({ kind: 'discovery',
    url: 'https://open.bigmodel.cn/api/paas/v4/models', checkedAt: '2026-11-02T10:00:00Z' });

  // A preset-only candidate is labelled as a preset, never as a scan result.
  ui.state.picker.models = [{
    id: 'glm-static', protocols: ['chat'], contextWindow: 200000,
    metadataSource: { kind: 'preset', url: 'https://docs.bigmodel.cn/model-overview', checkedAt: '2026-11-02' },
  }];
  ui.pickCandidate('glm-static');
  expect(ui.state.editor.draft.metadataSource.kind).toBe('preset');

  // A discovery that reported other capabilities but no context window: the
  // budget came from the preset, and only a single-source merge is attributable.
  ui.state.picker.models = [{
    id: 'glm-partial', protocols: ['chat'],
    sources: { preset: { kind: 'preset', checkedAt: '2026-11-02' } },
  }];
  ui.pickCandidate('glm-partial');
  expect(ui.state.editor.draft.metadataSource).toEqual({ kind: 'preset', checkedAt: '2026-11-02' });

  // Nothing tells us where the number came from: manual, not an invented scan.
  ui.state.picker.models = [{ id: 'glm-bare', protocols: ['chat'], contextWindow: 128000 }];
  ui.pickCandidate('glm-bare');
  expect(ui.state.editor.draft.metadataSource).toEqual({ kind: 'manual' });
});

test('approximate search ranks exact and prefix matches first and keeps every upstream ID intact', () => {
  const ui = panel();
  const models = [
    { id: 'vendor/glm-5.3-flash' },
    { id: 'vendor/glm-5.3' },
    { id: 'other/deepseek-v4-1-flash' },
    { id: 'vendor/GLM5.3' },
  ];
  expect(ui.rankedCandidates(models, 'glm5.3')[0].id.toLowerCase()).toBe('vendor/glm5.3');
  const ranked = ui.rankedCandidates(models, 'glm').map((model) => model.id);
  expect(ranked).toHaveLength(3);
  // Ranking never rewrites an ID: whatever comes back is one of the inputs.
  expect(ranked.every((id) => models.some((model) => model.id === id))).toBe(true);
  expect(ranked).toContain('vendor/GLM5.3');

  const exact = ui.rankedCandidates(models, 'vendor/glm-5.3')[0];
  expect(exact.id).toBe('vendor/glm-5.3');
  // An unrelated query yields nothing instead of a fallback selection.
  expect(ui.rankedCandidates(models, 'zzzz')).toEqual([]);
});

// --- overview ---------------------------------------------------------------

test('the overview reports a route and marks unknown usage as not provided', () => {
  const ui = panel();
  const data = stateWith();
  ui.state.data = data;
  ui.renderOverview(data);
  expect(ui.nodes.get('fact-route').textContent).toBe('deepseek-chat');
  expect(ui.nodes.get('fact-route-sub').textContent).toContain('deepseek');
  expect(ui.nodes.get('fact-connections').textContent).toContain('1 条连接');
  expect(ui.nodes.get('fact-context').textContent).toBe('已写入原生配置');
  expect(ui.nodes.get('fact-tools').textContent).toContain('2 个服务器');

  const usage = ui.nodes.get('recent-body').children
    .map((row) => row.children.map((cell) => cell.textContent));
  expect(usage[0]).toContain('120 / 30');
  expect(usage[1]).toContain('未提供');
  // First byte is reported as measured, not as a first-token latency.
  const headers = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  expect(headers).toContain('首字节');
  expect(headers).not.toContain('首 token');
  expect(headers).toContain('平均输出速率');
  expect(headers).toContain('上次请求输入');
  expect(headers).not.toContain('距上限');
  // The rate is labelled as a whole-request average, never as a token speed.
  expect(headers).toContain('含等待首字节的时间');
});

// `rate` and `context` are measurements of one finished request. An absent or
// unrecognised basis is "not provided", never a number reinterpreted as another
// unit, and the context figure is the last request's input — not a live session.
test('the flow table reports the request rate and the last request context honestly', () => {
  const ui = panel();
  const data = stateWith();
  data.metrics.recent = [
    { at: Date.now(), upstreamModelId: 'm1', status: 200, ms: 1800,
      usage: { inputTokens: 120, outputTokens: 30 },
      rate: { averageOutputTokensPerSecond: 16.67, basis: 'total_request_time' },
      context: { usedTokens: 120000, limitTokens: 262144, ratio: 0.458, source: 'upstream_usage' } },
    // A basis we do not know is not converted into tok/s.
    { at: Date.now(), upstreamModelId: 'm2', status: 200, ms: 900,
      rate: { averageOutputTokensPerSecond: 12, basis: 'per_token' } },
    // A failed or unfinished request has no context figure at all.
    { at: Date.now(), upstreamModelId: 'm3', status: 500, ms: 400, error: 'upstream_connection_failed' },
  ];
  ui.state.data = data;
  ui.renderOverview(data);
  const cells = ui.nodes.get('recent-body').children
    .map((row) => row.children.map((cell) => cell.textContent));
  const columns = ['time', 'model', 'protocol', 'status', 'firstByte', 'total', 'rate', 'usage', 'context'];
  const row = (index) => Object.fromEntries(columns.map((name, at) => [name, cells[index][at]]));

  expect(row(0).rate).toBe('16.7 tok/s');
  // The figure is the last request's input against the *configured budget*, so
  // the wording must not read as "distance to the vendor's hard limit".
  expect(row(0).context).toContain('120,000 tokens');
  expect(row(0).context).toContain('占预算 46%');
  expect(row(0).context).not.toContain('剩余');
  expect(row(1).rate).toBe('未提供');
  expect(row(1).context).toBe('未提供');
  expect(row(2).rate).toBe('未提供');
  expect(row(2).context).toBe('未提供');
  // A known budget with an unknown limit still reports the measured input.
  data.metrics.recent = [{ at: Date.now(), upstreamModelId: 'm4', status: 200, ms: 100,
    context: { usedTokens: 5000, source: 'upstream_usage' } }];
  ui.recentSignature = '';
  ui.renderOverview(data);
  const limited = ui.nodes.get('recent-body').children[0].children
    .map((cell) => cell.textContent);
  expect(limited[8]).toContain('5,000 tokens');
  expect(limited[8]).toContain('预算未知');
});

test('the panel renders without a connections or context block at all', () => {
  const ui = panel();
  const data = stateWith({ connections: undefined, context: undefined, tools: undefined });
  ui.state.data = data;
  expect(() => ui.renderOverview(data)).not.toThrow();
  expect(() => ui.renderConnections()).not.toThrow();
  expect(() => ui.renderContext()).not.toThrow();
  expect(() => ui.renderTools()).not.toThrow();
  expect(ui.nodes.get('conns-unavailable').hidden).toBe(false);
  expect(ui.nodes.get('ctx-unavailable').hidden).toBe(false);
});

// --- unified candidate search ------------------------------------------------

// The catalog must come from `/api/model-search`, not from a raw discovery dump:
// the shared endpoint is the only thing that merges the preset, the last
// discovery, aliases and per-model provenance, so the picker cannot disagree
// with what saving later records.
test('opening the picker searches the connection instead of showing an empty list', async () => {
  const search = [];
  const ui = panel({ routes: {
    '/api/model-search': (entry) => {
      search.push(entry.body);
      return { status: 200, body: { query: entry.body.query, models: [
        { id: 'gpt-6-astra', protocols: ['chat', 'responses'], contextWindow: 1050000,
          aliases: ['Astra'], metadataSource: { kind: 'preset', checkedAt: '2026-11-02' } },
        { id: 'gpt-6.1-sol', protocols: ['responses'], contextWindow: 1050000 },
      ] } };
    },
  } });
  ui.state.data = stateWith();
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';

  ui.openPicker();
  // `openPicker` kicks off the request; let the promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  expect(search).toHaveLength(1);
  expect(search[0]).toEqual({ query: '', connectionId: 'deepseek' });
  const listed = ui.nodes.get('picker-list').children.map((row) => row.children[0].dataset.candidateId);
  expect(listed).toEqual(['gpt-6-astra', 'gpt-6.1-sol']);
  expect(ui.nodes.get('picker-lede').textContent).toContain('供应商目录');
});

test('a non-empty query is sent to the shared search and its ranking is kept', async () => {
  const search = [];
  const ui = panel({ routes: {
    '/api/model-search': (entry) => {
      search.push(entry.body);
      // The server ranks: an alias hit comes back first and nothing else does.
      const models = entry.body.query === 'aster' ? [{ id: 'gpt-6-astra', aliases: ['Astra'] }] : [];
      return { status: 200, body: { query: entry.body.query, models } };
    },
  } });
  ui.state.data = stateWith();
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.picker.open = true;

  await ui.searchCandidates('aster');
  expect(search.at(-1)).toEqual({ query: 'aster', connectionId: 'deepseek' });
  // The local list must not re-rank or drop what the server returned.
  const listed = ui.nodes.get('picker-list').children.map((row) => row.children[0].dataset.candidateId);
  expect(listed).toEqual(['gpt-6-astra']);

  await ui.searchCandidates('zzz');
  expect(ui.nodes.get('picker-empty').hidden).toBe(false);
  expect(ui.nodes.get('picker-empty-title').textContent).toBe('没有匹配的候选');
});

// A fast connection or keyword change must not let an older answer overwrite
// newer state, and the losing request must leave the busy flag alone.
test('a stale search answer never overwrites a newer one', async () => {
  const pending = [];
  const ui = panel({ routes: {
    '/api/model-search': (entry) => new Promise((resolve) => {
      pending.push({ query: entry.body.query, resolve });
    }),
  } });
  ui.state.data = stateWith();
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.picker.open = true;

  const first = ui.searchCandidates('glm');
  const second = ui.searchCandidates('kimi');
  // Answer the newest request first, then the stale one.
  pending[1].resolve({ status: 200, body: { query: 'kimi', models: [{ id: 'kimi-k3' }] } });
  await second;
  pending[0].resolve({ status: 200, body: { query: 'glm', models: [{ id: 'glm-5.3' }] } });
  await first;

  const listed = ui.nodes.get('picker-list').children.map((row) => row.children[0].dataset.candidateId);
  expect(listed).toEqual(['kimi-k3']);
  expect(ui.state.picker.busy).toBe(false);
});

test('a failed search is reported in place while the preset catalog stays usable', async () => {
  let calls = 0;
  const ui = panel({ routes: {
    '/api/model-search': (entry) => {
      calls++;
      if (calls === 1) return { status: 200, body: { query: '', models: [{ id: 'k3' }] } };
      return { status: 503, body: { error: { code: 'panel_operation_failed' } } };
    },
  } });
  ui.state.data = stateWith();
  ui.openEditor(null);
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.picker.open = true;

  await ui.searchCandidates('');
  expect(ui.nodes.get('picker-list').children).toHaveLength(1);
  await ui.searchCandidates('broken');
  // The failure is shown, and the previously loaded rows are not silently kept
  // as if the new query had matched them.
  expect(ui.state.picker.reason).toBe('panel_operation_failed');
  expect(ui.nodes.get('picker-state').textContent).toContain('未完成');
});

// --- budget presets wired to the real markup --------------------------------

/* The budget buttons and the script must agree on one vocabulary. Reading the
   values out of `ui/index.html` (rather than repeating the constants here) is
   what makes this test catch a markup change: a token number in `data-budget`
   finds no preset, and the old code threw on `preset.label`, which aborted the
   rest of `renderEditor` — the save button, the context hint and the default
   effort all froze at their previous values. */
const MARKUP = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

function markupBudgetButtons() {
  const group = /<div class="segmented segmented--budget"[\s\S]*?<\/div>/.exec(MARKUP)?.[0] ?? '';
  return [...group.matchAll(/data-budget="([^"]+)"/g)].map((match) => match[1]);
}

/* `dom.mBudgetGroup` was captured while the script evaluated, so the buttons
   have to be attached to that very element — replacing the node would leave the
   renderer looking at the empty original. */
function seedBudgetGroup(group) {
  group.children = markupBudgetButtons().map((id) => {
    const button = element();
    button.dataset.budget = id;
    return button;
  });
  return group;
}

test('every budget button in the markup names a preset the script knows', () => {
  const ids = markupBudgetButtons();
  expect(ids).toEqual(['256k', '350k', '600k', 'full']);
  // The same list the script resolves against, read from its own source.
  const declared = [...source.matchAll(/\{ id: '([^']+)', label: '([^']+)', tokens: (null|\d+) \}/g)]
    .map((match) => ({ id: match[1], label: match[2], tokens: match[3] === 'null' ? null : Number(match[3]) }));
  expect(declared.map((entry) => entry.id)).toEqual(ids);
});

test('rendering with the real budget buttons marks the matching one and never throws', () => {
  const ui = panel();
  ui.state.data = stateWith();
  ui.openEditor(null);
  const group = seedBudgetGroup(ui.nodes.get('m-budget-group'));
  ui.state.editor.draft.id = 'deepseek/resp-deepseek-chat';
  ui.state.editor.draft.connectionId = 'deepseek';
  ui.state.editor.draft.context = '262144';
  ui.state.editor.draft.contextLimit = '1048576';
  ui.renderEditor();

  const byId = Object.fromEntries(group.children.map((button) => [button.dataset.budget, button]));
  // 256K is the current budget, so it is the pressed one.
  expect(byId['256k'].attrs['aria-pressed']).toBe('true');
  expect(byId['350k'].attrs['aria-pressed']).toBe('false');
  expect(byId['600k'].attrs['aria-pressed']).toBe('false');
  expect(byId.full.attrs['aria-pressed']).toBe('false');
  // The budget hint is written from the real limit, not left at its static text.
  expect(ui.nodes.get('m-context-hint').textContent).toContain('1,048,576');
  // Nothing threw, so the save button reached its normal enabled state.
  expect(ui.nodes.get('model-save').disabled).toBe(false);
});

test('clicking a real budget button sets the budget the user asked for', () => {
  const ui = panel();
  ui.state.data = stateWith();
  ui.openEditor(null);
  const group = seedBudgetGroup(ui.nodes.get('m-budget-group'));
  ui.state.editor.draft.contextLimit = '1048576';
  ui.state.editor.draft.context = '262144';

  const target = group.children.find((button) => button.dataset.budget === '350k');
  ui.applyBudgetPreset(target.dataset.budget);
  expect(ui.state.editor.draft.context).toBe('350000');
  expect(ui.nodes.get('m-context').value).toBe('350000');

  // The full option follows the known limit, and is refused when it is unknown.
  ui.state.editor.draft.contextLimit = '';
  ui.state.editor.draft.context = '350000';
  ui.applyBudgetPreset('full');
  expect(ui.state.editor.draft.context).toBe('350000');
  // The refusal is recorded on the editor; the error box is later used for the
  // form's own validation messages, so the note is what this asserts.
  expect(ui.state.editor.budgetNote).toContain('未知上游上限');
});

test('an unrecognised budget button is disabled instead of breaking the editor', () => {
  const ui = panel();
  ui.state.data = stateWith();
  ui.openEditor(null);
  const group = ui.nodes.get('m-budget-group');
  const stray = element();
  stray.dataset.budget = '262144';
  group.children = [stray];
  // This is the exact shape that used to throw: a token number in data-budget.
  expect(() => ui.renderEditor()).not.toThrow();
  expect(stray.disabled).toBe(true);
  expect(stray.attrs.title).toContain('未识别');
});

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

function element() {
  return { dataset: {}, style: {}, textContent: '', value: '', checked: false, disabled: false,
    hidden: false, scrollTop: 0, firstChild: null, id: '', type: '', attrs: {},
    events: new Map(), children: [], classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this.events.set(name, handler); },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); },
    querySelectorAll: () => [], querySelector: () => null, closest: () => null, focus() {} };
}

const MODEL = 'group/deepseek-v4-1-flash';
const ALIAS = 'byok-kth-resp/' + MODEL;

function models() {
  return [
    { id: MODEL, name: 'DeepSeek V4.1 Flash', protocol: 'responses', contextWindow: 128000,
      maxOutputTokens: 8192, tools: true, reasoning: true, inputModalities: ['text'],
      reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'other/deepseek-v4-1-flash', protocol: 'responses', contextWindow: 64000, tools: true },
  ];
}

function baseState(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 'a'.repeat(64),
    configuration: { state: 'ready', file: 'gateway.json' },
    gateway: { state: 'running', url: 'http://127.0.0.1:3426/v1', modelCount: 2, activeRequests: 0 },
    models: models(),
    subagents: {
      configured: { mode: 'force', model: MODEL, modelAlias: ALIAS, effort: 'low' },
      policy: { mode: 'force', model: MODEL, modelAlias: ALIAS, effort: 'low' },
      runtime: { state: 'loaded', mode: 'force', modelAlias: ALIAS, version: '3.2.21' },
    },
    connection: {
      active: { upstream: { baseURL: 'https://api.example.com/v1', apiKeyEnv: 'UPSTREAM_API_KEY' },
        tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 3426, dns: { enabled: false, port: 53535 } },
      saved: null,
      environment: { apiKeySet: true, tokenSet: true },
    },
    metrics: { startedAt: 1, requests: 3, failures: 1, recent: [] },
    diagnostics: {},
    setup: {},
    operation: null,
    ...overrides,
  };
}

function translationState(overrides = {}) {
  return {
    configured: { enabled: false, provider: 'bing', targetLanguage: 'zh', view: 'translated',
      customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' },
    environment: { keySet: false },
    runtime: { state: 'disabled' },
    ...overrides,
  };
}

function ui({ routes = {}, hash = '' } = {}) {
  const nodes = new Map();
  const events = new Map();
  const stored = new Map();
  const requests = [];
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const storage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  const window = { location: { hash, pathname: '/', search: '' },
    addEventListener: (name, handler) => events.set(name, handler),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const respond = (status, body) => ({ ok: status < 400, status,
    headers: { get: () => 'application/json' }, json: async () => body });
  const fetch = async (path, init = {}) => {
    const entry = { path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(entry);
    const route = routes[path];
    const handler = typeof route === 'function' ? route : route ? () => route : () => ({ status: 200, body: baseState() });
    const out = (await handler(entry, requests)) || { status: 200, body: baseState() };
    return respond(out.status ?? 200, out.body ?? out);
  };
  const context = vm.createContext({
    document: { readyState: 'loading', hidden: false, documentElement: element(),
      getElementById: get, addEventListener() {}, querySelectorAll: () => [],
      createElement: element, createElementNS: element, createTextNode: (text) => ({ textContent: text }) },
    window, localStorage: storage, sessionStorage: storage,
    history: { replaceState() { window.location.hash = ''; } },
    URL, URLSearchParams, requestAnimationFrame() {},
    fetch,
    IntersectionObserver: class { observe() {} disconnect() {} },
  });
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  vm.runInContext(source + `
globalThis.panelUI = { state, modelIdFromAlias, evaluateBinding, isInFlight, confirmActionResult,
  buildModel, parseEfforts, catalogueWith, buildConnection, evaluateSubagentDraft, savedTarget,
  adoptState, openEditor, closeEditor, editorDirty, saveCatalogue, modelFamilyFor, declaredEfforts,
  hasVision, setView, renderAll, renderOverview, renderModels, renderSubagents, renderConnection,
  renderOperation, loadState, readEditorFields, renderEditor, validateEditor,
  buildTranslation, savedTranslation, evaluateTranslation, translationLaunchState, translationKey,
  translationFormValues, fillTranslationForm, renderTranslation, saveTranslation, translationAvailable };`, context);
  return { ...context.panelUI, window, events, nodes, requests };
}

function messageOf(panel) {
  return panel.nodes.get('toast').children.map((child) => child.textContent || '').join('');
}

test('the panel resolves complete gateway model IDs without confusing provider prefixes', () => {
  const panel = ui();
  panel.state.data = baseState();
  expect(panel.modelIdFromAlias(MODEL)).toBe(MODEL);
  expect(panel.modelIdFromAlias(ALIAS)).toBe(MODEL);
  expect(panel.modelIdFromAlias('byok-kth-kimi/' + MODEL)).toBe(MODEL);
  expect(panel.modelIdFromAlias('byok-kth-resp/other/deepseek-v4-1-flash')).toBe('other/deepseek-v4-1-flash');
  expect(panel.modelIdFromAlias('unrecognized/deepseek-v4-1-flash')).toBeNull();
});

test('the panel only confirms force after the loaded runtime and applied policy match the saved target', () => {
  const panel = ui();
  const data = baseState();
  panel.state.data = data;
  expect(panel.evaluateBinding(data).word).toBe('已生效');
  for (const change of [
    (value) => { value.subagents.runtime.mode = 'inherit'; },
    (value) => { value.subagents.runtime.state = 'waiting-launch'; },
    (value) => { value.subagents.runtime.modelAlias = 'byok-kth-resp/other/deepseek-v4-1-flash'; },
    (value) => { value.subagents.policy.effort = 'high'; },
    (value) => { value.subagents.policy.model = 'other/deepseek-v4-1-flash'; },
    (value) => { value.subagents.policy.mode = 'blocked'; },
  ]) {
    const mismatch = baseState();
    change(mismatch);
    panel.state.data = mismatch;
    expect(panel.evaluateBinding(mismatch).word).not.toBe('已生效');
  }
});

test('the panel confirms inheritance from the runtime mode rather than only the saved policy', () => {
  const panel = ui();
  const data = baseState();
  data.subagents.configured = { mode: 'inherit' };
  data.subagents.policy = { mode: 'inherit' };
  panel.state.data = data;
  expect(panel.evaluateBinding(data).word).not.toBe('继承已生效');
  data.subagents.runtime = { state: 'loaded', mode: 'inherit' };
  expect(panel.evaluateBinding(data).word).toBe('继承已生效');
});

test('a completed Kimi launch request does not permanently lock panel controls', () => {
  const panel = ui();
  expect(panel.isInFlight({ state: 'running' })).toBe(true);
  for (const state of ['starting', 'waiting-kimi-exit', 'prepared', 'copied', 'passed', 'verified',
    'failed', 'interrupted', 'unavailable']) {
    expect(panel.isInFlight({ state })).toBe(false);
  }
});

test('a panel first opened without a key can accept the complete startup link later', async () => {
  const panel = ui();
  expect(panel.state.key).toBeNull();
  const receive = panel.events.get('hashchange');
  expect(typeof receive).toBe('function');
  panel.window.location.hash = '#key=unit-panel-session';
  receive();
  expect(panel.state.key).toBe('unit-panel-session');
  expect(panel.window.location.hash).toBe('');
  await Promise.resolve();
});

test('retrying the session gate successfully resumes periodic state refresh', async () => {
  const panel = ui({ hash: '#key=unit-panel-session' });
  await panel.nodes.get('gate-retry').events.get('click')();
  expect(panel.state.started).toBe(true);
  expect(panel.state.timer).not.toBeNull();
});

test('clipboard feedback only claims success for the matching completed operation', async () => {
  const panel = ui();
  panel.state.data = { operation: { id: 'owned-operation', state: 'running' } };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(messageOf(panel)).toBe('');
  panel.state.data.operation = { id: 'another-operation', state: 'copied' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(messageOf(panel)).toBe('');
  panel.state.data.operation = { id: 'owned-operation', state: 'unavailable' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(messageOf(panel)).toContain('未复制');
  panel.state.data.operation = { id: 'owned-operation', state: 'copied' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(messageOf(panel)).toContain('已由服务端写入系统剪贴板');
});

test('custom reasoning efforts serialize as declared identifiers and only a declared default is kept', () => {
  const panel = ui();
  panel.state.data = baseState();

  const built = panel.buildModel({ id: 'group/custom-model', context: '131072', output: '8192',
    tools: true, reasoning: true, vision: false, efforts: 'Low, medium ,high,xhigh, my-tier', defaultEffort: 'xhigh' });
  expect(built.errors).toEqual([]);
  expect(built.model.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'my-tier']);
  expect(built.model.defaultEffort).toBe('xhigh');
  expect(built.model.inputModalities).toEqual(['text']);

  const undeclaredDefault = panel.buildModel({ id: 'group/custom-model', context: '8192',
    reasoning: true, efforts: 'low', defaultEffort: 'high' });
  expect(undeclaredDefault.errors.join(' ')).toContain('默认档位');

  const invalid = panel.buildModel({ id: 'group/custom-model', context: '8192', reasoning: true, efforts: 'low, 3fast, Hi There' });
  expect(invalid.errors.join(' ')).toContain('3fast');

  const parsed = panel.parseEfforts('low, low, HIGH');
  expect(parsed.list).toEqual(['low', 'high']);
  expect(parsed.invalid).toEqual([]);

  const noReasoning = panel.buildModel({ id: 'group/custom-model', context: '8192', reasoning: false, efforts: 'low' });
  expect(noReasoning.model.reasoningEfforts).toBeUndefined();
  expect(noReasoning.model.defaultEffort).toBeUndefined();
});

test('model protocol follows the last ID segment and vision changes the input modalities', () => {
  const panel = ui();
  panel.state.data = baseState();
  expect(panel.modelFamilyFor('kimi-group/kimi-k2')).toBe('chat');
  expect(panel.modelFamilyFor('kimi-group/other-model')).toBe('responses');
  expect(panel.modelFamilyFor('group/deepseek-v4-1-flash')).toBe('responses');
  expect(panel.modelFamilyFor('')).toBeNull();

  const chat = panel.buildModel({ id: 'group/kimi-k2', context: '262144', tools: true, vision: true });
  expect(chat.model.protocol).toBe('chat');
  expect(chat.model.inputModalities).toEqual(['text', 'image']);

  const responses = panel.buildModel({ id: 'group/kimi-k2/glm-5', context: '262144' });
  expect(responses.model.protocol).toBe('responses');
  expect(responses.model.inputModalities).toEqual(['text']);
});

test('the catalogue editor replaces the edited row and appends new models without touching the rest', () => {
  const panel = ui();
  panel.state.data = baseState();
  const original = panel.state.data.models.map((model) => ({ ...model }));

  panel.openEditor(panel.state.data.models[0]);
  panel.state.editor.draft.context = '200000';
  panel.state.editor.draft.efforts = 'low, medium, high';
  panel.state.editor.draft.defaultEffort = 'medium';
  const replaced = panel.catalogueWith(panel.state.editor, panel.state.data.models);

  expect(replaced.length).toBe(2);
  expect(replaced[0].id).toBe(MODEL);
  expect(replaced[0].contextWindow).toBe(200000);
  expect(replaced[0].reasoningEfforts).toEqual(['low', 'medium', 'high']);
  expect(replaced[0].defaultEffort).toBe('medium');
  expect(replaced[1]).toEqual(original[1]);

  panel.closeEditor(true);
  panel.openEditor(null);
  panel.state.editor.draft.id = 'group/brand-new-model';
  panel.state.editor.draft.context = '32768';
  panel.state.editor.draft.tools = false;
  const appended = panel.catalogueWith(panel.state.editor, panel.state.data.models);
  expect(appended.length).toBe(3);
  expect(appended[2].id).toBe('group/brand-new-model');
  expect(appended[2].protocol).toBe('responses');
  expect(appended[2].tools).toBe(false);
});

test('an undeclared effort is reported as a problem instead of being offered as supported', () => {
  const panel = ui();
  const data = baseState();
  panel.state.data = data;

  const declared = panel.evaluateSubagentDraft({ mode: 'force', model: MODEL, effort: 'high' }, data);
  expect(declared.problems).toEqual([]);

  const undeclared = panel.evaluateSubagentDraft({ mode: 'force', model: MODEL, effort: 'xhigh' }, data);
  expect(undeclared.problems.join(' ')).toContain('未声明档位 xhigh');
  expect(undeclared.problems.join(' ')).toContain('模型管理');

  const noTools = panel.evaluateSubagentDraft({ mode: 'force', model: 'group/text-only', effort: null }, {
    ...data,
    models: [...data.models, { id: 'group/text-only', protocol: 'responses', contextWindow: 8192, tools: false }],
  });
  expect(noTools.problems.join(' ')).toContain('工具调用');

  const inherit = panel.evaluateSubagentDraft({ mode: 'inherit', model: null, effort: null }, data);
  expect(inherit.problems).toEqual([]);
});

test('a polling refresh keeps an unsaved subagent draft and an unsaved connection draft', () => {
  const panel = ui();
  panel.state.data = baseState();

  panel.state.draft = { mode: 'force', model: MODEL, effort: 'high' };
  panel.state.draftDirty = true;
  panel.nodes.get('c-base').value = 'https://edited.example.com/v1';
  panel.state.conn.dirty = true;

  const refreshed = baseState({ revision: 'b'.repeat(64) });
  refreshed.subagents.configured = { mode: 'inherit' };
  refreshed.subagents.policy = { mode: 'inherit' };
  refreshed.subagents.runtime = { state: 'loaded', mode: 'inherit' };
  refreshed.connection.saved = { upstream: { baseURL: 'https://saved.example.com/v1', apiKeyEnv: 'UPSTREAM_API_KEY' },
    tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 3426, dns: { enabled: false, port: 53535 } };

  panel.adoptState(refreshed);

  expect(panel.state.draft).toEqual({ mode: 'force', model: MODEL, effort: 'high' });
  expect(panel.state.draftDirty).toBe(true);
  expect(panel.nodes.get('c-base').value).toBe('https://edited.example.com/v1');
  expect(panel.state.data.revision).toBe('b'.repeat(64));
});

test('connection edits reject credentials, query strings and plain HTTP on non-loopback hosts', () => {
  const panel = ui();
  const valid = { apiKeyEnv: 'UPSTREAM_API_KEY', tokenEnv: 'KIMI_WORK_GATEWAY_TOKEN', port: 3426, dnsPort: 53535, dns: false };

  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1' }).errors).toEqual([]);
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1' }).value.upstream.baseURL)
    .toBe('https://api.example.com/v1');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1/' }).value.upstream.baseURL)
    .toBe('https://api.example.com/v1');
  expect(panel.buildConnection({ ...valid, baseURL: 'http://127.0.0.1:8080/v1' }).errors).toEqual([]);
  expect(panel.buildConnection({ ...valid, baseURL: 'http://localhost:8080/v1' }).errors).toEqual([]);

  expect(panel.buildConnection({ ...valid, baseURL: 'http://api.example.com/v1' }).errors.join(' ')).toContain('HTTPS');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://user:secret@api.example.com/v1' }).errors.join(' '))
    .toContain('账号或密码');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1?key=1' }).errors.join(' '))
    .toContain('查询参数');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1#x' }).errors.join(' '))
    .toContain('查询参数');
  expect(panel.buildConnection({ ...valid, baseURL: 'ftp://api.example.com/v1' }).errors.join(' ')).toContain('HTTPS');
  expect(panel.buildConnection({ ...valid, baseURL: 'not a url' }).errors.join(' ')).toContain('URL');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1', apiKeyEnv: 'bad-name' }).errors.join(' '))
    .toContain('变量名');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1', port: 70000 }).errors.join(' '))
    .toContain('端口');
  expect(panel.buildConnection({ ...valid, baseURL: 'https://api.example.com/v1', dnsPort: 80 }).errors.join(' '))
    .toContain('DNS');
});

test('saving models posts the full catalogue with the revision and closes the editor on success', async () => {
  const next = baseState({ revision: 'c'.repeat(64) });
  const panel = ui({ hash: '#key=unit-panel-session',
    routes: { '/api/models': { status: 200, body: { ok: true, state: next } } } });
  panel.state.data = baseState();

  panel.openEditor(panel.state.data.models[0]);
  panel.state.editor.draft.context = '64000';
  panel.state.editor.draft.efforts = 'low, high, xhigh';
  const catalogue = panel.catalogueWith(panel.state.editor, panel.state.data.models);

  await panel.saveCatalogue(catalogue);

  const posted = panel.requests.filter((entry) => entry.path === '/api/models');
  expect(posted.length).toBe(1);
  expect(posted[0].method).toBe('POST');
  expect(posted[0].body.revision).toBe('a'.repeat(64));
  expect(posted[0].body.models.length).toBe(2);
  expect(posted[0].body.models[0].contextWindow).toBe(64000);
  expect(posted[0].body.models[0].reasoningEfforts).toEqual(['low', 'high', 'xhigh']);
  expect(panel.state.editor).toBeNull();
  expect(panel.state.data.revision).toBe('c'.repeat(64));
  expect(messageOf(panel)).toContain('模型目录已保存');
});

test('a configuration conflict refreshes state but keeps the editor draft', async () => {
  const panel = ui({
    hash: '#key=unit-panel-session',
    routes: {
      '/api/models': { status: 409, body: { error: { code: 'configuration_conflict', message: '配置已经变更，请刷新后重新应用。' } } },
      '/api/state': { status: 200, body: baseState({ revision: 'd'.repeat(64) }) },
    },
  });
  panel.state.data = baseState();

  panel.openEditor(panel.state.data.models[0]);
  panel.state.editor.draft.context = '64000';
  const catalogue = panel.catalogueWith(panel.state.editor, panel.state.data.models);

  await panel.saveCatalogue(catalogue);

  expect(panel.state.editor).not.toBeNull();
  expect(panel.state.editor.draft.context).toBe('64000');
  expect(panel.state.data.revision).toBe('d'.repeat(64));
  expect(messageOf(panel)).toContain('保留');
});

test('an empty request list clears its loading message on the initial render and subsequent refreshes', () => {
  const panel = ui();
  panel.state.data = baseState();
  const empty = panel.nodes.get('recent-empty');
  for (let refresh = 0; refresh < 2; refresh++) {
    empty.textContent = '正在读取运行状态…';
    panel.renderOverview(panel.state.data);
    expect(empty.textContent).toBe('尚无推理请求。Kimi 开始调用模型后，这里会出现最近的 20 条记录。');
    expect(empty.hidden).toBe(false);
  }
});

test('every view renders against a full, empty and disconnected state without throwing', () => {
  const panel = ui();
  const states = [
    baseState(),
    baseState({ models: [], configuration: { state: 'unavailable', file: 'gateway.json' },
      subagents: { configured: { mode: 'inherit' }, policy: { mode: 'inherit' }, runtime: { state: 'unavailable' } },
      connection: { active: null, saved: null, environment: { apiKeySet: false, tokenSet: false } },
      metrics: { startedAt: 0, requests: 0, failures: 0, recent: [] }, diagnostics: {} }),
    baseState({ configuration: { state: 'changed', file: 'gateway.json' },
      connection: { active: baseState().connection.active,
        saved: { upstream: { baseURL: 'https://new.example.com/v1', apiKeyEnv: 'NEXT_KEY' },
          tokenEnv: 'NEXT_TOKEN', port: 3428, dns: { enabled: true, port: 53535 } },
        environment: { apiKeySet: false, tokenSet: false } },
      diagnostics: { upstream: { state: 'failed', at: 1, httpStatus: 500, ms: 12, reason: 'upstream_http_error' },
        compat: { state: 'incompatible', at: 2, version: '3.2.21', modelCount: 2, acceptedCount: 1, skippedCount: 1 } } }),
  ];

  for (const data of states) {
    panel.state.data = data;
    panel.state.draft = panel.savedTarget(data);
    panel.state.draftDirty = false;
    panel.state.editor = null;
    panel.state.deleteId = null;
    expect(() => panel.renderAll()).not.toThrow();
    for (const view of ['overview', 'models', 'subagents', 'translation', 'connection']) {
      expect(() => panel.setView(view)).not.toThrow();
    }
  }

  const empty = panel.state.data;
  expect(panel.nodes.get('model-empty-title').textContent).toBe('目录为空');
  expect(empty.configuration.state).toBe('changed');
});

test('typing into the inspector survives every re-render and reaches the catalogue unchanged', () => {
  const panel = ui();
  panel.state.data = baseState();
  panel.state.draft = { mode: 'force', model: MODEL, effort: 'low' };
  panel.state.draftDirty = false;
  panel.openEditor(panel.state.data.models[0]);

  const contextInput = panel.nodes.get('m-context');
  for (const typed of ['2', '25', '256', '2560', '25600']) {
    contextInput.value = typed;
    panel.readEditorFields();
    panel.renderEditor();
  }
  panel.nodes.get('m-efforts').value = 'low, medium, high, xhigh';
  panel.readEditorFields();
  panel.renderEditor();
  panel.nodes.get('m-default').value = 'xhigh';
  panel.readEditorFields();
  panel.renderEditor();

  expect(panel.state.editor.draft.context).toBe('25600');
  expect(panel.editorDirty()).toBe(true);

  const catalogue = panel.catalogueWith(panel.state.editor, panel.state.data.models);
  expect(catalogue[0].contextWindow).toBe(25600);
  expect(catalogue[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  expect(catalogue[0].defaultEffort).toBe('xhigh');

  panel.closeEditor(false);
  expect(panel.state.editor.confirmClose).toBe(true);
  panel.closeEditor(true);
  expect(panel.state.editor).toBeNull();
});

test('an invalid effort identifier blocks the save and names the offending value', () => {
  const panel = ui();
  panel.state.data = baseState();
  panel.openEditor(panel.state.data.models[0]);
  panel.nodes.get('m-reasoning').checked = true;
  panel.nodes.get('m-efforts').value = 'low, HIGH, 2x';
  panel.readEditorFields();
  panel.renderEditor();

  const text = panel.nodes.get('model-errors').children.map((child) => child.textContent || '').join(' ');
  expect(text).toContain('2x');
  expect(panel.nodes.get('model-save').disabled).toBe(true);

  panel.nodes.get('m-efforts').value = 'low, high';
  panel.readEditorFields();
  panel.renderEditor();
  expect(panel.nodes.get('model-errors').hidden).toBe(true);
  expect(panel.nodes.get('model-errors').children.length).toBe(0);

  /* 修正后仍与已保存目录一致，保存按钮应保持禁用，直到真的有改动。 */
  expect(panel.nodes.get('model-save').disabled).toBe(true);
  panel.nodes.get('m-context').value = '200000';
  panel.readEditorFields();
  panel.renderEditor();
  expect(panel.nodes.get('model-save').disabled).toBe(false);
});

test('switching views hides every other section and marks exactly one navigation item current', () => {
  const panel = ui();
  panel.state.data = baseState();
  panel.state.draft = panel.savedTarget(panel.state.data);
  panel.state.draftDirty = false;

  for (const view of ['overview', 'models', 'subagents', 'translation', 'connection']) {
    panel.setView(view);
    const visible = ['overview', 'models', 'subagents', 'translation', 'connection']
      .filter((name) => !panel.nodes.get('view-' + name).hidden);
    expect(visible).toEqual([view]);
    const current = ['overview', 'models', 'subagents', 'translation', 'connection']
      .filter((name) => panel.nodes.get('nav-' + name).attrs['aria-current'] === 'page');
    expect(current).toEqual([view]);
  }

  panel.setView('not-a-view');
  expect(panel.state.view).toBe('overview');
});

test('the translation view is unavailable rather than broken when the service omits the field', () => {
  const panel = ui();
  panel.state.data = baseState();
  panel.state.draft = panel.savedTarget(panel.state.data);
  panel.state.draftDirty = false;

  expect(() => panel.renderAll()).not.toThrow();
  expect(() => panel.setView('translation')).not.toThrow();

  expect(panel.nodes.get('tr-unavailable').hidden).toBe(false);
  expect(panel.nodes.get('tr-enabled').disabled).toBe(true);
  expect(panel.nodes.get('tr-save').disabled).toBe(true);
  expect(panel.nodes.get('tr-launch').disabled).toBe(true);
  expect(panel.nodes.get('tr-check').disabled).toBe(true);
  expect(panel.evaluateTranslation(panel.state.data).word).toBe('不可用');
  expect(panel.translationAvailable(panel.state.data)).toBe(false);
});

test('translation defaults to off with normalized settings from the panel state', () => {
  const panel = ui();
  const data = baseState({ translation: translationState() });
  panel.state.data = data;
  panel.adoptState(data, { initial: true });
  panel.renderTranslation();

  expect(panel.nodes.get('tr-enabled').checked).toBe(false);
  expect(panel.nodes.get('tr-provider').value).toBe('bing');
  expect(panel.nodes.get('tr-target').value).toBe('zh');
  expect(panel.nodes.get('tr-view').value).toBe('translated');
  expect(panel.nodes.get('tr-custom').hidden).toBe(true);
  expect(panel.nodes.get('tr-save').disabled).toBe(true);
  expect(panel.nodes.get('tr-launch').disabled).toBe(true);
  expect(panel.nodes.get('tr-draft').textContent).toBe('草稿与已保存一致');

  const odd = baseState({ translation: translationState({
    configured: { enabled: true, provider: 'unknown', targetLanguage: 'xx', view: 'sideways' },
  }) });
  expect(panel.savedTranslation(odd)).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'zh',
    view: 'translated', customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' });
});

test('custom translation validates its endpoint and variable name while allowing an optional model', () => {
  const panel = ui();
  const base = { enabled: true, provider: 'custom', targetLanguage: 'ja', view: 'original',
    customEndpoint: 'https://translate.example.com/v1/chat/completions', customModel: 'small-model',
    apiKeyEnv: 'TRANSLATION_KEY' };
  expect(panel.buildTranslation(base)).toEqual({ errors: [], value: base });
  expect(panel.buildTranslation({ ...base, customEndpoint: 'http://127.0.0.1:8080/v1/chat/completions' }).errors).toEqual([]);
  expect(panel.buildTranslation({ ...base, customEndpoint: '' }).errors.join(' ')).toContain('Chat Completions');
  expect(panel.buildTranslation({ ...base, customEndpoint: 'http://translate.example.com/v1' }).errors.join(' ')).toContain('HTTPS');
  expect(panel.buildTranslation({ ...base, customEndpoint: 'https://user:secret@translate.example.com/v1' }).errors.join(' ')).toContain('账号或密码');
  expect(panel.buildTranslation({ ...base, customEndpoint: 'https://translate.example.com/v1?key=1' }).errors.join(' ')).toContain('查询参数');
  expect(panel.buildTranslation({ ...base, customModel: '' }).errors).toEqual([]);
  expect(panel.buildTranslation({ ...base, customModel: 'm'.repeat(2048) }).errors).toEqual([]);
  expect(panel.buildTranslation({ ...base, customModel: 'm'.repeat(2049) }).errors.join(' ')).toContain('模型名称');
  expect(panel.buildTranslation({ ...base, customModel: 'bad\nmodel' }).errors.join(' ')).toContain('控制字符');
  expect(panel.buildTranslation({ ...base, apiKeyEnv: 'bad-name' }).errors.join(' ')).toContain('变量名');
  expect(panel.buildTranslation({ ...base, apiKeyEnv: 'A'.repeat(129) }).errors.join(' ')).toContain('变量名');
  const publicProvider = panel.buildTranslation({ ...base, provider: 'google', customEndpoint: 'not a url' });
  expect(publicProvider.errors).toEqual([]);
  expect(publicProvider.value).toMatchObject({ customEndpoint: '', customModel: 'small-model', apiKeyEnv: 'TRANSLATION_KEY' });
  expect(panel.buildTranslation({ ...base, apiKeyEnv: '' }).value.apiKeyEnv).toBe('KIMI_WORK_TRANSLATION_API_KEY');
});

test('only a runtime-confirmed active state counts as injected translation', () => {
  const panel = ui();

  const disabled = baseState({ translation: translationState({ runtime: { state: 'disabled' } }) });
  expect(panel.evaluateTranslation(disabled).word).toBe('已关闭');

  const active = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'active', version: '3.2.21', pid: 4321 },
  }) });
  expect(panel.evaluateTranslation(active)).toEqual({ tone: 'ok', word: '已注入', note: 'Kimi 已确认翻译引擎在运行。' });

  const enabledNotInjected = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'inactive' },
  }) });
  expect(panel.evaluateTranslation(enabledNotInjected).word).toBe('未生效');

  const pending = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'pending-settings' },
  }) });
  expect(panel.evaluateTranslation(pending).word).toBe('正在应用');
  const stopping = baseState({ translation: translationState({ runtime: { state: 'pending-settings' } }) });
  expect(panel.evaluateTranslation(stopping).word).toBe('等待停用确认');
  expect(panel.evaluateTranslation(baseState({ translation: translationState({ runtime: { state: 'stale' } }) })).word).toBe('停用未确认');

  const waiting = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'waiting-kimi-exit' },
  }) });
  expect(panel.evaluateTranslation(waiting).note).toContain('正常退出');

  const incompatible = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'incompatible', reason: 'version-unsupported' },
  }) });
  expect(panel.evaluateTranslation(incompatible)).toEqual({ tone: 'bad', word: '不兼容',
    note: '当前 Kimi 版本不支持翻译注入。' });

  const legacy = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'legacy-running' },
  }) });
  expect(panel.evaluateTranslation(legacy).note).toContain('旧注入');

  expect(panel.evaluateTranslation(active, { dirty: true }).word).toBe('有未保存修改');
  expect(panel.evaluateTranslation(active, { dirty: true }).note).toContain('当前运行状态未改变');
});

test('launching translated Kimi needs a saved enabled configuration and no unsaved draft', () => {
  const panel = ui();
  const disabled = baseState({ translation: translationState() });
  expect(panel.translationLaunchState(disabled).ready).toBe(false);
  expect(panel.translationLaunchState(disabled).problems.join(' ')).toContain('启用');

  const enabled = baseState({ translation: translationState({
    configured: { ...translationState().configured, enabled: true },
    runtime: { state: 'inactive' },
  }) });
  expect(panel.translationLaunchState(enabled)).toEqual({ problems: [], ready: true });
  expect(panel.translationLaunchState(enabled, { dirty: true }).problems.join(' ')).toContain('未保存');

  const notReady = baseState({ configuration: { state: 'changed', file: 'gateway.json' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true } }) });
  expect(panel.translationLaunchState(notReady).problems.join(' ')).toContain('重启');

  panel.state.data = disabled;
  panel.renderTranslation();
  expect(panel.nodes.get('tr-launch').disabled).toBe(true);
});

test('a two-second polling refresh keeps an unsaved translation draft', () => {
  const panel = ui();
  const data = baseState({ translation: translationState() });
  panel.state.data = data;
  panel.adoptState(data, { initial: true });

  panel.nodes.get('tr-enabled').checked = true;
  panel.nodes.get('tr-provider').value = 'google';
  panel.nodes.get('tr-target').value = 'ko';
  panel.renderTranslation();
  expect(panel.state.translation.dirty).toBe(true);

  const refreshed = baseState({ revision: 'b'.repeat(64), translation: translationState({
    configured: { ...translationState().configured, enabled: true, provider: 'custom',
      targetLanguage: 'fr', customEndpoint: 'https://saved.example.com/v1', customModel: 'saved-model' },
    runtime: { state: 'active', version: '3.2.21', pid: 99 },
  }) });
  panel.adoptState(refreshed);

  expect(panel.nodes.get('tr-enabled').checked).toBe(true);
  expect(panel.nodes.get('tr-provider').value).toBe('google');
  expect(panel.nodes.get('tr-target').value).toBe('ko');
  expect(panel.state.translation.dirty).toBe(true);
  expect(panel.state.data.revision).toBe('b'.repeat(64));

  panel.setView('translation');
  expect(panel.nodes.get('tr-runtime').textContent).toBe('已注入');
  expect(panel.nodes.get('tr-pid').textContent).toBe('99');
  expect(panel.nodes.get('tr-verdict-word').textContent).toBe('有未保存修改');
});

test('saving translation posts every setting with the revision and never claims injection', async () => {
  const saved = baseState({ revision: 'c'.repeat(64), translation: translationState({
    configured: { enabled: true, provider: 'custom', targetLanguage: 'ja', view: 'original',
      customEndpoint: 'https://translate.example.com/v1/chat/completions', customModel: 'small-model',
      apiKeyEnv: 'TRANSLATION_KEY' },
    environment: { keySet: true },
    runtime: { state: 'pending-settings' },
  }) });
  const panel = ui({ hash: '#key=unit-panel-session',
    routes: { '/api/translation': { status: 200, body: { ok: true, state: saved } } } });
  panel.state.data = baseState({ translation: translationState() });
  panel.adoptState(panel.state.data, { initial: true });

  panel.nodes.get('tr-enabled').checked = true;
  panel.nodes.get('tr-provider').value = 'custom';
  panel.nodes.get('tr-target').value = 'ja';
  panel.nodes.get('tr-view').value = 'original';
  panel.nodes.get('tr-endpoint').value = 'https://translate.example.com/v1/chat/completions';
  panel.nodes.get('tr-model').value = 'small-model';
  panel.nodes.get('tr-keyenv').value = 'TRANSLATION_KEY';
  panel.renderTranslation();

  expect(await panel.saveTranslation()).toBe(true);

  const posted = panel.requests.filter((entry) => entry.path === '/api/translation');
  expect(posted.length).toBe(1);
  expect(posted[0].method).toBe('POST');
  expect(posted[0].body).toEqual({ revision: 'a'.repeat(64), enabled: true, provider: 'custom',
    targetLanguage: 'ja', view: 'original', customEndpoint: 'https://translate.example.com/v1/chat/completions',
    customModel: 'small-model', apiKeyEnv: 'TRANSLATION_KEY' });

  const toast = messageOf(panel);
  expect(toast).toContain('已保存');
  expect(toast).toContain('以运行时状态为准');
  expect(toast).not.toContain('已注入');
  expect(panel.nodes.get('tr-verdict-word').textContent).toBe('正在应用');
});

test('a translation conflict refreshes state but keeps the unsaved draft', async () => {
  const refreshed = baseState({ revision: 'd'.repeat(64), translation: translationState({
    configured: { ...translationState().configured, enabled: true, provider: 'bing', targetLanguage: 'en' },
  }) });
  const panel = ui({
    hash: '#key=unit-panel-session',
    routes: {
      '/api/translation': { status: 409, body: { error: { code: 'configuration_conflict', message: '配置已经变更。' } } },
      '/api/state': { status: 200, body: refreshed },
    },
  });
  panel.state.data = baseState({ translation: translationState() });
  panel.adoptState(panel.state.data, { initial: true });

  panel.nodes.get('tr-enabled').checked = true;
  panel.nodes.get('tr-target').value = 'ru';
  panel.renderTranslation();

  expect(await panel.saveTranslation()).toBe(false);

  expect(panel.state.data.revision).toBe('d'.repeat(64));
  expect(panel.nodes.get('tr-enabled').checked).toBe(true);
  expect(panel.nodes.get('tr-target').value).toBe('ru');
  expect(panel.state.translation.dirty).toBe(true);
  expect(messageOf(panel)).toContain('保留');
});

test('translation action receipts report the runtime result rather than the accepted request', async () => {
  const panel = ui();

  panel.state.data = baseState({ operation: { id: 'op-1', state: 'starting', action: 'launch-translated-kimi' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true },
      runtime: { state: 'starting' } }) });
  await panel.confirmActionResult('launch-translated-kimi', 'op-1');
  expect(messageOf(panel)).toContain('等待运行时确认');

  panel.state.data = baseState({ operation: { id: 'op-2', state: 'done', action: 'launch-translated-kimi' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true },
      runtime: { state: 'active', version: '3.2.21' } }) });
  await panel.confirmActionResult('launch-translated-kimi', 'op-2');
  expect(messageOf(panel)).toContain('翻译已注入');

  panel.state.data = baseState({ operation: { id: 'op-3', state: 'done', action: 'check-translation' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true },
      runtime: { state: 'inactive' } }) });
  await panel.confirmActionResult('check-translation', 'op-3');
  expect(messageOf(panel)).toContain('注入尚未确认');
  expect(messageOf(panel)).not.toContain('翻译已注入');

  panel.state.data = baseState({ operation: { id: 'op-4', state: 'waiting-kimi-exit', action: 'launch-translated-kimi' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true },
      runtime: { state: 'waiting-kimi-exit' } }) });
  await panel.confirmActionResult('launch-translated-kimi', 'op-4');
  expect(messageOf(panel)).toContain('正常退出');
  expect(messageOf(panel)).toContain('不会强制结束');

  panel.state.data = baseState({ operation: { id: 'op-5', state: 'done', action: 'check-translation' },
    translation: translationState({ configured: { ...translationState().configured, enabled: true },
      runtime: { state: 'incompatible', reason: 'version-unsupported' } }) });
  await panel.confirmActionResult('check-translation', 'op-5');
  expect(messageOf(panel)).toContain('当前 Kimi 版本不支持翻译注入');
});

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

function element() {
  return { dataset: {}, style: {}, textContent: '', value: '', hidden: false, scrollTop: 0, firstChild: null,
    events: new Map(), children: [], classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, handler) { this.events.set(name, handler); },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; },
    querySelectorAll: () => [], querySelector: () => null, focus() {} };
}

function ui() {
  const nodes = new Map(), events = new Map(), stored = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const storage = { getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  const window = { location: { hash: '', pathname: '/', search: '' },
    addEventListener: (name, handler) => events.set(name, handler),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const context = vm.createContext({
    document: { readyState: 'loading', hidden: false, documentElement: element(),
      getElementById: get, addEventListener() {}, querySelectorAll: () => [],
      createElement: element, createElementNS: element, createTextNode: text => ({ textContent: text }) },
    window, localStorage: storage, sessionStorage: storage,
    history: { replaceState() { window.location.hash = ''; } }, URLSearchParams, requestAnimationFrame() {},
    fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(64), models: [],
      configuration: { state: 'ready' }, gateway: { state: 'running' }, setup: {}, operation: null,
      subagents: { configured: { mode: 'inherit' }, policy: { mode: 'inherit' }, runtime: { state: 'not-prepared' } } }),
    { headers: { 'Content-Type': 'application/json' } }),
    IntersectionObserver: class { observe() {} disconnect() {} },
  });
  const source = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
  vm.runInContext(source + '\nglobalThis.panelUI = { state, modelIdFromAlias, evaluateBinding, isInFlight, confirmActionResult };', context);
  return { ...context.panelUI, window, events, nodes };
}

const MODEL = 'group/deepseek-v4-1-flash';
const ALIAS = 'byok-kth-resp/' + MODEL;
const models = [{ id: MODEL, protocol: 'responses', contextWindow: 128000, tools: true,
  reasoning: true, reasoningEfforts: ['low', 'high'] },
{ id: 'other/deepseek-v4-1-flash', protocol: 'responses', contextWindow: 64000, tools: true }];
const binding = () => ({ configuration: { state: 'ready' }, models,
  subagents: {
    configured: { mode: 'force', model: MODEL, modelAlias: ALIAS, effort: 'low' },
    policy: { mode: 'force', model: MODEL, modelAlias: ALIAS, effort: 'low' },
    runtime: { state: 'loaded', mode: 'force', modelAlias: ALIAS },
  } });

test('the panel resolves complete gateway model IDs without confusing provider prefixes', () => {
  const panel = ui();
  panel.state.data = binding();
  expect(panel.modelIdFromAlias(MODEL)).toBe(MODEL);
  expect(panel.modelIdFromAlias(ALIAS)).toBe(MODEL);
  expect(panel.modelIdFromAlias('byok-kth-kimi/' + MODEL)).toBe(MODEL);
  expect(panel.modelIdFromAlias('byok-kth-resp/other/deepseek-v4-1-flash')).toBe('other/deepseek-v4-1-flash');
  expect(panel.modelIdFromAlias('unrecognized/deepseek-v4-1-flash')).toBeNull();
});

test('the panel only confirms force after the loaded runtime and applied policy match the saved target', () => {
  const panel = ui();
  const data = binding();
  panel.state.data = data;
  expect(panel.evaluateBinding(data).word).toBe('已生效');
  for (const change of [
    value => { value.subagents.runtime.mode = 'inherit'; },
    value => { value.subagents.runtime.state = 'waiting-launch'; },
    value => { value.subagents.runtime.modelAlias = 'byok-kth-resp/other/deepseek-v4-1-flash'; },
    value => { value.subagents.policy.effort = 'high'; },
    value => { value.subagents.policy.model = 'other/deepseek-v4-1-flash'; },
    value => { value.subagents.policy.mode = 'blocked'; },
  ]) {
    const mismatch = binding();
    change(mismatch);
    panel.state.data = mismatch;
    expect(panel.evaluateBinding(mismatch).word).not.toBe('已生效');
  }
});

test('the panel confirms inheritance from the runtime mode rather than only the saved policy', () => {
  const panel = ui();
  const data = binding();
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
  for (const state of ['starting', 'waiting-kimi-exit', 'prepared', 'copied', 'failed', 'interrupted']) {
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
  const panel = ui();
  panel.window.location.hash = '#key=unit-panel-session';
  await panel.nodes.get('gate-retry').events.get('click')();
  expect(panel.state.started).toBe(true);
  expect(panel.state.timer).not.toBeNull();
});

test('clipboard feedback only claims success for the matching completed operation', async () => {
  const panel = ui();
  const message = () => panel.nodes.get('toast').children.map(child => child.textContent || '').join('');
  panel.state.data = { operation: { id: 'owned-operation', state: 'running' } };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(message()).toBe('');
  panel.state.data.operation = { id: 'another-operation', state: 'copied' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(message()).toBe('');
  panel.state.data.operation = { id: 'owned-operation', state: 'unavailable' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(message()).toContain('未复制');
  panel.state.data.operation = { id: 'owned-operation', state: 'copied' };
  await panel.confirmActionResult('copy-token', 'owned-operation');
  expect(message()).toContain('已由服务端写入系统剪贴板');
});

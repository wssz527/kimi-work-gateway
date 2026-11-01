import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

// The setup page is one self-contained file: a DOM stand-in is enough to drive
// its script and check what it sends to the server on a save. It is not a
// browser, so nothing here proves layout — only behaviour and payload shape.

const source = fs.readFileSync(new URL('../ui/setup.html', import.meta.url), 'utf8');

function extract() {
  const script = /<script nonce="__SETUP_NONCE__">([\s\S]*?)<\/script>/.exec(source);
  const style = /<style nonce="__SETUP_NONCE__">([\s\S]*?)<\/style>/.exec(source);
  return { script: script?.[1] ?? '', style: style?.[1] ?? '' };
}

// Minimal element: enough querySelector/innerHTML behaviour for the page.
function element(id = '') {
  const node = {
    id, value: '', checked: false, type: 'text', hidden: false, disabled: false,
    className: '', attributes: {}, children: [], listeners: new Map(), innerHTMLSource: '',
    // As in a browser, replacing the text content drops every child node.
    set textContent(text) { this.textValue = String(text); this.children = []; },
    get textContent() { return this.textValue ?? ''; },
    set innerHTML(text) { this.innerHTMLSource = String(text); this.children = parseChildren(String(text), this); },
    get innerHTML() { return this.innerHTMLSource; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, handler) { this.listeners.set(name, handler); },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
    scrollIntoView() {},
    focus() {},
    querySelector(selector) { return find(this, selector); },
    querySelectorAll(selector) { return collect(this, selector); },
  };
  return node;
}

function parseChildren(html, owner) {
  // Only the tags the page generates matter; attributes are read back by their
  // data-f / data-act / data-derived markers.
  const children = [];
  const pattern = /<(input|select|button|span)\b([^>]*)>/g;
  for (const match of html.matchAll(pattern)) {
    const child = element();
    child.tag = match[1];
    for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = attribute;
      if (name === 'data-f') child.f = value;
      if (name === 'data-act') child.act = value;
      if (name === 'data-derived') child.derived = true;
      if (name === 'value') child.value = value;
      if (name === 'checked') child.checked = true;
      if (name === 'type') child.type = value;
    }
    child.parent = owner;
    children.push(child);
  }
  return children;
}

function walk(node, visit) {
  for (const child of node.children || []) { visit(child); walk(child, visit); }
}

function find(node, selector) {
  let found = null;
  walk(node, child => {
    if (found) return;
    if (selector === '[data-derived]' && child.derived) found = child;
    const match = /^\[data-(f|act)="([^"]+)"\]$/.exec(selector);
    if (match) {
      if (match[1] === 'f' && child.f === match[2]) found = child;
      if (match[1] === 'act' && child.act === match[2]) found = child;
    }
  });
  return found;
}

function collect(node, selector) {
  const found = [];
  walk(node, child => { if (selector === 'li' && child.tag === 'li') found.push(child); });
  return found;
}

// A page test must never leave a polling timer behind: `window.setTimeout` is a
// manual queue the test drains, so the page's retry loop is fully observable
// and cannot keep the test process alive.
function clock() {
  const pending = [];
  let id = 0;
  return {
    pending,
    setTimeout: (callback, ms) => { const handle = ++id; pending.push({ handle, callback, ms }); return handle; },
    clearTimeout: handle => { const index = pending.findIndex(item => item.handle === handle); if (index >= 0) pending.splice(index, 1); },
    // Runs the next scheduled callback, as a browser would when its delay
    // elapses. The poll's fetch/response chain spans several turns, so the test
    // drains it fully before asserting. Returns false when nothing is waiting.
    async tick() {
      const next = pending.shift();
      if (!next) return false;
      next.callback();
      for (let turn = 0; turn < 8; turn++) await flush();
      return true;
    },
  };
}

function page({ hash = '', state = null, saved = null, states = [], timer = clock() } = {}) {
  const nodes = new Map();
  const requests = [];
  const stored = new Map();
  // State reads after the first one walk `states`, so a test can describe a
  // panel that becomes ready while the page is polling.
  const queue = states.slice();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id);
  };
  const document = {
    getElementById: get,
    createElement: () => element(),
  };
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const defaultState = { schemaVersion: 1, configured: false, baseURL: null,
    port: null, dns: null, models: [], apiKeySet: false, tokenSet: false,
    configuration: { state: 'absent', file: '/state/gateway.json' },
    credentials: { state: 'absent', file: '/state/credentials.json' }, stateDir: '/state' };
  let initialStateRead = false;
  const fetch = async (pathname, init = {}) => {
    requests.push({ pathname, method: init.method || 'GET', headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === '/api/state') {
      // The page's own load happens before any save; `states` describes only
      // the reads that follow, which is what a polling page asks for.
      if (!initialStateRead) {
        initialStateRead = true;
        return respond(200, { ok: true, state: state ?? defaultState });
      }
      const next = queue.length ? queue.shift() : null;
      if (next) return respond(next.status ?? 200, next.body ?? next);
      if (state) return respond(200, { ok: true, state });
      return respond(200, { ok: true, state: defaultState });
    }
    return respond(200, saved ?? {});
  };
  const location = { hash, pathname: '/', search: '', origin: 'http://127.0.0.1:1' };
  const window = { open: () => null, setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout };
  const context = vm.createContext({
    document, fetch, location, window, URL, URLSearchParams, console,
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    history: { replaceState: () => { location.hash = ''; } },
  });
  vm.runInContext(extract().script, context);
  return { context, nodes, requests, stored, location, get, window, timer };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('the page is self-contained and needs no external asset', () => {
  const { script, style } = extract();
  expect(script).toContain('adoptKey');
  expect(style).toContain('prefers-color-scheme');
  expect(/(?:src|href)=["']https?:/.test(source)).toBe(false);
  expect(source).not.toContain('@import');
  // The CSP allows the nonce'd style block only, so an inline style attribute
  // would be dropped by the browser without any visible error.
  expect(source).not.toMatch(/\sstyle="/);
  expect(source).not.toMatch(/onclick=|onchange=|onsubmit=/);
  // Every inline block carries the nonce placeholder the server replaces.
  for (const tag of ['<script', '<style']) {
    const inline = source.split(tag).slice(1).filter(part => !part.startsWith(' nonce='));
    expect(inline).toHaveLength(0);
  }
}, 20000);

test('a page load without a key never calls the API and disables saving', async () => {
  const pageState = page();
  await flush();
  expect(pageState.requests).toHaveLength(0);
  expect(pageState.get('state-text').textContent).toBe('缺少会话');
  expect(pageState.get('save').disabled).toBe(true);
  expect(pageState.get('state-dot').getAttribute('data-tone')).toBe('bad');
}, 20000);

test('the session key is taken from the fragment, stored once and removed from the URL', async () => {
  const pageState = page({ hash: '#key=abc123' });
  await flush();
  expect(pageState.requests[0].pathname).toBe('/api/state');
  expect(pageState.requests[0].headers.Authorization).toBe('Bearer abc123');
  expect(pageState.stored.get('kimi-work-gateway.setup.key')).toBe('abc123');
  expect(pageState.location.hash).toBe('');
  // A reload without the fragment still resumes the same session.
  const second = page({ hash: '' });
  expect(second.stored.size).toBe(0);
}, 20000);

test('a save sends one bounded payload with no capability it was not told', async () => {
  const pageState = page({ hash: '#key=abc123', saved: { ok: true, service: { state: 'installed' },
    state: { configured: true, baseURL: 'https://api.example.com/v1', port: 3426, apiKeySet: true,
      tokenSet: true, models: [{ id: 'deepseek-v4-1-flash', protocol: 'responses', contextWindow: 131072 }],
      configuration: { file: '/state/gateway.json' }, credentials: { file: '/state/credentials.json' } },
    gateway: { baseURL: 'https://api.example.com/v1', port: 3426 } } });
  await flush();
  const form = pageState.get('form');
  pageState.get('baseURL').value = 'https://api.example.com/v1';
  pageState.get('apiKey').value = 'sk-page-test';
  pageState.get('port').value = '3426';
  pageState.get('installService').checked = true;
  const model = pageState.get('models').children[0];
  find(model, '[data-f="id"]').value = 'deepseek-v4-1-flash';
  find(model, '[data-f="protocol"]').value = 'responses';
  find(model, '[data-f="contextWindow"]').value = '131072';
  await form.listeners.get('submit')({ preventDefault() {} });
  await flush();

  const save = pageState.requests.find(entry => entry.pathname === '/api/save');
  expect(save.method).toBe('POST');
  expect(save.headers.Origin).toBe('http://127.0.0.1:1');
  expect(save.body.baseURL).toBe('https://api.example.com/v1');
  expect(save.body.apiKey).toBe('sk-page-test');
  expect(save.body.installService).toBe(true);
  expect(save.body.models).toEqual([{ id: 'deepseek-v4-1-flash', protocol: 'responses', contextWindow: 131072,
    tools: true, reasoning: false, inputModalities: ['text'] }]);
  // The key field is cleared after a successful save and never echoed back.
  expect(pageState.get('apiKey').value).toBe('');
  expect(pageState.get('done-card').hidden).toBe(false);
  expect(pageState.get('done-hint').textContent).toContain('后台服务已安装');
}, 20000);

test('the page refuses to submit without a protocol or without a key', async () => {
  const pageState = page({ hash: '#key=abc123' });
  await flush();
  const form = pageState.get('form');
  pageState.get('baseURL').value = 'https://api.example.com/v1';
  const model = pageState.get('models').children[0];
  find(model, '[data-f="id"]').value = 'some-model';
  find(model, '[data-f="contextWindow"]').value = '1000';
  await form.listeners.get('submit')({ preventDefault() {} });
  await flush();
  expect(pageState.get('msg').innerHTMLSource).toContain('API Key');
  expect(pageState.requests.some(entry => entry.pathname === '/api/save')).toBe(false);

  pageState.get('apiKey').value = 'sk-page-test';
  await form.listeners.get('submit')({ preventDefault() {} });
  await flush();
  expect(pageState.get('msg').innerHTMLSource).toContain('接口协议');
  expect(pageState.requests.some(entry => entry.pathname === '/api/save')).toBe(false);
}, 20000);

test('a rejected save shows the mapped message and stays editable', async () => {
  const pageState = page({ hash: '#key=abc123' });
  await flush();
  // Replace fetch with a rejecting one that mimics a protocol conflict.
  pageState.context.fetch = async pathname => {
    if (pathname === '/api/save') {
      return { ok: false, status: 400, json: async () => ({ error: { code: 'protocol_conflict' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, state: { configured: false, models: [] } }) };
  };
  pageState.get('baseURL').value = 'https://api.example.com/v1';
  pageState.get('apiKey').value = 'sk-page-test';
  const model = pageState.get('models').children[0];
  find(model, '[data-f="id"]').value = 'kimi-x';
  find(model, '[data-f="protocol"]').value = 'responses';
  find(model, '[data-f="contextWindow"]').value = '1000';
  await pageState.get('form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  expect(pageState.get('msg').innerHTMLSource).toContain('kimi- 开头时必须使用 Chat Completions');
  expect(pageState.get('save').disabled).toBe(false);
}, 20000);

test('the id field states which protocol Kimi will use', async () => {
  const pageState = page({ hash: '#key=abc123' });
  await flush();
  const model = pageState.get('models').children[0];
  const id = find(model, '[data-f="id"]');
  const hint = find(model, '[data-derived]');
  id.value = 'kimi-k3-pro';
  id.listeners.get('input')();
  expect(hint.textContent).toContain('Chat Completions');
  id.value = 'group/deepseek-v4-1-flash';
  id.listeners.get('input')();
  expect(hint.textContent).toContain('Responses');
}, 20000);

test('a ready panel becomes a real link and is opened once', async () => {
  const opened = [];
  const pageState = page({ hash: '#key=abc123', saved: { ok: true,
    service: { state: 'installed' }, panel: { state: 'ready', url: 'http://127.0.0.1:3427',
      entryURL: 'http://127.0.0.1:3427/#key=' + 'c'.repeat(64) },
    state: { configured: true, baseURL: 'https://api.example.com/v1', port: 3426, apiKeySet: true,
      tokenSet: true, models: [{ id: 'm', protocol: 'responses', contextWindow: 1000 }],
      configuration: { file: '/state/gateway.json' }, credentials: { file: '/state/credentials.json' } },
    gateway: { baseURL: 'https://api.example.com/v1', port: 3426 } } });
  pageState.window.open = (url, target, features) => { opened.push({ url, target, features }); return null; };
  await flush();
  pageState.get('baseURL').value = 'https://api.example.com/v1';
  pageState.get('apiKey').value = 'sk-page-test';
  const model = pageState.get('models').children[0];
  find(model, '[data-f="id"]').value = 'm';
  find(model, '[data-f="protocol"]').value = 'responses';
  find(model, '[data-f="contextWindow"]').value = '1000';
  await pageState.get('form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  const link = pageState.get('open-panel');
  expect(link.hidden).toBe(false);
  expect(link.getAttribute('href')).toBe('http://127.0.0.1:3427/#key=' + 'c'.repeat(64));
  expect(pageState.get('panel-waiting').hidden).toBe(true);
  expect(opened).toHaveLength(1);
  expect(opened[0].url).toBe('http://127.0.0.1:3427/#key=' + 'c'.repeat(64));
  // A second save must not spawn another tab for the same session.
  await pageState.get('form').listeners.get('submit')({ preventDefault() {} });
  await flush();
  expect(opened).toHaveLength(1);
}, 20000);

test('a waiting or manual panel shows a retry hint instead of a link', async () => {
  for (const panel of [{ state: 'waiting', reason: 'panel_not_ready' }, { state: 'manual' }]) {
    const pageState = page({ hash: '#key=abc123', saved: { ok: true, service: { state: 'installed' }, panel,
      state: { configured: true, baseURL: 'https://api.example.com/v1', port: 3426, apiKeySet: true, tokenSet: true,
        models: [{ id: 'm', protocol: 'responses', contextWindow: 1000 }],
        configuration: { file: '/state/gateway.json' }, credentials: { file: '/state/credentials.json' } },
      gateway: { baseURL: 'https://api.example.com/v1', port: 3426 } } });
    await flush();
    pageState.get('baseURL').value = 'https://api.example.com/v1';
    pageState.get('apiKey').value = 'sk-page-test';
    const model = pageState.get('models').children[0];
    find(model, '[data-f="id"]').value = 'm';
    find(model, '[data-f="protocol"]').value = 'responses';
    find(model, '[data-f="contextWindow"]').value = '1000';
    await pageState.get('form').listeners.get('submit')({ preventDefault() {} });
    await flush();
    expect(pageState.get('open-panel').hidden).toBe(true);
    expect(pageState.get('panel-waiting').hidden).toBe(false);
    expect(pageState.get('panel-waiting').textContent.length).toBeGreaterThan(10);
    expect(pageState.get('done-card').hidden).toBe(false);
  }
}, 20000);

// --- pending panel handoff ---------------------------------------------------

const SAVED_STATE = { configured: true, baseURL: 'https://api.example.com/v1', port: 3426, apiKeySet: true,
  tokenSet: true, models: [{ id: 'm', protocol: 'responses', contextWindow: 1000 }],
  configuration: { file: '/state/gateway.json' }, credentials: { file: '/state/credentials.json' } };

function panelResult(panel, service) {
  return { ok: true, changed: false, state: SAVED_STATE, service, panel,
    gateway: { baseURL: 'https://api.example.com/v1', port: 3426 } };
}

// Fills the form the way a user would and submits it once.
async function submit(pageState) {
  pageState.get('baseURL').value = 'https://api.example.com/v1';
  pageState.get('apiKey').value = 'sk-page-test';
  pageState.get('installService').checked = true;
  const model = pageState.get('models').children[0];
  find(model, '[data-f="id"]').value = 'm';
  find(model, '[data-f="protocol"]').value = 'responses';
  find(model, '[data-f="contextWindow"]').value = '1000';
  await pageState.get('form').listeners.get('submit')({ preventDefault() {} });
  await flush();
}

test('a starting panel is polled and its direct link opens exactly once', async () => {
  const opened = [];
  const fresh = 'http://127.0.0.1:3428/#key=' + 'e'.repeat(64);
  const pageState = page({ hash: '#key=abc123',
    saved: panelResult({ state: 'waiting', reason: 'panel_not_ready' }, { state: 'installed' }),
    states: [
      // Still starting: the page keeps waiting instead of asking for a terminal.
      { ok: true, state: SAVED_STATE, service: { state: 'installed' }, panel: { state: 'waiting', reason: 'panel_not_ready' } },
      // The gateway published its own link for the configuration just saved.
      { ok: true, state: SAVED_STATE, service: { state: 'installed' }, panel: { state: 'ready', url: 'http://127.0.0.1:3428', entryURL: fresh } },
    ] });
  pageState.window.open = url => { opened.push(url); return null; };
  await flush();
  expect(pageState.timer.pending).toHaveLength(0);
  await submit(pageState);
  expect(pageState.get('open-panel').hidden).toBe(true);
  expect(pageState.get('panel-waiting').hidden).toBe(false);
  expect(pageState.get('panel-waiting').textContent).toContain('自动');
  // The save left a real timer queued, and nothing was opened yet.
  expect(pageState.timer.pending).toHaveLength(1);
  expect(opened).toHaveLength(0);

  await pageState.timer.tick();
  const firstPoll = pageState.requests.filter(entry => entry.pathname === '/api/state').at(-1);
  expect(firstPoll.headers.Authorization).toBe('Bearer abc123');
  expect(pageState.get('open-panel').hidden).toBe(true);
  expect(pageState.timer.pending).toHaveLength(1);
  expect(opened).toHaveLength(0);

  await pageState.timer.tick();
  expect(pageState.get('open-panel').hidden).toBe(false);
  expect(pageState.get('open-panel').getAttribute('href')).toBe(fresh);
  expect(pageState.get('panel-waiting').hidden).toBe(true);
  expect(opened).toEqual([fresh]);
  // Ready ends the polling; no timer is left behind.
  expect(pageState.timer.pending).toHaveLength(0);

  // A later state read (the reload button) must not open a second tab.
  pageState.get('reload').listeners.get('click')();
  await flush();
  expect(opened).toEqual([fresh]);
  expect(pageState.get('open-panel').getAttribute('href')).toBe(fresh);
}, 20000);

test('a failed service keeps the page retryable and a later save opens the new link', async () => {
  const opened = [];
  const fresh = 'http://127.0.0.1:3429/#key=' + 'f'.repeat(64);
  let saves = 0;
  const pageState = page({ hash: '#key=abc123',
    saved: panelResult({ state: 'manual' }, { state: 'failed', reason: 'service_install_failed' }) });
  // The second save is what a retry looks like from the server.
  pageState.context.fetch = async (pathname, init = {}) => {
    const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
    pageState.requests.push({ pathname, method: init.method || 'GET', headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined });
    if (pathname === '/api/state') return respond(200, { ok: true, state: SAVED_STATE, service: null, panel: null });
    saves++;
    return saves === 1
      ? respond(200, panelResult({ state: 'manual' }, { state: 'failed', reason: 'service_install_failed' }))
      : respond(200, panelResult({ state: 'ready', url: 'http://127.0.0.1:3429', entryURL: fresh },
        { state: 'started', needsFreshEntry: true }));
  };
  pageState.window.open = url => { opened.push(url); return null; };
  await flush();
  await submit(pageState);
  // Nothing was started, so there is nothing to poll for and no link to open.
  expect(pageState.timer.pending).toHaveLength(0);
  expect(opened).toHaveLength(0);
  expect(pageState.get('open-panel').hidden).toBe(true);
  expect(pageState.get('panel-waiting').textContent).toContain('保存并继续');
  expect(pageState.get('done-hint').textContent).toContain('重试');
  // The form is still usable: the save button is live and the key is retained.
  expect(pageState.get('save').disabled).toBe(false);
  expect(pageState.get('done-card').hidden).toBe(false);

  await submit(pageState);
  expect(saves).toBe(2);
  expect(pageState.get('open-panel').hidden).toBe(false);
  expect(pageState.get('open-panel').getAttribute('href')).toBe(fresh);
  expect(pageState.get('done-hint').textContent).toContain('安全重启');
  expect(opened).toEqual([fresh]);
}, 20000);

test('polling stops on an expired session and never retries a refused page', async () => {
  const pageState = page({ hash: '#key=abc123',
    saved: panelResult({ state: 'waiting', reason: 'panel_restarting' }, { state: 'started', needsFreshEntry: true }),
    states: [{ ok: false, status: 401, body: { error: { code: 'unauthorized' } } }] });
  await flush();
  await submit(pageState);
  expect(pageState.timer.pending).toHaveLength(1);
  await pageState.timer.tick();
  expect(pageState.get('save').disabled).toBe(true);
  expect(pageState.timer.pending).toHaveLength(0);
  expect(pageState.get('panel-waiting').hidden).toBe(false);
}, 20000);

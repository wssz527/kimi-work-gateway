import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(import.meta.dir, '..', 'ui', 'translation-renderer.js'), 'utf8');
const CHAT_URL = 'https://www.kimi.com/chat/7f3c1a2b';

// A small DOM stand-in for the Chat thinking component, plus the parts of a
// browser window the engine reads around it (location, history, listeners).
// Selectors are matched as the engine writes them: a tag, `[attr]`, `.a`, or a
// compound `.a.b`, which is all the thinking surface uses.
class Node {
  constructor(tagName, document) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.children = [];
    this.parentNode = null;
    this.attrs = Object.create(null);
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.type = '';
    this.id = '';
    this._classes = new Set();
    this._text = '';
    this._innerText = null;
  }

  get className() { return [...this._classes].join(' '); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get classList() {
    const classes = this._classes;
    return {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => (force === undefined ? (classes.has(name) ? classes.delete(name) : classes.add(name)) : (force ? classes.add(name) : classes.delete(name))),
    };
  }

  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerText() { return this._innerText ?? this.textContent; }
  set innerText(value) { this._innerText = String(value); this._text = String(value); }
  get innerHTML() { return ''; }
  set innerHTML(value) { throw Error('innerHTML must not be used'); }

  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }

  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  click() {
    const handler = this.listeners.get('click');
    if (handler) handler({ preventDefault() {}, stopPropagation() {} });
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, reference) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  matches(selector) {
    if (selector.startsWith('[')) return this.attrs[selector.slice(1, -1)] !== undefined;
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this._classes.has(name));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === '*') return true;
    return this.tagName === selector.toUpperCase();
  }

  *walk() {
    for (const child of this.children) { yield child; yield* child.walk(); }
  }
  querySelectorAll(selector) { return [...this.walk()].filter(node => node.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parentNode) if (node.matches?.(selector)) return node;
    return null;
  }
}

class Document extends Node {
  constructor() {
    super('#document', null);
    this.ownerDocument = this;
    this.head = new Node('head', this);
    this.body = new Node('body', this);
    this.appendChild(this.head);
    this.appendChild(this.body);
    this.listeners = new Map();
  }
  createElement(tagName) { return new Node(tagName, this); }
  getElementById(id) { return [...this.walk()].find(node => node.id === id) || null; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
}

function flush() { return new Promise(resolve => setImmediate(resolve)); }
async function settle(times = 4) { for (let index = 0; index < times; index += 1) await flush(); }

function createClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(handler, delay = 0) {
      sequence += 1;
      timers.set(sequence, { at: now + Math.max(0, delay), handler });
      return sequence;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      let guard = 0;
      while (guard < 10000) {
        guard += 1;
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.handler();
        await settle(2);
      }
      now = target;
      await settle(2);
    },
  };
}

// The structure the Thinking component renders, as read from the shipped Chat
// bundle: root carries is-expanded, the height animation container carries the
// running flag, and the text lives under .markdown-container > .markdown.
function makeThinkingBlock(document, { text = 'First thought.\n\nSecond thought.', expanded = true,
  running = false, codeTexts } = {}) {
  const block = document.createElement('div');
  block.className = `toolcall-container thinking-container${expanded ? ' is-expanded' : ''}`;
  const title = document.createElement('div');
  title.className = 'toolcall-title-container';
  const resize = document.createElement('div');
  resize.className = `resize-container${running ? ' enable-grow-animation' : ''}`;
  const slot = document.createElement('div');
  slot.className = 'slot-container';
  const content = document.createElement('div');
  content.className = 'toolcall-content';
  const contentText = document.createElement('div');
  contentText.className = 'toolcall-content-text';
  const markdownContainer = document.createElement('div');
  markdownContainer.className = 'markdown-container';
  const markdown = document.createElement('div');
  markdown.className = 'markdown';
  markdown.innerText = text;
  const codeNodes = [];
  for (const [tag, value] of codeTexts || []) {
    const node = document.createElement(tag);
    node.innerText = value;
    markdown.appendChild(node);
    codeNodes.push(node);
  }
  markdownContainer.appendChild(markdown);
  contentText.appendChild(markdownContainer);
  content.appendChild(contentText);
  slot.appendChild(content);
  resize.appendChild(slot);
  block.append(title, resize);
  document.body.appendChild(block);
  return { block, title, resize, slot, content, contentText, markdownContainer, markdown, codeNodes };
}

function boot({ settings = { enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' },
  href = CHAT_URL, top = undefined, text, expanded, running, codeTexts, withBlock = true, document: provided } = {}) {
  const document = provided || new Document();
  const clock = createClock();
  const bindings = [];
  const observers = [];
  const calls = { fetch: 0, storage: 0 };
  const windowListeners = new Map();

  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
    emit(records) { if (this.targets.length) this.callback(records); }
  }

  const location = { href };
  const historyCalls = [];
  const history = {
    pushState(state, title, url) { historyCalls.push(['pushState', url]); if (url) location.href = new URL(url, location.href).href; },
    replaceState(state, title, url) { historyCalls.push(['replaceState', url]); if (url) location.href = new URL(url, location.href).href; },
  };

  const sandbox = {
    document,
    MutationObserver,
    // A browser realm always exposes URL; the payload parses location with it.
    URL,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    console,
    location,
    history,
    __kwgTranslationConfig: { ...settings, surface: 'chat' },
    addEventListener: (name, handler) => windowListeners.set(name, handler),
    removeEventListener: (name) => windowListeners.delete(name),
  };
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'window', { value: sandbox, configurable: true });
  sandbox.top = top === undefined ? sandbox : top;
  Object.defineProperty(sandbox, 'localStorage', {
    configurable: true,
    get() { calls.storage += 1; throw Error('renderer must not touch localStorage'); },
  });
  Object.defineProperty(sandbox, 'fetch', {
    configurable: true,
    get() { calls.fetch += 1; throw Error('renderer must not fetch'); },
  });
  sandbox.__kwgTranslate = (payload) => { bindings.push(JSON.parse(payload)); };

  const fixture = withBlock ? makeThinkingBlock(document, { text, expanded, running, codeTexts }) : null;

  const returned = vm.runInNewContext(SOURCE, sandbox, { filename: 'translation-renderer.js' });
  const engine = sandbox.__kwgTranslation;
  const receive = sandbox.__kwgTranslationReceive;

  return {
    sandbox, document, clock, observers, bindings, calls, returned, engine, receive, location, history,
    historyCalls, windowListeners, ...(fixture || {}),
    notify(records = [{ target: fixture.block, type: 'childList' }]) {
      for (const observer of observers) observer.emit(records);
    },
    navigate(url) {
      location.href = url;
      history.pushState({}, '', url);
    },
  };
}

test('chat mounts only on the verified origin and route, and never inside a frame', () => {
  const page = boot();
  expect(page.returned).toMatchObject({ state: 'active', version: 1, surface: 'chat', top: true });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(1);
  expect(page.calls.storage).toBe(0);
  expect(page.calls.fetch).toBe(0);
  expect(page.sandbox.__kwgTranslationConfig).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated', surface: 'chat' });

  for (const href of [
    'https://kimi.com.evil.test/chat/7f3c1a2b',
    'https://www.kimi.com./chat/7f3c1a2b',
    'https://www.kimi.com/settings/chat',
    'https://www.kimi.com/membership/pricing',
    'https://www.kimi.com/plugins',
    'https://www.kimi.com/chat',
    'http://www.kimi.com/chat/7f3c1a2b',
    'https://www.kimi.ai/chat/7f3c1a2b',
    'https://evil.test/chat/7f3c1a2b',
  ]) {
    const refused = boot({ href });
    expect(refused.returned).toMatchObject({ state: 'inactive', version: 1 });
    expect(refused.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
    expect(refused.bindings).toHaveLength(0);
  }

  // A frame is never the surface: the host may attach the top page only.
  const framed = boot({ top: {} });
  expect(framed.returned.state).toBe('inactive');
  expect(framed.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
  expect(framed.bindings).toHaveLength(0);

  // Root and history routes are the two non-conversation Chat pages.
  for (const href of ['https://www.kimi.com/', 'https://www.kimi.com/chat/history']) {
    const ok = boot({ href });
    expect(ok.returned).toMatchObject({ state: 'active', surface: 'chat' });
  }
});

test('a running thinking block is never sent, and the final text is sent exactly once', async () => {
  const page = boot({ running: true, text: 'Partial thought.' });
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(0);

  // The stream keeps growing while the grow animation is on.
  page.markdown.innerText = 'Partial thought. More text.';
  page.notify();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(0);

  // running ends: the class is removed and the last delta lands.
  page.resize.classList.remove('enable-grow-animation');
  page.markdown.innerText = 'Partial thought. More text. Final sentence.';
  page.notify();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  expect(page.bindings[0].text).toBe('Partial thought. More text. Final sentence.');
  expect(page.bindings[0].protectedTexts).toEqual([]);

  // A finished block at rest never asks again.
  page.notify();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
});

test('a collapsed block keeps its text in the DOM but is never dispatched', async () => {
  const page = boot({ expanded: false });
  await page.clock.advance(3000);
  // The full reasoning text is present under .toolcall-content, exactly as the
  // height animation leaves it, and must still not be sent: the user cannot see
  // it, so it is not visible reasoning.
  expect(page.markdown.innerText).toBe('First thought.\n\nSecond thought.');
  expect(page.bindings).toHaveLength(0);
  expect(page.document.querySelector('.kwg-translated')).toBeNull();

  page.block.classList.add('is-expanded');
  page.notify([{ target: page.block, type: 'attributes' }]);
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);

  page.receive(page.bindings[0].id, { text: '折叠译文' });
  await settle();
  const mirror = page.document.querySelector('.kwg-translated');
  expect(mirror.textContent).toBe('折叠译文');
  expect(mirror.hidden).toBe(false);
  expect(mirror.parentNode).toBe(page.block);
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);

  // Collapsing hides both the source and the mirror; the translation is kept.
  page.block.classList.remove('is-expanded');
  page.notify([{ target: page.block, type: 'attributes' }]);
  await page.clock.advance(2000);
  expect(mirror.hidden).toBe(true);
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('折叠译文');

  // Expanding again reuses the finished translation instead of paying twice.
  page.block.classList.add('is-expanded');
  page.notify([{ target: page.block, type: 'attributes' }]);
  await page.clock.advance(2000);
  expect(mirror.hidden).toBe(false);
  expect(page.bindings).toHaveLength(1);
});

test('the translation is painted in place of the visible reasoning and can be switched back', async () => {
  const page = boot();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  page.receive(page.bindings[0].id, { text: '第一段思考。\n\n第二段思考。' });
  await settle();

  const mirror = page.document.querySelector('.kwg-translated');
  expect(mirror.textContent).toBe('第一段思考。\n\n第二段思考。');
  // The mirror sits above the animated content, inside the thinking root: the
  // content container is what the height animation clips, so anchoring there
  // would hide the translation along with the original. The bar occupies index
  // 1 (below the title), and the mirror follows it.
  expect(mirror.parentNode).toBe(page.block);
  expect(page.block.children.indexOf(mirror)).toBe(2);

  page.document.querySelectorAll('.kwg-view-btn')[1].click();
  await settle();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(mirror.hidden).toBe(true);

  page.document.querySelectorAll('.kwg-view-btn')[0].click();
  await settle();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);
  expect(mirror.hidden).toBe(false);
});

test('a host failure keeps the original reasoning visible and states a safe reason', async () => {
  const page = boot();
  await page.clock.advance(3000);
  page.receive(page.bindings[0].id, { error: 'translation_http_error' });
  await settle();

  const status = page.document.querySelector('.kwg-status');
  expect(status.textContent).toBe('服务不可用');
  expect(status.dataset.state).toBe('error');
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(page.markdown.isConnected).toBe(true);
});

test('code and links inside the reasoning are protected, and the binding carries no credentials', async () => {
  const page = boot({ text: 'Run the command.', codeTexts: [['pre', 'curl https://example.test'], ['code', 'retry()'], ['a', 'https://example.test/docs']] });
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  expect(page.bindings[0].protectedTexts).toEqual(expect.arrayContaining([
    'curl https://example.test', 'retry()', 'https://example.test/docs',
  ]));
  expect(JSON.stringify(page.bindings[0])).not.toContain('apiKey');
  expect(JSON.stringify(page.bindings[0])).not.toContain('customEndpoint');
});

// The host refuses a request it cannot attribute to the live document, so both
// surfaces have to stamp one. A request without it would be dropped in the real
// host even though the renderer considered the translation valid.
test('every chat request carries the generation the host stamped', async () => {
  const page = boot();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  expect(Number.isInteger(page.bindings[0].generation)).toBe(true);
  expect(page.bindings[0].generation).toBe(0);

  // A re-injection into a new document reads the generation the host publishes
  // for it, and asks again under that stamp.
  page.sandbox.__kwgTranslationGeneration = 4;
  vm.runInNewContext(SOURCE, page.sandbox, { filename: 'translation-renderer.js' });
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(2);
  expect(page.bindings[1].generation).toBe(4);
  // The new document has its own receive channel; the retired one must not be
  // the one used here.
  page.sandbox.__kwgTranslationReceive(page.bindings[1].id, { text: '新文档译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('新文档译文');
});

test('leaving the chat route through the SPA removes the translation and refuses late replies', async () => {
  const page = boot();
  await page.clock.advance(3000);
  const requestId = page.bindings[0].id;
  page.receive(requestId, { text: '进入设置前的译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('进入设置前的译文');

  page.history.pushState({}, '', '/settings/chat');
  await page.clock.advance(1000);
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
  expect(page.document.querySelectorAll('.kwg-translated')).toHaveLength(0);
  expect(page.document.getElementById('kwg-style')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(page.clock.pending()).toBe(0);
  expect(page.observers.every(observer => observer.targets.length === 0)).toBe(true);

  // A reply that was already on the wire must not resurrect anything.
  page.receive(requestId, { text: '迟到的译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
  expect(page.bindings).toHaveLength(1);
});

test('a cross-document navigation stops the engine and drops work in flight', async () => {
  const page = boot({ running: false });
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);

  page.location.href = 'https://www.kimi.com/membership/pricing';
  // A mutation inside the block forces the rescan that a route change triggers
  // even when the history wrapper is bypassed (an anchor navigation, a redirect
  // handled by the router without pushState).
  page.notify();
  await page.clock.advance(2000);
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
  expect(page.document.querySelectorAll('.kwg-translated')).toHaveLength(0);
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  // The engine keeps reporting the surface it booted in but is no longer
  // running, and an explicit configure cannot bring it back on this page.
  expect(page.engine.status()).toMatchObject({ state: 'inactive', surface: 'chat' });
  expect(page.engine.configure({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' }))
    .toMatchObject({ state: 'inactive' });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
});

test('re-injection keeps the finished translation and never stacks a second engine', async () => {
  const page = boot();
  await page.clock.advance(3000);
  page.receive(page.bindings[0].id, { text: '注入前译文' });
  await settle();

  const returned = vm.runInNewContext(SOURCE, page.sandbox, { filename: 'translation-renderer.js' });
  await settle();
  expect(returned).toMatchObject({ state: 'active', surface: 'chat' });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(1);
  expect(page.document.querySelectorAll('#kwg-style')).toHaveLength(1);
  expect(page.observers.filter(observer => observer.targets.length > 0)).toHaveLength(1);

  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('注入前译文');
});

// Structure telemetry is how the host tells an empty conversation apart from a
// page whose reasoning DOM drifted, instead of reporting both as "attached".
test('an empty chat page reports no structure, and a drifted root reports partial', async () => {
  const empty = boot({ withBlock: false });
  expect(empty.returned).toMatchObject({ state: 'active', surface: 'chat', seenBlocks: 0, structure: 'none' });

  const matched = boot();
  await matched.clock.advance(1500);
  expect(matched.engine.status()).toMatchObject({ blocks: 1, seenBlocks: 1, structure: 'matched' });

  const drifted = matched.document.createElement('div');
  drifted.className = 'toolcall-container thinking-container';
  matched.document.body.appendChild(drifted);
  matched.notify([{ target: matched.document.body, type: 'childList' }]);
  await matched.clock.advance(1500);
  expect(matched.engine.status()).toMatchObject({ blocks: 1, seenBlocks: 2, structure: 'partial' });
});

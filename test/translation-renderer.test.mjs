import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(import.meta.dir, '..', 'ui', 'translation-renderer.js'), 'utf8');

// A deliberately small DOM stand-in: only the members the renderer touches,
// with a deterministic clock, so lifecycle and staleness are checkable without
// pulling a browser DOM into the test suite.
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
    this._innerHTMLTouched = false;
  }

  get className() { return [...this._classes].join(' '); }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

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
  set innerHTML(value) { this._innerHTMLTouched = true; throw Error('innerHTML must not be used'); }

  get firstChild() { return this.children[0] || null; }
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
    if (selector.startsWith('.')) return this._classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('[')) return this.attrs[selector.slice(1, -1)] !== undefined;
    if (selector === '*') return true;
    return this.tagName === selector.toUpperCase();
  }

  *walk() {
    for (const child of this.children) { yield child; yield* child.walk(); }
  }
  querySelectorAll(selector) {
    const all = [...this.walk()].filter(node => node.matches(selector));
    return all;
  }
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

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(times = 4) {
  for (let index = 0; index < times; index += 1) await flush();
}

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

function makeBlock(document, { text = 'First thought.\n\nSecond thought.', label = '已完成思考', expanded = 'true', codeTexts } = {}) {
  const block = document.createElement('div');
  block.className = 'think-block';
  const summary = document.createElement('div');
  summary.className = 'think-summary';
  summary.setAttribute('aria-expanded', expanded);
  const labelEl = document.createElement('span');
  labelEl.className = 'think-label';
  labelEl.textContent = label;
  summary.appendChild(labelEl);
  const wrap = document.createElement('div');
  wrap.className = 'think-body-wrap';
  const body = document.createElement('div');
  body.className = 'think-body';
  const markdown = document.createElement('div');
  markdown.className = 'chat-markdown';
  markdown.innerText = text;
  const codeNodes = [];
  for (const [tag, value] of codeTexts || [['pre', 'const token = "keep";'], ['code', 'config.value'],
    ['a', 'https://example.test/docs']]) {
    const node = document.createElement(tag);
    node.innerText = value;
    markdown.appendChild(node);
    codeNodes.push(node);
  }
  body.appendChild(markdown);
  wrap.appendChild(body);
  block.append(summary, wrap);
  document.body.appendChild(block);
  return { block, summary, labelEl, wrap, body, markdown, codeNodes };
}

function boot({ settings = { enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' },
  legacy = false, text, label, expanded, codeTexts } = {}) {
  const document = new Document();
  const clock = createClock();
  const bindings = [];
  const calls = { fetch: 0, storage: 0 };
  const observers = [];

  class MutationObserver {
    constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.targets = []; }
    emit(records) { if (this.targets.length) this.callback(records); }
  }

  const sandbox = {
    document,
    MutationObserver,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    Date: { now: clock.now },
    console,
  };
  const self = {
    __kwgTranslationConfig: settings,
  };
  if (legacy) self.__kctWork = { version: 3 };
  Object.assign(sandbox, self);
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'window', { value: sandbox, configurable: true });
  Object.defineProperty(sandbox, 'localStorage', {
    configurable: true,
    get() { calls.storage += 1; throw Error('renderer must not touch localStorage'); },
  });
  Object.defineProperty(sandbox, 'fetch', {
    configurable: true,
    get() { calls.fetch += 1; throw Error('renderer must not fetch'); },
  });
  sandbox.__kwgTranslate = (payload) => { bindings.push(JSON.parse(payload)); };

  const fixture = makeBlock(document, { text: text ?? 'First thought.\n\nSecond thought.',
    label: label ?? '已完成思考', expanded: expanded ?? 'true', codeTexts });

  const returned = vm.runInNewContext(SOURCE, sandbox, { filename: 'translation-renderer.js' });

  const engine = sandbox.__kwgTranslation;
  const receive = sandbox.__kwgTranslationReceive;

  return {
    sandbox, document, clock, observers, bindings, calls, returned, engine, receive, ...fixture,
    notify(records = [{ target: fixture.block, type: 'childList' }]) {
      for (const observer of observers) observer.emit(records);
    },
  };
}

test('the injection reports a real state and exposes the engine contract', () => {
  const disabled = boot({ settings: { enabled: false, provider: 'bing', targetLanguage: 'zh', view: 'translated' } });
  expect(disabled.returned).toEqual({ state: 'inactive', version: 1 });
  expect(disabled.engine.status()).toEqual({ state: 'inactive', version: 1 });
  expect(disabled.document.querySelectorAll('.kwg-bar')).toHaveLength(0);

  const active = boot();
  expect(active.returned).toEqual({ state: 'active', version: 1 });
  expect(active.engine.version).toBe(1);
  expect(typeof active.engine.configure).toBe('function');
  expect(typeof active.engine.stop).toBe('function');
  expect(active.document.querySelectorAll('.kwg-bar')).toHaveLength(1);
  expect(active.calls.storage).toBe(0);
  expect(active.calls.fetch).toBe(0);
  expect(active.sandbox.__kwgTranslationConfig).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' });
});

test('an existing task3 renderer is left untouched and reported as legacy-running', () => {
  const legacy = boot({ legacy: true });
  expect(legacy.returned).toEqual({ state: 'legacy-running', version: 1 });
  expect(legacy.engine.status()).toEqual({ state: 'legacy-running', version: 1 });
  expect(legacy.engine.configure({ enabled: true })).toEqual({ state: 'legacy-running', version: 1 });
  expect(legacy.engine.stop()).toEqual({ state: 'legacy-running', version: 1 });
  expect(legacy.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
  expect(legacy.bindings).toHaveLength(0);
  expect(legacy.sandbox.__kctWork).toEqual({ version: 3 });
});

test('only a settled block is sent, with its protected pre/code/a text', async () => {
  const streaming = boot({ label: '思考中', text: 'Still thinking.' });
  await streaming.clock.advance(1000);
  expect(streaming.bindings).toHaveLength(0);

  streaming.labelEl.textContent = '已完成思考';
  streaming.markdown.innerText = 'Finished thinking.';
  streaming.notify();
  await streaming.clock.advance(1000);
  expect(streaming.bindings).toHaveLength(1);
  const payload = streaming.bindings[0];
  expect(payload.type).toBe('translate');
  expect(payload.text).toBe('Finished thinking.');
  expect(typeof payload.id).toBe('string');
  expect(payload.protectedTexts).toEqual(expect.arrayContaining([
    'const token = "keep";', 'config.value', 'https://example.test/docs',
  ]));
  expect(JSON.stringify(payload)).not.toContain('apiKey');
});

test('a reply paints plain text over the source, and the source stays hidden until switched back', async () => {
  const page = boot();
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(1);
  const { id } = page.bindings[0];

  page.receive(id, { text: '第一段思考。\n\n第二段思考。' });
  await settle();

  const mirror = page.document.querySelector('.kwg-translated');
  expect(mirror).toBeTruthy();
  expect(mirror.textContent).toBe('第一段思考。\n\n第二段思考。');
  expect(mirror.innerHTML).toBe('');
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);
  expect(mirror.parentNode).toBe(page.block);
  expect(page.document.querySelector('.think-body-wrap').hidden).toBe(false);

  const originalButton = page.document.querySelectorAll('.kwg-view-btn')[1];
  originalButton.click();
  await settle();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(mirror.hidden).toBe(true);

  page.document.querySelectorAll('.kwg-view-btn')[0].click();
  await settle();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);
  expect(mirror.hidden).toBe(false);
});

test('a reply for replaced text never overwrites the current translation', async () => {
  const page = boot({ text: 'Version one.' });
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(1);
  const first = page.bindings[0].id;

  page.markdown.innerText = 'Version two.';
  page.notify();
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(2);
  const second = page.bindings[1].id;
  expect(first).not.toBe(second);
  expect(page.bindings[1].text).toBe('Version two.');

  page.receive(second, { text: '译文二' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('译文二');

  page.receive(first, { text: '译文一' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('译文二');
});

test('a stale reply after a settings change is ignored, and the new language is requested', async () => {
  const page = boot({ text: 'Stable text.' });
  await page.clock.advance(1000);
  const oldId = page.bindings[0].id;

  page.engine.configure({ enabled: true, provider: 'google', targetLanguage: 'en', view: 'translated' });
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(2);
  const newId = page.bindings[1].id;
  expect(newId).not.toBe(oldId);

  page.receive(oldId, { text: '旧译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);

  page.receive(newId, { text: 'New translation.' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('New translation.');
});

test('a host error shows a safe label, keeps the source, and never marks failure as success', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { error: 'translation_http_error' });
  await settle();

  const status = page.document.querySelector('.kwg-status');
  expect(status.textContent).toBe('服务不可用');
  expect(status.dataset.state).toBe('error');
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(status.textContent).not.toContain('key');
  expect(status.textContent).not.toContain('http_error');
});

test('unknown, expired and malformed host replies are ignored without throwing', async () => {
  const page = boot();
  await page.clock.advance(1000);
  expect(() => page.receive('kwg-unknown', { text: 'x' })).not.toThrow();
  expect(() => page.receive(undefined, { text: 'x' })).not.toThrow();
  expect(() => page.receive(page.bindings[0].id, 'not an object')).not.toThrow();
  expect(() => page.receive(page.bindings[0].id, { text: 42 })).not.toThrow();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();

  page.engine.stop();
  expect(() => page.receive(page.bindings[0].id, { text: 'late' })).not.toThrow();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
});

test('stop restores the original text and removes every node, observer and timer', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('译文');

  expect(page.engine.stop()).toEqual({ state: 'inactive', version: 1 });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
  expect(page.document.querySelectorAll('.kwg-translated')).toHaveLength(0);
  expect(page.document.getElementById('kwg-style')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
  expect(page.observers.every(observer => observer.targets.length === 0)).toBe(true);
  expect(page.clock.pending()).toBe(0);
  expect(page.engine.status()).toEqual({ state: 'inactive', version: 1 });

  page.markdown.innerText = 'Changed after stop.';
  page.clock.now();
  await page.clock.advance(3000);
  expect(page.bindings).toHaveLength(1);
  expect(page.document.querySelector('.kwg-bar')).toBeNull();
});

test('configure can bring the renderer back and re-reads the bounded cache', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '缓存译文' });
  await settle();
  page.engine.stop();
  expect(page.bindings).toHaveLength(1);

  expect(page.engine.configure({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' }))
    .toEqual({ state: 'active', version: 1 });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(1);
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(1);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('缓存译文');

  page.engine.stop();
  expect(page.engine.configure({ enabled: false })).toEqual({ state: 'inactive', version: 1 });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(0);
});

test('the retranslate button drops the cached value and asks the host again', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '第一次' });
  await settle();

  const retranslate = page.document.querySelectorAll('.kwg-bar')[0].children[2];
  expect(retranslate.textContent).toBe('重译');
  retranslate.click();
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(2);
  page.receive(page.bindings[1].id, { text: '第二次' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('第二次');
});

test('a collapsed block keeps its translation and shows it again after expanding', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '折叠译文' });
  await settle();

  page.summary.setAttribute('aria-expanded', 'false');
  page.wrap.remove();
  page.notify([{ target: page.block, type: 'childList' }]);
  await page.clock.advance(1000);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('折叠译文');

  const wrap = page.document.createElement('div');
  wrap.className = 'think-body-wrap';
  const body = page.document.createElement('div');
  body.className = 'think-body';
  const markdown = page.document.createElement('div');
  markdown.className = 'chat-markdown';
  markdown.innerText = 'First thought.\n\nSecond thought.';
  body.appendChild(markdown);
  wrap.appendChild(body);
  page.block.insertBefore(wrap, page.block.children[1] || null);
  page.summary.setAttribute('aria-expanded', 'true');
  page.notify([{ target: page.block, type: 'childList' }]);
  await page.clock.advance(1000);
  expect(page.document.querySelector('.kwg-translated').hidden).toBe(false);
  expect(page.bindings).toHaveLength(1);
});

test('re-injection stops the previous engine and leaves exactly one set of controls', async () => {
  const page = boot();
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '注入前译文' });
  await settle();
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(1);

  // The host attaches again without a renderer reload: the new run must retire
  // the old engine, its observers and its DOM rather than stacking a second one.
  page.sandbox.__kwgTranslationConfig = { enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' };
  const returned = vm.runInNewContext(SOURCE, page.sandbox, { filename: 'translation-renderer.js' });
  await settle();
  expect(returned).toEqual({ state: 'active', version: 1 });
  expect(page.document.querySelectorAll('.kwg-bar')).toHaveLength(1);
  expect(page.document.querySelectorAll('#kwg-style')).toHaveLength(1);
  const observing = page.observers.filter(observer => observer.targets.length > 0);
  expect(observing).toHaveLength(1);

  await page.clock.advance(1000);
  // The carried cache still answers the same text, so no second request is made.
  expect(page.bindings).toHaveLength(1);
  expect(page.document.querySelectorAll('.kwg-translated')).toHaveLength(1);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('注入前译文');
});

test('a stop followed by an immediate re-enable never lets the old run paint or oversubscribe', async () => {
  const page = boot();
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(1);
  const oldId = page.bindings[0].id;

  page.engine.stop();
  expect(page.engine.configure({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' }))
    .toEqual({ state: 'active', version: 1 });
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(2);
  const newId = page.bindings[1].id;
  expect(newId).not.toBe(oldId);

  // The reply of the retired run must not resurrect a mirror for it.
  page.receive(oldId, { text: '旧run译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);

  page.receive(newId, { text: '新run译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('新run译文');
});

test('late replies of a retired run cannot exceed the concurrency limit of the live run', async () => {
  const page = boot();
  // Three blocks, so more work exists than MAX_ACTIVE allows in flight.
  for (let index = 0; index < 2; index += 1) {
    makeBlock(page.document, { text: `Block ${index} text.` });
  }
  page.observers.forEach(observer => observer.emit([{ type: 'childList', target: page.document.body }]));
  await page.clock.advance(2000);
  expect(page.bindings).toHaveLength(2);

  page.engine.stop();
  page.engine.configure({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated' });
  await page.clock.advance(2000);
  const ids = page.bindings.map(entry => entry.id);
  // Replies of the retired run arrive while the new run is still busy.
  for (const id of ids.slice(0, 2)) page.receive(id, { text: 'stale' });
  await settle();
  expect(page.document.querySelectorAll('.kwg-translated')).toHaveLength(0);

  // The live run still dispatches at most MAX_ACTIVE (2) requests at a time.
  const live = ids.slice(2);
  expect(live.length).toBeLessThanOrEqual(2);
  for (const id of live) page.receive(id, { text: 'fresh' });
  await settle();
  for (const id of live) expect(page.receive(id, { text: 'duplicate' })).toBeUndefined();
});

test('a configure that changes provider or language starts a fresh scope', async () => {
  const page = boot({ text: 'Scope text.' });
  await page.clock.advance(1000);
  const oldId = page.bindings[0].id;
  page.receive(oldId, { text: 'bing 译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('bing 译文');

  // Same provider+language: the finished translation is still valid.
  page.engine.configure({ enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'original' });
  await page.clock.advance(1000);
  expect(page.document.querySelector('.kwg-translated').textContent).toBe('bing 译文');
  expect(page.bindings).toHaveLength(1);

  // New scope: old reply and old cache entry must not answer for the new scope.
  page.engine.configure({ enabled: true, provider: 'google', targetLanguage: 'en', view: 'translated' });
  await page.clock.advance(1000);
  expect(page.bindings).toHaveLength(2);
  page.receive(oldId, { text: '迟到的 bing 译文' });
  await settle();
  expect(page.document.querySelector('.kwg-translated')).toBeNull();
});

test('reading the source while the translation hides it does not retranslate the same text', async () => {
  const page = boot({ text: 'Stable reasoning text.' });
  await page.clock.advance(1000);
  page.receive(page.bindings[0].id, { text: '稳定译文' });
  await settle();
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);

  // In a real DOM a display:none subtree makes innerText fall back to
  // textContent. Simulate that: while the hiding class is present the bound
  // element reports a different string, which must never be sent.
  const node = page.markdown;
  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node) || {}, 'innerText');
  Object.defineProperty(node, 'innerText', {
    configurable: true,
    get() {
      return page.block.classList.contains('kwg-hiding-source') ? 'Stable reasoning\ntext.' : 'Stable reasoning text.';
    },
    set(value) { node.textContent = value; },
  });
  try {
    page.notify([{ target: page.block, type: 'childList' }]);
    page.observers.forEach(observer => observer.emit([{ type: 'childList', target: page.summary }]));
    await page.clock.advance(2000);
    expect(page.bindings).toHaveLength(1);
    expect(page.document.querySelector('.kwg-translated').textContent).toBe('稳定译文');
    // The class must be restored after the read.
    expect(page.block.classList.contains('kwg-hiding-source')).toBe(true);
  } finally {
    if (original) Object.defineProperty(node, 'innerText', original);
    else delete node.innerText;
  }
});

test('oversized reasoning fails immediately in the renderer and preserves the original', async () => {
  const page = boot({ text: '合'.repeat(120001) });
  await page.clock.advance(1000);
  await settle();
  expect(page.bindings).toHaveLength(0);
  expect(page.document.querySelector('.kwg-status').textContent).toBe('思考文本过长');
  expect(page.block.classList.contains('kwg-hiding-source')).toBe(false);
});

test('a large but bounded code block is protected whole; an unbounded one is refused, not translated', async () => {
  const big = 'w'.repeat(5000);
  const bounded = boot({ text: 'Run it.', codeTexts: [['pre', big], ['code', 'x']] });
  await bounded.clock.advance(1000);
  expect(bounded.bindings).toHaveLength(1);
  expect(bounded.bindings[0].protectedTexts).toContain(big);
  expect(bounded.bindings[0].protectedTexts).toContain('x');
  expect(bounded.bindings[0].text).not.toContain(big);

  const many = Array.from({ length: 260 }, (_, index) => ['code', `token${index}`]);
  const overflow = boot({ text: 'Run all tokens.', codeTexts: many });
  await overflow.clock.advance(1000);
  expect(overflow.bindings).toHaveLength(0);
  const status = overflow.document.querySelector('.kwg-status');
  expect(status.textContent).toBe('代码内容过长，未翻译');
  expect(status.dataset.state).toBe('error');
  expect(overflow.document.querySelector('.kwg-translated')).toBeNull();
  expect(overflow.block.classList.contains('kwg-hiding-source')).toBe(false);
});

import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { TranslationSession } from '../src/translation-host.mjs';
import { TranslationRuntime, readTranslationSettings } from '../src/translation-runtime.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

// The shipped payload, not a stand-in: the race this file covers only exists
// because the real renderer scans inside the evaluation that installs it.
const PAYLOAD = fs.readFileSync(path.join(import.meta.dir, '..', 'ui', 'translation-renderer.js'), 'utf8');
const WORK_URL = 'file:///app/kimi-agent.html';
const CHAT_URL = 'https://www.kimi.com/chat/7f3c1a2b';
const SESSION = 'test-session';
const MAIN_CONTEXT = 7;
const TRANSLATED = '合成译文';

// A DOM stand-in with the members both thinking surfaces touch. Selectors are
// matched the way the payload writes them: a tag, `[attr]`, `.a`, or `.a.b`.
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
    };
  }

  get textContent() {
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._text;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerText() { return this._innerText ?? this.textContent; }
  set innerText(value) { this._innerText = String(value); this._text = String(value); }
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
  }
  createElement(tagName) { return new Node(tagName, this); }
  getElementById(id) { return [...this.walk()].find(node => node.id === id) || null; }
  addEventListener() {}
  removeEventListener() {}
}

// The two shapes the renderer was written against: Work's summary/body pair and
// Chat's expanded thinking container.
function placeBlock(document, surface, text) {
  const block = document.createElement('div');
  block.className = surface === 'work' ? 'think-block' : 'toolcall-container thinking-container is-expanded';
  const markdown = document.createElement('div');
  markdown.className = surface === 'work' ? 'chat-markdown' : 'markdown';
  markdown.innerText = text;
  if (surface === 'work') {
    const summary = document.createElement('div');
    summary.className = 'think-summary';
    summary.setAttribute('aria-expanded', 'true');
    const label = document.createElement('span');
    label.className = 'think-label';
    label.textContent = '已完成思考';
    summary.appendChild(label);
    const wrap = document.createElement('div');
    wrap.className = 'think-body-wrap';
    const body = document.createElement('div');
    body.className = 'think-body';
    body.appendChild(markdown);
    wrap.appendChild(body);
    block.append(summary, wrap);
  } else {
    const title = document.createElement('div');
    title.className = 'toolcall-title-container';
    const resize = document.createElement('div');
    resize.className = 'resize-container';
    const slot = document.createElement('div');
    slot.className = 'slot-container';
    const content = document.createElement('div');
    content.className = 'toolcall-content';
    const contentText = document.createElement('div');
    contentText.className = 'toolcall-content-text';
    contentText.appendChild(markdown);
    content.append(title, contentText);
    slot.appendChild(content);
    resize.appendChild(slot);
    block.append(title, resize);
  }
  document.body.appendChild(block);
  return { block, markdown };
}

const flush = () => new Promise(resolve => setImmediate(resolve));
async function settle(times = 12) { for (let index = 0; index < times; index += 1) await flush(); }
async function until(predicate, tries = 200) {
  for (let index = 0; index < tries; index += 1) { if (predicate()) return true; await flush(); }
  return false;
}

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

// One fixture per surface. The pipe answers like the browser: `Runtime.evaluate`
// runs the expression in the page realm, and the binding the renderer fires
// during that run is handed to the host *before* the evaluation's reply is
// returned — the ordering the real private pipe produced in the acceptance run.
function fixture({ surface = 'work', text = 'The thinking block is settled.' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-handshake-')); dirs.push(dir);
  const runtime = new TranslationRuntime({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  runtime.configure({ enabled: true });
  const id = crypto.randomUUID();
  const application = path.join(dir, ...(process.platform === 'darwin' ? ['MacOS', 'Kimi'] : ['Kimi.exe']));
  const request = { schemaVersion: 1, id, pid: process.pid, homeDir: runtime.homeDir,
    application, version: '3.2.23', archive: path.join(dir, 'Resources', 'app.asar'), discoveredApplication: application };
  writeSubagentJSON(runtime.launchFile, request);

  const document = new Document();
  const placed = placeBlock(document, surface, text);
  const url = surface === 'work' ? WORK_URL : CHAT_URL;
  const location = { href: url };
  const sandbox = {
    document,
    URL,
    location,
    history: { pushState() {}, replaceState() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    Date,
    // The engine's own timers are not what this file measures; the first scan
    // happens synchronously inside start(), which is exactly the race.
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener() {},
    removeEventListener() {},
    console,
  };
  sandbox.globalThis = sandbox;
  Object.defineProperty(sandbox, 'window', { value: sandbox, configurable: true });
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);

  const calls = [];
  const events = [];
  const bindings = [];
  const replies = [];
  const translations = [];
  const pipe = { closed: false };
  pipe.targets = [{ type: 'page', targetId: surface, url }];
  pipe.mainFrameId = 'main-frame';
  pipe.mainContextId = MAIN_CONTEXT;
  pipe.phase = 'idle';
  pipe.afterEvaluate = null;
  pipe.reportPatch = null;
  pipe.failInjection = null;
  sandbox.__kwgTranslate = payload => {
    const input = JSON.parse(payload);
    const entry = [...session.sessions.values()].find(value => value.sessionId === SESSION);
    events.push({ kind: 'binding', phase: pipe.phase, generation: input.generation,
      hostGeneration: entry?.generation, live: entry ? session.live.has(entry) : false,
      text: input.text });
    // Fire-and-forget, exactly as the page does: the host must cope with a
    // request that arrives before it has its own receipt.
    bindings.push(session.binding({ sessionId: SESSION,
      params: { name: '__kwgTranslate', executionContextId: MAIN_CONTEXT, payload } }).catch(() => {}));
  };
  pipe.send = async (method, params = {}, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === 'Target.getTargets') {
      if (pipe.targets[0]?.url) location.href = pipe.targets[0].url;
      return { targetInfos: pipe.targets };
    }
    if (method === 'Target.getTargetInfo') {
      const target = pipe.targets.find(value => value.targetId === params.targetId);
      if (!target) throw Error('translation_protocol_error');
      return { targetInfo: { targetId: target.targetId, type: target.type, url: target.url } };
    }
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: pipe.mainFrameId, loaderId: 'loader', url } } };
    }
    if (method === 'Target.attachToTarget') return { sessionId: SESSION };
    if (method === 'Runtime.enable') {
      box.enabled ||= new Set();
      if (box.enabled.has(sessionId)) return {};
      box.enabled.add(sessionId);
      session.handleEvent({ method: 'Runtime.executionContextCreated', sessionId,
        params: { context: { id: MAIN_CONTEXT, uniqueId: 'unique-main',
          auxData: { isDefault: true, frameId: pipe.mainFrameId } } } });
      return {};
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'owned-script' };
    if (method === 'Runtime.evaluate') {
      if (pipe.failInjection === 'pipe' && params.contextId === MAIN_CONTEXT && !pipe.injectedOnce) {
        pipe.injectedOnce = true;
        pipe.phase = 'evaluate';
        try { vm.runInContext(params.expression, context); } finally { pipe.phase = 'idle'; }
        throw Error('translation_pipe_closed');
      }
      pipe.phase = 'evaluate';
      let value;
      try { value = vm.runInContext(params.expression, context); } finally { pipe.phase = 'idle'; }
      // A held receipt lets a test observe the exact window between the page's
      // request and the host confirming it.
      if (pipe.holdEvaluate) { const held = pipe.holdEvaluate; pipe.holdEvaluate = null; await held; }
      // A navigation or a destroyed world can land between the page running the
      // script and the host reading its receipt.
      if (pipe.afterEvaluate) { const hook = pipe.afterEvaluate; pipe.afterEvaluate = null; await hook(); }
      if (pipe.reportPatch && params.contextId === MAIN_CONTEXT && value && typeof value === 'object'
        && 'state' in value && 'version' in value) value = { ...value, ...pipe.reportPatch };
      if (typeof params.expression === 'string' && params.expression.startsWith('globalThis.__kwgTranslationReceive')) {
        replies.push(params.expression);
      }
      return { result: { value } };
    }
    return {};
  };
  const box = {};
  const session = new TranslationSession({ stateDir: dir, id,
    translate: async (value, settings) => { translations.push({ text: value, provider: settings.provider }); return TRANSLATED; } });
  const desired = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  session.request = request; session.settings = desired.settings; session.revision = desired.revision;
  session.payload = PAYLOAD; session.pipe = pipe; session.interval = 1e9;
  const entryFor = () => [...session.sessions.values()].find(value => value.sessionId === SESSION);
  const mirror = () => [...document.walk()].find(node => node.className === 'kwg-translated' && !node.hidden
    && node.isConnected) ?? null;
  return { dir, runtime, session, pipe, calls, events, bindings, replies, translations, document, placed,
    entryFor, mirror, sandbox, context };
}

// The receipts of the injections this fixture performed, in order.
const injectionEvaluations = f => f.calls.filter(call => call.method === 'Runtime.evaluate'
  && call.params.contextId === MAIN_CONTEXT && typeof call.params.expression === 'string'
  && call.params.expression.includes('__kwgTranslationGeneration='));

test('a request that arrives before the injection receipt is translated, not dropped', async () => {
  for (const surface of ['work', 'chat']) {
    const f = fixture({ surface });
    const pending = f.session.update();
    await pending;
    expect(await until(() => f.translations.length === 1)).toBe(true);
    expect(await until(() => !!f.mirror())).toBe(true);

    // The evidence that this is the real race and not a synthetic call: the
    // renderer asked while its own evaluation was still running, and the host
    // had not opened the entry yet.
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ kind: 'binding', phase: 'evaluate', live: false });
    expect(f.events[0].generation).toBe(f.events[0].hostGeneration);
    expect(f.translations).toEqual([{ text: 'The thinking block is settled.', provider: 'bing' }]);
    expect(f.mirror().textContent).toBe(TRANSLATED);
    expect(f.replies).toHaveLength(1);

    // The entry was only opened by the receipt, and the request was verified
    // again after that acknowledgement.
    const entry = f.entryFor();
    expect(f.session.live.has(entry)).toBe(true);
    expect(entry.state).toBe('active');
    const receipt = f.calls.findIndex(call => call.method === 'Runtime.evaluate'
      && String(call.params.expression).includes('__kwgTranslationGeneration='));
    const verify = f.calls.findIndex(call => call.method === 'Target.getTargetInfo');
    expect(verify).toBeGreaterThan(receipt);
    expect(f.session.jobs.size).toBe(0);
  }
});

test('without the handshake the same protocol order loses the first request', async () => {
  // The pre-fix behaviour, expressed as the one decision that changed: a call
  // arriving before the receipt is never held, so `verifyEntry` answers "not
  // live" and the reply is dropped for the same reason.
  const f = fixture();
  f.session.startupInjection = () => null;
  await f.session.update();
  await settle();
  expect(f.events).toHaveLength(1);
  expect(f.events[0]).toMatchObject({ phase: 'evaluate', live: false });
  expect(f.translations).toEqual([]);
  expect(f.replies).toEqual([]);
  expect(f.mirror()).toBeNull();
  expect(f.session.jobs.size).toBe(0);
  // The failure is not a hang: the lost request settles like any other refusal.
  expect(await Promise.race([Promise.all(f.bindings).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
});

test('a rejected injection releases the wait without calling the provider or replying', async () => {
  // The renderer still asks, then the receipt fails the surface/top check: the
  // page is not confirmed, so the request must not be paid for, answered, or
  // left waiting.
  const f = fixture();
  f.pipe.reportPatch = { top: false };
  await f.session.update();
  await settle();
  expect(f.events).toHaveLength(1);
  expect(f.events[0].live).toBe(false);
  expect(f.translations).toEqual([]);
  expect(f.replies).toEqual([]);
  expect(f.session.live.size).toBe(0);
  expect(f.entryFor()?.state).toBe('failed');
  expect(f.entryFor()?.injection ?? null).toBeNull();
  expect(await Promise.race([Promise.all(f.bindings).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
});

test('a world destroyed during the injection is not opened by a late receipt', async () => {
  const f = fixture();
  f.pipe.afterEvaluate = () => f.session.handleEvent({ method: 'Runtime.executionContextDestroyed',
    sessionId: SESSION, params: { executionContextId: MAIN_CONTEXT } });
  await f.session.update();
  await settle();
  expect(f.events).toHaveLength(1);
  expect(f.events[0].live).toBe(false);
  expect(f.translations).toEqual([]);
  expect(f.replies).toEqual([]);
  expect(f.session.live.size).toBe(0);
  expect(f.entryFor().mainContextId).toBeUndefined();
  expect(await Promise.race([Promise.all(f.bindings).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
});

test('a navigation during the injection retires it instead of acknowledging the old document', async () => {
  const f = fixture();
  f.pipe.afterEvaluate = () => f.session.handleEvent({ method: 'Page.frameNavigated',
    sessionId: SESSION, params: { frame: { id: 'main-frame', loaderId: 'next' } } });
  await f.session.update();
  await settle();
  expect(f.events).toHaveLength(1);
  expect(f.events[0].live).toBe(false);
  expect(f.translations).toEqual([]);
  expect(f.replies).toEqual([]);
  // The late receipt described the document that just left, so nothing was
  // opened for it; the entry moved on to a generation that was never injected.
  expect(f.session.live.size).toBe(0);
  expect(f.entryFor().generation).toBeGreaterThan(f.events[0].generation);
  expect(f.entryFor().injection ?? null).toBeNull();
  expect(await Promise.race([Promise.all(f.bindings).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
});

test('a closed pipe releases the wait and never reaches the provider', async () => {
  const f = fixture();
  f.pipe.failInjection = 'pipe';
  await f.session.update();
  await settle();
  expect(f.events).toHaveLength(1);
  expect(f.events[0].live).toBe(false);
  expect(f.translations).toEqual([]);
  expect(f.replies).toEqual([]);
  expect(readSubagentJSON(f.runtime.receiptFile).state).toBe('failed');
  expect(await Promise.race([Promise.all(f.bindings).then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
});

test('a request of an older generation during the injection is refused at once, not queued', async () => {
  // A request stamped before this injection belongs to no document the host is
  // injecting, so it is never attached to the handshake: it is refused on the
  // spot and cannot spend the provider or wait for an acknowledgement that does
  // not describe it.
  const f = fixture();
  let release;
  f.pipe.holdEvaluate = new Promise(resolve => { release = resolve; });
  const running = f.session.update();
  await settle();
  const entry = f.entryFor();
  // The renderer already asked inside the evaluation; its receipt is still held.
  expect(entry?.injection).toBeTruthy();
  expect(f.session.live.has(entry)).toBe(false);
  expect(f.events).toHaveLength(1);
  expect(f.events[0].generation).toBe(entry.injection.generation);

  const stale = f.session.binding({ sessionId: SESSION, params: { name: '__kwgTranslate',
    executionContextId: MAIN_CONTEXT, payload: JSON.stringify({ type: 'translate', id: 'stale-1',
      generation: entry.injection.generation - 1, text: 'Older generation reasoning', protectedTexts: [] }) } });
  expect(await Promise.race([stale.then(() => 'settled'),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500))])).toBe('settled');
  expect(f.translations).toEqual([]);

  release();
  await running;
  await settle();
  // The stale request was dropped without an answer — the entry it names was
  // never confirmed, so there is no document that could receive one. The
  // current request was served and answered only after the receipt.
  expect(f.translations.map(item => item.text)).toEqual(['The thinking block is settled.']);
  expect(f.replies).toHaveLength(1);
  expect(f.replies[0]).toContain('__kwgTranslationReceive');
  expect(f.replies[0]).toContain(TRANSLATED);
  expect(f.replies[0]).not.toContain('stale-1');
  expect(f.session.jobs.size).toBe(0);
});

test('two blocks visible at the first injection are both translated through the wait', async () => {
  const f = fixture({ surface: 'work' });
  const second = placeBlock(f.document, 'work', 'A second settled thought.');
  await f.session.update();
  expect(await until(() => f.translations.length === 2)).toBe(true);
  // Both first requests arrived before the receipt and were held, not refused.
  expect(f.events.length).toBeGreaterThanOrEqual(2);
  expect(f.events.every(event => event.phase === 'evaluate' && event.live === false)).toBe(true);
  expect(f.translations.map(entry => entry.text)).toEqual(expect.arrayContaining([
    'The thinking block is settled.', 'A second settled thought.',
  ]));
  expect(f.replies).toHaveLength(2);
  expect(second.block.isConnected).toBe(true);
  expect(f.session.jobs.size).toBe(0);
});

test('a settings save re-injects and the visible block asks again under the new generation', async () => {
  const f = fixture();
  await f.session.update();
  expect(await until(() => !!f.mirror())).toBe(true);
  expect(f.translations).toHaveLength(1);
  const firstGeneration = f.entryFor().generation;

  f.runtime.configure({ enabled: true, provider: 'google' });
  await f.session.update();
  expect(await until(() => f.translations.length === 2)).toBe(true);
  expect(f.translations[1].provider).toBe('google');
  // The block was already on screen and at rest; no click and no timer were
  // needed for it to ask again.
  expect(f.events).toHaveLength(2);
  expect(f.events[1]).toMatchObject({ phase: 'evaluate', live: false });
  expect(f.events[1].generation).toBeGreaterThan(firstGeneration);
  expect(f.entryFor().generation).toBe(f.events[1].generation);
  expect(f.mirror().textContent).toBe(TRANSLATED);
});

test('a load event re-confirms the world and a changed block still translates', async () => {
  const f = fixture();
  await f.session.update();
  expect(await until(() => !!f.mirror())).toBe(true);

  // The page finished loading; the world is kept and only the acknowledgement
  // is refreshed, so the next tick re-injects into the same context.
  f.session.handleEvent({ method: 'Page.loadEventFired', sessionId: SESSION, params: {} });
  const contextBefore = f.entryFor().mainContextId;
  f.placed.markdown.innerText = 'A second thought that finished after the load.';
  await f.session.update();
  expect(await until(() => f.translations.length === 2)).toBe(true);
  expect(f.translations[1].text).toBe('A second thought that finished after the load.');
  expect(f.entryFor().mainContextId).toBe(contextBefore);
  expect(f.events.at(-1)).toMatchObject({ phase: 'evaluate', live: false });
  expect(f.mirror().textContent).toBe(TRANSLATED);
});

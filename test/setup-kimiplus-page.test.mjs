import { expect, test } from 'bun:test';
import fs from 'node:fs';

// Contract-level checks on the first-run page source. They complement the DOM
// stand-in in setup-page.test.mjs: that file drives behaviour, this one pins the
// shape of the new first-run flow so a later edit cannot quietly reintroduce the
// legacy top-level credential pair or drop the provider guidance.
const source = fs.readFileSync(new URL('../ui/setup.html', import.meta.url), 'utf8');
const script = /<script nonce="__SETUP_NONCE__">([\s\S]*?)<\/script>/.exec(source)?.[1] ?? '';

test('first setup submits named connections only, with each key attached to its row', () => {
  expect(script).toContain("api('/api/save'");
  expect(script).toContain('connections: [connection]');
  // The legacy pair must not travel beside the connection: two sources of truth
  // for the same key is exactly what the new contract removes.
  expect(script).not.toContain('payload.baseURL');
  expect(script).not.toContain('payload.apiKey');
  expect(script).toContain('connection.apiKey = key');
});

test('first setup guides through provider presets and the shipped catalog', () => {
  expect(script).toContain("api('/api/providers')");
  expect(script).toContain("api('/api/model-search'");
  expect(script).toContain('applyPreset');
  // The loader must exist *and* be invoked on start, not merely defined.
  expect(script).toContain('loadPresets()');
  expect(script).toMatch(/var presetsReady = loadPresets\(\)/);
  expect(script).toContain('loadPresetModels');
  // Presets fill the address; they never invent a key or overwrite what the user typed.
  expect(script).not.toMatch(/el\('apiKey'\)\.value\s*=\s*preset/);
});

test('multi-protocol candidates auto-fill a route while unknown protocols stay blank', () => {
  // Declared protocols (one or many) produce a route; many catalogs list both.
  expect(script).toContain("protocols.indexOf('responses') >= 0");
  expect(script).toContain('encodeURIComponent(model.id)');
  // Nothing declared must not become a guessed default.
  expect(script).not.toMatch(/protocols\.length\s*\?\s*protocols\s*:\s*\['/);
});

test('first setup shows context budget presets instead of a 128K default', () => {
  expect(source).toContain('256K');
  expect(source).toContain('350K');
  expect(source).toContain('600K');
  expect(script).not.toContain('contextWindow: 131072');
});

// The first-run page never talks to the vendor: it has no usable credential yet
// and the setup server refuses network discovery before an authenticated save.
// So the button must not promise a live `/models` read, and the request it makes
// has to be the preset-backed search.
test('the first-run model button loads the shipped preset catalog, not the upstream', () => {
  expect(script).toContain("api('/api/model-search'");
  expect(script).toContain('载入预设模型');
  // No claim that a live upstream read happens, and no requirement for a key.
  expect(script).not.toContain('只请求上游 GET /models');
  expect(script).not.toContain('读取上游模型目录');
  // The load must be preset-scoped; an empty request would return nothing.
  expect(script).toMatch(/body:\s*\{\s*query:\s*'',\s*presetId:\s*preset\s*\}/);
});

test('first-run models keep unknown capabilities unknown instead of assuming tools', () => {
  // A preset row that does not state `tools` must leave the box unchecked: the
  // user confirms it, the page does not guess in the vendor's favour.
  expect(script).toContain('tools: model.tools === true ? true : undefined');
  expect(script).not.toContain('tools: model.tools !== false');
});

test('the first-run page is branded as Kimi++ and keeps the compat package name', () => {
  expect(source).toContain('<title>Kimi++ · 首次设置</title>');
  expect(source).toContain('<h1>Kimi++ · 首次设置</h1>');
  // The installable package and its paths stay unchanged.
  expect(source).not.toContain('Kimi++网关');
});

test('the accent button foreground meets contrast in both themes', () => {
  // The dark theme lightens the accent, so white text on it drops to 2.2:1.
  // A foreground token keeps the accent itself untouched.
  expect(source).toContain('--on-accent: #ffffff');
  expect(source).toContain('--on-accent: #14181d');
  expect(source).toMatch(/button\.primary\s*\{[^}]*color:\s*var\(--on-accent\)/);
  expect(source).toMatch(/\.btn-link\s*\{[^}]*color:\s*var\(--on-accent\)/);
  expect(source).not.toMatch(/button\.primary\s*\{[^}]*color:\s*#fff/);
});

test('DNS is an explicit opt-in on a fresh install', () => {
  expect(source).toContain('<input type="checkbox" id="dns">');
  expect(source).not.toContain('<input type="checkbox" id="dns" checked>');
  // A saved true is still echoed, not overridden.
  expect(script).toContain("el('dns').checked = Boolean(stateValue.dns && stateValue.dns.enabled === true)");
});

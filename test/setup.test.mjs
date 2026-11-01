import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { run as runCommand } from '../cli.mjs';
// Nothing in this file exercises real native onboarding: an isolated run would
// otherwise reach the macOS administrator prompt while only serving a panel.
const run = (argv, env, io, overrides = {}) => runCommand(argv, env, io, { nativeConnection: false, ...overrides });
import { SetupServer, saveSetup, setupPaths, setupState, inspectOwnedFile, normalizeSetupInput,
  normalizeSetupModels, readCredentials, writePanelEntry } from '../src/setup.mjs';

const KEY = 'sk-setup-test-0123456789';
const MODELS = [
  { id: 'deepseek-v4-1-flash', name: 'DeepSeek V4.1 Flash', protocol: 'responses', contextWindow: 131072, tools: true },
  { id: 'kimi-k3-pro', protocol: 'chat', contextWindow: 262144, tools: true, reasoning: true,
    reasoningEfforts: ['low', 'high'] },
];

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function workspace() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'kwg-setup-'));
  const stateDir = path.join(directory, '状态 目录');
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { directory, stateDir };
}

async function startSetup(options = {}) {
  const space = options.space ?? workspace();
  // Waiting for a background panel is real behaviour, but no test may sit in
  // that loop by accident: the fixture defaults the wait to zero, and a test
  // that exercises the wait passes its own window.
  const server = new SetupServer({ panelWaitMs: 0, stateDir: space.stateDir, ...options });
  const entry = await server.start({ port: 0 });
  cleanups.push(() => server.stop().catch(() => {}));
  const url = new URL(entry);
  return { server, entry, key: entry.slice(entry.indexOf('#key=') + 5), base: 'http://' + url.host,
    space, paths: setupPaths({ stateDir: space.stateDir }) };
}

function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const init = { method, headers: { ...headers } };
    if (body !== null) {
      init.headers['Content-Type'] ??= 'application/json';
      init.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(url, init, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'), json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

const AUTHLESS = { Accept: 'application/json' };

function payload(overrides = {}) {
  return JSON.stringify({ baseURL: 'https://api.example.com/v1', apiKey: KEY, port: 3426, models: MODELS, ...overrides });
}

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
}

// The setup page refuses port 0 (it is a user-visible gateway port), so the
// panel tests ask the OS for a free one instead.
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('setup page is loopback only and needs the one-run session key', async () => {
  const f = await startSetup();
  expect(f.entry.startsWith(f.base + '/#key=')).toBe(true);
  expect(new URL(f.entry).hostname).toBe('127.0.0.1');
  const page = await request(f.base + '/');
  expect(page.status).toBe(200);
  expect(page.text).toContain('Kimi Work 网关 · 首次设置');
  // The page is self-contained: no external asset and no inline style/script
  // without the per-response nonce.
  expect(page.text).not.toMatch(/src="http/);
  for (const match of page.text.matchAll(/<script([^>]*)>/g)) expect(match[1]).toContain('nonce=');
  for (const match of page.text.matchAll(/<style([^>]*)>/g)) expect(match[1]).toContain('nonce=');
  const csp = page.headers['content-security-policy'];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("form-action 'none'");

  expect((await request(f.base + '/api/state')).status).toBe(401);
  expect((await request(f.base + '/api/state', { headers: { ...AUTHLESS, Authorization: 'Bearer nope' } })).status).toBe(401);
  const authorized = await request(f.base + '/api/state', { headers: { Authorization: 'Bearer ' + f.key } });
  expect(authorized.status).toBe(200);
  expect(authorized.json().state.configured).toBe(false);
  expect(await request(f.base + '/nothing', { headers: { Authorization: 'Bearer ' + f.key } })).toMatchObject({ status: 404 });
}, 20000);

test('setup refuses a foreign Host, a foreign Origin and a cross-site request', async () => {
  const f = await startSetup();
  const auth = { Authorization: 'Bearer ' + f.key };
  expect((await request(f.base + '/api/state', { headers: { ...auth, Host: 'evil.example' } })).status).toBe(403);
  expect((await request(f.base + '/api/state', { headers: { ...auth, Origin: 'http://evil.example' } })).status).toBe(403);
  expect((await request(f.base + '/api/state', { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  expect((await request(f.base + '/', { headers: { Host: '127.0.0.1.nip.io:1' } })).status).toBe(403);
  // A same-origin page load is what the browser sends for the entry link.
  expect((await request(f.base + '/', { headers: { 'Sec-Fetch-Site': 'none' } })).status).toBe(200);
  expect((await request(f.base + '/', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status).toBe(200);
}, 20000);

test('one save writes a config, a private credential file and a receipt', async () => {
  const f = await startSetup();
  const auth = { Authorization: 'Bearer ' + f.key };
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { ...auth, Origin: f.base }, body: payload() });
  expect(saved.status).toBe(200);
  const body = saved.json();
  expect(body.ok).toBe(true);
  expect(body.state.configured).toBe(true);
  expect(body.state.baseURL).toBe('https://api.example.com/v1');
  expect(body.state.models.map(model => model.id)).toEqual(['deepseek-v4-1-flash', 'kimi-k3-pro']);
  expect(body.state.apiKeySet).toBe(true);
  expect(body.state.tokenSet).toBe(true);
  // Neither secret ever appears in the response the page receives.
  expect(saved.text).not.toContain(KEY);
  expect(saved.text).not.toMatch(/[a-f0-9]{64}/);

  const config = JSON.parse(fs.readFileSync(f.paths.config, 'utf8'));
  expect(config.upstream).toEqual({ baseURL: 'https://api.example.com/v1', apiKeyEnv: 'KIMI_WORK_UPSTREAM_KEY' });
  expect(config.tokenEnv).toBe('KIMI_WORK_GATEWAY_TOKEN');
  expect(config.port).toBe(3426);
  expect(JSON.stringify(config)).not.toContain(KEY);
  const credentials = readCredentials(f.paths.credentials);
  expect(credentials.upstreamApiKey).toBe(KEY);
  expect(credentials.gatewayToken).toMatch(/^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    expect(fs.statSync(f.paths.credentials).mode & 0o777).toBe(0o600);
    expect(fs.statSync(f.paths.config).mode & 0o777).toBe(0o600);
    expect(fs.statSync(f.paths.stateDir).mode & 0o777).toBe(0o700);
  }
  // The receipt proves this tool wrote both files.
  const receipt = JSON.parse(fs.readFileSync(f.paths.receipt, 'utf8'));
  expect(receipt.config).toBe(f.paths.config);
  expect(receipt.credentials).toBe(f.paths.credentials);
  expect(JSON.stringify(receipt)).not.toContain(KEY);
}, 20000);

test('a second save keeps the token Kimi already stores and can replace the key', async () => {
  const f = await startSetup();
  const auth = { Authorization: 'Bearer ' + f.key };
  const headers = { ...auth, Origin: f.base };
  await request(f.base + '/api/save', { method: 'POST', headers, body: payload() });
  const first = readCredentials(f.paths.credentials);
  // A blank key keeps the stored one; the page never has to re-enter it.
  const second = await request(f.base + '/api/save', { method: 'POST', headers,
    body: payload({ apiKey: undefined, port: 3500 }) });
  expect(second.status).toBe(200);
  const kept = readCredentials(f.paths.credentials);
  expect(kept.gatewayToken).toBe(first.gatewayToken);
  expect(kept.upstreamApiKey).toBe(KEY);
  expect(JSON.parse(fs.readFileSync(f.paths.config, 'utf8')).port).toBe(3500);

  const replaced = await request(f.base + '/api/save', { method: 'POST', headers, body: payload({ apiKey: 'sk-second-key-9999' }) });
  expect(replaced.status).toBe(200);
  const changed = readCredentials(f.paths.credentials);
  expect(changed.upstreamApiKey).toBe('sk-second-key-9999');
  expect(changed.gatewayToken).toBe(first.gatewayToken);
  expect(replaced.text).not.toContain('sk-second-key-9999');
}, 20000);

test('saving refuses to guess a protocol or a capability', async () => {
  const f = await startSetup();
  const auth = { Authorization: 'Bearer ' + f.key };
  const headers = { ...auth, Origin: f.base };
  const send = body => request(f.base + '/api/save', { method: 'POST', headers, body });

  // A Chat-Completions-only service must not be declared as Responses.
  const missingProtocol = await send(payload({ models: [{ id: 'deepseek-v4-1-flash', contextWindow: 131072 }] }));
  expect(missingProtocol.status).toBe(400);
  expect(missingProtocol.json().error.code).toBe('invalid_models');

  const conflicting = await send(payload({ models: [{ id: 'kimi-k3-pro', protocol: 'responses', contextWindow: 262144 }] }));
  expect(conflicting.status).toBe(400);
  expect(conflicting.json().error.code).toBe('protocol_conflict');

  const effortWithoutReasoning = await send(payload({ models: [{ id: 'x-model', protocol: 'responses',
    contextWindow: 1000, reasoningEfforts: ['low'] }] }));
  expect(effortWithoutReasoning.status).toBe(400);

  const unknownProtocol = await send(payload({ models: [{ id: 'x-model', protocol: 'completions', contextWindow: 1000 }] }));
  expect(unknownProtocol.status).toBe(400);

  const extraField = await send(payload({ models: [{ id: 'x-model', protocol: 'responses', contextWindow: 1000,
    supportsVision: true }] }));
  expect(extraField.status).toBe(400);

  const noModels = await send(payload({ models: [] }));
  expect(noModels.status).toBe(400);

  // Nothing was written by any rejected request.
  expect(fs.existsSync(f.paths.config)).toBe(false);
  expect(fs.existsSync(f.paths.credentials)).toBe(false);
}, 20000);

test('saving rejects a bearer URL, a loopback-only rule breach and an oversized body', async () => {
  const f = await startSetup();
  const headers = { Authorization: 'Bearer ' + f.key, Origin: f.base };
  const send = body => request(f.base + '/api/save', { method: 'POST', headers, body });

  for (const baseURL of ['http://api.example.com/v1', 'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=1', 'https://api.example.com/v1#x', 'file:///tmp/x', 'not a url']) {
    const result = await send(payload({ baseURL }));
    expect(result.status).toBe(400);
    expect(result.json().error.code).toBe('invalid_base_url');
  }
  // Plain HTTP is allowed only for a loopback upstream.
  expect((await send(payload({ baseURL: 'http://127.0.0.1:8080/v1' }))).status).toBe(200);
  const tooLarge = await send(JSON.stringify({ baseURL: 'https://api.example.com/v1', apiKey: KEY,
    models: MODELS, padding: 'x'.repeat(70 * 1024) }));
  expect(tooLarge.status).toBe(413);
  expect((await request(f.base + '/api/save', { method: 'POST', headers: { Authorization: 'Bearer ' + f.key },
    body: payload() })).status).toBe(403);
}, 20000);

test('a symlinked or foreign credential file is refused instead of followed', async () => {
  if (process.platform === 'win32') return;
  const f = await startSetup();
  const headers = { Authorization: 'Bearer ' + f.key, Origin: f.base };
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  const target = path.join(f.space.directory, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify({ upstreamApiKey: KEY, gatewayToken: 'a'.repeat(64) }), { mode: 0o600 });
  fs.symlinkSync(target, f.paths.credentials);

  expect(() => inspectOwnedFile(f.paths.credentials)).toThrow('setup_file_conflict');
  const result = await request(f.base + '/api/save', { method: 'POST', headers, body: payload() });
  expect(result.status).toBe(409);
  expect(['setup_file_conflict', 'setup_credentials_conflict']).toContain(result.json().error.code);
  // The link target is untouched and the config was not left half-written.
  expect(JSON.parse(fs.readFileSync(target, 'utf8')).upstreamApiKey).toBe(KEY);
  expect(fs.existsSync(f.paths.receipt)).toBe(false);
}, 20000);

test('a hand-written configuration is never overwritten', async () => {
  const f = await startSetup();
  const headers = { Authorization: 'Bearer ' + f.key, Origin: f.base };
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  const handWritten = { upstream: { baseURL: 'https://hand.example/v1', apiKeyEnv: 'HAND_KEY' },
    models: [{ id: 'hand-model', protocol: 'responses', contextWindow: 1000 }] };
  fs.writeFileSync(f.paths.config, JSON.stringify(handWritten), { mode: 0o600 });

  const result = await request(f.base + '/api/save', { method: 'POST', headers, body: payload() });
  expect(result.status).toBe(409);
  expect(result.json().error.code).toBe('setup_config_conflict');
  expect(JSON.parse(fs.readFileSync(f.paths.config, 'utf8'))).toEqual(handWritten);
  expect(fs.existsSync(f.paths.credentials)).toBe(false);
}, 20000);

test('the state view never contains a secret value', async () => {
  const f = await startSetup();
  const headers = { Authorization: 'Bearer ' + f.key, Origin: f.base };
  await request(f.base + '/api/save', { method: 'POST', headers, body: payload() });
  const view = await request(f.base + '/api/state', { headers: { Authorization: 'Bearer ' + f.key } });
  const text = view.text;
  const credentials = readCredentials(f.paths.credentials);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(credentials.gatewayToken);
  expect(text).not.toMatch(/[a-f0-9]{64}/);
  expect(view.json().state).toMatchObject({ configured: true, apiKeySet: true, tokenSet: true, receipt: 'owned' });
}, 20000);

test('the page can install the service after saving, and a failure keeps the save', async () => {
  const calls = [];
  const f = await startSetup({ installService: async input => {
    calls.push(input);
    return { state: 'installed', kind: 'launchd' };
  } });
  const headers = { Authorization: 'Bearer ' + f.key, Origin: f.base };
  const saved = await request(f.base + '/api/save', { method: 'POST', headers,
    body: payload({ installService: true }) });
  expect(saved.json().service).toEqual({ state: 'installed', kind: 'launchd' });
  expect(calls).toHaveLength(1);
  expect(calls[0].config.port).toBe(3426);
  expect(calls[0].paths.config).toBe(f.paths.config);
  // Neither the key nor the token is handed to the service installer.
  expect(JSON.stringify(calls[0])).not.toContain(KEY);
  expect(JSON.stringify(calls[0])).not.toContain(readCredentials(f.paths.credentials).gatewayToken);

  const failing = await startSetup({ installService: async () => { throw Error('service_launchd_denied'); } });
  const failed = await request(failing.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + failing.key, Origin: failing.base }, body: payload({ installService: true }) });
  expect(failed.status).toBe(200);
  expect(failed.json().ok).toBe(true);
  expect(failed.json().service).toEqual({ state: 'failed', reason: 'service_launchd_denied' });
  expect(failed.json().state.configured).toBe(true);

  // Without the opt-in the save never touches the service manager.
  const manual = await startSetup({ installService: async () => { throw Error('should not run'); } });
  const plain = await request(manual.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + manual.key, Origin: manual.base }, body: payload() });
  expect(plain.json().service).toBeNull();
}, 20000);

test('a page save that asks for a service on an unsupported platform still saves', async () => {
  const f = await startSetup({ platform: 'linux' });
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.key, Origin: f.base }, body: payload({ installService: true }) });
  expect(saved.status).toBe(200);
  expect(saved.json().service.state).toBe('unavailable');
  expect(saved.json().state.configured).toBe(true);
}, 20000);

test('a saved setup hands the authenticated page its real control panel link', async () => {
  const f = await startSetup({ installService: async () => ({ state: 'installed', kind: 'launchd' }), panelWaitMs: 5000 });
  // The gateway publishes its link only once its panel is up; a slow start is
  // waited for instead of failing the save.
  setTimeout(() => {
    const entry = { schemaVersion: 1, url: 'http://127.0.0.1:3427',
      entryURL: 'http://127.0.0.1:3427/#key=' + 'e'.repeat(64), pid: 4242, at: new Date().toISOString() };
    fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f.paths.entry, JSON.stringify(entry), { mode: 0o600 });
  }, 150);
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.key, Origin: f.base }, body: payload({ installService: true }) });
  const body = saved.json();
  expect(body.panel.state).toBe('ready');
  expect(body.panel.url).toBe('http://127.0.0.1:3427');
  expect(body.panel.entryURL).toBe('http://127.0.0.1:3427/#key=' + 'e'.repeat(64));
  // The page never sees the upstream key, and the entry file itself stays private.
  expect(saved.text).not.toContain(KEY);
  // Windows has no POSIX mode to assert; the owner ACL is the privacy boundary.
  if (process.platform !== 'win32') expect(fs.statSync(f.paths.entry).mode & 0o777).toBe(0o600);
}, 30000);

test('a setup save reports a waiting panel instead of failing when nothing publishes a link', async () => {
  const f = await startSetup({ installService: async () => ({ state: 'installed', kind: 'launchd' }),
    panelWaitMs: 400 });
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.key, Origin: f.base }, body: payload({ installService: true }) });
  expect(saved.status).toBe(200);
  expect(saved.json().ok).toBe(true);
  expect(saved.json().panel).toEqual({ state: 'waiting', reason: 'panel_not_ready' });
  // The setup itself is complete, so the user can retry the panel step only.
  expect(saved.json().state.configured).toBe(true);
}, 30000);

test('a manual save does not wait for a background panel it never started', async () => {
  const f = await startSetup({ panelWaitMs: 20000 });
  const started = Date.now();
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.key, Origin: f.base }, body: payload() });
  expect(saved.json().panel.state).toBe('manual');
  expect(Date.now() - started).toBeLessThan(5000);
}, 30000);

test('an unauthenticated caller never learns the panel link', async () => {
  const f = await startSetup({ installService: async () => ({ state: 'installed', kind: 'launchd' }), panelWaitMs: 5000 });
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.paths.entry, JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:3427',
    entryURL: 'http://127.0.0.1:3427/#key=' + 'f'.repeat(64) }), { mode: 0o600 });
  for (const headers of [{}, { Authorization: 'Bearer wrong' }]) {
    const denied = await request(f.base + '/api/state', { headers });
    expect(denied.status).toBe(401);
    expect(denied.text).not.toContain('f'.repeat(64));
  }
}, 20000);

test('a panel entry that is world-readable is not handed out', async () => {
  const f = await startSetup({ installService: async () => ({ state: 'installed', kind: 'launchd' }), panelWaitMs: 300 });
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.paths.entry, JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:3427',
    entryURL: 'http://127.0.0.1:3427/#key=' + 'a'.repeat(64) }), { mode: 0o644 });
  const saved = await request(f.base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + f.key, Origin: f.base }, body: payload({ installService: true }) });
  expect(saved.json().panel.state).toBe('waiting');
  expect(saved.text).not.toContain('a'.repeat(64));
}, 30000);

test('setup wires the page to the real service installer by default', async () => {
  const { stateDir } = workspace();
  const io = capture();
  const calls = [];
  let entryURL;
  // The panel entry is the proof the service came up; the CLI keeps the setup
  // server alive until it exists, so the fixture publishes it from the install.
  const finished = run(['setup', '--state-dir', stateDir], {}, io, {
    panelWaitMs: 50,
    openBrowser: url => { entryURL = url; },
    GatewayService: class {
      constructor(options) { calls.push({ options }); }
      install({ environment }) {
        calls.push({ environment });
        writePanelEntry(path.join(stateDir, 'panel-entry.json'), { url: 'http://127.0.0.1:3427',
          entryURL: 'http://127.0.0.1:3427/#key=' + 'd'.repeat(64) });
        return { state: 'installed', kind: 'launchd' };
      }
    },
  });
  for (let attempt = 0; attempt < 200 && !entryURL; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const url = new URL(entryURL);
  const base = 'http://' + url.host;
  const key = entryURL.slice(entryURL.indexOf('#key=') + 5);
  const saved = await request(base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + key, Origin: base }, body: payload({ installService: true }) });
  expect(saved.json().service).toEqual({ state: 'installed', kind: 'launchd' });
  expect(saved.json().panel.state).toBe('ready');
  expect(await finished).toBe(0);
  // The installer gets the same state directory and config the save wrote, and
  // never receives the upstream key.
  expect(calls).toHaveLength(2);
  expect(calls[0].options.stateDir).toBe(stateDir);
  expect(calls[0].options.configPath).toBe(path.join(stateDir, 'gateway.json'));
  expect(JSON.stringify(calls[0].options)).not.toContain(KEY);
  expect(calls[1].environment).toEqual({});
  expect(io.lines.out).toContain('service installed; starts automatically at login');
  expect(io.lines.out.join('\n')).toContain('panel http://127.0.0.1:3427/#key=' + 'd'.repeat(64));
}, 30000);

test('setupState reports a conflict instead of a broken file leaking its content', async () => {
  const f = await startSetup();
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(f.paths.credentials, '{not json', { mode: 0o600 });
  const state = setupState({ paths: f.paths, platform: process.platform });
  expect(state.apiKeySet).toBe(false);
  expect(state.tokenSet).toBe(false);
  expect(JSON.stringify(state)).not.toContain('not json');
}, 20000);

test('normalizeSetupModels keeps declared values and invents none', () => {
  const models = normalizeSetupModels([{ id: 'plain-model', protocol: 'responses', contextWindow: 64000 }]);
  expect(models).toEqual([{ id: 'plain-model', protocol: 'responses', contextWindow: 64000 }]);
  expect(models[0].tools).toBeUndefined();
  expect(models[0].reasoning).toBeUndefined();
  expect(models[0].inputModalities).toBeUndefined();
  expect(() => normalizeSetupModels([{ id: 'x', contextWindow: 1 }])).toThrow('invalid_models');
  expect(() => normalizeSetupModels([{ id: 'kimi-x', protocol: 'responses', contextWindow: 1 }])).toThrow('protocol_conflict');
});

test('saveSetup refuses an existing credentials file it did not record', () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.credentials, JSON.stringify({ schemaVersion: 1, upstreamApiKey: 'sk-other',
    gatewayToken: 'b'.repeat(64) }), { mode: 0o600 });
  expect(() => saveSetup({ paths, config, apiKey: KEY })).toThrow('setup_credentials_conflict');
  expect(fs.existsSync(paths.config)).toBe(false);
});

test('setup on the CLI prints one link, saves once and exits', async () => {
  const { stateDir } = workspace();
  const io = capture();
  let stopped = false;
  const fakeServer = class {
    constructor(options) { this.onSaved = options.onSaved; }
    async start({ port }) {
      if (port !== 0) throw Error('unexpected port');
      // Act like the page: one save ends the command without any shutdown signal.
      setTimeout(() => this.onSaved({ ok: true, state: { configuration: { file: path.join(stateDir, 'gateway.json') },
        models: [1, 2] }, gateway: { port: 3426 } }), 5);
      return 'http://127.0.0.1:1/#key=abc';
    }
    async stop() { stopped = true; }
  };
  expect(await run(['setup', '--state-dir', stateDir, '--no-open'], {}, io, { SetupServer: fakeServer })).toBe(0);
  expect(io.lines.out[0]).toBe('setup http://127.0.0.1:1/#key=abc');
  expect(io.lines.out).toContain('state ' + stateDir);
  expect(io.lines.out.join('\n')).toContain('models 2, port 3426');
  expect(io.lines.err).toEqual([]);
  expect(stopped).toBe(true);
}, 20000);

test('setup rejects an unknown flag and a bad port with usage', async () => {
  for (const args of [['setup', '--wat', '1'], ['setup', '--port', 'abc'], ['setup', '--port', '99999']]) {
    const io = capture();
    expect(await run(args, {}, io, { openBrowser: false })).toBe(1);
    expect(io.lines.err.join('\n')).toContain('usage:');
  }
}, 20000);

test('the setup command finishes after a real page save, with no secret on stdout', async () => {
  const { stateDir } = workspace();
  const io = capture();
  let entryURL;
  const finished = run(['setup', '--state-dir', stateDir], {}, io, {
    panelWaitMs: 50,
    openBrowser: url => { entryURL = url; },
    installService: async () => {
      writePanelEntry(path.join(stateDir, 'panel-entry.json'), { url: 'http://127.0.0.1:3427',
        entryURL: 'http://127.0.0.1:3427/#key=' + 'a'.repeat(64) });
      return { state: 'installed', kind: 'launchd' };
    },
  });
  // Wait for the link to be printed, then act as the browser would.
  for (let attempt = 0; attempt < 100 && !entryURL; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(entryURL).toBeTruthy();
  const url = new URL(entryURL);
  const base = 'http://' + url.host;
  const key = entryURL.slice(entryURL.indexOf('#key=') + 5);
  const saved = await request(base + '/api/save', { method: 'POST',
    headers: { Authorization: 'Bearer ' + key, Origin: base }, body: payload({ installService: true }) });
  expect(saved.status).toBe(200);
  expect(saved.json().service.state).toBe('installed');
  expect(saved.json().panel.state).toBe('ready');
  const code = await finished;
  expect(code).toBe(0);
  expect(io.lines.out.some(line => line.startsWith('saved '))).toBe(true);
  expect(io.lines.out).toContain('service installed; starts automatically at login');
  expect(io.lines.out).toContain('panel http://127.0.0.1:3427/#key=' + 'a'.repeat(64));
  expect(io.lines.out.join('\n')).not.toContain(KEY);
  expect(io.lines.out.join('\n')).not.toContain(readCredentials(path.join(stateDir, 'credentials.json')).gatewayToken);
  // The listening socket is closed once the save completes.
  await expect(request(base + '/api/state', { headers: { Authorization: 'Bearer ' + key } })).rejects.toBeTruthy();
}, 30000);

test('a failed service keeps the setup server alive until the page retries and the panel is ready', async () => {
  const { stateDir } = workspace();
  const io = capture();
  let entryURL;
  let attempts = 0;
  // The CLI no longer exits on a failed service: the page stays retryable and
  // the command only finishes once a save really produced a panel link.
  const finished = run(['setup', '--state-dir', stateDir], {}, io, {
    panelWaitMs: 50,
    openBrowser: url => { entryURL = url; },
    installService: async () => {
      attempts++;
      if (attempts === 1) return { state: 'failed', kind: 'launchd' };
      writePanelEntry(path.join(stateDir, 'panel-entry.json'), { url: 'http://127.0.0.1:3427',
        entryURL: 'http://127.0.0.1:3427/#key=' + 'b'.repeat(64) });
      return { state: 'started', kind: 'launchd', needsFreshEntry: true };
    },
  });
  for (let attempt = 0; attempt < 100 && !entryURL; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const url = new URL(entryURL);
  const base = 'http://' + url.host;
  const key = entryURL.slice(entryURL.indexOf('#key=') + 5);
  const headers = { Authorization: 'Bearer ' + key, Origin: base };
  let settled = false;
  void finished.then(() => { settled = true; });
  const failed = await request(base + '/api/save', { method: 'POST', headers, body: payload({ installService: true }) });
  expect(failed.status).toBe(200);
  expect(failed.json().service).toEqual({ state: 'failed', kind: 'launchd' });
  expect(failed.json().panel).toEqual({ state: 'manual' });
  // The save is kept and the listener is still there, so the page can retry.
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(settled).toBe(false);
  expect((await request(base + '/api/state', { headers: { Authorization: 'Bearer ' + key } })).status).toBe(200);

  const retried = await request(base + '/api/save', { method: 'POST', headers, body: payload({ installService: true, port: 3500 }) });
  expect(retried.json().service.state).toBe('started');
  expect(retried.json().panel.state).toBe('ready');
  expect(await finished).toBe(0);
  expect(io.lines.out).toContain('service started; starts automatically at login');
  expect(io.lines.out.join('\n')).not.toContain(KEY);
}, 30000);

test('panel --credentials starts from the two named values with no shell environment', async () => {
  const { directory, stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS,
    port: await freePort(), dns: false });
  saveSetup({ paths, config, apiKey: KEY });

  // A background start has no shell environment. The Kimi home is a temporary
  // one: this test must never read or write the user's real data directory.
  const io = capture();
  const kimiDir = path.join(directory, 'kimi');
  const runner = { code: await run(['panel', '--config', paths.config, '--state-dir', stateDir,
    '--kimi-dir', kimiDir, '--credentials', paths.credentials, '--ui-port', '0'], {}, io, { waitForShutdown: async () => {} }) };
  expect(runner.code).toBe(0);
  expect(io.lines.out.join('\n')).not.toContain(KEY);
  fs.rmSync(directory, { recursive: true, force: true });
}, 30000);

// Public readability is a POSIX mode; Windows keeps the file private through
// the owner ACL, where 0644 is not expressible and chmod is not a permission
// boundary. Only the POSIX refusal is asserted here.
test.skipIf(process.platform === 'win32')('panel --credentials refuses a publicly readable file on POSIX', async () => {
  const { directory, stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS,
    port: await freePort(), dns: false });
  saveSetup({ paths, config, apiKey: KEY });

  const io = capture();
  fs.chmodSync(paths.credentials, 0o644);
  const code = await run(['panel', '--config', paths.config, '--state-dir', stateDir,
    '--kimi-dir', path.join(directory, 'kimi'), '--credentials', paths.credentials, '--ui-port', '0'], {}, io,
  { waitForShutdown: async () => {} });
  expect(code).toBe(2);
  expect(io.lines.err.join('\n')).toContain('cannot read credentials file');
  expect(io.lines.out.join('\n')).not.toContain(KEY);
  fs.rmSync(directory, { recursive: true, force: true });
}, 30000);

test('panel writes a private entry file for the background status link and removes it on exit', async () => {
  const { stateDir, directory } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS,
    port: await freePort(), dns: false });
  saveSetup({ paths, config, apiKey: KEY });
  const entryFile = path.join(directory, 'run', 'panel-entry.json');
  const io = capture();
  const code = await run(['panel', '--config', paths.config, '--state-dir', stateDir,
    '--kimi-dir', path.join(directory, 'kimi'),
    '--credentials', paths.credentials, '--entry-file', entryFile, '--ui-port', '0'], {}, io, {
    waitForShutdown: async () => {
      const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
      expect(entry.entryURL.startsWith(entry.url + '/#key=')).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(entryFile).mode & 0o777).toBe(0o600);
      expect(io.lines.out.join('\n')).not.toContain(entry.entryURL.split('#key=')[1]);
    },
  });
  expect(code).toBe(0);
  expect(fs.existsSync(entryFile)).toBe(false);
  expect(io.lines.out.join('\n')).not.toContain(KEY);
  fs.rmSync(directory, { recursive: true, force: true });
}, 30000);

test('credentials read back only from a regular private file', async () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  const written = saveSetup({ paths, config, apiKey: KEY });
  expect(readCredentials(paths.credentials, { requirePrivate: true }).gatewayToken).toBe(written.credentials.gatewayToken);
  fs.writeFileSync(paths.credentials, JSON.stringify({ schemaVersion: 1, upstreamApiKey: KEY,
    gatewayToken: 'c'.repeat(64), extra: true }), { mode: 0o600 });
  expect(() => readCredentials(paths.credentials)).toThrow('setup_credentials_conflict');
  // A gateway token that is not 32 random bytes is not accepted.
  fs.writeFileSync(paths.credentials, JSON.stringify({ schemaVersion: 1, upstreamApiKey: KEY, gatewayToken: 'short' }), { mode: 0o600 });
  expect(() => readCredentials(paths.credentials)).toThrow('setup_credentials_conflict');
});

// Windows privacy is the owner ACL, not a POSIX mode: the mode Windows reports
// for a file this tool wrote is 0666 and cannot be narrowed, so applying the
// POSIX rule there refused every legitimate `requirePrivate` read.
test('a requirePrivate read applies the POSIX rule only outside Windows', () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  const written = saveSetup({ paths, config, apiKey: KEY });
  if (process.platform !== 'win32') fs.chmodSync(paths.credentials, 0o644);

  expect(readCredentials(paths.credentials, { platform: 'win32', requirePrivate: true }).gatewayToken)
    .toBe(written.credentials.gatewayToken);
  for (const platform of ['darwin', 'linux']) {
    // uid is pinned so this isolates the POSIX mode rule; ownership on a
    // Windows host is a separate check with its own coverage.
    expect(() => readCredentials(paths.credentials, { platform, uid: null, requirePrivate: true }))
      .toThrow('setup_credentials_permissions');
  }
  // A caller that names no platform is judged by the platform it runs on; this
  // is the shape the background service and the CLI already use.
  if (process.platform === 'win32') {
    expect(readCredentials(paths.credentials, { requirePrivate: true }).gatewayToken).toBe(written.credentials.gatewayToken);
  } else {
    expect(() => readCredentials(paths.credentials, { requirePrivate: true })).toThrow('setup_credentials_permissions');
  }
});

test('a panel edit of models does not expire the setup ownership', () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  saveSetup({ paths, config, apiKey: KEY });
  const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'));
  // The panel rewrites the same file with different models and a chosen
  // subagent target; ownership is a token plus paths, not a content hash.
  const edited = { ...JSON.parse(fs.readFileSync(paths.config, 'utf8')),
    models: [{ id: 'other-model', protocol: 'responses', contextWindow: 64000 }],
    subagents: { mode: 'inherit', transport: 'native-config' } };
  fs.writeFileSync(paths.config, JSON.stringify(edited), { mode: 0o600 });
  expect(setupState({ paths, platform: process.platform }).receipt).toBe('owned');

  // Changing only the key is still allowed, and the token stays the same so
  // nothing Kimi stored has to change.
  const before = readCredentials(paths.credentials).gatewayToken;
  const replace = saveSetup({ paths, config: { ...edited, upstream: { ...edited.upstream, baseURL: 'https://api2.example.com/v1' } },
    apiKey: 'sk-second-key-9999' });
  expect(readCredentials(paths.credentials).gatewayToken).toBe(before);
  expect(replace.credentials.upstreamApiKey).toBe('sk-second-key-9999');
  const after = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'));
  expect(after.token).toBe(receipt.token);
  expect(after.configDigest).toBeUndefined();
}, 20000);

test('setup keeps settings it does not own when it saves again', () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  saveSetup({ paths, config, apiKey: KEY });
  // The panel adds subagents, translation and a field this version does not know.
  const current = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  fs.writeFileSync(paths.config, JSON.stringify({ ...current,
    subagents: { mode: 'inherit', transport: 'native-config' },
    translation: { enabled: true, provider: 'bing', targetLanguage: 'ja', view: 'translated' },
    futureSetting: { keep: true } }), { mode: 0o600 });
  saveSetup({ paths, config: { ...config, port: 3500 }, apiKey: KEY });
  const saved = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  expect(saved.port).toBe(3500);
  expect(saved.subagents).toEqual({ mode: 'inherit', transport: 'native-config' });
  expect(saved.translation).toEqual({ enabled: true, provider: 'bing', targetLanguage: 'ja', view: 'translated' });
  expect(saved.futureSetting).toEqual({ keep: true });
}, 20000);

test('a receipt for another state directory does not authorize a rewrite', () => {
  const { stateDir, directory } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  saveSetup({ paths, config, apiKey: KEY });
  // Move the whole directory: the paths inside the receipt no longer match.
  const moved = path.join(directory, 'moved');
  fs.renameSync(stateDir, moved);
  const movedPaths = setupPaths({ stateDir: moved });
  expect(setupState({ paths: movedPaths, platform: process.platform }).receipt).toBe('foreign');
  expect(() => saveSetup({ paths: movedPaths, config, apiKey: KEY })).toThrow('setup_config_conflict');
  // The moved files are untouched.
  expect(JSON.parse(fs.readFileSync(movedPaths.config, 'utf8')).upstream.baseURL).toBe('https://api.example.com/v1');
}, 20000);

test('a foreign credential file still blocks a rewrite even with our receipt gone', () => {
  const { stateDir } = workspace();
  const paths = setupPaths({ stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  saveSetup({ paths, config, apiKey: KEY });
  fs.rmSync(paths.receipt);
  expect(() => saveSetup({ paths, config, apiKey: 'sk-second-key-9999' }))
    .toThrow('setup_config_conflict');
  expect(readCredentials(paths.credentials).upstreamApiKey).toBe(KEY);
}, 20000);

// --- panel handoff -----------------------------------------------------------

// A save that needs a fresh entry is driven by an injectable clock, so a
// waiting panel never leaves a real timer behind in the test process.
function steppedClock() {
  const clock = { time: 0, sleeps: [] };
  clock.now = () => clock.time;
  clock.sleep = ms => { clock.sleeps.push(ms); clock.time += ms; return Promise.resolve(); };
  return clock;
}

function panelEntry(entryURL, url = 'http://127.0.0.1:3427') {
  return { schemaVersion: 1, url, entryURL, at: new Date().toISOString(), pid: 4242 };
}

test('a restarted service with only the old panel entry stays waiting and publishes nothing', async () => {
  const clock = steppedClock();
  const f = await startSetup({ ...clock, panelWaitMs: 3000, pollMs: 250,
    // A safe restart of a running gateway: the caller reports it directly.
    installService: async () => ({ state: 'started', needsFreshEntry: true }) });
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  const oldEntry = 'http://127.0.0.1:3427/#key=' + '1'.repeat(64);
  fs.writeFileSync(f.paths.entry, JSON.stringify(panelEntry(oldEntry)), { mode: 0o600 });
  const auth = { Authorization: 'Bearer ' + f.key };
  const headers = { ...auth, Origin: f.base };
  // The first save is a manual one: it may advertise the entry it did not start.
  const manual = await request(f.base + '/api/save', { method: 'POST', headers, body: payload() });
  expect(manual.json().panel.state).toBe('ready');

  const restarted = await request(f.base + '/api/save', { method: 'POST', headers,
    body: payload({ installService: true, port: 3500, apiKey: undefined }) });
  // The safe restart is still in flight; the entry that was there before the
  // save describes the old configuration and must not be offered again.
  expect(restarted.json().service).toEqual({ state: 'started', needsFreshEntry: true });
  expect(restarted.json().panel.state).toBe('waiting');
  expect(restarted.text).not.toContain('1'.repeat(64));
  expect(restarted.text).not.toContain(KEY);
  expect(clock.sleeps.length).toBeGreaterThan(0);

  const view = await request(f.base + '/api/state', { headers: auth });
  expect(view.json().panel.state).toBe('waiting');
  expect(view.text).not.toContain('1'.repeat(64));
  // The state read did not complete a handoff, so no caller was released.
  expect(f.server.pendingPanel).not.toBeNull();
}, 20000);

test('a waiting panel turns ready on the next state read and releases the caller once', async () => {
  const clock = steppedClock();
  const saved = [];
  const f = await startSetup({ ...clock, panelWaitMs: 3000, pollMs: 250, onSaved: result => saved.push(result),
    installService: async () => ({ state: 'waiting', reason: 'runner_busy', needsFreshEntry: true }) });
  const auth = { Authorization: 'Bearer ' + f.key };
  const headers = { ...auth, Origin: f.base };
  const first = await request(f.base + '/api/save', { method: 'POST', headers, body: payload({ installService: true }) });
  expect(first.json().service).toMatchObject({ state: 'waiting', reason: 'runner_busy', needsFreshEntry: true });
  expect(first.json().panel).toEqual({ state: 'waiting', reason: 'panel_not_ready' });
  expect(saved).toHaveLength(1);

  // Still waiting: the read is an honest "not yet" and releases nobody.
  const pending = await request(f.base + '/api/state', { headers: auth });
  expect(pending.json().panel.state).toBe('waiting');
  expect(pending.json().service.state).toBe('waiting');
  expect(saved).toHaveLength(1);

  writePanelEntry(f.paths.entry, panelEntry('http://127.0.0.1:3428/#key=' + '2'.repeat(64), 'http://127.0.0.1:3428'));
  const ready = await request(f.base + '/api/state', { headers: auth });
  expect(ready.json().panel).toEqual({ state: 'ready', url: 'http://127.0.0.1:3428',
    entryURL: 'http://127.0.0.1:3428/#key=' + '2'.repeat(64) });
  // The restart is confirmed by its new entry, so the caller is told it applied.
  expect(ready.json().service.state).toBe('started');
  expect(ready.json().service.needsFreshEntry).toBe(false);
  expect(ready.text).not.toContain(KEY);
  expect(saved).toHaveLength(2);
  expect(saved[1]).toMatchObject({ ok: true, gateway: { port: 3426 },
    service: { state: 'started' }, panel: { state: 'ready' } });

  // A second read never releases the caller again.
  const again = await request(f.base + '/api/state', { headers: auth });
  expect(again.json().panel.state).toBe('ready');
  expect(saved).toHaveLength(2);
}, 20000);

test('a failed service is retried from the page and only a real new entry finishes it', async () => {
  const clock = steppedClock();
  const calls = [];
  const saved = [];
  const f = await startSetup({ ...clock, panelWaitMs: 0, onSaved: result => saved.push(result),
    installService: async input => {
      calls.push(input);
      if (calls.length === 1) throw Error('service_install_failed');
      return { state: 'waiting', reason: 'runner_timeout', needsFreshEntry: true };
    } });
  fs.mkdirSync(f.paths.stateDir, { recursive: true, mode: 0o700 });
  // An entry from an older run exists: a failed install must not adopt it.
  const stale = 'http://127.0.0.1:3427/#key=' + '3'.repeat(64);
  fs.writeFileSync(f.paths.entry, JSON.stringify(panelEntry(stale)), { mode: 0o600 });
  const auth = { Authorization: 'Bearer ' + f.key };
  const headers = { ...auth, Origin: f.base };

  const failed = await request(f.base + '/api/save', { method: 'POST', headers, body: payload({ installService: true }) });
  expect(failed.status).toBe(200);
  expect(failed.json().state.configured).toBe(true);
  expect(failed.json().service).toEqual({ state: 'failed', reason: 'service_install_failed' });
  expect(failed.json().panel).toEqual({ state: 'manual' });
  expect(failed.text).not.toContain('3'.repeat(64));
  expect(saved).toHaveLength(1);

  // The same page saves again; the retry is a normal save, not a dead end.
  const retry = await request(f.base + '/api/save', { method: 'POST', headers,
    body: payload({ installService: true, port: 3600 }) });
  expect(retry.status).toBe(200);
  expect(retry.json().service.state).toBe('waiting');
  expect(retry.json().panel.state).toBe('waiting');
  expect(calls).toHaveLength(2);
  // The older entry is still not proof, even though it is now the only one.
  expect((await request(f.base + '/api/state', { headers: auth })).json().panel.state).toBe('waiting');
  expect(saved).toHaveLength(2);

  const fresh = 'http://127.0.0.1:3429/#key=' + '4'.repeat(64);
  writePanelEntry(f.paths.entry, panelEntry(fresh, 'http://127.0.0.1:3429'));
  const ready = await request(f.base + '/api/state', { headers: auth });
  expect(ready.json().panel).toEqual({ state: 'ready', url: 'http://127.0.0.1:3429', entryURL: fresh });
  expect(ready.json().service).toMatchObject({ state: 'started', needsFreshEntry: false });
  expect(saved).toHaveLength(3);
  expect(saved[2].panel.entryURL).toBe(fresh);
  expect(ready.text).not.toContain(KEY);
  expect(ready.text).not.toContain('3'.repeat(64));
}, 20000);

test('the state view keeps the panel link behind authentication and out of the service fields', async () => {
  const clock = steppedClock();
  const f = await startSetup({ ...clock, panelWaitMs: 0,
    installService: async () => ({ state: 'failed', reason: 'service_install_failed', launcher: '/private/launcher' }) });
  writePanelEntry(f.paths.entry, panelEntry('http://127.0.0.1:3427/#key=' + '5'.repeat(64)));
  const auth = { Authorization: 'Bearer ' + f.key };
  await request(f.base + '/api/save', { method: 'POST', headers: { ...auth, Origin: f.base },
    body: payload({ installService: true }) });
  const anonymous = await request(f.base + '/api/state');
  expect(anonymous.status).toBe(401);
  expect(anonymous.text).not.toContain('5'.repeat(64));

  const view = await request(f.base + '/api/state', { headers: auth });
  const body = view.json();
  // The installer's own paths never reach the page, and a failed service has
  // no panel to offer even though an entry file is present.
  expect(body.service).toEqual({ state: 'failed', reason: 'service_install_failed' });
  expect(body.panel).toEqual({ state: 'manual' });
  expect(body.state.apiKeySet).toBe(true);
  expect(view.text).not.toContain(KEY);
  expect(view.text).not.toContain(readCredentials(f.paths.credentials).gatewayToken);
  expect(view.text).not.toContain('site-packages');
}, 20000);

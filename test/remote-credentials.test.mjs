import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installRemoteCredentials, MAX_PLAINTEXT, credentialApplication,
  remoteCredentialsPaths, rotateRemoteCredentialsLog } from '../src/remote-credentials.mjs';
import { readCredentialServiceConfig, startRemoteCredentialsService } from '../src/remote-credentials-service.mjs';

// This module is macOS-only: its helper identity is a Keychain ACL and its
// private channel is a Unix socket owned by the current uid, so the suites below
// are skipped elsewhere instead of asserting support that does not exist.
// One fixture tree for the whole file, outside TMPDIR so a service that repoints
// temp cannot relocate it, is created on first use and removed once in afterAll:
// no case directory survives into another suite, and a skipped run leaves
// nothing behind.
let BASE;
const fixtureTree = () => (BASE ??= fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.kwg-credentials-test-'))));
afterAll(() => { if (BASE) fs.rmSync(BASE, { recursive: true, force: true }); });
let counter = 0;

function stateRoot() {
  const root = path.join(fixtureTree(), 'case-' + (++counter));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.realpathSync(root);
}

// A private state directory laid out the way ensureRemoteCredentials leaves it,
// without building or signing a real bundle. The application is the fixed helper
// path the production code requires; a mocked invoke needs no binary there.
function configFixture({ tokenFile = true, serviceFiles = false } = {}) {
  const stateDir = stateRoot();
  const root = path.join(stateDir, 'remote-credentials', 'v1');
  for (const name of ['temp', 'userData', 'sessionData', 'crashDumps', 'documents', 'downloads', 'desktop', 'logs']) {
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  }
  const socket = path.join(root, 'service.sock');
  const token = path.join(root, 'service.token');
  if (tokenFile) fs.writeFileSync(token, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const config = { root, application: credentialApplication(root),
    client: remoteCredentialsPaths.client, socket, tokenFile: token };
  if (serviceFiles) {
    fs.mkdirSync(path.dirname(config.application), { recursive: true });
    fs.writeFileSync(config.application, 'synthetic-helper');
    fs.writeFileSync(path.join(root, 'service.json'), JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  }
  return { stateDir, root, config };
}

// Synthetic safeStorage stand-in: the gateway only ever delegates, and the
// production key must never be involved in a test run.
function mockSafeStorage() {
  const calls = [];
  const available = { value: true };
  return {
    available, calls,
    isEncryptionAvailable() { calls.push(['available']); return available.value; },
    encryptString(text) { calls.push(['encrypt', text.length]); return Buffer.from('enc:' + text, 'utf8'); },
    decryptString(buffer) {
      calls.push(['decrypt', buffer.length]);
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw Error('decrypt_failed');
      return text.slice(4);
    },
  };
}

function invoker(responses) {
  const seen = [];
  return {
    seen,
    invoke: (settings, payload) => {
      seen.push({ settings, payload });
      const next = typeof responses === 'function' ? responses(payload) : responses.shift();
      return next ?? { ok: false, code: 'remote_credentials_unavailable' };
    },
  };
}

const surface = value => Object.keys(value).sort();

// src/remote-credentials.mjs refuses every non-darwin state directory, so the
// whole file runs only where the helper actually exists.
const macos = process.platform === 'darwin';

describe.skipIf(!macos)('installRemoteCredentials replaces the live safeStorage methods', () => {
  test('returns exactly the three synchronised methods plus uninstall', () => {
    const { config } = configFixture();
    const delegated = installRemoteCredentials(mockSafeStorage(), config,
      { invoke: () => ({ ok: true, value: true }) });
    expect(surface(delegated)).toEqual(['decryptString', 'encryptString', 'isEncryptionAvailable', 'uninstall']);
    delegated.uninstall();
  });

  test('a call through the original variable reaches the helper, not the local method', () => {
    const { config } = configFixture();
    const safe = mockSafeStorage();
    const localCalls = [];
    const local = {
      available: safe.isEncryptionAvailable,
      encrypt: safe.encryptString,
      decrypt: safe.decryptString,
    };
    // Count any use of the original methods so a regression to a wrapper that
    // only returns new functions is visible.
    safe.isEncryptionAvailable = () => { localCalls.push('available'); return local.available(); };
    safe.encryptString = text => { localCalls.push('encrypt'); return local.encrypt(text); };
    safe.decryptString = value => { localCalls.push('decrypt'); return local.decrypt(value); };
    safe.calls.length = 0;

    const driver = invoker(payload => {
      if (payload.operation === 'available') return { ok: true, value: true };
      if (payload.operation === 'encrypt') return { ok: true, value: Buffer.from('enc:synthetic').toString('base64') };
      return { ok: true, value: 'kwg-synthetic' };
    });
    const delegated = installRemoteCredentials(safe, config, { invoke: driver.invoke });

    // The runtime ignores the return value and keeps using its own reference, so
    // the object itself must now delegate.
    expect(safe.encryptString).not.toBe(local.encrypt);
    expect(safe.isEncryptionAvailable).not.toBe(local.available);
    expect(safe.decryptString).not.toBe(local.decrypt);

    const cipher = safe.encryptString('kwg-synthetic');
    expect(localCalls).toEqual([]);
    expect(safe.calls).toHaveLength(0);
    expect(driver.seen[0].payload).toEqual({ operation: 'encrypt', value: 'kwg-synthetic',
      socket: config.socket, tokenFile: config.tokenFile });
    expect(driver.seen[0].payload.token).toBeUndefined();
    expect(Buffer.isBuffer(cipher)).toBe(true);

    expect(safe.isEncryptionAvailable()).toBe(true);

    expect(safe.decryptString(cipher)).toBe('kwg-synthetic');
    const last = driver.seen[driver.seen.length - 1].payload;
    expect(last).toEqual({ operation: 'decrypt',
      value: cipher.toString('base64'), socket: config.socket, tokenFile: config.tokenFile });
    expect(last.token).toBeUndefined();
    expect(localCalls).toEqual([]);
    delegated.uninstall();
  });

  test('uninstall restores the exact original methods', () => {
    const { config } = configFixture();
    const safe = mockSafeStorage();
    const original = { available: safe.isEncryptionAvailable, encrypt: safe.encryptString, decrypt: safe.decryptString };
    const delegated = installRemoteCredentials(safe, config, { invoke: () => ({ ok: true, value: true }) });
    delegated.uninstall();
    expect(safe.isEncryptionAvailable).toBe(original.available);
    expect(safe.encryptString).toBe(original.encrypt);
    expect(safe.decryptString).toBe(original.decrypt);
    // Restored methods are the local ones again: no helper call is made.
    expect(safe.encryptString('local').toString('utf8')).toBe('enc:local');
  });

  test('uninstall leaves a method a later owner replaced untouched', () => {
    const { config } = configFixture();
    const safe = mockSafeStorage();
    const delegated = installRemoteCredentials(safe, config, { invoke: () => ({ ok: true, value: true }) });
    const later = () => Buffer.from('later-owner');
    safe.encryptString = later;
    delegated.uninstall();
    expect(safe.encryptString).toBe(later);
    expect(safe.encryptString().toString('utf8')).toBe('later-owner');
  });

  test('uninstall is safe to call twice and after the owner changed', () => {
    const { config } = configFixture();
    const safe = mockSafeStorage();
    const original = safe.decryptString;
    const delegated = installRemoteCredentials(safe, config, { invoke: () => ({ ok: true, value: true }) });
    delegated.uninstall();
    expect(() => delegated.uninstall()).not.toThrow();
    expect(safe.decryptString).toBe(original);
  });

  test('reports availability from the helper, never from the replaced local method', () => {
    const { config } = configFixture();
    const no = mockSafeStorage();
    const off = installRemoteCredentials(no, config, { invoke: () => ({ ok: true, value: true }) });
    expect(no.isEncryptionAvailable()).toBe(true);
    off.uninstall();
    const broken = mockSafeStorage();
    const delegated = installRemoteCredentials(broken, config,
      { invoke: () => ({ ok: false, code: 'remote_credentials_unavailable' }) });
    expect(broken.isEncryptionAvailable()).toBe(false);
    delegated.uninstall();
  });

  test('refuses oversized and non-string plaintext without calling the helper', () => {
    const { config } = configFixture();
    const safe = mockSafeStorage();
    const driver = invoker(() => ({ ok: true, value: '' }));
    const delegated = installRemoteCredentials(safe, config, { invoke: driver.invoke });
    expect(() => safe.encryptString('x'.repeat(MAX_PLAINTEXT + 1))).toThrow('remote_credentials_unavailable');
    for (const value of [undefined, null, 1, {}, ['x']]) {
      expect(() => safe.encryptString(value)).toThrow('remote_credentials_unavailable');
    }
    expect(driver.seen).toHaveLength(0);
    delegated.uninstall();
  });

  test('safeStorage application failures do not restart the helper', () => {
    const { config } = configFixture({ serviceFiles: true });
    const safe = mockSafeStorage();
    let starts = 0, calls = 0;
    const delegated = installRemoteCredentials(safe, config, {
      invoke: () => { calls++; return { ok: false, code: 'remote_credentials_safe_storage_failed' }; },
      start: () => { starts++; },
    });
    expect(() => safe.encryptString('kwg-synthetic')).toThrow('remote_credentials_unavailable');
    expect(() => safe.decryptString(Buffer.from('cipher'))).toThrow('remote_credentials_unavailable');
    expect(calls).toBe(2);
    expect(starts).toBe(0);
    delegated.uninstall();
  });

  test('transport recovery probes a live owner without replacing it or rotating its token', () => {
    const { config, root } = configFixture({ serviceFiles: true });
    const safe = mockSafeStorage();
    const token = fs.readFileSync(config.tokenFile, 'utf8');
    let starts = 0, attempts = 0;
    const timeouts = [];
    const delegated = installRemoteCredentials(safe, config, {
      invoke: (_settings, payload, timeout) => {
        timeouts.push(timeout);
        if (payload.operation === 'status') return { ok: true, value: true, pid: 4242,
          root, application: config.application };
        attempts++;
        return attempts === 1 ? { ok: false, code: 'remote_credentials_client_failed' } : { ok: true, value: true };
      },
      start: () => { starts++; },
    });
    expect(safe.isEncryptionAvailable()).toBe(true);
    expect(attempts).toBe(2);
    expect(starts).toBe(0);
    expect(timeouts.every(value => value > 0 && value <= 2000)).toBe(true);
    expect(fs.readFileSync(config.tokenFile, 'utf8')).toBe(token);
    delegated.uninstall();
  });

  test('transport recovery refuses to start without the private service configuration', () => {
    const { config, root } = configFixture({ serviceFiles: true });
    fs.rmSync(path.join(root, 'service.json'));
    const safe = mockSafeStorage();
    let starts = 0, calls = 0;
    const delegated = installRemoteCredentials(safe, config, {
      invoke: () => { calls++; return { ok: false, code: 'remote_credentials_client_failed' }; },
      start: () => { starts++; },
    });
    expect(safe.isEncryptionAvailable()).toBe(false);
    expect(calls).toBe(1);
    expect(starts).toBe(0);
    delegated.uninstall();
  });

  test('transport recovery has a two second deadline and starts at most once', () => {
    const { config } = configFixture({ serviceFiles: true });
    const safe = mockSafeStorage();
    const timeouts = [];
    let time = 0, starts = 0;
    const delegated = installRemoteCredentials(safe, config, {
      invoke: (_settings, _payload, timeout) => { timeouts.push(timeout);
        return { ok: false, code: 'remote_credentials_client_failed' }; },
      start: () => { starts++; }, now: () => time, wait: ms => { time += ms; },
    });
    expect(safe.isEncryptionAvailable()).toBe(false);
    expect(time).toBe(2000);
    expect(starts).toBe(1);
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts.every(value => value > 0 && value <= 2000)).toBe(true);
    delegated.uninstall();
  });

  test('rejects a configuration that is not the owned helper and client', () => {
    const { config, root } = configFixture();
    for (const value of [
      { ...config, token: 'x'.repeat(64) }, { ...config, key: 'value' },
      { ...config, root: '/tmp' },
      { ...config, application: '/Applications/Kimi.app/Contents/MacOS/Kimi' },
      { ...config, client: '/tmp/kwg-client.mjs' },
      { ...config, socket: path.join(root, 'other.sock') },
      { ...config, tokenFile: path.join(root, 'other.token') },
      { ...config, socket: path.join(root, '..', 'service.sock') },
      { ...config, application: 'relative' }]) {
      expect(() => installRemoteCredentials(mockSafeStorage(), value)).toThrow('remote_credentials_config_invalid');
    }
    for (const value of [null, undefined, [], 'x', 1]) {
      expect(() => installRemoteCredentials(mockSafeStorage(), value)).toThrow('remote_credentials_config_invalid');
    }
    expect(() => installRemoteCredentials(undefined, config)).toThrow('remote_credentials_config_invalid');
  });

  test('the fixed helper path is derived from the root and stays stable', () => {
    const first = configFixture();
    const second = configFixture();
    expect(credentialApplication(first.root)).toBe(first.config.application);
    expect(credentialApplication(first.root)).not.toBe(credentialApplication(second.root));
    expect(path.basename(credentialApplication(first.root))).toBe('KimiWorkCredentials');
    expect(fs.existsSync(first.config.client)).toBe(true);
  });
});

describe.skipIf(!macos)('resident helper private channel', () => {
  // The fake covers only what the service calls; whenReady is deliberately
  // absent so the documented on('ready') fallback is exercised.
  function fakeElectron(overrides = {}) {
    const paths = [];
    let ready;
    const app = {
      setName: () => {}, setPath: (name, value) => paths.push([name, value]), setAppLogsPath: () => {},
      setAsDefaultProtocolClient: () => false, removeAsDefaultProtocolClient: () => false,
      setLoginItemSettings: () => {}, on: (event, handler) => { if (event === 'ready') ready = handler; },
      exit: code => { app.exitCode = code; },
    };
    setTimeout(() => ready?.(), 0);
    const safeStorage = overrides.safeStorage ?? mockSafeStorage();
    return { app, safeStorage, paths, electron: { app, safeStorage } };
  }

  function serviceSettings(root, overrides = {}) {
    const file = path.join(root, 'service.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, root,
      application: credentialApplication(root), socket: path.join(root, 'service.sock'),
      tokenFile: path.join(root, 'service.token'), home: os.homedir(), temp: path.join(root, 'temp'),
      idleMS: 30000, ...overrides }), { mode: 0o600 });
    return file;
  }

  const request = (socket, payload) => new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let buffer = '';
    client.setEncoding('utf8');
    client.on('connect', () => client.write(JSON.stringify(payload) + '\n'));
    client.on('data', chunk => { buffer += chunk; });
    client.on('end', () => { try { resolve(JSON.parse(buffer.trim())); } catch (error) { reject(error); } });
    client.on('error', reject);
  });

  const open = (root, { fake, settings = {} } = {}) =>
    startRemoteCredentialsService(serviceSettings(root, settings), { electron: fake.electron });

  test('isolates every app path without repointing the caller environment', async () => {
    const { root } = configFixture();
    const fake = fakeElectron();
    const tmpdir = process.env.TMPDIR;
    const running = await open(root, { fake });
    try {
      expect(running.pid).toBe(process.pid);
      expect(running.socket).toBe(path.join(root, 'service.sock'));
      expect(typeof running.close).toBe('function');
      const names = fake.paths.map(([name]) => name).sort();
      expect(names).toEqual(['crashDumps', 'desktop', 'documents', 'downloads', 'sessionData', 'temp', 'userData']);
      for (const [, value] of fake.paths) expect(value.startsWith(root + path.sep)).toBe(true);
      expect(process.env.TMPDIR).toBe(tmpdir);
      expect(fs.lstatSync(path.join(root, 'service.sock')).mode & 0o077).toBe(0);
      expect(fs.lstatSync(path.join(root, 'service.token')).mode & 0o077).toBe(0);
    } finally { running.close(); }
  });

  test('close removes its own socket and restart reuses the private token', async () => {
    const { root } = configFixture();
    const first = await open(root, { fake: fakeElectron() });
    expect(fs.existsSync(first.socket)).toBe(true);
    const token = fs.readFileSync(path.join(root, 'service.token'), 'utf8');
    first.close();
    expect(fs.existsSync(first.socket)).toBe(false);
    const second = await open(root, { fake: fakeElectron() });
    try {
      expect(fs.readFileSync(path.join(root, 'service.token'), 'utf8')).toBe(token);
      expect((await request(second.socket, { operation: 'status', token })).ok).toBe(true);
    } finally { second.close(); }
  });

  test('a second service cannot replace a live listener or rotate its token', async () => {
    const { root } = configFixture();
    const first = await open(root, { fake: fakeElectron() });
    const token = fs.readFileSync(path.join(root, 'service.token'), 'utf8');
    const state = fs.readFileSync(path.join(root, 'service-state.json'), 'utf8');
    try {
      await expect(open(root, { fake: fakeElectron() })).rejects.toThrow('remote_credentials_service_conflict');
      expect(fs.readFileSync(path.join(root, 'service.token'), 'utf8')).toBe(token);
      expect(fs.readFileSync(path.join(root, 'service-state.json'), 'utf8')).toBe(state);
      expect((await request(first.socket, { operation: 'status', token })).ok).toBe(true);
    } finally { first.close(); }
  });

  test('an old owner cannot remove a replacement socket while exiting', async () => {
    const { root } = configFixture();
    const first = await open(root, { fake: fakeElectron() });
    fs.rmSync(first.socket);
    const replacement = net.createServer(socket => socket.end('synthetic'));
    await new Promise((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(first.socket, resolve);
    });
    try {
      first.close();
      expect(fs.existsSync(first.socket)).toBe(true);
    } finally {
      await new Promise(resolve => replacement.close(resolve));
    }
  });

  test('accepts authenticated synthetic round trips and caps request text', async () => {
    const { root } = configFixture();
    const running = await open(root, { fake: fakeElectron() });
    const token = fs.readFileSync(path.join(root, 'service.token'), 'utf8');
    try {
      expect(await request(running.socket, { operation: 'status', token }))
        .toMatchObject({ ok: true, value: true, root });
      expect(await request(running.socket, { operation: 'available', token })).toEqual({ ok: true, value: true });
      const encrypted = await request(running.socket, { operation: 'encrypt', value: 'kwg-synthetic', token });
      expect(encrypted.ok).toBe(true);
      expect(await request(running.socket, { operation: 'decrypt',
        value: Buffer.from('enc:' + 'kwg-synthetic').toString('base64'), token }))
        .toEqual({ ok: true, value: 'kwg-synthetic' });
    } finally { running.close(); }
  });

  test('rejects wrong tokens, unknown operations and oversized input with fixed codes', async () => {
    const { root } = configFixture();
    const running = await open(root, { fake: fakeElectron() });
    const token = fs.readFileSync(path.join(root, 'service.token'), 'utf8');
    try {
      expect((await request(running.socket, { operation: 'status' })).code).toBe('remote_credentials_unauthorized');
      expect((await request(running.socket, { operation: 'status', token: 'f'.repeat(64) })).code)
        .toBe('remote_credentials_unauthorized');
      expect((await request(running.socket, { operation: 'eval', token })).code).toBe('remote_credentials_unauthorized');
      expect((await request(running.socket, { operation: 'encrypt', value: 'x'.repeat(MAX_PLAINTEXT * 2 + 1), token })).code)
        .toBe('remote_credentials_request_too_large');
    } finally { running.close(); }
  });

  test('reports a failing keychain as a fixed code instead of leaking the reason', async () => {
    const { root } = configFixture();
    const broken = {
      isEncryptionAvailable: () => true,
      encryptString: () => { throw Error('User canceled the operation'); },
      decryptString: () => { throw Error('keychain unavailable'); },
    };
    const running = await open(root, { fake: fakeElectron({ safeStorage: broken }) });
    const token = fs.readFileSync(path.join(root, 'service.token'), 'utf8');
    try {
      const response = await request(running.socket, { operation: 'encrypt', value: 'kwg-synthetic', token });
      expect(response).toEqual({ ok: false, code: 'remote_credentials_safe_storage_failed' });
      expect(JSON.stringify(response)).not.toContain('canceled');
    } finally { running.close(); }
  });

  test('rejects a ready failure with a fixed code', async () => {
    const { root } = configFixture();
    const fake = fakeElectron();
    fake.app.whenReady = () => Promise.reject(Error('private startup detail'));
    await expect(open(root, { fake })).rejects.toThrow('remote_credentials_service_failed');
    expect(fake.app.exitCode).toBe(1);
  });

  test('refuses a world-readable token and an insecure service root', async () => {
    for (const prepare of [
      root => fs.writeFileSync(path.join(root, 'service.token'), 'a'.repeat(64), { mode: 0o644 }),
      root => fs.chmodSync(root, 0o755),
    ]) {
      const { root } = configFixture({ tokenFile: false });
      const file = serviceSettings(root);
      prepare(root);
      await expect(startRemoteCredentialsService(file, { electron: fakeElectron().electron }))
        .rejects.toThrow('remote_credentials_scope_unverified');
    }
  });
});

describe.skipIf(!macos)('credential service configuration', () => {
  test('accepts the private layout and rejects anything that escapes it', () => {
    const { root } = configFixture();
    const file = path.join(root, 'service.json');
    const base = { schemaVersion: 1, root, application: credentialApplication(root),
      socket: path.join(root, 'service.sock'), tokenFile: path.join(root, 'service.token'),
      home: os.homedir(), temp: path.join(root, 'temp'), idleMS: 300000 };
    fs.writeFileSync(file, JSON.stringify(base), { mode: 0o600 });
    expect(readCredentialServiceConfig(file).idleMS).toBe(300000);
    for (const patch of [{ schemaVersion: 2 }, { root: 'relative' }, { socket: '/tmp/service.sock' },
      { tokenFile: path.join(root, 'other.token') }, { idleMS: 1000 }, { idleMS: 7200000 },
      { temp: undefined }]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, ...patch }), { mode: 0o600 });
      expect(() => readCredentialServiceConfig(file)).toThrow('remote_credentials_config_invalid');
    }
  });

  test('refuses a service file that is not private', () => {
    const { root } = configFixture();
    const file = path.join(root, 'service.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    expect(() => readCredentialServiceConfig(file)).toThrow('remote_credentials_scope_unverified');
  });
});

describe.skipIf(!macos)('credential service diagnostics', () => {
  test('log rotation keeps one bounded backup', () => {
    const root = stateRoot(), file = path.join(root, 'service.log');
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1, 120), { mode: 0o600 });
    expect(rotateRemoteCredentialsLog(file)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.lstatSync(file + '.1').size).toBe(1024 * 1024 + 1);
    fs.writeFileSync(file, 'synthetic-new-log\n', { mode: 0o600 });
    expect(rotateRemoteCredentialsLog(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('synthetic-new-log\n');
    expect(fs.lstatSync(file + '.1').size).toBe(1024 * 1024 + 1);
  });
});

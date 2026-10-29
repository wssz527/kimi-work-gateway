import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readConfig } from '../src/config.mjs';
import { normalizeTranslationConfig, TRANSLATION_DEFAULTS } from '../src/translation-config.mjs';
import { TranslationRuntime, readTranslationSettings } from '../src/translation-runtime.mjs';
import { TranslationPipe } from '../src/translation-pipe.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const dirs = [];
function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-'));
  dirs.push(dir);
  const calls = [];
  const runtime = new TranslationRuntime({ stateDir: dir, kimiDir: path.join(dir, 'kimi'),
    locate: () => ({ application: path.join(dir, ...(process.platform === 'darwin' ? ['MacOS', 'Kimi'] : ['Kimi.exe'])),
      version: '3.2.21', platform: process.platform, archive: path.join(dir, 'Resources', 'app.asar') }),
    spawnHost: (...args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.pid = 424242; child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }, ...overrides });
  runtime.configure({ enabled: true });
  return { dir, runtime, calls };
}

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('translation settings reject credentials and unsafe endpoints while preserving old configuration shape', () => {
  expect(normalizeTranslationConfig()).toEqual(TRANSLATION_DEFAULTS);
  const document = { upstream: { baseURL: 'https://example.test/v1', apiKeyEnv: 'TEST_KEY' }, models: [] };
  expect(readConfig(document).translation).toBeUndefined();
  for (const value of [null, [], { key: 'secret' }, { apiKey: 'secret' }, { enabled: 'true' },
    { provider: 'unknown' }, { apiKeyEnv: 'secret-value' }, { targetLanguage: 'xx' },
    { provider: 'custom' }, ...['http://example.test', 'https://user:secret@example.test/v1',
      'https://example.test/v1?key=secret', 'https://example.test/#secret', 'file:///tmp/api'].map(customEndpoint => ({ customEndpoint }))]) {
    expect(() => normalizeTranslationConfig(value)).toThrow();
  }
  expect(normalizeTranslationConfig({ provider: 'custom', customEndpoint: 'http://127.0.0.1:3000/v1/chat/completions' }).customEndpoint)
    .toBe('http://127.0.0.1:3000/v1/chat/completions');
});

// Structural and runtime variables must never be configurable as the
// translation key name: the host deletes its configured key from the Kimi
// child environment, and deleting PATH/HOME or the subagent bundle override
// would break Kimi itself.
test('structural and runtime environment names are rejected as the translation key variable', () => {
  for (const apiKeyEnv of ['PATH', 'HOME', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SHELL',
    'DAIMON_BUNDLE_DIR', 'DAIMON_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD',
    'KIMI_API_KEY', 'KIMI_SHARE_DIR', 'KIMI_DAIMON_SOURCE_DIR', 'KIMI_CODE_HOME']) {
    expect(() => normalizeTranslationConfig({ enabled: true, apiKeyEnv })).toThrow('invalid_translation_config');
  }
  expect(normalizeTranslationConfig({ enabled: true, apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' }).apiKeyEnv)
    .toBe('KIMI_WORK_TRANSLATION_API_KEY');
  expect(normalizeTranslationConfig({ enabled: true, apiKeyEnv: 'MY_TRANSLATOR_KEY_2' }).apiKeyEnv)
    .toBe('MY_TRANSLATOR_KEY_2');
});

test('configuration and receipts are scoped and only fresh renderer evidence reports active', () => {
  const { runtime } = fixture({ isAlive: pid => pid === 4242 });
  expect(runtime.inspect().state).toBe('not-started');
  const desired = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  expect(() => readTranslationSettings(runtime.settingsFile, '/another-scope')).toThrow('translation_scope_conflict');
  const receipt = { schemaVersion: 1, id: crypto.randomUUID(), homeDir: runtime.homeDir, pid: 4242,
    version: '3.2.21', revision: desired.revision, state: 'active', at: Date.now() };
  writeSubagentJSON(runtime.receiptFile, receipt);
  expect(runtime.inspect().state).toBe('active');
  writeSubagentJSON(runtime.receiptFile, { ...receipt, at: Date.now() - 16000 });
  expect(runtime.inspect().state).toBe('stale');
  writeSubagentJSON(runtime.receiptFile, receipt);
  runtime.configure({ enabled: false });
  expect(runtime.inspect().state).toBe('pending-settings');
  const disabled = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  writeSubagentJSON(runtime.receiptFile, { ...receipt, state: 'inactive', revision: disabled.revision });
  expect(runtime.inspect().state).toBe('inactive');
  writeSubagentJSON(runtime.receiptFile, { ...receipt, homeDir: '/another-scope' });
  expect(runtime.inspect()).toEqual({ state: 'failed', reason: 'translation_session_conflict' });
});

test('launch waits for existing Kimi without killing or starting it', async () => {
  const { runtime, calls } = fixture();
  expect(await runtime.launch({ isRunning: () => true })).toEqual({ state: 'waiting-kimi-exit', version: '3.2.21' });
  expect(calls).toHaveLength(0);
  expect(fs.existsSync(runtime.launchFile)).toBe(false);
});

test('one private helper carries the validated subagent bundle and no key is written to receipts', async () => {
  const secret = 'translation-env-secret';
  const { runtime, calls } = fixture({ env: { KIMI_WORK_TRANSLATION_API_KEY: secret, ELECTRON_RUN_AS_NODE: '1' } });
  const subagentRuntime = { launchContext: () => ({ application: runtime.locate().application, bundleDir: path.join(runtime.stateDir, 'bundle') }) };
  const [first, second] = await Promise.all([runtime.launch({ force: true, subagentRuntime, isRunning: () => false }),
    runtime.launch({ force: true, subagentRuntime, isRunning: () => false })]);
  expect(first.state).toBe('starting'); expect(second.state).toBe('starting');
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
  expect(calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(calls[0][2].env.KIMI_WORK_TRANSLATION_API_KEY).toBe(secret);
  const record = readSubagentJSON(runtime.launchFile);
  expect(record.bundleDir).toBe(path.join(runtime.stateDir, 'bundle'));
  expect(record.subagent).toMatchObject({ adopted: true, state: 'force' });
  for (const file of [runtime.settingsFile, runtime.launchFile]) expect(fs.readFileSync(file, 'utf8')).not.toContain(secret);
});

test('force launch fails closed without a usable subagent runtime and disabled settings cannot launch', async () => {
  const { runtime, calls } = fixture();
  await expect(runtime.launch({ force: true, isRunning: () => false })).rejects.toThrow('subagent_runtime_not_ready');
  runtime.configure({ enabled: false });
  await expect(runtime.launch({ isRunning: () => false })).rejects.toThrow('translation_not_enabled');
  expect(calls).toHaveLength(0);
});

test('a running translation session cannot bypass a new force policy or pretend it loaded another bundle', async () => {
  const { runtime, calls } = fixture({ isAlive: pid => pid === process.pid });
  const id = crypto.randomUUID();
  const desired = readTranslationSettings(runtime.settingsFile, runtime.homeDir);
  const application = runtime.locate().application;
  writeSubagentJSON(runtime.receiptFile, { schemaVersion: 1, id, homeDir: runtime.homeDir, pid: process.pid,
    version: '3.2.21', revision: desired.revision, state: 'active', at: Date.now() });
  writeSubagentJSON(runtime.launchFile, { schemaVersion: 1, id, homeDir: runtime.homeDir, application,
    pid: process.pid, at: Date.now() });
  await expect(runtime.launch({ force: true })).rejects.toThrow('subagent_runtime_not_ready');
  const bundleDir = path.join(runtime.stateDir, 'validated-bundle');
  const subagentRuntime = { launchContext: () => ({ application, bundleDir }) };
  expect((await runtime.launch({ force: true, subagentRuntime })).state).toBe('waiting-kimi-exit');
  writeSubagentJSON(runtime.launchFile, { ...readSubagentJSON(runtime.launchFile), bundleDir });
  expect((await runtime.launch({ force: true, subagentRuntime })).state).toBe('active');
  expect(calls).toHaveLength(0);
});

test('installation checking reports actual probe failures without starting a process', () => {
  const { runtime, calls } = fixture({ locate: () => { throw Error('translation_runtime_incompatible'); } });
  expect(runtime.check()).toEqual({ state: 'incompatible', reason: 'translation_runtime_incompatible' });
  expect(calls).toHaveLength(0);
});

// A prepared-but-unusable subagent runtime must not be silently dropped: the
// launch proceeds translation-only and the reason is visible on the result and
// inside the launch record. `not-prepared` stays a plain pure-translation case
// with no warning at all.
test('an unusable subagent runtime launches translation alone and reports why instead of dropping the bundle silently', async () => {
  const cases = [
    [{ state: 'outdated', version: '3.2.21' }, 'subagent_runtime_outdated'],
    [{ state: 'conflict' }, 'subagent_runtime_conflict'],
    [{ state: 'heartbeat-stale', version: '3.2.21' }, 'subagent_runtime_heartbeat-stale'],
    [{ state: 'policy-unavailable' }, 'subagent_runtime_policy-unavailable'],
  ];
  for (const [status, warning] of cases) {
    const { runtime, calls } = fixture();
    const subagentRuntime = { inspect: () => status, launchContext: () => { throw Error('subagent_runtime_not_ready'); } };
    const result = await runtime.launch({ subagentRuntime, isRunning: () => false });
    expect(result.state).toBe('starting');
    expect(result.warning).toBe(warning);
    const record = readSubagentJSON(runtime.launchFile);
    expect(record.bundleDir).toBeUndefined();
    expect(record.subagent).toMatchObject({ adopted: false, reason: warning });
    expect(calls).toHaveLength(1);
  }
});

test('a not-prepared subagent runtime stays a silent pure-translation launch', async () => {
  const { runtime, calls } = fixture();
  const subagentRuntime = { inspect: () => ({ state: 'not-prepared' }), launchContext: () => { throw Error('subagent_runtime_not_ready'); } };
  const result = await runtime.launch({ subagentRuntime, isRunning: () => false });
  expect(result).toEqual({ state: 'starting', pid: 424242, version: '3.2.21' });
  expect(readSubagentJSON(runtime.launchFile).subagent).toEqual({ adopted: false, state: 'not-prepared' });
  expect(calls).toHaveLength(1);
});

// The adopted subagent context is only trusted when it describes the very
// installation discovered on disk. A context pointing elsewhere falls back to
// the discovered application and surfaces the mismatch.
test('a subagent context from another Kimi installation is not adopted', async () => {
  const { runtime, calls } = fixture();
  const foreign = path.join(runtime.stateDir, 'foreign', 'Kimi');
  const subagentRuntime = { inspect: () => ({ state: 'loaded' }),
    launchContext: () => ({ application: foreign, bundleDir: path.join(runtime.stateDir, 'bundle') }) };
  const result = await runtime.launch({ subagentRuntime, isRunning: () => false });
  expect(result.state).toBe('starting');
  expect(result.warning).toBe('subagent_bundle_application_mismatch');
  const record = readSubagentJSON(runtime.launchFile);
  expect(record.bundleDir).toBeUndefined();
  expect(record.application).toBe(runtime.locate().application);
  expect(calls).toHaveLength(1);
});

// Version strings are metadata: unknown, prerelease and arbitrary builds must
// launch and are only labelled, while a locate failure is a hard failure with
// its reason preserved instead of a swallowed incompatible/unavailable split.
test('version strings no longer gate launching; unknown builds are labelled and locate failures keep their reason', () => {
  const cold = fixture({ locate: () => ({ application: '/tmp/Kimi', version: '9.9.9', platform: 'darwin', archive: '/tmp/app.asar' }) });
  expect(cold.runtime.inspect()).toMatchObject({ state: 'not-started', version: '9.9.9', verification: 'unverified-version' });
  for (const version of ['9.9.9', '4.0.0-beta.1', 'nightly-20990501', 'unknown']) {
    const { runtime } = fixture({ locate: () => ({ application: '/tmp/Kimi', version, platform: 'darwin', archive: '/tmp/app.asar' }) });
    const result = runtime.check();
    expect(result.state).toBe('not-started');
    expect(result.version).toBe(version);
    expect(result.verification).toBe(version === '3.2.21' ? undefined : 'unverified-version');
    expect(runtime.inspect()).toMatchObject({ state: 'not-started', version, verification: 'unverified-version' });
  }
  const known = fixture();
  expect(known.runtime.check().verification).toBeUndefined();
  const broken = fixture({ locate: () => { throw Error('translation_kimi_unavailable'); } });
  expect(broken.runtime.check()).toEqual({ state: 'failed', reason: 'translation_kimi_unavailable' });
});

test('translation version metadata is cached briefly and refreshed after upgrades or probe failures', () => {
  let version = '3.2.21';
  let probes = 0;
  let unavailable = false;
  const { runtime } = fixture({ locate: () => {
    probes += 1;
    if (unavailable) throw Error('translation_kimi_unavailable');
    return { application: '/tmp/Kimi', version, platform: 'darwin', archive: '/tmp/app.asar' };
  } });
  for (let i = 0; i < 6; i += 1) {
    expect(runtime.inspect()).toMatchObject({ state: 'not-started', version: '3.2.21' });
  }
  expect(probes).toBe(1);
  version = '4.0.0';
  runtime.versionCheckedAt = 0;
  expect(runtime.inspect()).toMatchObject({ state: 'not-started', version: '4.0.0', verification: 'unverified-version' });
  expect(probes).toBe(2);
  unavailable = true;
  runtime.versionCheckedAt = 0;
  expect(runtime.inspect()).toEqual({ state: 'not-started' });
  expect(runtime.inspect()).toEqual({ state: 'not-started' });
  expect(probes).toBe(3);
});

test('translation installation treats new and unknown version metadata as informational', () => {
  const f = fixture();
  const archive = path.join(f.dir, 'Contents', 'Resources', 'app.asar');
  const application = path.join(f.dir, 'Contents', 'MacOS', 'Kimi');
  const metadata = path.join(f.dir, 'Contents', 'Info.plist');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.mkdirSync(path.dirname(application), { recursive: true });
  fs.writeFileSync(archive, 'synthetic archive without an embedded package');
  fs.writeFileSync(application, 'synthetic executable, never launched');
  fs.writeFileSync(metadata, '<key>CFBundleShortVersionString</key><string>99.4.0</string>');
  const runtime = new TranslationRuntime({ stateDir: f.dir, kimiDir: f.runtime.homeDir,
    installation: { archive, application, platform: 'darwin' } });
  runtime.configure({ enabled: true });
  expect(runtime.check()).toEqual({ state: 'not-started', version: '99.4.0', verification: 'unverified-version' });
  fs.unlinkSync(metadata);
  expect(runtime.check()).toEqual({ state: 'not-started', version: 'unknown', verification: 'unverified-version' });
});

test('private CDP pipe handles split UTF-8, events, errors and bounded pending calls', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const pipe = new TranslationPipe(input, output);
  const sent = [];
  output.on('data', chunk => sent.push(JSON.parse(chunk.toString().slice(0, -1))));
  const events = []; pipe.on('message', message => events.push(message));
  const waiting = pipe.send('Runtime.evaluate', { expression: 'synthetic' }, 'session');
  expect(sent[0]).toMatchObject({ id: 1, method: 'Runtime.evaluate', sessionId: 'session' });
  const buffer = Buffer.from(JSON.stringify({ id: 1, result: { value: '中文' } }) + '\0');
  const split = buffer.indexOf(Buffer.from('中文')) + 1;
  input.write(buffer.subarray(0, split)); input.write(buffer.subarray(split));
  expect(await waiting).toEqual({ value: '中文' });
  input.write(JSON.stringify({ method: 'Runtime.bindingCalled', params: { name: '__kwgTranslate' } }) + '\0');
  expect(events).toHaveLength(1);
  const error = pipe.send('Page.enable');
  input.write(JSON.stringify({ id: 2, error: { message: 'private-data' } }) + '\0');
  await expect(error).rejects.toThrow('translation_protocol_error');
  const timed = pipe.send('NoReply', {}, undefined, 5);
  await expect(timed).rejects.toThrow('translation_protocol_timeout');
  const pending = pipe.send('Pending');
  pipe.dispose();
  await expect(pending).rejects.toThrow('translation_pipe_closed');
  await expect(pipe.send('AfterClose')).rejects.toThrow('translation_pipe_closed');
});

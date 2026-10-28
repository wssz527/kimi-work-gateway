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
    locate: () => ({ application: path.join(dir, 'Kimi'), version: '3.2.21', platform: process.platform, archive: path.join(dir, 'app.asar') }),
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
  const subagentRuntime = { launchContext: () => ({ application: path.join(runtime.stateDir, 'Kimi'), bundleDir: path.join(runtime.stateDir, 'bundle') }) };
  const [first, second] = await Promise.all([runtime.launch({ force: true, subagentRuntime, isRunning: () => false }),
    runtime.launch({ force: true, subagentRuntime, isRunning: () => false })]);
  expect(first.state).toBe('starting'); expect(second.state).toBe('starting');
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
  expect(calls[0][2].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(calls[0][2].env.KIMI_WORK_TRANSLATION_API_KEY).toBe(secret);
  expect(readSubagentJSON(runtime.launchFile).bundleDir).toBe(path.join(runtime.stateDir, 'bundle'));
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
  const application = path.join(runtime.stateDir, 'Kimi');
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

test('installation checking reports incompatible versions without starting a process', () => {
  const { runtime, calls } = fixture({ locate: () => { throw Error('translation_runtime_incompatible'); } });
  expect(runtime.check()).toEqual({ state: 'incompatible', reason: 'translation_runtime_incompatible' });
  expect(calls).toHaveLength(0);
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

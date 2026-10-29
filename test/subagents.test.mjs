import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import { SubagentPolicy, normalizeSubagentPolicy, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { createSubagentRuntimeHook } from '../src/subagent-hook.mjs';
import { SubagentRuntime, transformSubagentKernel } from '../src/subagent-runtime.mjs';

const roots = [];
const hooks = [];
const models = [
  { id: 'vendor/kimi-child', protocol: 'chat', contextWindow: 64000, tools: true, reasoning: true,
    reasoningEfforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'vendor/child-responses', protocol: 'responses', contextWindow: 32000, tools: true },
  { id: 'vendor/no-tools', protocol: 'responses', contextWindow: 32000 },
];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-subagents-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const kimiDir = path.join(root, 'kimi');
  const policy = new SubagentPolicy({ stateDir, kimiDir });
  const receiptPath = path.join(stateDir, 'receipt.json');
  const hook = createSubagentRuntimeHook({ policyPath: policy.file, receiptPath,
    runtimeId: 'a'.repeat(24), sourceHash: 'b'.repeat(64) });
  hooks.push(hook);
  return { root, stateDir, kimiDir, policy, hook, receiptPath };
}
afterEach(() => {
  for (const hook of hooks.splice(0)) hook.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('force binds the real native alias and model effort while missing policy inherits', () => {
  expect(normalizeSubagentPolicy(undefined)).toEqual({ mode: 'inherit' });
  expect(normalizeSubagentPolicy({ mode: 'force', model: 'vendor/kimi-child' }, models)).toEqual({
    mode: 'force', model: 'vendor/kimi-child', modelAlias: 'byok-kth-kimi/vendor/kimi-child', effort: 'low',
  });
  expect(normalizeSubagentPolicy({ mode: 'force', model: 'vendor/child-responses' }, models).modelAlias)
    .toBe('byok-kth-resp/vendor/child-responses');
  for (const value of [null, [], { mode: 'guess' }, { mode: 'force', model: 'missing' },
    { mode: 'force', model: 'vendor/no-tools' }, { mode: 'force', model: 'vendor/kimi-child', effort: 'max' },
    { mode: 'force', model: 'vendor/child-responses', effort: 'high' }]) {
    expect(() => normalizeSubagentPolicy(value, models)).toThrow();
  }
});

test('gateway revocation blocks a stale forced model and closing restores inheritance', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  expect(hook.configuration(policy.homeDir)).toEqual({ force: true,
    defaultModel: 'byok-kth-kimi/vendor/kimi-child', defaultEffort: 'low' });
  expect(() => policy.configure({ mode: 'force', model: models[0].id }, [models[1]])).toThrow('subagent_model_unavailable');
  const blockedConfig = { get: () => hook.configuration(policy.homeDir) };
  expect(blockedConfig.get()).toEqual({});
  expect(() => hook.assertSpawn(blockedConfig, {})).toThrow('subagent_model_unavailable');
  expect(() => hook.assertModel(blockedConfig, 'parent')).toThrow('subagent_model_unavailable');
  policy.close();
  expect(hook.configuration(policy.homeDir)).toBeUndefined();
});

test('the runtime only overrides its matching Work home and records observed policy', () => {
  const { policy, hook, receiptPath, root } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  expect(hook.configuration(path.join(root, 'other-home'))).toBeUndefined();
  const section = hook.configuration(policy.homeDir);
  const config = { get: () => section };
  hook.assertModel(config, section.defaultModel);
  const receipt = readSubagentJSON(receiptPath);
  expect(receipt.revision).toBe(readSubagentJSON(policy.file).revision);
  expect(receipt.pid).toBe(process.pid);
  expect(receipt.lastSpawn.modelAlias).toBe(section.defaultModel);
  expect(JSON.stringify(receipt)).not.toContain('apiKey');
  expect(JSON.stringify(section)).not.toContain('models');
});

test('force refuses fork and resumed agents bound to another model', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const section = hook.configuration(policy.homeDir);
  const config = { get: () => section };
  expect(() => hook.assertSpawn(config, { fork: true })).toThrow('subagent_policy_fork_conflict');
  expect(() => hook.assertModel(config, 'parent')).toThrow('subagent_policy_resume_conflict');
  expect(() => hook.assertSpawn(config, {})).not.toThrow();
  expect(() => hook.assertModel(config, section.defaultModel)).not.toThrow();
  expect(() => hook.assertSpawn({ get: () => undefined }, { fork: true })).not.toThrow();
});

test('malformed or missing policy keeps model discovery safe and rejects actual subagent runs', () => {
  const { policy, hook, receiptPath } = setup();
  const config = { get: () => hook.configuration(policy.homeDir) };
  expect(config.get()).toEqual({});
  expect(() => hook.assertSpawn(config, { model: 'primary' })).toThrow('subagent_policy_unavailable');
  policy.configure(undefined, models);
  fs.writeFileSync(policy.file, '{broken');
  expect(config.get()).toEqual({});
  expect(() => hook.assertModel(config, 'parent')).toThrow('subagent_policy_unavailable');
  expect(readSubagentJSON(receiptPath).mode).toBe('blocked');
  expect(() => policy.configure(undefined, models)).toThrow();
});

test('subagent efforts are rejected before writing a kernel-incompatible policy', () => {
  for (const effort of ['High', 'with space', 'a'.repeat(33)]) {
    const target = { ...models[0], reasoningEfforts: [effort], defaultEffort: effort };
    expect(() => normalizeSubagentPolicy({ mode: 'force', model: target.id }, [target])).toThrow('invalid_subagent_effort');
  }
});

test('an exiting old gateway does not disable its replacement policy', () => {
  const { stateDir, kimiDir, policy } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const replacement = new SubagentPolicy({ stateDir, kimiDir });
  replacement.configure({ mode: 'force', model: models[1].id }, models);
  policy.close();
  expect(readSubagentJSON(policy.file).model).toBe(models[1].id);
});

test('policy and runtime files refuse symlinks and preserve their targets', () => {
  const { policy, stateDir, root } = setup();
  fs.mkdirSync(stateDir);
  const target = path.join(root, 'untouched');
  fs.writeFileSync(target, 'keep');
  try { fs.symlinkSync(target, policy.file); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  expect(() => policy.configure(undefined, models)).toThrow('subagent_file_conflict');
  expect(fs.readFileSync(target, 'utf8')).toBe('keep');
});

test('unrecognized kernel layouts are refused before any transformation is returned', () => {
  expect(() => transformSubagentKernel('export const other = true;', {})).toThrow('subagent_runtime_incompatible');
  expect(() => transformSubagentKernel('const kwgSubagentHook = {};', {})).toThrow('subagent_runtime_already_adapted');
});

test('runtime status distinguishes missing and malformed state', () => {
  const { stateDir } = setup();
  const runtime = new SubagentRuntime({ stateDir, launchProbe: () => ({ state: 'supported' }) });
  expect(runtime.inspect()).toEqual({ state: 'not-prepared' });
  fs.mkdirSync(stateDir);
  fs.writeFileSync(runtime.manifestFile, '{broken');
  expect(runtime.inspect()).toEqual({ state: 'conflict' });
});

test('launch waits for Kimi exit and passes the override only to the new process', async () => {
  const { stateDir, root, policy } = setup();
  policy.configure(undefined, models);
  const runtime = new SubagentRuntime({ stateDir, launchProbe: () => ({ state: 'supported' }) });
  const application = path.join(root, 'Kimi');
  fs.writeFileSync(application, 'fixture');
  writeSubagentJSON(runtime.manifestFile, { application, bundleDir: path.join(root, 'bundle'), runtimeId: 'a'.repeat(24) });
  runtime.inspect = () => ({ state: 'waiting-launch' });
  expect(await runtime.launch({ isRunning: () => true })).toEqual({ state: 'waiting-kimi-exit' });
  let captured;
  const previous = process.env.DAIMON_BUNDLE_DIR;
  const result = await runtime.launch({ isRunning: () => false, spawnApp: (...args) => {
    captured = args;
    const child = new EventEmitter();
    child.pid = 1234;
    child.unref = () => {};
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  expect(result.state).toBe('starting');
  expect(captured[0]).toBe(application);
  expect(captured[2].env.DAIMON_BUNDLE_DIR).toBe(path.join(root, 'bundle'));
  expect(process.env.DAIMON_BUNDLE_DIR).toBe(previous);
});

function archiveHeader(name, type, link = '') {
  const header = Buffer.alloc(512);
  const field = (offset, length, value) => header.write(value, offset, length, 'utf8');
  field(0, 100, name); field(100, 8, '0000755\0'); field(108, 8, '0000000\0'); field(116, 8, '0000000\0');
  field(124, 12, '00000000000\0'); field(136, 12, '00000000000\0'); field(148, 8, '        ');
  field(156, 1, type); field(157, 100, link); field(257, 6, 'ustar\0'); field(263, 2, '00');
  const sum = header.reduce((total, byte) => total + byte, 0);
  field(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

test('bundle archive links are refused before extraction can follow their targets', () => {
  for (const type of ['1', '2']) {
    const { stateDir, root } = setup();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
    const tarball = path.join(root, 'bundle.tar.gz');
    fs.writeFileSync(tarball, gzipSync(Buffer.concat([
      archiveHeader('escape', type, outside), archiveHeader('escape/keep', '0'), Buffer.alloc(1024),
    ])));
    const runtime = new SubagentRuntime({ stateDir, launchProbe: () => ({ state: 'supported' }) });
    runtime.installation = () => ({ tarball, version: 'fixture' });
    expect(() => runtime.prepare()).toThrow('subagent_bundle_archive_links_unsupported');
    expect(fs.readFileSync(path.join(outside, 'keep'), 'utf8')).toBe('untouched');
    expect(fs.readdirSync(path.join(stateDir, 'native-runtime'))).toEqual([]);
  }
});

test('unrecognised source structure is refused and staging directories are removed', () => {
  const { stateDir, root } = setup();
  const bundleDir = path.join(root, 'source');
  const kernel = path.join(bundleDir, 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs');
  fs.mkdirSync(path.dirname(kernel), { recursive: true }); fs.writeFileSync(kernel, 'unknown kernel');
  const runtime = new SubagentRuntime({ stateDir, launchProbe: () => ({ state: 'supported' }) });
  runtime.installation = () => ({ bundleDir, version: '999.0.0' });
  expect(() => runtime.prepare()).toThrow('subagent_runtime_incompatible');
  expect(fs.existsSync(runtime.manifestFile)).toBe(false);
  expect(fs.readFileSync(kernel, 'utf8')).toBe('unknown kernel');
  expect(fs.readdirSync(path.join(stateDir, 'native-runtime'))).toEqual([]);
});

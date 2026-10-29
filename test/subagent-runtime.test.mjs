import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SubagentRuntime } from '../src/subagent-runtime.mjs';
import { SubagentPolicy, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { structuralKernel } from './fixtures/structural-kernel.mjs';

const roots = [];
const relativeKernel = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
function fixture(capability = { state: 'supported' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-runtime-contract-')); roots.push(root);
  const stateDir = path.join(root, 'state');
  const bundleDir = path.join(root, 'source');
  const kernel = path.join(bundleDir, relativeKernel);
  fs.mkdirSync(path.dirname(kernel), { recursive: true });
  fs.writeFileSync(kernel, structuralKernel);
  const application = path.join(root, 'Kimi'); fs.writeFileSync(application, 'fixture');
  const archive = path.join(root, 'app.asar'); fs.writeFileSync(archive, 'fixture');
  const installation = { application, archive, bundleDir, version: '9.9.9-nightly' };
  const runtime = new SubagentRuntime({ stateDir, launchProbe: () => capability });
  runtime.installation = () => installation;
  const policy = new SubagentPolicy({ stateDir, kimiDir: path.join(root, 'kimi') });
  return { runtime, policy, root, stateDir, installation, kernel };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('unknown versions with a recognized behavioral contract prepare and source upgrades invalidate the copy', () => {
  const f = fixture(); f.policy.configure();
  expect(f.runtime.prepare().state).toBe('prepared');
  expect(f.runtime.inspect().state).toBe('waiting-launch');
  const manifest = readSubagentJSON(f.runtime.manifestFile);
  expect(manifest.adapterVersion).toBe(3);
  expect(manifest.compatibility).toEqual({ strategy: 'structural', checks: ['configuration', 'spawn', 'run', 'profile'] });
  fs.appendFileSync(f.kernel, '\n');
  expect(f.runtime.inspect().state).toBe('outdated');
  expect(fs.existsSync(manifest.bundleDir)).toBe(true);
});

test('packaged launch incompatibility is diagnosed before copying or spawning', async () => {
  const f = fixture({ state: 'unsupported', reason: 'packaged_bundle_override_disabled' });
  expect(f.runtime.inspect()).toMatchObject({ state: 'unsupported', reason: 'packaged_bundle_override_disabled' });
  expect(() => f.runtime.prepare()).toThrow('subagent_launch_unsupported');
  expect(fs.existsSync(f.stateDir)).toBe(false);
  await expect(f.runtime.launch({ spawnApp: () => { throw Error('must not spawn'); } })).rejects.toThrow('subagent_launch_unsupported');
});

test('original launch works without launch capability or a prepared copy and strips inherited bundle and credentials', async () => {
  const f = fixture({ state: 'unsupported', reason: 'packaged_bundle_override_disabled' });
  const previousBundle = process.env.DAIMON_BUNDLE_DIR;
  const previousKey = process.env.KWG_RUNTIME_PRIVATE_TEST;
  process.env.DAIMON_BUNDLE_DIR = '/stale/bundle';
  process.env.KWG_RUNTIME_PRIVATE_TEST = 'host-only';
  let launched;
  try {
    const result = await f.runtime.launchOriginal({ isRunning: () => false,
      protectedEnvNames: ['KWG_RUNTIME_PRIVATE_TEST', 'PATH'], spawnApp: (application, _args, options) => {
        launched = { application, env: options.env };
        const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
        queueMicrotask(() => child.emit('spawn')); return child;
      } });
    expect(result).toEqual({ state: 'starting', pid: 123 });
    expect(launched.application).toBe(f.installation.application);
    expect(launched.env.DAIMON_BUNDLE_DIR).toBeUndefined();
    expect(launched.env.KWG_RUNTIME_PRIVATE_TEST).toBeUndefined();
    expect(launched.env.PATH).toBe(process.env.PATH);
    expect(fs.existsSync(f.runtime.manifestFile)).toBe(false);
  } finally {
    if (previousBundle === undefined) delete process.env.DAIMON_BUNDLE_DIR; else process.env.DAIMON_BUNDLE_DIR = previousBundle;
    if (previousKey === undefined) delete process.env.KWG_RUNTIME_PRIVATE_TEST; else process.env.KWG_RUNTIME_PRIVATE_TEST = previousKey;
  }
});

test('original launch needs only the application and archive, never a daimon bundle', async () => {
  const f = fixture();
  fs.rmSync(f.installation.bundleDir, { recursive: true, force: true });
  const runtime = new SubagentRuntime({ stateDir: path.join(f.root, 'original-state'),
    archive: f.installation.archive, application: f.installation.application, platform: 'darwin' });
  expect(() => runtime.installation()).toThrow('subagent_bundle_unavailable');
  const result = await runtime.launchOriginal({ isRunning: () => false, spawnApp: () => {
    const child = new EventEmitter(); child.pid = 124; child.unref = () => {};
    queueMicrotask(() => child.emit('spawn')); return child;
  } });
  expect(result).toEqual({ state: 'starting', pid: 124 });
});

test('hook and adapter upgrades request re-preparation while changed copies remain conflicts', () => {
  const f = fixture(); f.runtime.prepare();
  const manifest = readSubagentJSON(f.runtime.manifestFile);
  writeSubagentJSON(f.runtime.manifestFile, { ...manifest, adapterVersion: manifest.adapterVersion - 1 });
  expect(f.runtime.inspect().state).toBe('outdated');
  writeSubagentJSON(f.runtime.manifestFile, manifest);
  fs.appendFileSync(path.join(manifest.bundleDir, relativeKernel), '\n// changed');
  expect(f.runtime.inspect().state).toBe('conflict');
});

test('missing policies fail with a stable reason and child environments retain structural variables', async () => {
  const f = fixture(); f.runtime.prepare();
  expect(() => f.runtime.launchContext()).toThrow('subagent_policy_unavailable');
  f.policy.configure();
  const previous = process.env.KWG_RUNTIME_PRIVATE_TEST;
  process.env.KWG_RUNTIME_PRIVATE_TEST = 'host-only';
  let env;
  try {
    const result = await f.runtime.launch({ isRunning: () => false,
      protectedEnvNames: ['KWG_RUNTIME_PRIVATE_TEST', 'PATH', 'DAIMON_BUNDLE_DIR'], spawnApp: (_app, _args, options) => {
        env = options.env;
        const child = new EventEmitter(); child.pid = 123; child.unref = () => {};
        queueMicrotask(() => child.emit('spawn')); return child;
      } });
    expect(result.state).toBe('starting');
    expect(env.KWG_RUNTIME_PRIVATE_TEST).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.DAIMON_BUNDLE_DIR).toBe(readSubagentJSON(f.runtime.manifestFile).bundleDir);
    expect(process.env.KWG_RUNTIME_PRIVATE_TEST).toBe('host-only');
  } finally {
    if (previous === undefined) delete process.env.KWG_RUNTIME_PRIVATE_TEST;
    else process.env.KWG_RUNTIME_PRIVATE_TEST = previous;
  }
});

test('fresh observed scope mismatches are distinct from waiting for launch', () => {
  const f = fixture(); f.policy.configure(); f.runtime.prepare();
  const manifest = readSubagentJSON(f.runtime.manifestFile);
  writeSubagentJSON(f.runtime.receiptPath, { schemaVersion: 1, pid: process.pid, at: Date.now(),
    runtimeId: manifest.runtimeId, sourceHash: manifest.sourceHash, reason: 'subagent_scope_mismatch' });
  expect(f.runtime.inspect().state).toBe('scope-conflict');
});

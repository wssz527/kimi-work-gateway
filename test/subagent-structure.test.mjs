import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { probeSubagentKernel } from '../src/subagent-structure.mjs';
import { SubagentRuntime, transformSubagentKernel } from '../src/subagent-runtime.mjs';
import { SubagentPolicy, readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { structuralKernel } from './fixtures/structural-kernel.mjs';

const roots = [];
const KERNEL = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const models = [{ id: 'kimi-structural-child', protocol: 'chat', contextWindow: 32768, tools: true }];
function fixture(source = structuralKernel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-structure-')); roots.push(root);
  const stateDir = path.join(root, 'state'), bundleDir = path.join(root, 'source');
  const kernel = path.join(bundleDir, KERNEL), archive = path.join(root, 'app.asar'), application = path.join(root, 'Kimi');
  fs.mkdirSync(path.dirname(kernel), { recursive: true });
  fs.writeFileSync(kernel, source); fs.writeFileSync(archive, 'synthetic'); fs.writeFileSync(application, 'synthetic');
  const installation = { version: '99.3.0', archive, application, bundleDir, platform: process.platform };
  const runtime = new SubagentRuntime({ stateDir, launchProbe: () => ({ state: 'supported' }) }); runtime.installation = () => ({ ...installation });
  const policy = new SubagentPolicy({ stateDir, kimiDir: path.join(root, 'kimi') });
  policy.configure({ mode: 'force', model: models[0].id }, models);
  return { root, runtime, policy, kernel, installation };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function renamed(source) {
  for (const [old, next] of Object.entries({ domain: 'section', input: 'job', caller: 'parent', handle: 'current',
    IAgentProfileService: 'ProfileToken', Error2: 'KernelFailure', ErrorCodes: 'KernelCodes', runAgentTurn: 'executeTurn' })) {
    source = source.replace(new RegExp('\\b' + old + '\\b', 'g'), next);
  }
  return source;
}

test('unlisted versions and changed build text prepare from uniquely recognised structure', () => {
  const f = fixture('// Unlisted build with unrelated metadata\n' + structuralKernel);
  const result = f.runtime.prepare();
  expect(result.state).toBe('prepared');
  expect(result.version).toBe('99.3.0');
  expect(result.compatibility).toEqual({ strategy: 'structural', checks: ['configuration', 'spawn', 'run', 'profile'] });
  expect(f.runtime.inspect().state).toBe('waiting-launch');
  expect(fs.readFileSync(f.kernel, 'utf8')).not.toContain('kwgSubagentHook');
});

test('renamed symbols and compacted whitespace preserve actual model, fork and resume enforcement', async () => {
  const f = fixture(renamed(structuralKernel).replace(/\s+/g, ' '));
  const prepared = f.runtime.prepare();
  const module = await import(pathToFileURL(path.join(prepared.bundleDir, KERNEL)).href);
  const config = new module.Config(f.policy.homeDir);
  expect(config.get('secondaryModel').defaultModel).toBe('byok-kth-kimi/kimi-structural-child');
  let modelAlias = 'byok-kth-kimi/kimi-structural-child';
  const dispatcher = new module.Dispatcher(config, { accessor: { get: () => ({ data: () => ({ modelAlias }) }) } });
  expect(await dispatcher.planSpawn({ callerAgentId: 'parent' })).toBe('parent');
  await expect(dispatcher.planSpawn({ callerAgentId: 'parent', fork: true })).rejects.toThrow('subagent_policy_fork_conflict');
  expect(dispatcher.run({ agentId: 'child' }, 'STRUCTURE_OK', {})).toBe('STRUCTURE_OK');
  modelAlias = 'other-parent';
  expect(() => dispatcher.run({ agentId: 'child' }, 'WRONG_MODEL', {})).toThrow('subagent_policy_resume_conflict');
  expect(f.runtime.inspect().state).toBe('loaded');
});

test('comments, strings and regular expressions do not create or duplicate structural anchors', () => {
  const decoy = JSON.stringify(structuralKernel);
  const source = 'const text = ' + decoy + ';\n/* ' + structuralKernel + ' */\n' + structuralKernel
    + '\nconst pattern = /get\\(domain\\)/;\n';
  expect(probeSubagentKernel(source).checks).toHaveLength(4);
  expect(() => probeSubagentKernel('const text = ' + decoy + ';')).toThrow('subagent_runtime_incompatible');
  expect(() => probeSubagentKernel(structuralKernel + structuralKernel)).toThrow('subagent_runtime_incompatible');
});

test('missing or ambiguous real hooks fail before changing the original bundle or publishing a manifest', () => {
  for (const source of [structuralKernel.replace('planSpawn', 'differentPlan'), structuralKernel + structuralKernel,
    structuralKernel.replace('agentProfileService', 'unrelatedProfile')]) {
    const f = fixture(source);
    expect(() => f.runtime.prepare()).toThrow('subagent_runtime_incompatible');
    expect(fs.existsSync(f.runtime.manifestFile)).toBe(false);
    expect(fs.readFileSync(f.kernel, 'utf8')).toBe(source);
    expect(fs.readdirSync(path.join(f.runtime.stateDir, 'native-runtime'))).toEqual([]);
  }
});

test('launch refreshes the local copy after a compatible Kimi update without a gateway upgrade', () => {
  const f = fixture();
  const first = f.runtime.launchContext();
  f.installation.version = '99.4.0';
  fs.appendFileSync(f.kernel, '\n// another compatible build\n');
  expect(f.runtime.inspect().state).toBe('outdated');
  const second = f.runtime.launchContext();
  expect(second.version).toBe('99.4.0');
  expect(second.runtimeId).not.toBe(first.runtimeId);
  expect(fs.existsSync(first.bundleDir)).toBe(true);
  expect(readSubagentJSON(f.policy.file).mode).toBe('force');
  const good = fs.readFileSync(f.runtime.manifestFile, 'utf8');
  fs.writeFileSync(f.kernel, 'export const unrelated = true;');
  expect(() => f.runtime.launchContext()).toThrow('subagent_runtime_incompatible');
  expect(fs.readFileSync(f.runtime.manifestFile, 'utf8')).toBe(good);
});

test('a bundle link that cannot be inspected is refused as a copy conflict, not a raw OS error', () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return;
  const f = fixture();
  const outside = path.join(f.root, 'outside-secret');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'payload'), 'keep');
  const link = path.join(f.installation.bundleDir, 'app/daimon/dist/restricted-link');
  fs.symlinkSync(path.join(outside, 'payload'), link);
  fs.chmodSync(outside, 0o000);
  try {
    expect(() => f.runtime.prepare()).toThrow('subagent_bundle_link_conflict');
  } finally { fs.chmodSync(outside, 0o700); }
});

test('version-only changes can refresh while modified prepared copies remain conflicts', () => {
  const f = fixture();
  const first = f.runtime.launchContext();
  f.installation.version = '99.4.0';
  const second = f.runtime.launchContext();
  expect(second.runtimeId).not.toBe(first.runtimeId);
  fs.appendFileSync(path.join(second.bundleDir, KERNEL), '\n// changed after preparation');
  expect(f.runtime.inspect().state).toBe('conflict');
  expect(() => f.runtime.launchContext()).toThrow('subagent_runtime_not_ready');
});

test('existing manifest identities and live receipts remain readable without a version allowlist', () => {
  const f = fixture();
  const prepared = f.runtime.launchContext();
  const legacy = readSubagentJSON(f.runtime.manifestFile);
  delete legacy.adapterVersion; delete legacy.compatibility;
  legacy.runtimeId = digest(JSON.stringify([legacy.sourceHash, f.runtime.policyPath, legacy.hookVersion, legacy.hookHash])).slice(0, 24);
  const oldDirectory = path.dirname(prepared.bundleDir), newDirectory = path.join(f.runtime.stateDir, 'native-runtime', legacy.runtimeId);
  fs.renameSync(oldDirectory, newDirectory);
  legacy.bundleDir = path.join(newDirectory, 'bundle');
  const code = transformSubagentKernel(structuralKernel, { policyPath: f.runtime.policyPath,
    receiptPath: f.runtime.receiptPath, runtimeId: legacy.runtimeId, sourceHash: legacy.sourceHash });
  fs.writeFileSync(path.join(legacy.bundleDir, KERNEL), code); legacy.patchedHash = digest(code);
  writeSubagentJSON(f.runtime.manifestFile, legacy);
  const policy = readSubagentJSON(f.policy.file);
  writeSubagentJSON(f.runtime.receiptPath, { schemaVersion: 1, runtimeId: legacy.runtimeId, sourceHash: legacy.sourceHash,
    pid: process.pid, at: Date.now(), homeDir: f.policy.homeDir, revision: policy.revision, mode: 'force', modelAlias: policy.modelAlias });
  expect(f.runtime.inspect().state).toBe('loaded');
  expect(f.runtime.launchContext().runtimeId).toBe(legacy.runtimeId);
});

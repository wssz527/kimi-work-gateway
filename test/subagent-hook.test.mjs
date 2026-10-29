import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SubagentPolicy, readSubagentJSON } from '../src/subagent-policy.mjs';
import { createSubagentRuntimeHook } from '../src/subagent-hook.mjs';

// The guard must survive configuration objects the kernel may clone, merge or
// cache, so these cases hand the hook copies instead of the exact object
// `configuration()` returned.

const roots = [];
const hooks = [];
const models = [
  { id: 'vendor/kimi-child', protocol: 'chat', contextWindow: 64000, tools: true,
    reasoning: true, reasoningEfforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'vendor/child-responses', protocol: 'responses', contextWindow: 32000, tools: true },
];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-hook-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const policy = new SubagentPolicy({ stateDir, kimiDir: path.join(root, 'kimi') });
  const receiptPath = path.join(stateDir, 'receipt.json');
  const hook = createSubagentRuntimeHook({ policyPath: policy.file, receiptPath,
    runtimeId: 'a'.repeat(24), sourceHash: 'b'.repeat(64) });
  hooks.push(hook);
  return { root, stateDir, policy, hook, receiptPath };
}

afterEach(() => {
  for (const hook of hooks.splice(0)) hook.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const configOf = section => ({ get: domain => domain === 'secondaryModel' ? section : undefined });
const clone = value => structuredClone(value);
const deepMerge = (base, patch) => {
  if (!base || typeof base !== 'object' || !patch || typeof patch !== 'object') return patch ?? base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? deepMerge(base[key], value) : value;
  }
  return out;
};
// Everything the kernel plausibly does to a configuration section before the
// guard sees it again.
const variations = section => [section, clone(section), deepMerge({}, section),
  deepMerge(section, {}), JSON.parse(JSON.stringify(section)), { ...section }];

test('a blocked policy reports the kernel-neutral empty section, never a model pool', () => {
  const { policy, hook, receiptPath } = setup();
  expect(() => policy.configure({ mode: 'force', model: models[0].id }, [])).toThrow('subagent_model_unavailable');
  const section = hook.configuration(policy.homeDir);
  // `{}` means "no [secondary_model] section": no pool, no forced binding.
  // `{ models: {} }` would advertise an empty pool and fail the kernel's own
  // section validation (`default_model required`).
  expect(section).toEqual({});
  expect(Object.keys(section)).toHaveLength(0);
  expect(readSubagentJSON(receiptPath)).toMatchObject({ mode: 'blocked', reason: 'subagent_model_unavailable' });
});

test('a revoked policy still blocks the public model:"primary" spawn path', () => {
  const { policy, hook } = setup();
  expect(() => policy.configure({ mode: 'force', model: models[0].id }, [])).toThrow('subagent_model_unavailable');
  const section = hook.configuration(policy.homeDir);
  // `primary` is a documented Agent parameter and the kernel's own resolver
  // would honour it as primary_override, so the block has to land before the
  // resolver runs — which is where assertSpawn sits in the transform.
  for (const copy of variations(section)) {
    const config = configOf(copy);
    for (const input of [{}, { model: 'primary' }, { fork: true }, { model: 'primary', fork: true }]) {
      expect(() => hook.assertSpawn(config, input)).toThrow('subagent_model_unavailable');
      expect(() => hook.assertSpawn(config, input, policy.homeDir)).toThrow('subagent_model_unavailable');
    }
    expect(() => hook.assertModel(config, 'parent')).toThrow('subagent_model_unavailable');
    expect(() => hook.assertModel(config, 'parent', policy.homeDir)).toThrow('subagent_model_unavailable');
  }
});

test('a cloned or merged section cannot lift a block, nor revive a revoked force', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const forced = hook.configuration(policy.homeDir);
  expect(forced.force).toBe(true);
  expect(() => policy.configure({ mode: 'force', model: models[0].id }, [])).toThrow('subagent_model_unavailable');
  const blocked = hook.configuration(policy.homeDir);
  expect(blocked).toEqual({});
  // the revoked policy must also override a *stale cached force* section, which
  // is what a kernel that keeps its own copy would still be holding
  for (const copy of [...variations(blocked), ...variations(forced)]) {
    expect(() => hook.assertSpawn(configOf(copy), {})).toThrow('subagent_model_unavailable');
    expect(() => hook.assertModel(configOf(copy), 'parent')).toThrow('subagent_model_unavailable');
    expect(() => hook.assertSpawn(configOf(copy), {}, policy.homeDir)).toThrow('subagent_model_unavailable');
    expect(() => hook.assertModel(configOf(copy), 'parent', policy.homeDir)).toThrow('subagent_model_unavailable');
  }
});

test('force refuses fork through copies, and the disk policy refuses it even without a section', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const section = hook.configuration(policy.homeDir);
  for (const copy of variations(section)) {
    expect(() => hook.assertSpawn(configOf(copy), { fork: true })).toThrow('subagent_policy_fork_conflict');
    expect(() => hook.assertSpawn(configOf(copy), { fork: true }, policy.homeDir)).toThrow('subagent_policy_fork_conflict');
    expect(() => hook.assertSpawn(configOf(copy), {})).not.toThrow();
    expect(() => hook.assertSpawn(configOf(copy), { model: 'primary' })).not.toThrow();
  }
  // an explicit scope makes the disk policy authoritative, so fork is refused
  // even when the kernel passes no section at all
  expect(() => hook.assertSpawn(configOf(undefined), { fork: true }, policy.homeDir))
    .toThrow('subagent_policy_fork_conflict');
});

test('a resumed agent bound to another model is refused through copies, and disk wins over a stale alias', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const first = clone(hook.configuration(policy.homeDir));
  for (const copy of variations(first)) {
    expect(() => hook.assertModel(configOf(copy), 'parent')).toThrow('subagent_policy_resume_conflict');
    expect(() => hook.assertModel(configOf(copy), copy.defaultModel)).not.toThrow();
  }
  // the gateway switches the forced model while the kernel still holds the old one
  policy.configure({ mode: 'force', model: models[1].id }, models);
  const stale = first.defaultModel;
  // the disk policy is the current binding, so a cached section naming the old
  // alias cannot vouch for it
  expect(() => hook.assertModel(configOf(first), stale)).toThrow('subagent_policy_resume_conflict');
  expect(() => hook.assertModel(configOf(first), stale, policy.homeDir)).toThrow('subagent_policy_resume_conflict');
  const second = hook.configuration(policy.homeDir);
  expect(second.defaultModel).not.toBe(stale);
  expect(() => hook.assertModel(configOf(second), second.defaultModel)).not.toThrow();
  expect(() => hook.assertModel(configOf(second), stale)).toThrow('subagent_policy_resume_conflict');
});

test('missing, corrupt or foreign-owned policies stay fail-closed inside their own scope', () => {
  const { policy, hook } = setup();
  fs.mkdirSync(path.dirname(policy.file), { recursive: true });
  // missing file: no configuration, but the guard still refuses
  expect(hook.configuration(policy.homeDir)).toEqual({});
  expect(() => hook.assertSpawn(configOf({}), {})).toThrow('subagent_policy_unavailable');
  expect(() => hook.assertModel(configOf({}), 'parent', policy.homeDir)).toThrow('subagent_policy_unavailable');
  // corrupt file
  fs.writeFileSync(policy.file, '{broken');
  expect(hook.configuration(policy.homeDir)).toEqual({});
  expect(() => hook.assertSpawn(configOf({}), {}, policy.homeDir)).toThrow('subagent_policy_unavailable');
  // a well-formed file that claims another home is not trusted for this scope
  fs.writeFileSync(policy.file, JSON.stringify({ schemaVersion: 1, homeDir: '/somewhere/else',
    revision: '0'.repeat(64), mode: 'inherit' }));
  expect(() => hook.assertSpawn(configOf({}), {}, policy.homeDir)).toThrow('subagent_policy_unavailable');
});

test('a foreign home keeps its own model and never inherits this gateway force', () => {
  const { policy, hook, receiptPath } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const foreign = path.join(path.dirname(path.dirname(policy.homeDir)), 'other-home');
  expect(hook.configuration(foreign)).toBeUndefined();
  // the foreign home's own (unforced) section must not be governed here
  expect(() => hook.assertSpawn(configOf(undefined), {}, foreign)).not.toThrow();
  expect(() => hook.assertSpawn(configOf({ models: { 'other/child': '' } }), { fork: true }, foreign)).not.toThrow();
  expect(() => hook.assertModel(configOf({ models: {} }), 'other/child', foreign)).not.toThrow();
  const nativeForce = configOf({ force: true, defaultModel: 'foreign-native-model' });
  expect(() => hook.assertSpawn(nativeForce, { fork: true }, foreign)).not.toThrow();
  expect(() => hook.assertModel(nativeForce, 'other/child', foreign)).not.toThrow();
  // the receipt names the reason, so the parent runtime can report a scope
  // conflict instead of waiting for a launch that will never report
  const receipt = readSubagentJSON(receiptPath);
  expect(receipt.mode).toBe('blocked');
  expect(receipt.reason).toBe('subagent_scope_mismatch');
  expect(receipt.homeDir).toBe(path.resolve(foreign));
  // the matching home still gets its force section afterwards
  expect(hook.configuration(policy.homeDir).force).toBe(true);
  expect(readSubagentJSON(receiptPath).reason).toBeUndefined();
});

test('two-argument guards keep working once the scope has been recorded', () => {
  const { policy, hook, receiptPath } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const section = hook.configuration(policy.homeDir);
  expect(() => hook.assertSpawn(configOf(section), { fork: true })).toThrow('subagent_policy_fork_conflict');
  expect(() => hook.assertModel(configOf(section), 'parent')).toThrow('subagent_policy_resume_conflict');
  expect(() => hook.assertModel(configOf(section), section.defaultModel)).not.toThrow();
  expect(readSubagentJSON(receiptPath).lastSpawn.modelAlias).toBe(section.defaultModel);
  // with no section in play, an explicit scope still applies the disk policy:
  // a fork would bypass the forced model just the same
  expect(() => hook.assertSpawn(configOf(undefined), { fork: true }, policy.homeDir))
    .toThrow('subagent_policy_fork_conflict');
  expect(() => hook.assertModel(configOf(undefined), 'parent', policy.homeDir))
    .toThrow('subagent_policy_resume_conflict');
  // the legacy shape cannot tell whose home this is without a section, so it
  // leaves the kernel alone rather than guessing and policing a foreign home
  expect(() => hook.assertSpawn(configOf(undefined), { fork: true })).not.toThrow();
  expect(() => hook.assertModel(configOf(undefined), 'parent')).not.toThrow();
  expect(() => hook.assertSpawn(configOf(undefined), {})).not.toThrow();
});

test('an inherited policy neither forces nor blocks, and records the spawn it observed', () => {
  const { policy, hook, receiptPath } = setup();
  policy.configure(undefined, models);
  expect(hook.configuration(policy.homeDir)).toBeUndefined();
  expect(() => hook.assertSpawn(configOf(undefined), { fork: true })).not.toThrow();
  expect(() => hook.assertModel(configOf(undefined), 'parent', policy.homeDir)).not.toThrow();
  const receipt = readSubagentJSON(receiptPath);
  expect(receipt.mode).toBe('inherit');
  expect(receipt.lastSpawn.modelAlias).toBe('parent');
  expect(receipt.homeDir).toBe(policy.homeDir);
  expect(JSON.stringify(receipt)).not.toContain('apiKey');
});

test('a hostile homeDir argument is rejected instead of silently skipping the guard', () => {
  const { policy, hook } = setup();
  policy.configure({ mode: 'force', model: models[0].id }, models);
  const section = hook.configuration(policy.homeDir);
  for (const homeDir of ['', 0, null, {}, 'relative/path']) {
    expect(() => hook.assertSpawn(configOf(section), {}, homeDir)).toThrow('subagent_scope_invalid');
    expect(() => hook.assertModel(configOf(section), 'parent', homeDir)).toThrow('subagent_scope_invalid');
  }
});

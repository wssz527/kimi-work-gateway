import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSubagentBridge, bindNativeSubagents } from '../src/native-subagent-bridge.mjs';
import { SubagentPolicy, normalizeSubagentPolicy } from '../src/subagent-policy.mjs';

const roots = [], policies = [];
const models = [{ id: 'lab/kimi-child', protocol: 'chat', contextWindow: 64000, tools: true }];
const desired = { mode: 'pool', model: models[0].id, models: [{ id: models[0].id, description: 'Review' }] };
const selected = normalizeSubagentPolicy(desired, models);
const source = 'default_model = "byok-kth-kimi/lab/kimi-child"\n[models."byok-kth-kimi/lab/kimi-child"]\nprovider="lab"\nmodel="lab/kimi-child"\n';
const tool = { type: 'function', function: { name: 'Agent', description: selected.modelAlias + ' [default]', parameters: { properties: { model: { type: 'string' } } } } };
const inspectContract = () => ({ state: 'source-compatible', version: 'synthetic' });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-lifecycle-')); roots.push(root);
  const stateDir = path.join(root, 'state'), kimiDir = path.join(root, 'kimi');
  const configFile = path.join(kimiDir, 'runtime/kimi-code/home/config.toml');
  fs.mkdirSync(path.dirname(configFile), { recursive: true }); fs.writeFileSync(configFile, source);
  const bridge = new NativeSubagentBridge({ stateDir, kimiDir, inspectContract });
  return { root, stateDir, kimiDir, configFile, bridge };
}
function bind(f) {
  const policy = new SubagentPolicy(f); policy.configure(desired, models); policies.push(policy);
  const gateway = {}; bindNativeSubagents({ ...f, policy, gateway, bridge: f.bridge });
  return { policy, gateway };
}
afterEach(() => { for (const policy of policies.splice(0)) policy.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test('pool observation expires, resets after regeneration and clears when the tool schema disappears', () => {
  const f = fixture(); f.bridge.update(selected);
  f.bridge.beforeRequest('chat', { tools: [tool] }); expect(f.bridge.inspect().observed.state).toBe('observed-schema');
  f.bridge.observed.at = Date.now() - 600001; expect(f.bridge.inspect().observed).toBeUndefined();
  f.bridge.beforeRequest('chat', { tools: [tool] });
  fs.writeFileSync(f.configFile, source); f.bridge.update(selected); expect(f.bridge.inspect().observed).toBeUndefined();
  f.bridge.beforeRequest('chat', { tools: [tool] });
  expect(f.bridge.beforeRequest('chat', { tools: [{ ...tool, function: { ...tool.function, description: '' } }] }).status).toBe(503);
  expect(f.bridge.inspect().observed).toBeUndefined();
});
test('an explicit inherit conflict blocks inference and preserves the edited block', () => {
  const f = fixture(); f.bridge.update(selected);
  const changed = fs.readFileSync(f.configFile, 'utf8').replace('"Review"', '"User changed this"'); fs.writeFileSync(f.configFile, changed);
  expect(f.bridge.update({ mode: 'inherit', transport: 'native-config' }).state).toBe('conflict');
  expect(f.bridge.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_native_restore_conflict' });
  expect(fs.readFileSync(f.configFile, 'utf8')).toBe(changed);
});
test('leaving native mode retains its restore guard until the conflict is resolved', () => {
  const f = fixture(); const { policy, gateway } = bind(f);
  const changed = fs.readFileSync(f.configFile, 'utf8').replace('"Review"', '"User edit"'); fs.writeFileSync(f.configFile, changed);
  policy.configure({ mode: 'inherit' }, models);
  expect(gateway.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_native_restore_conflict' });
  expect(gateway.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_native_restore_conflict' });
  expect(fs.readFileSync(f.configFile, 'utf8')).toBe(changed);
});
test('an old gateway cannot mutate or restore a replacement policy and config block', () => {
  const f = fixture(); const old = bind(f);
  const replacementBridge = new NativeSubagentBridge({ stateDir: f.stateDir, kimiDir: f.kimiDir, inspectContract });
  const next = bind({ ...f, bridge: replacementBridge }); const content = fs.readFileSync(f.configFile, 'utf8');
  expect(old.gateway.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_policy_owner_conflict' });
  old.policy.close(); expect(fs.readFileSync(f.configFile, 'utf8')).toBe(content);
  expect(next.gateway.beforeRequest('chat', { tools: [tool] })).toBeUndefined();
  next.policy.close(); expect(fs.readFileSync(f.configFile, 'utf8')).toBe(source);
});
test('revocation removes the invalid pool and blocks requests instead of silently inheriting', () => {
  const f = fixture(); const { policy, gateway } = bind(f);
  expect(() => policy.configure(desired, [])).toThrow('subagent_model_unavailable');
  expect(gateway.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_model_unavailable' });
  expect(fs.readFileSync(f.configFile, 'utf8')).toBe(source);
});

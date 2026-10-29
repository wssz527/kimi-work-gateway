import { expect, test } from 'bun:test';
import { NativeSubagentBridge } from '../src/native-subagent-bridge.mjs';

const policy = { mode: 'pool', transport: 'native-config', modelAlias: 'byok-kth-kimi/lab/kimi-child',
  models: [{ modelAlias: 'byok-kth-kimi/lab/kimi-child', description: 'Review' }] };
function fixture(compatibility = { state: 'source-compatible', version: 'synthetic' }) {
  const calls = [];
  const bridge = new NativeSubagentBridge({ config: { update(value) { calls.push(value); return { state: value.mode === 'pool' ? 'file-applied' : 'inherit', transport: 'native-config' }; },
    close() { return { state: 'restored' }; } }, inspectContract: () => compatibility });
  return { calls, bridge };
}
test('native pool requests wait for the actual default and model parameter in every agent tool', () => {
  const { bridge } = fixture(); bridge.update(policy);
  const tool = { name: 'Agent', description: 'Available models: byok-kth-kimi/lab/kimi-child [default]', parameters: { properties: { model: { type: 'string' } } } };
  expect(bridge.beforeRequest('chat', { tools: [{ function: { ...tool, parameters: {} } }] })).toEqual({ status: 503, code: 'subagent_native_reload_pending' });
  expect(bridge.beforeRequest('chat', { tools: [{ function: { ...tool, description: 'No default' } }] })).toBeDefined();
  expect(bridge.beforeRequest('chat', { tools: [{ function: tool }] })).toBeUndefined();
  expect(bridge.inspect().observed.state).toBe('observed-schema');
  expect(bridge.beforeRequest('responses', { tools: [tool, { ...tool, name: 'TowerSpawn', description: '' }] })).toBeDefined();
  expect(bridge.beforeRequest('responses', { tools: [tool] })).toBeUndefined();
  expect(bridge.beforeRequest('chat', {})).toBeUndefined();
});
test('unsupported installations do not write config and blocked models never silently inherit', () => {
  const { bridge, calls } = fixture({ state: 'unverified', reason: 'subagent_native_contract_unverified' });
  expect(bridge.update(policy).state).toBe('unverified'); expect(calls).toHaveLength(0);
  expect(bridge.beforeRequest('chat', {})).toEqual({ status: 503, code: 'subagent_native_contract_unverified' });
  bridge.update({ mode: 'blocked', reason: 'subagent_model_unavailable' });
  expect(bridge.beforeRequest('chat', {})).toEqual({ status: 409, code: 'subagent_model_unavailable' });
  bridge.update({ mode: 'inherit' }); expect(bridge.beforeRequest('chat', {})).toBeUndefined();
});

import { test, expect } from 'bun:test';
import { bindNativeWorkIntegration } from '../src/native-work-binding.mjs';

test('standalone binding uses the native aliases and closes the same coordinator on shutdown', async () => {
  const seen = [], gateway = { url: 'http://127.0.0.1:3426/v1' }, backend = { models: [{ id: 'child' }] };
  const policy = { desired: { mode: 'force', model: 'child', transport: 'native-config' },
    configure(value, models) { seen.push({ value, models, aliases: this.aliases }); } };
  const integration = { async reconcile(input) { seen.push(input); return { state: 'ready', imported: true, aliases: { child: 'native/child' } }; },
    close() { seen.push('closed'); } };
  const binding = await bindNativeWorkIntegration({ gateway, backend, policy, integration });
  expect(binding.status.imported).toBe(true);
  expect(seen[1]).toEqual({ value: policy.desired, models: backend.models, aliases: { child: 'native/child' } });
  expect(gateway.nativeIntegration).toBe(binding);
  await binding.close();
  expect(seen.at(-1)).toBe('closed');
  expect(gateway.nativeIntegration).toBeUndefined();
});

test('unknown account and missing native import never trigger a generated-config policy alias change', async () => {
  const gateway = { url: 'http://127.0.0.1:3426/v1' }, backend = { models: [] };
  const policy = { configure() { throw Error('unexpected policy write'); } };
  const integration = { reconcile: async () => ({ state: 'needs-native-import', imported: false }), close() {} };
  const binding = await bindNativeWorkIntegration({ gateway, backend, policy, integration });
  try { expect(binding.status.state).toBe('needs-native-import'); expect(policy.aliases).toBeUndefined(); }
  finally { await binding.close(); }
});

test('a fixed target waits for confirmed import without losing its durable selection', async () => {
  const gateway = { url: 'http://127.0.0.1:3426/v1' }, backend = { models: [] };
  const desired = { mode: 'force', model: 'child', transport: 'native-config' };
  const policy = { desired, save(value) { this.value = value; }, configure() { throw Error('unexpected configuration'); } };
  const integration = { reconcile: async () => ({ state: 'needs-native-import', imported: false }), close() {} };
  const binding = await bindNativeWorkIntegration({ gateway, backend, policy, integration });
  try {
    expect(policy.value).toEqual({ mode: 'blocked', transport: 'native-config', reason: 'subagent_native_import_pending' });
    expect(policy.desired).toEqual(desired);
  } finally { await binding.close(); }
});

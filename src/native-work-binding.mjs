import crypto from 'node:crypto';
import { NativeWorkIntegration } from './native-work-integration.mjs';

export async function bindNativeWorkIntegration({ stateDir, kimiDir, gateway, backend, policy, integration, onChange, deferInitial = false } = {}) {
  const manager = integration || new NativeWorkIntegration({ stateDir, kimiDir, sourceID: 'gateway' });
  let closed = false, pending, signature;
  const binding = { manager, status: { state: 'checking', imported: false } };
  const reconcile = () => {
    if (closed || pending) return pending;
    pending = Promise.resolve().then(async () => {
      const value = await manager.reconcile({ enabled: true, url: gateway.url, models: backend.models,
        connectionRevision: crypto.createHash('sha256').update(gateway.connection?.key || '').digest('hex'),
        allowNativeImport: typeof manager.syncNative === 'function' });
      binding.status = value;
      const next = JSON.stringify(value);
      if (next !== signature) {
        signature = next;
        if (value.imported && value.aliases) {
          policy.aliases = value.aliases;
          try { policy.configure(policy.desired ?? policy.value, backend.models); } catch {}
        } else if (['force', 'pool'].includes(policy.desired?.mode)) {
          policy.aliases = {};
          policy.save({ mode: 'blocked', transport: 'native-config', reason: 'subagent_native_import_pending' });
        }
        await onChange?.(value);
      }
      return value;
    }).catch(() => { binding.status = { state: 'unavailable', imported: false, reason: 'native_integration_failed' }; })
      .finally(() => { pending = undefined; });
    return pending;
  };
  gateway.nativeIntegration = binding;
  if (deferInitial) void reconcile(); else await reconcile();
  const timer = setInterval(reconcile, 1000);
  timer.unref?.();
  binding.close = async () => {
    closed = true;
    clearInterval(timer);
    await pending;
    await manager.close();
    if (gateway.nativeIntegration === binding) delete gateway.nativeIntegration;
  };
  return binding;
}

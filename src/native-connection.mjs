import { NativeDesktopRuntime } from './native-desktop-runtime.mjs';
import { NativeModelImport } from './native-import.mjs';
import { NativeOnboarding } from './native-onboarding.mjs';

// Every variable that carries an upstream credential is removed from the
// environment the Kimi child inherits: the legacy key when the config still
// has one, and each connection's own key. A names-only list is enough because
// the child is started from this process's environment, and this module never
// needs to read the values themselves.
export function protectedConnectionEnvNames(config) {
  return [config.upstream?.apiKeyEnv, ...(config.connections || []).map(connection => connection.apiKeyEnv), config.tokenEnv]
    .filter(name => typeof name === 'string' && name);
}

export function createNativeConnection({ stateDir, kimiDir, gateway, config, env = process.env,
  desktop, onboarding, importer } = {}) {
  const protectedEnvNames = protectedConnectionEnvNames(config);
  const runtime = desktop || new NativeDesktopRuntime({ stateDir, kimiDir, env, protectedEnvNames,
    gatewayBusy: () => gateway.inflight.size });
  runtime.configure(config.translation);
  const preparation = onboarding || new NativeOnboarding({ stateDir, kimiDir, dnsPort: config.dns.port });
  const connection = { desktop: runtime, onboarding: preparation, status: { state: 'checking' } };
  const ensure = async ({ retry = false } = {}) => {
    if (runtime.scopeVerified === false) {
      connection.status = await runtime.ensure();
      return connection.status;
    }
    connection.status = { state: 'preparing' };
    connection.status = await preparation.ensure({ retry });
    if (['ready', 'done', 'waiting-kimi'].includes(connection.status?.state)) return runtime.ensure();
    return { ...connection.status, ok: false, reason: 'native_setup_' + (connection.status?.state || 'failed') };
  };
  connection.importer = importer || new NativeModelImport({ stateDir, kimiDir, getToken: () => gateway.connection?.key,
    ensureRuntime: ensure });
  connection.syncNative = request => connection.importer.sync(request);
  connection.ensure = ensure;
  connection.retry = async () => {
    connection.importer.after = 0;
    connection.importer.retry = true;
    return ensure({ retry: true });
  };
  connection.close = () => runtime.close();
  return connection;
}

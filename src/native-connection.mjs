import { NativeDesktopRuntime } from './native-desktop-runtime.mjs';
import { NativeModelImport } from './native-import.mjs';
import { NativeOnboarding } from './native-onboarding.mjs';

export function createNativeConnection({ stateDir, kimiDir, gateway, config, env = process.env,
  desktop, onboarding, importer } = {}) {
  const protectedEnvNames = [config.upstream.apiKeyEnv, config.tokenEnv];
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

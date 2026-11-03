import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readConfig } from './src/config.mjs';
import { BYOK_DNS_PORT, KimiWorkGateway, NativeByokDNS, NativeSetup, OpenAIBackend,
  copySetupToken, defaultKimiDirectory, defaultStateDirectory, nativeFlagFile,
  inspectKimiContract, summarizeKimiContract, SubagentPolicy, SubagentRuntime, bindNativeSubagents, NativeWorkIntegration } from './src/index.mjs';
import { readSubagentJSON } from './src/subagent-policy.mjs';
import { PanelController } from './src/panel-controller.mjs';
import { GatewayPanel } from './src/panel.mjs';
import { TranslationRuntime } from './src/translation-runtime.mjs';
import { bindNativeWorkIntegration } from './src/native-work-binding.mjs';
import { SetupServer, readCredentials, removePanelEntry,
  setupPaths, writePanelEntry, credentialEnvironment, requiredCredentialNames,
  UPSTREAM_KEY_ENV, GATEWAY_TOKEN_ENV } from './src/setup.mjs';
import { GatewayService, assertPersistableEnvironment, selectEnvironment, stableLauncherPath,
  SERVICE_LABEL } from './src/service-manager.mjs';
import { ServiceRunner, inspectRunner, requestRunner } from './src/service-runner.mjs';
import { createNativeConnection } from './src/native-connection.mjs';

const USAGE = [
  'usage: kimi-work-gateway <command> [options]',
  '',
  'commands:',
  '  setup [--state-dir <dir>] [--config <file>] [--port <port>] [--no-open]',
  '      first run: open a local page to save the upstream and models, then install the service',
  '  serve --config <file|-> [--instructions <file>] [--state-dir <dir>] [--kimi-dir <dir>]',
  '      serve models and maintain native Kimi integration; --no-native disables desktop preparation',
  '  panel --config <file> [--ui-port <port>] [--credentials <file>] [--entry-file <file>]',
  '        [--instructions <file>] [--state-dir <dir>] [--kimi-dir <dir>]',
  '      serve the gateway with a local web control panel (default port 3427)',
  '  service install [--state-dir <dir>] [--config <file>] [--panel-port <port>] [--env <NAME> ...]',
  '      install and start the current-user background service from the saved setup',
  '  service start|stop|restart|status [--state-dir <dir>]',
  '      control or report the background service; status prints the panel link',
  '  service uninstall [--state-dir <dir>]',
  '      remove only the service files this tool created; keeps config and credentials',
  '  service-run --state-dir <dir> -- <panel arguments>',
  '      supervised entry point used by the service definition; restarts the panel',
  '  prepare [--state-dir <dir>] [--kimi-dir <dir>] [--dns-port <port>]',
  '      install the dev.msh.team resolver; may ask for administrator rights',
  '  remove-dns [--state-dir <dir>] [--kimi-dir <dir>] [--dns-port <port>]',
  '      remove the dev.msh.team resolver; may ask for administrator rights',
  '  compat [--archive <file>] [--config <file>]',
  '      check configured models, or the built-in sample catalog if no config is given',
  '  status [--state-dir <dir>] [--kimi-dir <dir>]',
  '      show the gateway status file, the native setup receipt and the subagent state',
  '  copy-token [--state-dir <dir>] [--token-env <name>]',
  '      copy the gateway token to the clipboard',
  '  subagents-prepare [--state-dir <dir>] [--kimi-dir <dir>] [--archive <file>]',
  '      adapt a local copy of the installed Kimi runtime for subagent control',
  '  subagents-status [--state-dir <dir>] [--kimi-dir <dir>] [--archive <file>]',
  '      report the subagent policy and runtime state; changes nothing',
  '  subagents-launch [--state-dir <dir>] [--kimi-dir <dir>] [--archive <file>]',
  '      start Kimi on the adapted runtime copy; quit Kimi first',
  '  check-update',
  '      check the latest stable GitHub release without changing the running program',
  '  update',
  '      verify and stage the latest release; restart the gateway to use it',
  '  rollback-update',
  '      select the previous installed release for the next gateway start',
  '  help',
  '      show this text',
].join('\n');

// serve: 2 for bad config or missing env, 3 for a listener, state or policy failure.
// prepare/remove-dns map the setup state: 4 resolver-conflict, 5 cancelled,
// 6 interrupted, 7 failed, 8 unsupported-platform.
// compat: 0 verified or unverifiable, 9 incompatible (models would be dropped).
// subagents-*: 0 prepared or launched (including "quit Kimi first"), 3 failed or
// conflicting, 9 an unsupported kernel or launch contract.
const SETUP_EXIT = { done: 0, 'resolver-conflict': 4, cancelled: 5, interrupted: 6, failed: 7, 'unsupported-platform': 8 };
const COMPAT_EXIT = { verified: 0, unverified: 0, unavailable: 0, incompatible: 9 };
const SUBAGENT_INCOMPATIBLE = new Set(['subagent_runtime_incompatible', 'subagent_runtime_already_adapted', 'subagent_launch_unsupported',
  'subagent_bundle_link_conflict', 'subagent_bundle_file_conflict']);

// A retained legacy block with no model routing through it must not block
// startup: the endpoint is registered only when its key is actually present.
function legacyEndpoint(config, env) {
  return config.upstream && env[config.upstream.apiKeyEnv]
    ? { baseURL: config.upstream.baseURL, apiKey: env[config.upstream.apiKeyEnv] } : {};
}

function streams(io) {
  return {
    out: io?.out || (line => process.stdout.write(line + '\n')),
    err: io?.err || (line => process.stderr.write(line + '\n')),
  };
}

function parseFlags(argv, allowed, required = []) {
  const flags = {};
  for (let at = 0; at < argv.length; at++) {
    if (!argv[at].startsWith('--') || !allowed.includes(argv[at].slice(2)) || at + 1 >= argv.length) return null;
    flags[argv[at].slice(2)] = argv[++at];
  }
  return required.every(name => flags[name]) ? flags : null;
}

function usageError(io, message) {
  io.err(message);
  io.err(USAGE);
  return 1;
}

function writeStatus(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readStateFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return { raw, value: JSON.parse(raw) };
  } catch (failure) {
    return failure.code === 'ENOENT' ? null : { raw: '', value: null, broken: failure.message };
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Only the fields that describe the selection, never credentials or upstream
// settings, are reported in status.json, logs and command output.
function summarizeSubagentPolicy(policy) {
  if (!['force', 'pool', 'blocked'].includes(policy.mode)) return { mode: 'inherit', ...(policy.transport ? { transport: policy.transport } : {}) };
  if (policy.mode === 'blocked') return { mode: 'blocked', ...(policy.reason ? { reason: String(policy.reason) } : {}) };
  return { mode: policy.mode, ...(policy.transport ? { transport: policy.transport } : {}),
    model: policy.model, ...(policy.modelAlias ? { modelAlias: policy.modelAlias } : {}),
    ...(policy.models ? { models: policy.models } : {}), ...(policy.effort === undefined ? {} : { effort: policy.effort }) };
}

function describeSubagentPolicy(summary) {
  if (summary.mode === 'force') {
    return 'force ' + (summary.modelAlias || summary.model) + (summary.effort === undefined ? '' : ' (' + summary.effort + ')');
  }
  if (summary.mode === 'blocked') return 'blocked (' + (summary.reason || 'model unavailable') + ')';
  if (summary.mode === 'pool') return 'pool ' + (summary.modelAlias || summary.model) + ' (' + (Array.isArray(summary.models) ? summary.models.length : 'unknown') + ' models)';
  return 'inherit';
}

// Only the state words a caller can act on, never paths or a raw bridge reply.
function summarizeNative(connection) {
  const pick = (value, fields) => Object.fromEntries(Object.entries(value || {})
    .filter(([key, entry]) => fields.includes(key) && (typeof entry === 'string' || typeof entry === 'number')));
  return { preparation: pick(connection?.status, ['state', 'reason', 'stage']),
    desktop: pick(connection?.desktop?.inspect?.(), ['state', 'reason', 'version', 'enabled']) };
}

// Reads the policy without creating or touching anything, so `status` stays a
// pure observer even when the file is missing or foreign.
function readSubagentPolicy(file) {
  let document;
  try { document = readSubagentJSON(file); }
  catch (failure) { return { state: failure?.code === 'ENOENT' ? 'absent' : 'conflict' }; }
  if (!document || typeof document !== 'object' || document.schemaVersion !== 1
    || typeof document.homeDir !== 'string' || !path.isAbsolute(document.homeDir)
    || !/^[a-f0-9]{64}$/.test(document.revision ?? '')
    || !['inherit', 'force', 'pool', 'blocked'].includes(document.mode)) return { state: 'conflict' };
  if (document.mode === 'pool' && (document.transport !== 'native-config'
    || typeof document.model !== 'string' || typeof document.modelAlias !== 'string'
    || !Array.isArray(document.models) || !document.models.length || document.models.length > 32
    || document.models.some(row => !row || typeof row.id !== 'string' || typeof row.modelAlias !== 'string'
      || typeof row.description !== 'string' || !row.description.trim())
    || !document.models.some(row => row.id === document.model && row.modelAlias === document.modelAlias))) return { state: 'conflict' };
  return { state: 'ok', document };
}

// prepare/launch need a policy the adapted runtime can read. A missing file
// becomes explicit inheritance; an existing one is kept, but only if it belongs
// to this Kimi scope, otherwise the runtime would silently ignore it.
function ensureSubagentPolicy(policy) {
  const current = readSubagentPolicy(policy.file);
  if (current.state === 'absent') {
    policy.configure(undefined);
    return readSubagentPolicy(policy.file);
  }
  if (current.state === 'conflict') throw Error('subagent_file_conflict');
  if (path.resolve(current.document.homeDir) !== policy.homeDir) throw Error('subagent_policy_scope_conflict');
  return current;
}

function subagentFailure(io, action, failure) {
  const code = failure?.message || String(failure);
  io.err('kimi-work-gateway: subagents-' + action + ' failed (' + code + ')');
  return SUBAGENT_INCOMPATIBLE.has(code) ? 9 : 3;
}

async function serveCommand(argv, env, io, overrides = {}) {
  const panelEnabled = overrides.panel === true;
  const nativeDisabled = argv.includes('--no-native');
  const flags = parseFlags(argv.filter(value => value !== '--native' && value !== '--no-native'),
    ['config', 'instructions', 'state-dir', 'kimi-dir',
      ...(panelEnabled ? ['ui-port', 'credentials', 'entry-file'] : [])], ['config']);
  if (!flags || panelEnabled && flags.config === '-') {
    return usageError(io, 'kimi-work-gateway: ' + (panelEnabled ? 'panel needs --config <file>' : 'serve needs --config <file|->'));
  }
  const uiPort = flags['ui-port'] === undefined ? 3427 : Number(flags['ui-port']);
  if (panelEnabled && (!Number.isInteger(uiPort) || uiPort < 0 || uiPort > 65535)) {
    return usageError(io, 'kimi-work-gateway: --ui-port must be an integer from 0 to 65535');
  }
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  const kimiDir = flags['kimi-dir'] || defaultKimiDirectory();
  let text;
  if (flags.config === '-') text = await readStdin();
  else {
    try { text = panelEnabled ? JSON.stringify(readSubagentJSON(flags.config)) : fs.readFileSync(flags.config, 'utf8'); }
    catch { io.err('kimi-work-gateway: cannot read config file ' + flags.config); return 2; }
  }
  let config;
  try { config = readConfig(JSON.parse(text)); }
  catch (failure) {
    io.err('kimi-work-gateway: invalid config ('
      + (failure instanceof SyntaxError ? 'not valid JSON' : failure.message) + ')');
    return 2;
  }
  // `--credentials` is how a background service starts without an interactive
  // shell. Each key in the file is mapped to the variable its connection names,
  // so several upstreams can hold different credentials; the file never becomes
  // the environment of anything else, and no value is printed.
  let runtimeEnv = env;
  if (flags.credentials) {
    let credentials;
    try { credentials = readCredentials(flags.credentials, { requirePrivate: true }); }
    catch (failure) {
      io.err('kimi-work-gateway: cannot read credentials file ' + flags.credentials
        + ' (' + (failure?.message || String(failure)) + ')');
      return 2;
    }
    if (!credentials) { io.err('kimi-work-gateway: credentials file ' + flags.credentials + ' is absent'); return 2; }
    if (config.tokenEnv !== GATEWAY_TOKEN_ENV) {
      io.err('kimi-work-gateway: credentials file needs ' + GATEWAY_TOKEN_ENV
        + ' in the config; use environment variables or update the config');
      return 2;
    }
    if (config.upstream && credentials.upstreamApiKey && config.upstream.apiKeyEnv !== UPSTREAM_KEY_ENV) {
      io.err('kimi-work-gateway: credentials file stores the legacy key as ' + UPSTREAM_KEY_ENV
        + '; use environment variables or update the config');
      return 2;
    }
    runtimeEnv = { ...env, ...credentialEnvironment(config, credentials) };
  }
  // Only the variables this configuration actually routes through are required:
  // a connections-only gateway must not be blocked on an unused legacy key.
  const missing = requiredCredentialNames(config).filter(name => !runtimeEnv[name]);
  if (missing.length) {
    for (const name of missing) io.err('kimi-work-gateway: missing environment variable ' + name);
    return 2;
  }
  let backend, gateway;
  try {
    // Both the legacy block and each connection are registered only when their
    // key is actually present. `requiredCredentialNames` has already refused
    // any variable a model routes through, so a gap here can only be an unused
    // endpoint; registering it with an empty key would abort startup for a
    // configuration the service legitimately accepted.
    const endpoints = config.connections
      .filter(connection => runtimeEnv[connection.apiKeyEnv])
      .map(connection => ({ id: connection.id, baseURL: connection.baseURL,
        apiKey: runtimeEnv[connection.apiKeyEnv],
        ...(connection.protocols ? { protocols: connection.protocols } : {}) }));
    backend = new OpenAIBackend({ ...legacyEndpoint(config, runtimeEnv), connections: endpoints, models: config.models });
    gateway = new KimiWorkGateway({ backend, instructionsFile: flags.instructions, recordRequests: panelEnabled });
    if (config.subagents?.transport === 'native-config') gateway.beforeRequest = () => ({ status: 503, code: 'subagent_policy_initializing' });
  } catch (failure) {
    io.err('kimi-work-gateway: invalid config (' + failure.message + ')');
    return 2;
  }
  let dns, policy, panel, controller, nativeConnection;
  const statusFile = path.join(stateDir, 'status.json');
  const instanceId = crypto.randomUUID();
  const hostsMode = config.dns.enabled && (overrides.platform || process.platform) === 'win32';
  let published = false;
  let entryPublished = false;
  // The native connection is built only after the listener exists: a duplicate
  // serve must not open a desktop bridge, touch Kimi or claim the import intent.
  // Any explicit native override (integration, context, sync, connection) means
  // the caller owns that path, so no real desktop/onboarding is created.
  const createNative = overrides.createNativeConnection || createNativeConnection;
  const nativeOwned = 'nativeConnection' in overrides || 'nativeIntegration' in overrides
    || 'nativeContext' in overrides || 'syncNative' in overrides
    || typeof overrides.createNativeConnection === 'function';
  const buildNative = () => createNative({ stateDir, kimiDir, gateway, config, env: runtimeEnv });
  try {
    let url;
    try { url = await gateway.configure({ key: runtimeEnv[config.tokenEnv], port: config.port }); }
    catch (failure) {
      io.err('kimi-work-gateway: cannot listen on 127.0.0.1:' + config.port + ' (' + failure.message + ')');
      return 3;
    }
    // A real connection starts preparation right away, but only off the request
    // path: a desktop prompt or a missing Kimi must never fail `serve`.
    const deferNative = overrides.deferNative === true;
    if (nativeDisabled || overrides.nativeConnection === false) nativeConnection = null;
    else if (overrides.nativeConnection) nativeConnection = overrides.nativeConnection;
    else if (nativeOwned && typeof overrides.createNativeConnection !== 'function') nativeConnection = null;
    else {
      try { nativeConnection = buildNative(); }
      catch (failure) {
        // A missing desktop bridge must not hide the models from a plain serve;
        // the panel reports the native preparation state separately.
        io.err('kimi-work-gateway: native connection unavailable (' + (failure?.message || String(failure)) + ')');
        nativeConnection = null;
      }
    }
    if (config.dns.enabled && !hostsMode) {
      dns = new (overrides.NativeByokDNS || NativeByokDNS)();
      try { await dns.start(config.dns.port); }
      catch (failure) {
        io.err('kimi-work-gateway: cannot start dns on port ' + config.dns.port + ' (' + failure.message + ')');
        return 3;
      }
    }
    // Only after the listener exists: a failed duplicate serve must leave the
    // policy of the instance that owns the port untouched. Reaching here means
    // this process is the one Work talks to, so it owns the subagent policy
    // until it exits; without `subagents` in the config that means inheritance.
    let subagents;
    try {
      policy = new (overrides.SubagentPolicy || SubagentPolicy)({ stateDir, kimiDir });
      policy.configure(config.subagents, backend.models);
      gateway.workBinding = await bindNativeWorkIntegration({ stateDir, kimiDir, gateway, backend, policy,
        deferInitial: overrides.deferInitial !== false,
        integration: overrides.nativeIntegration || new (overrides.NativeWorkIntegration || NativeWorkIntegration)({ stateDir, kimiDir,
          sourceID: 'gateway', getContext: overrides.nativeContext,
          syncNative: overrides.syncNative || nativeConnection?.syncNative }),
        onChange: value => {
          const current = readStateFile(statusFile)?.value;
          if (current?.instanceId === instanceId) writeStatus(statusFile, { ...current, integration: value,
            subagents: summarizeSubagentPolicy(policy.value) });
        } });
      bindNativeSubagents({ policy, gateway, stateDir, kimiDir });
      subagents = summarizeSubagentPolicy(policy.value);
    } catch (failure) {
      io.err('kimi-work-gateway: cannot apply the subagent policy (' + (failure?.message || String(failure)) + ')');
      return 3;
    }
    if (panelEnabled) {
      try {
        // A read-only view of the background service, so the page can tell a
        // service-run panel from a terminal one and name the actual restart
        // commands. Constructing the service executes nothing: launchd and
        // schtasks are only reached by the install/start/stop commands.
        const serviceView = new (overrides.GatewayService || GatewayService)({
          stateDir, env: runtimeEnv,
          ...(flags.config ? { configPath: path.resolve(flags.config) } : {}),
          ...(flags.credentials ? { credentialsFile: path.resolve(flags.credentials) } : {}),
          ...(flags['entry-file'] ? { entryFile: path.resolve(flags['entry-file']) } : {}),
          ...(kimiDir ? { kimiDir } : {}),
          panelPort: uiPort,
          ...(overrides.nodePath ? { nodePath: overrides.nodePath } : {}),
          ...(overrides.serviceRunner ? { runner: overrides.serviceRunner } : {}),
          ...(overrides.home ? { home: overrides.home } : {}),
          ...(overrides.serviceVersion ? { version: overrides.serviceVersion } : {}) });
        controller = new (overrides.PanelController || PanelController)({
          configFile: flags.config, config, gateway, backend, stateDir, kimiDir, policy, env: runtimeEnv,
          nativeConnection, ...(flags.credentials ? { credentialsFile: flags.credentials } : {}),
          service: serviceView,
          // One manager instance for the whole process: the kernel client is
          // shared by every request and closed exactly once, at shutdown.
          ...('contextPolicy' in overrides ? { contextPolicy: overrides.contextPolicy } : {}),
          ...('mcpManager' in overrides ? { mcpManager: overrides.mcpManager } : {}),
          onPolicy: value => {
            const current = readStateFile(statusFile)?.value;
            if (current?.instanceId !== instanceId) return;
            try { writeStatus(statusFile, { ...current, models: backend.models.length, subagents: summarizeSubagentPolicy(value) }); }
            catch { io.err('kimi-work-gateway: cannot update ' + statusFile); }
          },
        });
        panel = new (overrides.GatewayPanel || GatewayPanel)({ controller });
        await panel.start({ port: uiPort });
        // The MCP card fills before the page polls it, and the saved context
        // policy is re-asserted whenever the desktop rewrites `config.toml`
        // again. Both are best effort: a missing Kimi must not fail the run.
        void controller.loadNativeState();
        if (!('contextPolicy' in overrides) || overrides.contextPolicy) controller.startContextWatch?.();
      } catch (failure) {
        io.err('kimi-work-gateway: cannot start panel (' + (failure?.message || String(failure)) + ')');
        return 3;
      }
    }
    try {
      writeStatus(statusFile, { pid: process.pid, instanceId, url, models: backend.models.length,
        dns: { enabled: Boolean(dns), port: config.dns.port, ...(hostsMode ? { mode: 'hosts' } : {}) },
        subagents, integration: gateway.workBinding?.status,
        ...(nativeConnection ? { native: summarizeNative(nativeConnection) } : {}),
        ...(panel ? { panel: { url: panel.url } } : {}), at: new Date().toISOString() });
      published = true;
    } catch { io.err('kimi-work-gateway: cannot write ' + statusFile); return 3; }
    // A background service has no terminal, so the panel link is written to a
    // private file that `service status` can read. It contains the session key
    // and is removed again on exit.
    if (panel && flags['entry-file']) {
      try {
        writePanelEntry(flags['entry-file'], { url: panel.url, entryURL: panel.entryURL, pid: process.pid });
        entryPublished = true;
      } catch (failure) {
        io.err('kimi-work-gateway: cannot write panel entry (' + (failure?.message || String(failure)) + ')');
      }
    }
    // Publish the control surface before the first system prompt. Cancellation
    // is persisted by onboarding and requires an explicit retry from the panel.
    if (nativeConnection && !deferNative) {
      void Promise.resolve(nativeConnection.ensure())
        .then(value => {
          const current = readStateFile(statusFile)?.value;
          if (current?.instanceId === instanceId) {
            try { writeStatus(statusFile, { ...current, native: summarizeNative(nativeConnection) }); } catch {}
          }
          return value;
        })
        .catch(() => {});
    }
    io.out(url);
    io.out(hostsMode ? 'dns provided by Windows hosts' : dns ? 'dns listening on port ' + config.dns.port : 'dns disabled');
    io.out('subagents ' + describeSubagentPolicy(subagents));
    // When the link goes to the entry file, stdout is a log: printing the
    // session key there would put it in the service log on every start.
    if (panel) {
      io.out(flags['entry-file'] ? 'panel ' + panel.url + ' (link in ' + flags['entry-file'] + ')'
        : 'panel ' + panel.entryURL);
    }
    if (overrides.waitForShutdown) await overrides.waitForShutdown();
    else await new Promise(resolve => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    // close() on the native connection can wait on a desktop bridge; shutdown
    // must not hang on it, and nothing here ends Kimi or clears an intent.
    const bounded = (task, ms) => Promise.race([Promise.resolve().then(task),
      new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); })]);
    for (const [name, stop] of [['panel', () => panel?.stop()], ['panel controller', () => controller?.close()],
      ['native connection', () => bounded(() => nativeConnection?.close(), 3000)],
      ['native integration', () => bounded(() => gateway.workBinding?.close(), 3000)],
      ['dns', () => dns?.stop()], ['gateway', () => gateway.stop()]]) {
      try { await stop(); } catch { io.err('kimi-work-gateway: cannot stop ' + name); }
    }
    // If the controller never came up, a manager supplied by an embedder is
    // still this process's to release; closing twice is idempotent.
    if (!controller && typeof overrides.mcpManager?.close === 'function') {
      try { await bounded(() => overrides.mcpManager.close(), 3000); } catch {}
    }
    if (published && readStateFile(statusFile)?.value?.instanceId === instanceId) fs.rmSync(statusFile, { force: true });
    if (entryPublished && flags['entry-file']) removePanelEntry(flags['entry-file']);
    // Restoring inheritance is best effort and never blocks shutdown; close()
    // only rewrites the file when this process still owns it.
    try { policy?.close(); } catch (failure) { io.err('kimi-work-gateway: cannot restore the subagent policy (' + (failure?.message || String(failure)) + ')'); }
  }
  return 0;
}

async function nativeCommand(action, argv, env, io, overrides) {
  const flags = parseFlags(argv, ['state-dir', 'kimi-dir', 'dns-port']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for ' + action);
  const dnsPort = flags['dns-port'] === undefined ? BYOK_DNS_PORT : Number(flags['dns-port']);
  if (!Number.isInteger(dnsPort) || dnsPort < 1024 || dnsPort > 65535) {
    return usageError(io, 'kimi-work-gateway: --dns-port must be an integer from 1024 to 65535');
  }
  const stateDir = flags['state-dir'] || defaultStateDirectory();
  const kimiDir = flags['kimi-dir'] || defaultKimiDirectory();
  const setup = new (overrides.NativeSetup || NativeSetup)({ stateDir, flagFile: nativeFlagFile(kimiDir) });
  const result = await setup.run({ action, id: crypto.randomBytes(16).toString('hex'), at: Date.now() }, dnsPort);
  io.out(JSON.stringify(result ?? { action, state: 'failed' }));
  return SETUP_EXIT[result?.state] ?? 7;
}

async function statusCommand(argv, env, io, overrides = {}) {
  const flags = parseFlags(argv, ['state-dir', 'kimi-dir']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for status');
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  const kimiDir = flags['kimi-dir'] || defaultKimiDirectory();
  const gateway = readStateFile(path.join(stateDir, 'status.json'));
  if (!gateway) io.out('gateway: absent');
  else if (!gateway.value) io.out('gateway: unreadable (' + gateway.broken + ')');
  else {
    io.out('gateway: pid ' + gateway.value.pid + ' ' + gateway.value.url + ', ' + gateway.value.models + ' models, dns '
      + (gateway.value.dns?.mode === 'hosts' ? 'provided by Windows hosts'
        : gateway.value.dns?.enabled ? 'listening on port ' + gateway.value.dns.port : 'disabled'));
    // Older status files predate the subagent policy; their absence is not a fault.
    io.out('gateway subagents: ' + (gateway.value.subagents ? describeSubagentPolicy(gateway.value.subagents) : 'unknown'));
    io.out(gateway.raw);
  }
  const setup = readStateFile(path.join(stateDir, 'native-setup-receipt.json'));
  if (!setup) io.out('native setup: absent');
  else if (!setup.value) io.out('native setup: unreadable (' + setup.broken + ')');
  else {
    io.out('native setup: ' + (setup.value.result?.state || setup.value.state || 'unknown'));
    io.out(setup.raw);
  }
  const policy = new (overrides.SubagentPolicy || SubagentPolicy)({ stateDir, kimiDir });
  const current = readSubagentPolicy(policy.file);
  if (current.state === 'absent') io.out('subagents: absent');
  else if (current.state === 'conflict') io.out('subagents: unreadable or foreign policy file');
  else {
    io.out('subagents: ' + describeSubagentPolicy(summarizeSubagentPolicy(current.document))
      + (path.resolve(current.document.homeDir) === policy.homeDir ? '' : ' (another Kimi scope)'));
  }
  if (current.state === 'ok' && current.document.transport === 'native-config') {
    const { NativeSubagentConfig } = await import('./src/index.mjs');
    const native = new NativeSubagentConfig({ stateDir, kimiDir }).inspect();
    io.out('subagent runtime: ' + native.state + ' (native-config)');
  } else {
    const runtime = new (overrides.SubagentRuntime || SubagentRuntime)({ stateDir });
    io.out('subagent runtime: ' + runtime.inspect().state);
  }
  const translation = new TranslationRuntime({ stateDir, kimiDir, env }).inspect();
  io.out('translation: ' + translation.state + (translation.reason ? ' (' + translation.reason + ')' : ''));
  return 0;
}

// subagents-*: prepare and launch act on real state, so they refuse to guess.
// `--archive` pins the Kimi installation; `--kimi-dir` selects the Work home the
// adapted runtime is allowed to override.
async function subagentCommand(action, argv, env, io, overrides) {
  const flags = parseFlags(argv, ['state-dir', 'kimi-dir', 'archive']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for subagents-' + action);
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  const kimiDir = flags['kimi-dir'] || defaultKimiDirectory();
  const runtime = new (overrides.SubagentRuntime || SubagentRuntime)({
    stateDir, ...(flags.archive ? { archive: flags.archive } : {}),
  });
  const policy = new (overrides.SubagentPolicy || SubagentPolicy)({ stateDir, kimiDir });
  const report = (current, result, exit) => {
    io.out(JSON.stringify({ command: 'subagents-' + action, homeDir: policy.homeDir,
      policy: current.state === 'ok' ? summarizeSubagentPolicy(current.document) : { state: current.state },
      runtime: result }));
    return exit;
  };
  try {
    const selected = readSubagentPolicy(policy.file);
    if (selected.state === 'ok' && selected.document.transport === 'native-config') {
      if (path.resolve(selected.document.homeDir) !== policy.homeDir) return report({ state: 'scope-conflict' }, { state: 'conflict' }, 3);
      const { NativeSubagentConfig, inspectNativeSubagentContract } = await import('./src/index.mjs');
      const compatibility = inspectNativeSubagentContract(flags.archive ? { archive: flags.archive } : {});
      const inspected = { ...new NativeSubagentConfig({ stateDir, kimiDir }).inspect(), compatibility };
      if (action !== 'launch') return report(selected, inspected, compatibility.state === 'source-compatible' ? 0 : 9);
      if (inspected.state !== 'file-applied' || compatibility.state !== 'source-compatible') throw Error('subagent_runtime_not_ready');
      return report(selected, await runtime.launchOriginal({ protectedEnvNames: ['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN', 'KIMI_WORK_TRANSLATION_API_KEY'] }), 0);
    }
    if (action === 'status') {
      // Read-only: no policy file is created here and the runtime is only inspected.
      const current = selected;
      const inspected = runtime.inspect();
      if (current.state === 'conflict') return report(current, inspected, 3);
      if (current.state === 'ok' && path.resolve(current.document.homeDir) !== policy.homeDir) {
        return report({ state: 'scope-conflict' }, inspected, 3);
      }
      const failed = current.document?.mode === 'blocked'
        || ['conflict', 'scope-conflict', 'outdated', 'unavailable', 'policy-unavailable', 'heartbeat-stale'].includes(inspected.state);
      return report(current, inspected, inspected.state === 'unsupported' ? 9 : failed ? 3 : 0);
    }
    const current = ensureSubagentPolicy(policy);
    if (action === 'prepare') return report(current, runtime.prepare(), 0);
    if (current.document.mode === 'blocked') throw Error('subagent_policy_blocked');
    // launch() refuses unprepared state too, but failing here keeps the reason
    // and the exit code in the CLI contract instead of the runtime's wording.
    const inspected = runtime.inspect();
    if (inspected.state === 'unsupported') throw Error('subagent_launch_unsupported');
    if (!['loaded', 'pending-policy', 'waiting-launch'].includes(inspected.state)) throw Error('subagent_runtime_not_ready');
    return report(current, await runtime.launch({ protectedEnvNames: ['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN', 'KIMI_WORK_TRANSLATION_API_KEY'] }), 0);
  } catch (failure) {
    return subagentFailure(io, action, failure);
  }
}

async function copyTokenCommand(argv, env, io, overrides) {
  const flags = parseFlags(argv, ['state-dir', 'token-env']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for copy-token');
  const tokenEnv = flags['token-env'] || 'KIMI_WORK_GATEWAY_TOKEN';
  if (!env[tokenEnv]) { io.out('no-token'); return 0; }
  const stateDir = flags['state-dir'] || defaultStateDirectory();
  const result = await (overrides.copySetupToken || copySetupToken)({
    request: { id: crypto.randomBytes(16).toString('hex'), at: Date.now() }, stateDir, key: env[tokenEnv],
  });
  io.out(result === 'copied' ? 'copied' : 'unavailable');
  return 0;
}

function compatCommand(argv, env, io, overrides) {
  const flags = parseFlags(argv, ['archive', 'config']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for compat');
  let models;
  if (flags.config) {
    try {
      const config = readConfig(JSON.parse(fs.readFileSync(flags.config, 'utf8')));
      // A syntax check has no credentials; a placeholder keeps the endpoint
      // list constructible without ever reading a real key.
      const placeholder = 'offline-compat-probe';
      models = new OpenAIBackend({
        ...(config.upstream ? { baseURL: config.upstream.baseURL, apiKey: placeholder } : {}),
        connections: config.connections.map(connection => ({ id: connection.id, baseURL: connection.baseURL, apiKey: placeholder })),
        models: config.models,
      }).models;
    } catch (failure) {
      io.err('kimi-work-gateway: invalid config (' + (failure instanceof SyntaxError ? 'not valid JSON' : failure.code || failure.message) + ')');
      return 2;
    }
  }
  const result = (overrides.inspectKimiContract || inspectKimiContract)({
    ...(flags.archive ? { archive: flags.archive } : {}), ...(models ? { models } : {}),
  });
  io.out(summarizeKimiContract({ ...result, scope: flags.config ? 'configured-models' : 'sample-models',
    ...(models ? { modelCount: models.length } : {}) }));
  return COMPAT_EXIT[result.state] ?? 0;
}

async function updateCommand(command, argv, env, io, overrides) {
  if (argv.length) return usageError(io, 'kimi-work-gateway: invalid arguments for ' + command);
  try {
    const { GatewayUpdater, gatewayUpdateDirectory } = await import('./src/update-manager.mjs');
    const updater = new (overrides.GatewayUpdater || GatewayUpdater)({ updateDir: gatewayUpdateDirectory(env) });
    const method = { 'check-update': 'check', update: 'install', 'rollback-update': 'rollback' }[command];
    const result = await updater[method]();
    io.out(JSON.stringify(result));
    return result.state === 'failed' ? 3 : 0;
  } catch (failure) {
    const code = /^update_[a-z0-9_]{1,80}$/.test(failure?.message) ? failure.message : 'update_failed';
    io.err('kimi-work-gateway: ' + command + ' failed (' + code + ')');
    return 3;
  }
}

// setup: 0 saved (whether the service step succeeded is reported, not fatal),
// 2 an unusable argument or existing file, 3 the page or the service failed.
// service: 0 in the desired state, 3 refused or failed.
function serviceFailure(io, action, failure) {
  const code = /^[a-z][a-z0-9_-]{1,80}$/.test(failure?.message) ? failure.message : 'service_failed';
  io.err('kimi-work-gateway: service ' + action + ' failed (' + code + ')');
  return 3;
}

function serviceFromFlags(flags, env, overrides) {
  const Service = overrides.GatewayService || GatewayService;
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  return new Service({ stateDir, env, platform: overrides.platform || process.platform,
    ...(flags.config ? { configPath: path.resolve(flags.config) } : {}),
    ...(flags['panel-port'] ? { panelPort: Number(flags['panel-port']) } : {}),
    ...(flags['kimi-dir'] ? { kimiDir: flags['kimi-dir'] } : {}),
    ...(flags['launcher'] ? { launcherPath: flags['launcher'] } : {}),
    ...(overrides.nodePath ? { nodePath: overrides.nodePath } : {}),
    ...(overrides.serviceRunner ? { runner: overrides.serviceRunner } : {}),
    ...(overrides.home ? { home: overrides.home } : {}),
    ...(overrides.serviceVersion ? { version: overrides.serviceVersion } : {}) });
}

function serviceUsage(io, message) {
  return usageError(io, 'kimi-work-gateway: ' + message);
}

async function serviceCommand(argv, env, io, overrides = {}) {
  const [action, ...rest] = argv;
  const allowed = { install: ['state-dir', 'config', 'panel-port', 'kimi-dir', 'launcher'],
    start: ['state-dir', 'config'], stop: ['state-dir', 'config'], restart: ['state-dir', 'config'],
    status: ['state-dir', 'config'], uninstall: ['state-dir', 'config'] };
  if (!action || !allowed[action]) return serviceUsage(io, 'service needs install, start, stop, restart, status or uninstall');
  // --env selects variables to persist; it is parsed separately because it can
  // repeat and its value must never be mistaken for a flag value.
  const names = [];
  const positional = [];
  for (let at = 0; at < rest.length; at++) {
    if (rest[at] === '--env') {
      if (action !== 'install' || at + 1 >= rest.length) return serviceUsage(io, 'service --env needs a variable name');
      names.push(rest[++at]);
    } else positional.push(rest[at]);
  }
  const flags = parseFlags(positional, allowed[action]);
  if (!flags) return serviceUsage(io, 'invalid arguments for service ' + action);
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  let service;
  try { service = serviceFromFlags({ ...flags, ...(flags['panel-port'] ? {} : {}) }, env, overrides); }
  catch (failure) { return serviceFailure(io, action, failure); }
  const runnerRequest = overrides.requestRunner || requestRunner;
  const runnerState = () => (overrides.inspectRunner || inspectRunner)({ stateDir,
    platform: overrides.platform || process.platform });
  const output = outcome => io.out(JSON.stringify({ ...outcome,
    platform: overrides.platform || process.platform, label: SERVICE_LABEL }));
  try {
    if (action === 'install') {
      const environment = selectEnvironment(env, assertPersistableEnvironment(names));
      output(await service.install({ environment }));
      return 0;
    }
    if (action === 'status') {
      const result = service.status();
      io.out(JSON.stringify({ ...result, runner: runnerState() }));
      return result.state === 'conflict' ? 3 : 0;
    }
    if (['restart', 'stop', 'uninstall'].includes(action)) {
      const runner = runnerState();
      if (runner.runnerAlive || ['running', 'starting'].includes(runner.state)) {
        const outcome = await runnerRequest({ stateDir, action: action === 'uninstall' ? 'stop' : action,
          ...(action === 'uninstall' ? { timeoutMs: 20000 } : {}) });
        if (action !== 'uninstall' || !['stopped', 'absent'].includes(outcome.state)) {
          output({ ...outcome, supervised: true });
          return 0;
        }
        output(await service.uninstall());
        return 0;
      }
      const current = await service.status();
      if (!['stopped', 'not-installed'].includes(current.state)) {
        output({ state: 'waiting', reason: 'runner_unavailable' });
        return 0;
      }
      if (action === 'restart') output(await service.start());
      else if (action === 'stop') output({ state: 'stopped' });
      else output(await service.uninstall());
      return 0;
    }
    output(await service[action]());
    return 0;
  } catch (failure) { return serviceFailure(io, action, failure); }
}

// The runner entry point used by the service definition. It keeps the panel
// child alive and exists so a restart can wait for a quiet moment instead of
// killing a live conversation.
async function serviceRunCommand(argv, env, io, overrides = {}) {
  const separator = argv.indexOf('--');
  if (separator < 0) return usageError(io, 'kimi-work-gateway: service-run needs -- <panel arguments>');
  const flags = parseFlags(argv.slice(0, separator), ['state-dir', 'log', 'runner']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for service-run');
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  const Runner = overrides.ServiceRunner || ServiceRunner;
  const launcher = overrides.serviceLauncher || process.argv[1] || stableLauncher();
  const runner = new Runner({ stateDir, launcherPath: launcher, nodePath: overrides.nodePath || process.execPath,
    argv: argv.slice(separator + 1), env, platform: overrides.platform || process.platform,
    ...(flags.log ? { logFile: flags.log } : {}),
    ...(overrides.runnerSpawn ? { spawnImpl: overrides.runnerSpawn } : {}),
    ...(overrides.runnerFetch ? { fetchImpl: overrides.runnerFetch } : {}),
    ...(overrides.runnerTiming || {}) });
  return runner.run();
}

function stableLauncher() {
  try { return stableLauncherPath({ env: process.env }); } catch { return process.argv[1]; }
}

function openInBrowser(url, { platform = process.platform, run: exec = null } = {}) {
  try {
    if (exec) { exec(url); return true; }
    const [bin, args] = platform === 'darwin' ? ['/usr/bin/open', [url]]
      : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    const child = spawn(bin, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// The page is the only interactive step: it collects the upstream, the key and
// the model declarations once, and the command returns as soon as the save
// succeeds. Nothing secret is echoed; the printed link carries the one-run
// session key and its own filename is the only hint that it exists.
async function setupCommand(argv, env, io, overrides = {}) {
  const noOpen = argv.includes('--no-open');
  const flags = parseFlags(argv.filter(value => value !== '--no-open'), ['state-dir', 'config', 'port'], []);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for setup');
  const stateDir = path.resolve(flags['state-dir'] || defaultStateDirectory());
  const paths = setupPaths({ stateDir, ...(flags.config ? { configPath: flags.config } : {}) });
  const port = flags.port === undefined ? 0 : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return usageError(io, 'kimi-work-gateway: --port must be an integer from 0 to 65535');
  }
  const platform = overrides.platform || process.platform;
  let finish;
  const saved = new Promise(resolve => { finish = resolve; });
  const Server = overrides.SetupServer || SetupServer;
  // The page installs the service right after saving when its checkbox is on.
  // This is the same installer `service install` uses, so both paths produce one
  // definition; on a platform without a service it reports "unavailable".
  const install = overrides.installService ?? (async () => {
    const Service = overrides.GatewayService || GatewayService;
    const service = new Service({ stateDir: paths.stateDir, configPath: paths.config, env,
      platform, ...(overrides.serviceRunner ? { runner: overrides.serviceRunner } : {}) });
    const installed = await service.install({ environment: {} });
    if (installed.state !== 'unchanged') return installed;
    const current = (overrides.inspectRunner || inspectRunner)({ stateDir: paths.stateDir });
    if (current.runnerAlive) {
      const restarted = await (overrides.requestRunner || requestRunner)({ stateDir: paths.stateDir, action: 'restart' });
      return restarted.state === 'restarted' ? { ...installed, state: 'started', needsFreshEntry: true }
        : { state: 'waiting', reason: restarted.reason || 'runner_waiting', needsFreshEntry: true };
    }
    if (typeof service.start !== 'function') return installed;
    const started = await service.start();
    if (started.state !== 'started') return { state: 'waiting', reason: 'runner_unavailable', needsFreshEntry: true };
    return { ...installed, state: 'started', needsFreshEntry: true };
  });
  let server, savedAny = false;
  try {
    server = new Server({ stateDir, configPath: paths.config, platform, installService: install,
      ...(overrides.panelWaitMs === undefined && typeof overrides.SetupServer === 'function'
        ? { panelWaitMs: 0 } : { ...(overrides.panelWaitMs === undefined ? {} : { panelWaitMs: overrides.panelWaitMs }) }),
      logger: (...entry) => { if (overrides.verbose) io.err('setup ' + entry.map(String).join(' ')); },
      onSaved: result => {
        savedAny = true;
        if (['failed', 'waiting'].includes(result.service?.state) || result.panel?.state === 'waiting') return;
        finish(result);
      } });
    const entry = await server.start({ port });
    io.out('setup ' + entry);
    io.out('state ' + paths.stateDir);
    if (noOpen || overrides.openBrowser === false) io.out('open the link above in a browser to finish setup');
    else openInBrowser(entry, { platform, run: overrides.openBrowser });
  } catch (failure) {
    io.err('kimi-work-gateway: cannot start setup (' + (failure?.message || String(failure)) + ')');
    try { await server?.stop(); } catch {}
    return 3;
  }
  const stop = () => finish(null);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let result;
  try { result = await saved; }
  finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { await server.stop(); } catch {}
  }
  if (!result) {
    io.out(savedAny ? 'setup closed; saved configuration kept' : 'setup cancelled; nothing changed');
    return 0;
  }
  io.out('saved ' + result.state.configuration.file);
  io.out('models ' + result.state.models.length + ', port ' + result.gateway.port);
  if (['installed', 'unchanged', 'started'].includes(result.service?.state)) {
    io.out('service ' + result.service.state + '; starts automatically at login');
  } else if (result.service?.state === 'failed') {
    io.out('service failed (' + result.service.reason + ')');
    io.out('next: kimi-work-gateway service install');
  } else {
    io.out('next: kimi-work-gateway service install');
  }
  if (result.panel?.state === 'ready') io.out('panel ' + result.panel.entryURL);
  else if (result.panel?.state === 'waiting') io.out('panel waiting; run: kimi-work-gateway service status');
  else io.out('panel not started; run: kimi-work-gateway panel --config ' + paths.config + ' --credentials ' + paths.credentials);
  return 0;
}

export async function run(argv, env = process.env, io, overrides = {}) {
  const sink = streams(io);
  const [command, ...rest] = argv || [];
  if (!command || command === 'help' || command === '--help' || command === '-h') { sink.out(USAGE); return 0; }
  switch (command) {
    case 'setup': return setupCommand(rest, env, sink, overrides);
    case 'service': return serviceCommand(rest, env, sink, overrides);
    case 'service-run': return serviceRunCommand(rest, env, sink, overrides);
    case 'serve': return serveCommand(rest, env, sink, overrides);
    case 'panel': return serveCommand(rest, env, sink, { ...overrides, panel: true });
    case 'prepare': return nativeCommand('prepare', rest, env, sink, overrides);
    case 'remove-dns': return nativeCommand('remove-dns', rest, env, sink, overrides);
    case 'compat': return compatCommand(rest, env, sink, overrides);
    case 'status': return statusCommand(rest, env, sink, overrides);
    case 'copy-token': return copyTokenCommand(rest, env, sink, overrides);
    case 'subagents-prepare': return subagentCommand('prepare', rest, env, sink, overrides);
    case 'subagents-status': return subagentCommand('status', rest, env, sink, overrides);
    case 'subagents-launch': return subagentCommand('launch', rest, env, sink, overrides);
    case 'check-update':
    case 'update':
    case 'rollback-update': return updateCommand(command, rest, env, sink, overrides);
    default: return usageError(sink, 'kimi-work-gateway: unknown command ' + command);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try { process.exitCode = await run(argv, env); }
  catch (failure) {
    process.stderr.write('kimi-work-gateway: ' + (failure?.message || String(failure)) + '\n');
    process.exitCode = 1;
  }
}

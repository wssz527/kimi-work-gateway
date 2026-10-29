import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './src/config.mjs';
import { BYOK_DNS_PORT, KimiWorkGateway, NativeByokDNS, NativeSetup, OpenAIBackend,
  copySetupToken, defaultKimiDirectory, defaultStateDirectory, nativeFlagFile,
  inspectKimiContract, summarizeKimiContract, SubagentPolicy, SubagentRuntime } from './src/index.mjs';
import { readSubagentJSON } from './src/subagent-policy.mjs';
import { PanelController } from './src/panel-controller.mjs';
import { GatewayPanel } from './src/panel.mjs';
import { TranslationRuntime } from './src/translation-runtime.mjs';

const USAGE = [
  'usage: kimi-work-gateway <command> [options]',
  '',
  'commands:',
  '  serve --config <file|-> [--instructions <file>] [--state-dir <dir>] [--kimi-dir <dir>]',
  '      serve the configured upstream models to Kimi desktop Work',
  '  panel --config <file> [--ui-port <port>] [--instructions <file>] [--state-dir <dir>] [--kimi-dir <dir>]',
  '      serve the gateway with a local web control panel (default port 3427)',
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
const SUBAGENT_INCOMPATIBLE = new Set(['subagent_runtime_incompatible', 'subagent_runtime_already_adapted', 'subagent_launch_unsupported']);

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
  if (policy.mode !== 'force' && policy.mode !== 'blocked') return { mode: 'inherit' };
  if (policy.mode === 'blocked') return { mode: 'blocked', ...(policy.reason ? { reason: String(policy.reason) } : {}) };
  return { mode: 'force', model: policy.model, ...(policy.modelAlias ? { modelAlias: policy.modelAlias } : {}),
    ...(policy.effort === undefined ? {} : { effort: policy.effort }) };
}

function describeSubagentPolicy(summary) {
  if (summary.mode === 'force') {
    return 'force ' + (summary.modelAlias || summary.model) + (summary.effort === undefined ? '' : ' (' + summary.effort + ')');
  }
  if (summary.mode === 'blocked') return 'blocked (' + (summary.reason || 'model unavailable') + ')';
  return 'inherit';
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
    || !['inherit', 'force', 'blocked'].includes(document.mode)) return { state: 'conflict' };
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
  const flags = parseFlags(argv, ['config', 'instructions', 'state-dir', 'kimi-dir', ...(panelEnabled ? ['ui-port'] : [])], ['config']);
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
  const missing = [config.upstream.apiKeyEnv, config.tokenEnv].filter(name => !env[name]);
  if (missing.length) {
    for (const name of missing) io.err('kimi-work-gateway: missing environment variable ' + name);
    return 2;
  }
  let backend, gateway;
  try {
    backend = new OpenAIBackend({ baseURL: config.upstream.baseURL, apiKey: env[config.upstream.apiKeyEnv], models: config.models });
    gateway = new KimiWorkGateway({ backend, instructionsFile: flags.instructions, recordRequests: panelEnabled });
  } catch (failure) {
    io.err('kimi-work-gateway: invalid config (' + failure.message + ')');
    return 2;
  }
  let dns, policy, panel, controller;
  const statusFile = path.join(stateDir, 'status.json');
  const instanceId = crypto.randomUUID();
  const hostsMode = config.dns.enabled && (overrides.platform || process.platform) === 'win32';
  let published = false;
  try {
    let url;
    try { url = await gateway.configure({ key: env[config.tokenEnv], port: config.port }); }
    catch (failure) {
      io.err('kimi-work-gateway: cannot listen on 127.0.0.1:' + config.port + ' (' + failure.message + ')');
      return 3;
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
      const configured = policy.configure(config.subagents, backend.models);
      subagents = summarizeSubagentPolicy(configured);
    } catch (failure) {
      io.err('kimi-work-gateway: cannot apply the subagent policy (' + (failure?.message || String(failure)) + ')');
      return 3;
    }
    if (panelEnabled) {
      try {
        controller = new (overrides.PanelController || PanelController)({
          configFile: flags.config, config, gateway, backend, stateDir, kimiDir, policy, env,
          onPolicy: value => {
            const current = readStateFile(statusFile)?.value;
            if (current?.instanceId !== instanceId) return;
            try { writeStatus(statusFile, { ...current, models: backend.models.length, subagents: summarizeSubagentPolicy(value) }); }
            catch { io.err('kimi-work-gateway: cannot update ' + statusFile); }
          },
        });
        panel = new (overrides.GatewayPanel || GatewayPanel)({ controller });
        await panel.start({ port: uiPort });
      } catch (failure) {
        io.err('kimi-work-gateway: cannot start panel (' + (failure?.message || String(failure)) + ')');
        return 3;
      }
    }
    try {
      writeStatus(statusFile, { pid: process.pid, instanceId, url, models: backend.models.length,
        dns: { enabled: Boolean(dns), port: config.dns.port, ...(hostsMode ? { mode: 'hosts' } : {}) },
        subagents, ...(panel ? { panel: { url: panel.url } } : {}), at: new Date().toISOString() });
      published = true;
    } catch { io.err('kimi-work-gateway: cannot write ' + statusFile); return 3; }
    io.out(url);
    io.out(hostsMode ? 'dns provided by Windows hosts' : dns ? 'dns listening on port ' + config.dns.port : 'dns disabled');
    io.out('subagents ' + describeSubagentPolicy(subagents));
    if (panel) io.out('panel ' + panel.entryURL);
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
    for (const [name, stop] of [['panel', () => panel?.stop()], ['panel controller', () => controller?.close()],
      ['dns', () => dns?.stop()], ['gateway', () => gateway.stop()]]) {
      try { await stop(); } catch { io.err('kimi-work-gateway: cannot stop ' + name); }
    }
    if (published && readStateFile(statusFile)?.value?.instanceId === instanceId) fs.rmSync(statusFile, { force: true });
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
  const runtime = new (overrides.SubagentRuntime || SubagentRuntime)({ stateDir });
  io.out('subagent runtime: ' + runtime.inspect().state);
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
    if (action === 'status') {
      // Read-only: no policy file is created here and the runtime is only inspected.
      const current = readSubagentPolicy(policy.file);
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
      models = new OpenAIBackend({ ...config.upstream, apiKey: 'offline-compat-probe', models: config.models }).models;
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

export async function run(argv, env = process.env, io, overrides = {}) {
  const sink = streams(io);
  const [command, ...rest] = argv || [];
  if (!command || command === 'help' || command === '--help' || command === '-h') { sink.out(USAGE); return 0; }
  switch (command) {
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

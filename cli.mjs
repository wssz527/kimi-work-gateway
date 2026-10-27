import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './src/config.mjs';
import { BYOK_DNS_PORT, KimiWorkGateway, NativeByokDNS, NativeSetup, OpenAIBackend,
  copySetupToken, defaultKimiDirectory, defaultStateDirectory, nativeFlagFile,
  inspectKimiContract, summarizeKimiContract } from './src/index.mjs';

const USAGE = [
  'usage: kimi-work-gateway <command> [options]',
  '',
  'commands:',
  '  serve --config <file|-> [--instructions <file>] [--state-dir <dir>]',
  '      serve the configured upstream models to Kimi desktop Work',
  '  prepare [--state-dir <dir>] [--kimi-dir <dir>] [--dns-port <port>]',
  '      install the dev.msh.team resolver; may ask for administrator rights',
  '  remove-dns [--state-dir <dir>] [--kimi-dir <dir>] [--dns-port <port>]',
  '      remove the dev.msh.team resolver; may ask for administrator rights',
  '  compat [--archive <file>] [--config <file>]',
  '      check configured models, or the built-in sample catalog if no config is given',
  '  status [--state-dir <dir>]',
  '      show the gateway status file and the native setup receipt',
  '  copy-token [--state-dir <dir>] [--token-env <name>]',
  '      copy the gateway token to the clipboard',
  '  help',
  '      show this text',
].join('\n');

// serve: 2 for bad config or missing env, 3 for a listener failure.
// prepare/remove-dns map the setup state: 4 resolver-conflict, 5 cancelled,
// 6 interrupted, 7 failed, 8 unsupported-platform.
// compat: 0 verified or unverifiable, 9 incompatible (models would be dropped).
const SETUP_EXIT = { done: 0, 'resolver-conflict': 4, cancelled: 5, interrupted: 6, failed: 7, 'unsupported-platform': 8 };
const COMPAT_EXIT = { verified: 0, unverified: 0, unavailable: 0, incompatible: 9 };

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

async function serveCommand(argv, env, io, overrides = {}) {
  const flags = parseFlags(argv, ['config', 'instructions', 'state-dir'], ['config']);
  if (!flags) return usageError(io, 'kimi-work-gateway: serve needs --config <file|->');
  const stateDir = flags['state-dir'] || defaultStateDirectory();
  let text;
  if (flags.config === '-') text = await readStdin();
  else {
    try { text = fs.readFileSync(flags.config, 'utf8'); }
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
    gateway = new KimiWorkGateway({ backend, instructionsFile: flags.instructions });
  } catch (failure) {
    io.err('kimi-work-gateway: invalid config (' + failure.message + ')');
    return 2;
  }
  let dns;
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
    try {
      writeStatus(statusFile, { pid: process.pid, instanceId, url, models: backend.models.length,
        dns: { enabled: Boolean(dns), port: config.dns.port, ...(hostsMode ? { mode: 'hosts' } : {}) },
        at: new Date().toISOString() });
      published = true;
    } catch { io.err('kimi-work-gateway: cannot write ' + statusFile); return 3; }
    io.out(url);
    io.out(hostsMode ? 'dns provided by Windows hosts' : dns ? 'dns listening on port ' + config.dns.port : 'dns disabled');
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
    if (dns) await dns.stop();
    await gateway.stop();
    if (published && readStateFile(statusFile)?.value?.instanceId === instanceId) fs.rmSync(statusFile, { force: true });
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

async function statusCommand(argv, env, io) {
  const flags = parseFlags(argv, ['state-dir']);
  if (!flags) return usageError(io, 'kimi-work-gateway: invalid arguments for status');
  const stateDir = flags['state-dir'] || defaultStateDirectory();
  const gateway = readStateFile(path.join(stateDir, 'status.json'));
  if (!gateway) io.out('gateway: absent');
  else if (!gateway.value) io.out('gateway: unreadable (' + gateway.broken + ')');
  else {
    io.out('gateway: pid ' + gateway.value.pid + ' ' + gateway.value.url + ', ' + gateway.value.models + ' models, dns '
      + (gateway.value.dns?.mode === 'hosts' ? 'provided by Windows hosts'
        : gateway.value.dns?.enabled ? 'listening on port ' + gateway.value.dns.port : 'disabled'));
    io.out(gateway.raw);
  }
  const setup = readStateFile(path.join(stateDir, 'native-setup-receipt.json'));
  if (!setup) io.out('native setup: absent');
  else if (!setup.value) io.out('native setup: unreadable (' + setup.broken + ')');
  else {
    io.out('native setup: ' + (setup.value.result?.state || setup.value.state || 'unknown'));
    io.out(setup.raw);
  }
  return 0;
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

export async function run(argv, env = process.env, io, overrides = {}) {
  const sink = streams(io);
  const [command, ...rest] = argv || [];
  if (!command || command === 'help' || command === '--help' || command === '-h') { sink.out(USAGE); return 0; }
  switch (command) {
    case 'serve': return serveCommand(rest, env, sink, overrides);
    case 'prepare': return nativeCommand('prepare', rest, env, sink, overrides);
    case 'remove-dns': return nativeCommand('remove-dns', rest, env, sink, overrides);
    case 'compat': return compatCommand(rest, env, sink, overrides);
    case 'status': return statusCommand(rest, env, sink);
    case 'copy-token': return copyTokenCommand(rest, env, sink, overrides);
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

// Keeps the gateway running in the background of the current user.
//
// The service never points at a release copy: it executes bin/kimi-work-gateway.mjs,
// which re-resolves the active update pointer on every start. Switching a
// release and restarting therefore runs the new version without reinstalling
// anything.
//
// Everything here is a plan plus a thin apply step. The plan is pure so tests
// inspect the exact launchd/scheduled-task definitions without installing
// anything, and every system command goes through an injectable runner so no
// test reaches the real service manager.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { defaultStateDirectory } from './paths.mjs';
import { readCredentials } from './setup.mjs';

// The credentials file stores exactly these two names. A config that names
// other variables cannot be started from it, so install refuses it instead of
// registering a service that would fail on every login.
export const CREDENTIAL_UPSTREAM_ENV = 'KIMI_WORK_UPSTREAM_KEY';
export const CREDENTIAL_TOKEN_ENV = 'KIMI_WORK_GATEWAY_TOKEN';

export const SERVICE_LABEL = 'dev.kimi-work-gateway';
export const SERVICE_SCHEMA_VERSION = 1;
export const SERVICE_FILE = 'service.json';
export const ENTRY_FILE = 'panel-entry.json';
export const LOG_FILE = 'service.log';
export const CONFIG_FILE = 'gateway.json';
export const CREDENTIAL_FILE = 'credentials.json';

// A secret passed as --env would be copied into the launchd plist and into the
// Windows task definition, where file permissions cannot protect it. Secrets
// live only in the credentials file, so their variable names are refused.
const SECRET_ENV = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/;
const RESERVED_SECRET_NAMES = new Set(['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN', 'KIMI_WORK_TRANSLATION_API_KEY']);
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$/;

export function homeDirectory(env = process.env, platform = process.platform) {
  const value = platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME;
  return typeof value === 'string' && value.trim() ? path.resolve(value) : os.homedir();
}

export function servicePaths({ stateDir, home, platform = process.platform } = {}) {
  const resolvedHome = path.resolve(home ?? homeDirectory());
  const directory = path.resolve(stateDir ?? defaultStateDirectory(resolvedHome));
  return {
    home: resolvedHome,
    stateDir: directory,
    config: path.join(directory, CONFIG_FILE),
    credentials: path.join(directory, CREDENTIAL_FILE),
    entry: path.join(directory, ENTRY_FILE),
    service: path.join(directory, SERVICE_FILE),
    log: path.join(directory, LOG_FILE),
    definition: platform === 'darwin'
      ? path.join(resolvedHome, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist')
      : null,
  };
}

// The stable launcher is the npm-installed bin script. When this process runs
// from an update release, KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT still names the base
// package, so an update never rewrites the service to point at itself.
export function stableLauncherPath({ env = {}, moduleRoot } = {}) {
  const root = path.dirname(moduleRoot ?? path.dirname(fileURLToPath(import.meta.url)));
  const candidates = [];
  const bootstrap = env.KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT;
  if (typeof bootstrap === 'string' && path.isAbsolute(bootstrap)) candidates.push(path.join(bootstrap, 'bin', 'kimi-work-gateway.mjs'));
  candidates.push(path.join(root, 'bin', 'kimi-work-gateway.mjs'));
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {}
  }
  throw Error('service_launcher_missing');
}

export function assertPersistableEnvironment(names, secretNames = []) {
  if (!Array.isArray(names)) throw Error('service_environment_invalid');
  for (const name of names) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) throw Error('service_environment_invalid');
    if (SECRET_ENV.test(name) || RESERVED_SECRET_NAMES.has(name) || secretNames.includes(name)) {
      throw Error('service_environment_secret_refused');
    }
  }
  return [...new Set(names)];
}

export function selectEnvironment(env, names) {
  const selected = {};
  for (const name of names) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) throw Error('service_environment_invalid');
    const value = env[name];
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw Error('service_environment_missing');
    }
    selected[name] = value;
  }
  return selected;
}

export function renderLaunchAgent({ label = SERVICE_LABEL, nodePath, programArguments, environment = {},
  workingDirectory, logPath }) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- managed by kimi-work-gateway; remove with: kimi-work-gateway service uninstall -->',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    '  <string>' + escape(label) + '</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...[nodePath, ...programArguments].map(value => '    <string>' + escape(value) + '</string>'),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    '  <string>' + escape(workingDirectory) + '</string>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>StandardOutPath</key>',
    '  <string>' + escape(logPath) + '</string>',
    '  <key>StandardErrorPath</key>',
    '  <string>' + escape(logPath) + '</string>',
  ];
  const names = Object.keys(environment);
  if (names.length) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const name of names) lines.push('    <key>' + escape(name) + '</key>', '    <string>' + escape(environment[name]) + '</string>');
    lines.push('  </dict>');
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

function quoteWindows(value) {
  return '"' + String(value).replaceAll('"', '\\"') + '"';
}

export function scheduledTaskCommandLine(nodePath, programArguments) {
  return [nodePath, ...programArguments].map(quoteWindows).join(' ');
}

// The panel key is never part of argv or a log line: with `--entry-file`, the
// running panel writes its link to a private file that `service status` reads,
// so stdout (which launchd and the scheduled task append to a log) only ever
// carries the plain loopback URL.
//
// `service install` starts the stable runner instead of the panel: the runner
// survives a panel crash, restart and the update pointer switch, and it is the
// only thing that decides when a restart may interrupt a request.
export function serviceProgramArguments({ launcherPath, configPath, stateDir, credentialFile, entryFile,
  panelPort, kimiDir, runnerPath }) {
  const panel = ['panel', '--config', configPath, '--state-dir', stateDir,
    '--credentials', credentialFile, '--entry-file', entryFile, '--ui-port', String(panelPort),
    ...(kimiDir ? ['--kimi-dir', kimiDir] : [])];
  return [launcherPath, 'service-run', '--state-dir', stateDir, '--log', path.join(path.dirname(entryFile), LOG_FILE),
    ...(runnerPath ? ['--runner', runnerPath] : []), '--', ...panel];
}

// Pure plan: the exact definition file, commands and paths a platform uses.
export function planService({ platform = process.platform, paths, nodePath, programArguments,
  environment = {}, label = SERVICE_LABEL, uid = typeof process.getuid === 'function' ? process.getuid() : null }) {
  if (!LABEL_PATTERN.test(label)) throw Error('service_label_invalid');
  if (!paths || !path.isAbsolute(paths.stateDir) || !path.isAbsolute(paths.config)) throw Error('service_paths_invalid');
  if (typeof nodePath !== 'string' || !path.isAbsolute(nodePath)) throw Error('service_node_missing');
  const base = { platform, label, nodePath, argv: [...programArguments], environment: { ...environment },
    stateDir: paths.stateDir, config: paths.config, credentials: paths.credentials, entry: paths.entry,
    log: paths.log, service: paths.service, supported: false, reason: 'service_unsupported_platform' };
  if (platform === 'darwin') {
    if (!Number.isInteger(uid) || uid < 0) throw Error('service_platform_unavailable');
    const target = 'gui/' + uid + '/' + label;
    return {
      ...base, supported: true, kind: 'launchd', target, reason: null,
      definition: { path: paths.definition, content: renderLaunchAgent({ label, nodePath, programArguments, environment,
        workingDirectory: paths.stateDir, logPath: paths.log }), mode: 0o600 },
      commands: {
        load: [{ bin: '/bin/launchctl', args: ['bootstrap', 'gui/' + uid, paths.definition] }],
        unload: [{ bin: '/bin/launchctl', args: ['bootout', target] }],
        start: [{ bin: '/bin/launchctl', args: ['kickstart', target] }],
        restart: [{ bin: '/bin/launchctl', args: ['kickstart', '-k', target] }],
        status: [{ bin: '/bin/launchctl', args: ['print', target] }],
      },
    };
  }
  if (platform === 'win32') {
    const commandLine = scheduledTaskCommandLine(nodePath, programArguments);
    return {
      ...base, supported: true, kind: 'scheduled-task', target: label, reason: null,
      definition: { path: null, content: commandLine, mode: null },
      task: { name: label, commandLine },
      commands: {
        load: [{ bin: 'schtasks', args: ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', label, '/TR', commandLine] }],
        unload: [{ bin: 'schtasks', args: ['/End', '/TN', label] }, { bin: 'schtasks', args: ['/Delete', '/F', '/TN', label] }],
        start: [{ bin: 'schtasks', args: ['/Run', '/TN', label] }],
        restart: [{ bin: 'schtasks', args: ['/End', '/TN', label] }, { bin: 'schtasks', args: ['/Run', '/TN', label] }],
        status: [{ bin: 'schtasks', args: ['/Query', '/TN', label, '/FO', 'CSV', '/NH'] }],
      },
    };
  }
  return base;
}

export function defaultRunner(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return { code: Number.isInteger(result.status) ? result.status : 1,
      stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? result.error?.message ?? '') };
  } catch (error) {
    return { code: 1, stdout: '', stderr: String(error?.message || error) };
  }
}

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const TOLERATED = /already (?:bootstrapped|loaded|running)|service already loaded|Bootstrap failed: 37|not (?:found|loaded|running)|no such (?:file|process|service)|could not find|The system cannot find|ERROR: The process .* not found/i;

function readSmallFile(file, limit = 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('service_file_conflict');
  if (stat.size > limit) throw Error('service_file_conflict');
  return fs.readFileSync(file, 'utf8');
}

function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, content, { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readRecord(file) {
  try { return JSON.parse(readSmallFile(file, 64 * 1024)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function removeEntry(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

function readConfigFile(file) {
  let text;
  try { text = readSmallFile(file, 1024 * 1024); }
  catch (error) { throw Error(error.code === 'ENOENT' ? 'service_config_missing' : 'service_config_conflict'); }
  try { return readConfig(JSON.parse(text)); } catch { throw Error('service_config_conflict'); }
}

// Credentials only reach a background run through this private file. A
// world-readable or foreign file is not a usable credential store.
function readPrivateCredentials(file) {
  let credentials;
  try { credentials = readCredentials(file, { requirePrivate: true }); }
  catch { throw Error('service_credentials_conflict'); }
  return credentials;
}

// The panel entry is a secret: it carries the session key. It is read only
// when it is a regular 0600 file owned by this user, and its key is never
// copied into a log line or a service record.
export function readPanelEntry(file, { uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null;
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return null;
    if (uid !== null && process.platform !== 'win32' && stat.uid !== uid) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schemaVersion !== 1 || typeof value.url !== 'string' || typeof value.entryURL !== 'string') return null;
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.url) || !value.entryURL.startsWith(value.url + '/#key=')) return null;
    if (value.entryURL.length > 4096) return null;
    return { url: value.url, entryURL: value.entryURL, at: value.at, pid: value.pid };
  } catch { return null; }
}

export class GatewayService {
  constructor({ stateDir, configPath, credentialsFile, entryFile, logFile, panelPort = 3427,
    platform = process.platform, home, runner = defaultRunner, launcherPath, nodePath,
    version = '0.0.0', label = SERVICE_LABEL, kimiDir, uid, env = {} } = {}) {
    this.platform = platform;
    this.env = env;
    this.label = label;
    this.uid = uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
    this.home = path.resolve(home ?? homeDirectory(env, platform));
    this.stateDir = path.resolve(stateDir ?? defaultStateDirectory(this.home));
    this.paths = servicePaths({ stateDir: this.stateDir, home: this.home, platform });
    this.configPath = path.resolve(configPath ?? this.paths.config);
    this.credentialsFile = path.resolve(credentialsFile ?? this.paths.credentials);
    this.entryFile = path.resolve(entryFile ?? this.paths.entry);
    this.logFile = path.resolve(logFile ?? this.paths.log);
    this.panelPort = panelPort;
    this.launcherPath = path.resolve(launcherPath ?? stableLauncherPath({ env }));
    this.nodePath = path.resolve(nodePath ?? process.execPath);
    this.version = version;
    this.runner = runner;
    this.kimiDir = kimiDir ? path.resolve(kimiDir) : undefined;
  }

  plan({ environment = {} } = {}) {
    return planService({ platform: this.platform, paths: this.paths, nodePath: this.nodePath,
      programArguments: serviceProgramArguments({ launcherPath: this.launcherPath, configPath: this.configPath,
        stateDir: this.stateDir, credentialFile: this.credentialsFile, entryFile: this.entryFile,
        panelPort: this.panelPort, kimiDir: this.kimiDir }),
      environment, label: this.label, uid: this.uid });
  }

  exec(commands) {
    return (commands || []).map(command => ({ bin: command.bin, args: command.args, ...this.runner(command.bin, command.args) }));
  }

  isLoaded(plan) {
    const probe = (plan.commands.status || [])[0];
    if (!probe) return false;
    const result = this.runner(probe.bin, probe.args);
    if (result.code !== 0) return false;
    if (this.platform === 'darwin') {
      return /^\s*state\s*=\s*(?:running|waiting|spawn scheduled)/m.test(result.stdout) || /\bpid\s*=\s*\d+/m.test(result.stdout);
    }
    return !/"Ready"|"Disabled"/.test(result.stdout) || /"Running"/.test(result.stdout);
  }

  definitionState(plan) {
    if (!plan.definition?.path) return { state: 'none' };
    let current;
    try { current = readSmallFile(plan.definition.path, 256 * 1024); }
    catch (error) { if (error.code === 'ENOENT') return { state: 'absent' }; throw error; }
    if (current === plan.definition.content) return { state: 'same' };
    let record;
    try { record = readRecord(this.paths.service); } catch { record = null; }
    const ours = Boolean(record && record.label === this.label && typeof record.definitionDigest === 'string'
      && record.definitionDigest === digest(current));
    return { state: ours ? 'stale' : 'foreign' };
  }

  // A scheduled task is not a file: ask the task database whether the name is
  // taken, and accept it only when it is this tool's own command line. A query
  // that cannot be answered is treated as "not proven ours" and refused, because
  // `/Create /F` would otherwise delete somebody else's task.
  assertTaskOwnership(plan) {
    const probe = (plan.commands.status || [])[0];
    if (!probe) throw Error('service_platform_unavailable');
    const result = this.runner(probe.bin, probe.args);
    if (result.code !== 0) {
      if (/cannot find|does not exist|no such/i.test(result.stderr + result.stdout)) return { state: 'absent' };
      throw Error('service_task_query_failed');
    }
    const xml = this.runner('schtasks', ['/Query', '/TN', this.label, '/XML']).stdout;
    const matches = xml.includes(plan.definition.content) || result.stdout.includes(plan.definition.content);
    if (!matches) throw Error('service_definition_conflict');
    return { state: 'same' };
  }

  record() {
    return { schemaVersion: SERVICE_SCHEMA_VERSION, label: this.label, platform: this.platform,
      definition: null, definitionDigest: null, launcher: this.launcherPath, node: this.nodePath,
      config: this.configPath, credentials: this.credentialsFile, entry: this.entryFile, log: this.logFile,
      panelPort: this.panelPort, environment: [], version: this.version, installedAt: new Date().toISOString() };
  }

  writeRecord(plan, environment) {
    writeAtomic(this.paths.service, JSON.stringify({ ...this.record(),
      kind: plan.kind, definition: plan.definition?.path ?? null, definitionDigest: digest(plan.definition.content),
      environment: Object.keys(environment) }, null, 2) + '\n');
  }

  // install is idempotent: an identical definition is left alone and a
  // definition this tool did not write is never replaced. The service is only
  // reloaded when something actually changed or it was not running.
  install({ environment = {}, preflight = true } = {}) {
    const plan = this.plan({ environment });
    if (!plan.supported) throw Error('service_unsupported_platform');
    // A service with no usable credentials would start, fail and retry forever.
    // The check happens before any file or service-manager change, so a broken
    // setup leaves the previous state untouched.
    if (preflight) this.preflight();
    // Windows keeps the task in a database, so `/Create /F` would silently
    // overwrite a same-named task the user or another tool owns. Only a task
    // whose command line matches ours may be replaced.
    const definition = plan.definition?.path ? this.definitionState(plan) : this.assertTaskOwnership(plan);
    if (definition.state === 'foreign') throw Error('service_definition_conflict');
    const rewrite = definition.state === 'absent' || definition.state === 'stale';
    const loaded = this.isLoaded(plan);
    if (loaded && rewrite) return { state: 'waiting', reason: 'service_definition_update_pending',
      platform: this.platform, label: this.label };
    if (loaded && !rewrite) {
      this.writeRecord(plan, environment);
      return { state: 'unchanged', platform: this.platform, kind: plan.kind, label: this.label,
        running: true, definition: plan.definition?.path ?? null, config: this.configPath,
        credentials: this.credentialsFile, log: this.logFile };
    }
    if (plan.definition?.path && rewrite) writeAtomic(plan.definition.path, plan.definition.content, plan.definition.mode);
    if (loaded) this.exec(plan.commands.unload);
    const loadedNow = this.exec(plan.commands.load);
    const loadFailed = loadedNow.find(result => result.code !== 0);
    if (loadFailed && !TOLERATED.test(loadFailed.stderr + loadFailed.stdout)) throw Error('service_install_failed');
    const started = this.exec(plan.commands.start);
    const startFailed = started.find(result => result.code !== 0);
    if (startFailed && !TOLERATED.test(startFailed.stderr + startFailed.stdout)) throw Error('service_start_failed');
    this.writeRecord(plan, environment);
    return { state: 'installed', platform: this.platform, kind: plan.kind, label: this.label,
      running: true, definition: plan.definition?.path ?? null, config: this.configPath,
      credentials: this.credentialsFile, log: this.logFile };
  }

  // Confirms the saved setup can start without an interactive shell: a readable
  // config plus a private credential file the background start can use. The
  // credentials file stores exactly the two default variable names, so a config
  // naming other variables cannot be started from it and is refused here rather
  // than failing on every login.
  preflight() {
    const config = readConfigFile(this.configPath);
    if (config.upstream.apiKeyEnv !== CREDENTIAL_UPSTREAM_ENV || config.tokenEnv !== CREDENTIAL_TOKEN_ENV) {
      throw Error('service_credentials_name_mismatch');
    }
    const credentials = readPrivateCredentials(this.credentialsFile);
    if (!credentials?.upstreamApiKey || !credentials?.gatewayToken) throw Error('service_credentials_missing');
    return { models: config.models.length };
  }

  status() {
    let record;
    try { record = readRecord(this.paths.service); }
    catch { return { state: 'conflict', reason: 'service_record_invalid', platform: this.platform, label: this.label }; }
    if (!record) return { state: 'not-installed', platform: this.platform, label: this.label,
      config: this.configPath, credentials: this.credentialsFile, log: this.logFile };
    if (record.schemaVersion !== SERVICE_SCHEMA_VERSION || record.label !== this.label
      || record.launcher !== this.launcherPath || record.config !== this.configPath) {
      return { state: 'conflict', reason: 'service_record_conflict', platform: this.platform, label: this.label };
    }
    const plan = this.plan();
    const probe = (plan.commands.status || [])[0];
    const result = probe ? this.runner(probe.bin, probe.args) : { code: 1, stdout: '', stderr: '' };
    let running = result.code === 0;
    let pid;
    if (running && this.platform === 'darwin') {
      const match = /\bpid\s*=\s*(\d+)/.exec(result.stdout);
      if (!match && /^\s*state\s*=\s*(?:not running|exited)/m.test(result.stdout)) running = false;
      else if (match) pid = Number(match[1]);
    }
    const entry = running ? readPanelEntry(this.entryFile, { uid: this.uid }) : null;
    return { state: running ? 'running' : 'stopped', platform: this.platform, kind: record.kind,
      label: this.label, ...(pid ? { pid } : {}), launcher: record.launcher, config: record.config,
      credentials: record.credentials, log: record.log,
      ...(entry ? { panel: { url: entry.url, entryURL: entry.entryURL } } : {}) };
  }

  // `start` is idempotent: an already loaded agent is left alone. Kickstarting
  // a live gateway would kill in-flight inference, and the service is already
  // in the requested state. After a `stop` the agent is not loaded, so the
  // definition has to be bootstrapped again; kickstart alone cannot do that.
  start() {
    const record = readRecord(this.paths.service);
    if (!record) throw Error('service_not_installed');
    const plan = this.plan();
    // A loaded agent is left alone, unless the supervised runner recorded that
    // it exited: launchd then still holds the job, but nothing serves the panel.
    // Reloading in that case is the only way to bring it back.
    if (this.isLoaded(plan) && !this.runnerExited()) {
      return { state: 'running', platform: this.platform, label: this.label };
    }
    const boot = this.exec(plan.commands.load);
    const loadFailed = boot.find(result => result.code !== 0);
    if (loadFailed && !TOLERATED.test(loadFailed.stderr + loadFailed.stdout)) throw Error('service_start_failed');
    const results = this.exec(plan.commands.start);
    const failed = results.find(result => result.code !== 0);
    if (failed && !TOLERATED.test(failed.stderr + failed.stdout)) throw Error('service_start_failed');
    return { state: 'started', platform: this.platform, label: this.label };
  }

  // The runner writes `stopped` just before it exits. That record is the proof
  // that a loaded job has no live process behind it.
  runnerExited() {
    let state;
    try { state = readRecord(path.join(this.stateDir, 'service-runner.json')); }
    catch { return false; }
    return state?.state === 'stopped';
  }

  // stop keeps the definition and the record so `start` can bring it back.
  stop() {
    if (!readRecord(this.paths.service)) throw Error('service_not_installed');
    const plan = this.plan();
    const results = this.exec(plan.commands.unload);
    const failed = results.find(result => result.code !== 0);
    if (failed && !TOLERATED.test(failed.stderr + failed.stdout)) throw Error('service_stop_failed');
    removeEntry(this.entryFile);
    return { state: 'stopped', platform: this.platform, label: this.label };
  }

  restart() {
    if (!readRecord(this.paths.service)) throw Error('service_not_installed');
    if (this.status().state !== 'stopped') return { state: 'waiting',
      reason: 'supervised_restart_required', platform: this.platform, label: this.label };
    return this.start();
  }

  // Uninstall removes only files this tool wrote and still recognizes: the
  // recorded definition, the service record and the panel entry. Config,
  // credentials and the log belong to the user and are kept.
  uninstall() {
    let record;
    try { record = readRecord(this.paths.service); }
    catch { throw Error('service_record_invalid'); }
    if (!record) return { state: 'absent', platform: this.platform, label: this.label };
    if (record.schemaVersion !== SERVICE_SCHEMA_VERSION || record.label !== this.label) throw Error('service_record_conflict');
    const plan = this.plan();
    // The definition check only applies where the OS keeps a definition file
    // (launchd). A scheduled task lives in the task database, so its existence
    // and ownership are checked through the task query itself.
    const definition = plan.definition?.path ? this.definitionState(plan) : { state: 'task' };
    if (definition.state === 'foreign') throw Error('service_definition_changed');
    const results = this.exec(plan.commands.unload);
    const failed = results.find(result => result.code !== 0);
    if (failed && !TOLERATED.test(failed.stderr + failed.stdout)) throw Error('service_uninstall_failed');
    if (plan.definition?.path && (definition.state === 'same' || definition.state === 'stale')) {
      fs.rmSync(plan.definition.path, { force: true });
    }
    fs.rmSync(this.paths.service, { force: true });
    removeEntry(this.entryFile);
    return { state: 'removed', platform: this.platform, label: this.label,
      kept: [this.configPath, this.credentialsFile, this.logFile] };
  }
}

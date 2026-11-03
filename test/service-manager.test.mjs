import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../cli.mjs';
import { saveSetup, setupPaths, normalizeSetupInput } from '../src/setup.mjs';
import { GatewayService, SERVICE_LABEL, assertPersistableEnvironment, planService, readPanelEntry,
  renderLaunchAgent, scheduledTaskCommandLine, selectEnvironment, servicePaths, stableLauncherPath } from '../src/service-manager.mjs';

const KEY = '{{SECRET_jpfbmwdv}}';
// The uid that owns files this test creates. Tests that assert on file
// ownership must use it instead of a literal that only holds on one machine.
const CURRENT_UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const MODELS = [{ id: 'deepseek-v4-1-flash', protocol: 'responses', contextWindow: 131072, tools: true }];
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

// The service manager is only ever driven with a fake command runner and an
// isolated HOME: no test may create a real LaunchAgent or scheduled task.
function fakeRunner() {
  const calls = [];
  const state = { loaded: false, statusOutput: '', statusCode: 1, failInstall: null,
    // Windows task database: the XML of a same-named task, when one exists.
    taskXml: null, failQuery: null };
  const runner = (bin, args) => {
    calls.push({ bin, args: [...args] });
    const joined = args.join(' ');
    if (/^bootstrap /.test(joined)) {
      if (state.failInstall) return { code: 1, stdout: '', stderr: state.failInstall };
      state.loaded = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (/^(bootout|bootstr)/.test(joined) && /^bootout/.test(joined)) { state.loaded = false; return { code: 0, stdout: '', stderr: '' }; }
    if (/^kickstart/.test(joined)) {
      state.loaded = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (/^print /.test(joined)) {
      return state.loaded
        ? { code: 0, stdout: 'gui/501/' + SERVICE_LABEL + ' = {\n\tstate = running\n\tpid = 4242\n}\n', stderr: '' }
        : { code: 113, stdout: '', stderr: 'Could not find service' };
    }
    if (/^\/Create/.test(joined)) {
      state.loaded = true;
      state.taskXml = '<Task><Actions><Exec><Command>' + args[args.length - 1] + '</Command></Exec></Actions></Task>';
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (/^\/Run/.test(joined)) { state.loaded = true; return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    if (/^\/(End|Delete)/.test(joined)) {
      if (/^\/Delete/.test(joined)) state.taskXml = null;
      state.loaded = false;
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (/^\/Query/.test(joined)) {
      if (state.failQuery) return { code: 1, stdout: '', stderr: state.failQuery };
      if (args.includes('/XML')) {
        return state.taskXml
          ? { code: 0, stdout: state.taskXml, stderr: '' }
          : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
      }
      return state.loaded || state.taskXml
        ? { code: 0, stdout: args.includes('/FO') ? '"Running"\r\n' : 'TaskName  Status\r\n' + SERVICE_LABEL + '  Running\r\n', stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected command' };
  };
  return { runner, calls, state };
}

function workspace(options = {}) {
  const home = fs.mkdtempSync(path.join(tmpdir(), 'kwg-service-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const stateDir = path.join(home, '.config', 'kimi-work-gateway');
  const fake = fakeRunner();
  const service = new GatewayService({ home, stateDir, platform: options.platform ?? 'darwin', runner: fake.runner,
    nodePath: '/usr/local/bin/node', launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
    uid: 501, version: '0.7.2', ...options });
  // install() refuses to register a service that could not start, so every
  // workspace begins with a real saved setup unless a test opts out.
  const paths = setupPaths({ stateDir });
  if (options.seed !== false) {
    const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
    saveSetup({ paths, config, apiKey: KEY });
  }
  return { home, stateDir, service, paths, ...fake };
}

test('the macOS plan runs the stable launcher, not a release copy', () => {
  const w = workspace();
  const plan = w.service.plan();
  expect(plan.supported).toBe(true);
  expect(plan.kind).toBe('launchd');
  expect(plan.target).toBe('gui/501/' + SERVICE_LABEL);
  // The service starts the stable launcher, which runs the runner; the runner
  // then owns the panel. The panel key is never in argv. The fixture's launcher
  // is resolved the way the service resolves it, so the expectation holds on a
  // Windows drive-qualified path too.
  expect(plan.argv).toEqual([path.resolve('/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs'), 'service-run',
    '--state-dir', w.stateDir, '--log', path.join(w.stateDir, 'service.log'), '--',
    'panel', '--config', path.join(w.stateDir, 'gateway.json'), '--state-dir', w.stateDir,
    '--credentials', path.join(w.stateDir, 'credentials.json'),
    '--entry-file', path.join(w.stateDir, 'panel-entry.json'),
    '--ui-port', '3427']);
  const plist = plan.definition.content;
  expect(plist).toContain('<key>Label</key>');
  expect(plist).toContain('<string>' + SERVICE_LABEL + '</string>');
  expect(plist).toContain('<key>RunAtLoad</key>');
  expect(plist).toContain('<key>KeepAlive</key>');
  expect(plist).toContain('<key>SuccessfulExit</key>');
  expect(plist).toContain('<false/>');
  // Both streams go to the log, and the panel key is not part of argv.
  expect(plist).toContain(path.join(w.stateDir, 'service.log'));
  expect(plist).not.toContain('#key=');
  expect(plan.definition.path).toBe(path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'));
  expect(plan.commands.load[0]).toEqual({ bin: '/bin/launchctl', args: ['bootstrap', 'gui/501', plan.definition.path] });
  expect(plan.commands.start[0].args).toEqual(['kickstart', 'gui/501/' + SERVICE_LABEL]);
  expect(plan.commands.restart[0].args).toEqual(['kickstart', '-k', 'gui/501/' + SERVICE_LABEL]);
  expect(plan.commands.unload[0].args).toEqual(['bootout', 'gui/501/' + SERVICE_LABEL]);
}, 20000);

test('the Windows plan registers a logon task for the current user without elevation', () => {
  const w = workspace({ platform: 'win32' });
  const plan = w.service.plan();
  expect(plan.supported).toBe(true);
  expect(plan.kind).toBe('scheduled-task');
  expect(plan.definition.path).toBeNull();
  expect(plan.task.commandLine).toBe(scheduledTaskCommandLine(path.resolve('/usr/local/bin/node'), plan.argv));
  const create = plan.commands.load[0];
  expect(create.bin).toBe('schtasks');
  expect(create.args.slice(0, 7)).toEqual(['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN']);
  expect(create.args[7]).toBe(SERVICE_LABEL);
  // Quotes protect the profile path and the arguments; no secret is present.
  expect(create.args[9]).toContain('"' + plan.argv[0] + '"');
  expect(create.args[9]).not.toContain('#key=');
  expect(plan.commands.unload.map(command => command.args[0])).toEqual(['/End', '/Delete']);
  expect(plan.commands.status[0].args).toEqual(['/Query', '/TN', SERVICE_LABEL, '/FO', 'CSV', '/NH']);
}, 20000);

test('an unsupported platform yields an explicit, unusable plan', () => {
  const w = workspace({ platform: 'linux' });
  const plan = w.service.plan();
  expect(plan.supported).toBe(false);
  expect(plan.reason).toBe('service_unsupported_platform');
  expect(() => w.service.install()).toThrow('service_unsupported_platform');
  expect(w.calls).toEqual([]);
});

test('install is idempotent and only reloads when something changed', () => {
  const w = workspace();
  const first = w.service.install({ environment: { KIMI_WORK_GATEWAY_UPDATE_DIR: '/tmp/updates' } });
  expect(first.state).toBe('installed');
  expect(fs.existsSync(path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'))).toBe(true);
  const plist = fs.readFileSync(path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'), 'utf8');
  expect(plist).toContain('<key>KIMI_WORK_GATEWAY_UPDATE_DIR</key>');
  expect(plist).toContain('/tmp/updates');
  const loads = w.calls.filter(call => call.args[0] === 'bootstrap').length;

  const second = w.service.install({ environment: { KIMI_WORK_GATEWAY_UPDATE_DIR: '/tmp/updates' } });
  expect(second.state).toBe('unchanged');
  expect(w.calls.filter(call => call.args[0] === 'bootstrap').length).toBe(loads);
  expect(w.service.status().state).toBe('running');
}, 20000);

test('a definition this tool did not write is never replaced or deleted', () => {
  const w = workspace();
  const file = path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<plist>someone else</plist>');
  expect(() => w.service.install()).toThrow('service_definition_conflict');
  expect(fs.readFileSync(file, 'utf8')).toBe('<plist>someone else</plist>');

  // A record claiming ownership of that file does not help either.
  w.service.install;
  const service = new GatewayService({ home: w.home, stateDir: w.stateDir, platform: 'darwin', runner: w.runner,
    nodePath: '/usr/local/bin/node', launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs', uid: 501 });
  fs.mkdirSync(w.stateDir, { recursive: true });
  fs.writeFileSync(path.join(w.stateDir, 'service.json'), JSON.stringify({ schemaVersion: 1, label: SERVICE_LABEL,
    definitionDigest: 'a'.repeat(64), launcher: service.launcherPath, config: service.configPath }));
  expect(() => service.uninstall()).toThrow('service_definition_changed');
  expect(fs.existsSync(file)).toBe(true);
}, 20000);

test('uninstall removes only its own files and keeps config, credentials and the log', () => {
  const w = workspace();
  w.service.install();
  const paths = setupPaths({ stateDir: w.stateDir });
  const { config } = normalizeSetupInput({ baseURL: 'https://api.example.com/v1', apiKey: KEY, models: MODELS });
  saveSetup({ paths, config, apiKey: KEY });
  fs.writeFileSync(paths.stateDir + '/service.log', 'log line\n');
  fs.writeFileSync(w.service.entryFile, JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:1',
    entryURL: 'http://127.0.0.1:1/#key=x' }), { mode: 0o600 });

  const result = w.service.uninstall();
  expect(result.state).toBe('removed');
  expect(fs.existsSync(path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'))).toBe(false);
  expect(fs.existsSync(path.join(w.stateDir, 'service.json'))).toBe(false);
  expect(fs.existsSync(w.service.entryFile)).toBe(false);
  expect(fs.existsSync(paths.config)).toBe(true);
  expect(fs.existsSync(paths.credentials)).toBe(true);
  expect(fs.existsSync(path.join(w.stateDir, 'service.log'))).toBe(true);
  expect(w.service.status().state).toBe('not-installed');
  // Uninstalling again is a no-op, not an error.
  expect(w.service.uninstall().state).toBe('absent');
}, 20000);

test('status reports the panel link only from a private entry file', () => {
  // The entry file belongs to whoever wrote it, so the service has to run as
  // this process's own uid; a hard-coded 501 only ever holds on one machine.
  const w = workspace({ uid: CURRENT_UID });
  w.service.install();
  const entryFile = w.service.entryFile;
  fs.writeFileSync(entryFile, JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:3427',
    entryURL: 'http://127.0.0.1:3427/#key=' + 'd'.repeat(64), pid: 4242 }), { mode: 0o600 });
  const status = w.service.status();
  expect(status.state).toBe('running');
  expect(status.pid).toBe(4242);
  expect(status.panel).toEqual({ url: 'http://127.0.0.1:3427', entryURL: 'http://127.0.0.1:3427/#key=' + 'd'.repeat(64) });

  if (process.platform !== 'win32') {
    // A world-readable or symlinked entry is ignored rather than followed.
    fs.chmodSync(entryFile, 0o644);
    expect(w.service.status().panel).toBeUndefined();
    fs.chmodSync(entryFile, 0o600);
    expect(readPanelEntry(entryFile)).toBeTruthy();
    // Private is not enough by itself: an entry owned by another user is
    // refused, and that owner check stays in place.
    expect(readPanelEntry(entryFile, { uid: CURRENT_UID + 1 })).toBeNull();
    expect(readPanelEntry(entryFile, { uid: CURRENT_UID })).toBeTruthy();
  }
  fs.rmSync(entryFile);
  expect(w.service.status().panel).toBeUndefined();
  expect(w.service.status().state).toBe('running');
}, 20000);

test('the stored environment is an explicit allow list, never the whole process', () => {
  const env = { KIMI_WORK_GATEWAY_UPDATE_DIR: '/tmp/updates', AWS_SECRET_ACCESS_KEY: 'leak',
    KIMI_WORK_UPSTREAM_KEY: 'sk-leak', KIMI_WORK_GATEWAY_TOKEN: 'e'.repeat(64), HTTP_PROXY: 'http://proxy' };
  expect(selectEnvironment(env, ['KIMI_WORK_GATEWAY_UPDATE_DIR'])).toEqual({ KIMI_WORK_GATEWAY_UPDATE_DIR: '/tmp/updates' });
  expect(() => selectEnvironment(env, ['MISSING'])).toThrow('service_environment_missing');
  expect(() => selectEnvironment(env, ['lower-case'])).toThrow('service_environment_invalid');
  // Credentials belong in the credentials file, not in a plist or a task.
  for (const name of ['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN', 'AWS_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY', 'DB_PASSWORD', 'X_CREDENTIAL']) {
    expect(() => assertPersistableEnvironment([name])).toThrow('service_environment_secret_refused');
  }
  expect(assertPersistableEnvironment(['KIMI_WORK_GATEWAY_UPDATE_DIR', 'HTTPS_PROXY']))
    .toEqual(['KIMI_WORK_GATEWAY_UPDATE_DIR', 'HTTPS_PROXY']);
  expect(assertPersistableEnvironment(['A', 'A']).length).toBe(1);
}, 20000);

test('a plist escapes XML and records only the allow-listed variables', () => {
  const plist = renderLaunchAgent({ nodePath: '/usr/local/bin/node', programArguments: ['/a & b/cli.mjs', '--x', '<y>'],
    environment: { HTTPS_PROXY: 'http://p?a=1&b=2' }, workingDirectory: '/tmp/state <x>', logPath: '/tmp/log&x' });
  expect(plist).toContain('/a &amp; b/cli.mjs');
  expect(plist).toContain('&lt;y&gt;');
  expect(plist).toContain('http://p?a=1&amp;b=2');
  expect(plist).toContain('/tmp/state &lt;x&gt;');
  expect(plist).toContain('/tmp/log&amp;x');
  expect((plist.match(/<key>HTTPS_PROXY<\/key>/g) || []).length).toBe(1);
});

test('stableLauncherPath prefers the npm-installed base over a running release', () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'kwg-launcher-'));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
  const launcher = path.join(base, 'bin', 'kimi-work-gateway.mjs');
  fs.writeFileSync(launcher, '#!/usr/bin/env node\n');
  expect(stableLauncherPath({ env: { KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT: base },
    moduleRoot: path.join(base, 'src') })).toBe(launcher);
  // A relative or missing bootstrap root falls back to this package.
  expect(() => stableLauncherPath({ env: { KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT: 'relative' },
    moduleRoot: path.join(base, 'src') })).not.toThrow();
  expect(() => stableLauncherPath({ env: {}, moduleRoot: path.join(base, 'src', 'nested') })).toThrow('service_launcher_missing');
}, 20000);

test('planService rejects an unvalidated label and a relative launcher', () => {
  const paths = servicePaths({ stateDir: path.join(tmpdir(), 'kwg-plan-state'), home: tmpdir(), platform: 'darwin' });
  expect(() => planService({ platform: 'darwin', paths, nodePath: '/usr/local/bin/node',
    programArguments: ['x'], label: 'bad label with spaces', uid: 501 })).toThrow('service_label_invalid');
  expect(() => planService({ platform: 'darwin', paths, nodePath: 'node', programArguments: ['x'], uid: 501 }))
    .toThrow('service_node_missing');
  expect(() => planService({ platform: 'darwin', paths: { ...paths, stateDir: 'relative' },
    nodePath: '/usr/local/bin/node', programArguments: ['x'], uid: 501 })).toThrow('service_paths_invalid');
});

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
}

// The CLI builds its own GatewayService from flags, so the tests subclass it to
// pin the launcher, runner, HOME and platform the commands would otherwise
// read from the real machine.
function serviceOverride(w, extra = {}) {
  return {
    platform: w.service.platform, home: w.home, nodePath: '/usr/local/bin/node',
    serviceRunner: w.runner,
    GatewayService: class extends GatewayService {
      constructor(options) {
        super({ ...options, platform: w.service.platform, home: w.home, runner: w.runner,
          nodePath: '/usr/local/bin/node', uid: 501, launcherPath: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
          ...extra });
      }
    },
  };
}

test('service status and uninstall work through the CLI with an isolated HOME', async () => {
  const w = workspace();
  w.service.install();
  const state = capture();
  expect(await run(['service', 'status', '--state-dir', w.stateDir], {}, state, serviceOverride(w))).toBe(0);
  const parsed = JSON.parse(state.lines.out.at(-1));
  expect(parsed.state).toBe('running');
  expect(parsed.label).toBe(SERVICE_LABEL);
  expect(parsed.pid).toBe(4242);

  w.service.stop();
  const removed = capture();
  expect(await run(['service', 'uninstall', '--state-dir', w.stateDir], {}, removed, {
    ...serviceOverride(w), inspectRunner: () => ({ state: 'stopped' }),
  })).toBe(0);
  expect(JSON.parse(removed.lines.out.at(-1)).state).toBe('removed');
}, 20000);

test('service install through the CLI persists only the named variables', async () => {
  const w = workspace();
  const io = capture();
  const code = await run(['service', 'install', '--state-dir', w.stateDir, '--env', 'HTTPS_PROXY'],
    { HTTPS_PROXY: 'http://proxy:8080', KIMI_WORK_UPSTREAM_KEY: KEY }, io, serviceOverride(w));
  expect(code).toBe(0);
  const result = JSON.parse(io.lines.out.at(-1));
  expect(result.state).toBe('installed');
  const plist = fs.readFileSync(path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'), 'utf8');
  expect(plist).toContain('http://proxy:8080');
  expect(plist).not.toContain(KEY);
  expect(io.lines.out.join('\n')).not.toContain(KEY);
}, 20000);

test('service rejects unknown actions, bad flags and secret environment names', async () => {
  const w = workspace();
  for (const args of [['service'], ['service', 'frobnicate'], ['service', 'install', '--wat', '1'],
    ['service', 'status', '--panel-port', '1'], ['service', 'start', '--env', 'X']]) {
    const io = capture();
    expect(await run(args, {}, io, serviceOverride(w))).toBe(1);
    expect(io.lines.err.join('\n')).toContain('usage:');
  }
  const refused = capture();
  const code = await run(['service', 'install', '--state-dir', w.stateDir, '--env', 'KIMI_WORK_UPSTREAM_KEY'],
    { KIMI_WORK_UPSTREAM_KEY: KEY }, refused, serviceOverride(w));
  expect(code).toBe(3);
  expect(refused.lines.err.join('\n')).toContain('service_environment_secret_refused');
  expect(refused.lines.out.join('\n')).not.toContain(KEY);
  expect(w.calls).toEqual([]);
}, 20000);

test('service install never writes a secret into the definition or the record', async () => {
  const w = workspace();
  w.service.install({ environment: { HTTPS_PROXY: 'http://proxy:8080' } });
  const files = [path.join(w.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'),
    path.join(w.stateDir, 'service.json')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(text).not.toContain('#key=');
    expect(text).not.toContain(KEY);
  }
  const record = JSON.parse(fs.readFileSync(files[1], 'utf8'));
  expect(record.environment).toEqual(['HTTPS_PROXY']);
  // The record stores the launcher the service actually resolved; a POSIX
  // literal would only hold on a machine that resolves paths that way.
  expect(record.launcher).toBe(w.service.launcherPath);
  // The only 64-hex value in the record is the definition digest.
  expect(record.definitionDigest).toMatch(/^[a-f0-9]{64}$/);
  const hexes = (fs.readFileSync(files[1], 'utf8').match(/[a-f0-9]{64}/g) || []);
  expect(hexes).toEqual([record.definitionDigest]);
}, 20000);

test('the installer refuses to register a service that could not start', () => {
  // Nothing saved at all.
  const empty = workspace({ seed: false });
  expect(() => empty.service.install()).toThrow('service_config_missing');
  expect(empty.calls).toEqual([]);
  expect(fs.existsSync(path.join(empty.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'))).toBe(false);

  // Config without a credential file: the service would start and fail forever.
  const missing = workspace();
  fs.rmSync(missing.paths.credentials);
  expect(() => missing.service.install()).toThrow('service_credentials_missing');
  expect(missing.calls).toEqual([]);

  // A world-readable credential file is not a usable credential store.
  const exposed = workspace();
  if (process.platform !== 'win32') {
    fs.chmodSync(exposed.paths.credentials, 0o644);
    expect(() => exposed.service.install()).toThrow('service_credentials_conflict');
    expect(exposed.calls).toEqual([]);
    expect(fs.existsSync(path.join(exposed.home, 'Library', 'LaunchAgents', SERVICE_LABEL + '.plist'))).toBe(false);
  }

  // The credentials are read by the variable names the config declares.
  const custom = workspace();
  fs.writeFileSync(custom.paths.config, JSON.stringify({ upstream: { baseURL: 'https://api.example.com/v1',
    apiKeyEnv: 'MY_UPSTREAM_KEY' }, tokenEnv: 'MY_TOKEN',
    models: MODELS }), { mode: 0o600 });
  expect(() => custom.service.install()).toThrow('service_credentials_name_mismatch');
  expect(custom.calls).toEqual([]);
}, 20000);

test('the installer propagates a real command failure instead of claiming success', () => {
  const w = workspace();
  w.state.failInstall = 'Bootstrap failed: 5: Input/output error';
  expect(() => w.service.install()).toThrow('service_install_failed');
  expect(fs.existsSync(path.join(w.stateDir, 'service.json'))).toBe(false);
}, 20000);

test('start, stop and restart follow the loaded state', () => {
  const w = workspace();
  expect(() => w.service.start()).toThrow('service_not_installed');
  expect(() => w.service.stop()).toThrow('service_not_installed');
  w.service.install();
  expect(w.service.status().state).toBe('running');
  expect(w.service.stop().state).toBe('stopped');
  expect(w.service.status().state).toBe('stopped');
  expect(w.service.start().state).toBe('started');
  expect(w.service.restart()).toMatchObject({ state: 'waiting', reason: 'supervised_restart_required' });
  expect(w.calls.some(call => call.args[0] === 'kickstart' && call.args.includes('-k'))).toBe(false);
}, 20000);

test('start on a running service is a no-op and never kickstarts a live gateway', () => {
  const w = workspace();
  w.service.install();
  const before = w.calls.length;
  expect(w.service.start()).toEqual({ state: 'running', platform: 'darwin', label: SERVICE_LABEL });
  // Only the read-only state probe runs. An already loaded agent must not be
  // kicked, because that would kill the responses Work is streaming right now.
  const after = w.calls.slice(before);
  expect(after.map(call => call.args[0])).toEqual(['print']);
  expect(after.some(call => call.args[0] === 'kickstart')).toBe(false);
}, 20000);

test('start after stop bootstraps again instead of only kickstarting an unloaded agent', () => {
  const w = workspace();
  w.service.install();
  w.service.stop();
  const before = w.calls.length;
  expect(w.service.start().state).toBe('started');
  const after = w.calls.slice(before).map(call => call.args[0]);
  // bootout removed the agent, so kickstart alone would fail with ENOENT.
  expect(after).toEqual(['print', 'bootstrap', 'kickstart']);
  expect(w.calls.filter(call => call.args[0] === 'bootstrap').length).toBe(2);
}, 20000);

test('uninstall on Windows ends and deletes the scheduled task even without a definition file', () => {
  const w = workspace({ platform: 'win32' });
  w.service.install();
  expect(w.state.taskXml).toBeTruthy();
  const state = w.service.plan();
  expect(state.definition.path).toBeNull();
  const result = w.service.uninstall();
  expect(result.state).toBe('removed');
  const args = w.calls.map(call => call.args[0]);
  expect(args).toContain('/End');
  expect(args).toContain('/Delete');
  expect(w.state.taskXml).toBeNull();
  expect(fs.existsSync(path.join(w.stateDir, 'service.json'))).toBe(false);
}, 20000);

test('install refuses to replace a same-named scheduled task it does not own', () => {
  const w = workspace({ platform: 'win32' });
  w.state.taskXml = '<Task><Actions><Exec><Command>"C:\\Other\\tool.exe" run</Command></Exec></Actions></Task>';
  expect(() => w.service.install()).toThrow('service_definition_conflict');
  // Not a single /Create was issued, so the foreign task still exists.
  expect(w.calls.some(call => call.args[0] === '/Create')).toBe(false);
  expect(w.state.taskXml).toContain('Other');
}, 20000);

test('reinstall leaves its running scheduled task untouched', () => {
  const w = workspace({ platform: 'win32' });
  w.service.install();
  const before = w.calls.length;
  expect(w.state.taskXml).toContain('kimi-work-gateway.mjs');
  expect(w.service.install().state).toBe('unchanged');
  expect(w.calls.slice(before).every(call => call.args[0] === '/Query')).toBe(true);
  expect(w.calls.filter(call => call.args[0] === '/Create')).toHaveLength(1);
}, 20000);

test('a task query that cannot be answered is a refusal, not a silent overwrite', () => {
  const w = workspace({ platform: 'win32' });
  w.state.failQuery = 'ERROR: Access is denied.';
  expect(() => w.service.install()).toThrow('service_task_query_failed');
  expect(w.calls.some(call => call.args[0] === '/Create')).toBe(false);
}, 20000);

test('service restart asks a running runner to drain instead of kickstarting it', async () => {
  const w = workspace();
  w.service.install();
  const requests = [];
  const io = capture();
  const code = await run(['service', 'restart', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w),
    inspectRunner: () => ({ state: 'running', pid: 111, child: 222 }),
    requestRunner: async ({ action }) => { requests.push(action); return { id: 'a'.repeat(32), action, state: 'restarted' }; },
  });
  expect(code).toBe(0);
  expect(requests).toEqual(['restart']);
  const result = JSON.parse(io.lines.out.at(-1));
  expect(result).toMatchObject({ state: 'restarted', supervised: true });
  // The platform-level restart was never issued: it would kill live requests.
  expect(w.calls.some(call => call.args.includes('-k'))).toBe(false);
}, 20000);

test('a drain that timed out is reported as waiting and leaves the panel alive', async () => {
  const w = workspace();
  w.service.install();
  const io = capture();
  const code = await run(['service', 'restart', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w),
    inspectRunner: () => ({ state: 'running' }),
    requestRunner: async ({ action }) => ({ id: 'b'.repeat(32), action, state: 'waiting', reason: 'panel_busy' }),
  });
  expect(code).toBe(0);
  expect(JSON.parse(io.lines.out.at(-1))).toMatchObject({ state: 'waiting', reason: 'panel_busy', supervised: true });
}, 20000);

test('service status reports the runner view next to the platform state', async () => {
  const w = workspace();
  w.service.install();
  const io = capture();
  expect(await run(['service', 'status', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w),
    inspectRunner: () => ({ state: 'running', pid: 111, child: 222, childAlive: true, restarts: 1 }),
  })).toBe(0);
  const result = JSON.parse(io.lines.out.at(-1));
  expect(result.state).toBe('running');
  expect(result.runner).toMatchObject({ state: 'running', child: 222, restarts: 1 });
}, 20000);

test('service uninstall stops a running runner before removing the definition', async () => {
  const w = workspace();
  w.service.install();
  const order = [];
  const io = capture();
  expect(await run(['service', 'uninstall', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w),
    inspectRunner: () => ({ state: 'running' }),
    requestRunner: async ({ action }) => { order.push('runner:' + action); return { id: 'c'.repeat(32), action, state: 'stopped' }; },
  })).toBe(0);
  expect(order).toEqual(['runner:stop']);
  expect(JSON.parse(io.lines.out.at(-1)).state).toBe('removed');
}, 20000);

test('uninstall preserves the service while its runner is busy', async () => {
  const w = workspace();
  w.service.install();
  const before = w.calls.length;
  const io = capture();
  expect(await run(['service', 'uninstall', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w), inspectRunner: () => ({ state: 'running' }),
    requestRunner: async () => ({ state: 'waiting', reason: 'work_busy' }),
  })).toBe(0);
  expect(JSON.parse(io.lines.out.at(-1))).toMatchObject({ state: 'waiting', reason: 'work_busy' });
  expect(w.calls.slice(before)).toEqual([]);
  expect(fs.existsSync(path.join(w.stateDir, 'service.json'))).toBe(true);
});

for (const action of ['restart', 'stop', 'uninstall']) test(action + ' refuses a running service without a reachable runner', async () => {
  const w = workspace();
  w.service.install();
  const before = w.calls.length;
  const io = capture();
  expect(await run(['service', action, '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w), inspectRunner: () => ({ state: 'invalid' }),
    requestRunner: async () => { throw Error('must_not_request'); },
  })).toBe(0);
  expect(JSON.parse(io.lines.out.at(-1))).toMatchObject({ state: 'waiting', reason: 'runner_unavailable' });
  expect(w.calls.slice(before).map(call => call.args[0])).toEqual(['print']);
  expect(fs.existsSync(path.join(w.stateDir, 'service.json'))).toBe(true);
});

test('restart starts a confirmed stopped service without force', async () => {
  const w = workspace();
  w.service.install();
  w.service.stop();
  const before = w.calls.length;
  const io = capture();
  expect(await run(['service', 'restart', '--state-dir', w.stateDir], {}, io, {
    ...serviceOverride(w), inspectRunner: () => ({ state: 'stopped' }),
  })).toBe(0);
  expect(JSON.parse(io.lines.out.at(-1)).state).toBe('started');
  expect(w.calls.slice(before).some(call => call.args.includes('-k'))).toBe(false);
});

test('service-run refuses to start without the panel it supervises', async () => {
  const io = capture();
  expect(await run(['service-run', '--state-dir', '/tmp/x'], {}, io, {})).toBe(1);
  expect(io.lines.err.join('\n')).toContain('usage:');
  const bad = capture();
  expect(await run(['service-run', '--wat', '1', '--', 'panel'], {}, bad, {})).toBe(1);
  expect(bad.lines.err.join('\n')).toContain('usage:');
}, 20000);

test('service-run hands the panel arguments to the runner unchanged', async () => {
  const { stateDir } = workspace();
  const seen = [];
  class FakeRunner {
    constructor(options) { Object.assign(this, options); seen.push(options); }
    async run() { seen.push({ ran: true, pid: this.child?.pid }); return 0; }
  }
  const io = capture();
  const code = await run(['service-run', '--state-dir', stateDir, '--log', path.join(stateDir, 'service.log'),
    '--', 'panel', '--config', '/x/gateway.json', '--ui-port', '3427'], {}, io, {
    ServiceRunner: FakeRunner, serviceLauncher: '/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs',
    nodePath: '/usr/local/bin/node',
  });
  expect(code).toBe(0);
  expect(seen[0].stateDir).toBe(path.resolve(stateDir));
  expect(seen[0].argv).toEqual(['panel', '--config', '/x/gateway.json', '--ui-port', '3427']);
  expect(seen[0].launcherPath).toBe('/opt/kimi-work-gateway/bin/kimi-work-gateway.mjs');
  expect(seen[0].logFile).toBe(path.join(stateDir, 'service.log'));
}, 20000);

test('start reloads a loaded job whose supervised runner has exited', () => {
  const w = workspace();
  w.service.install();
  // The agent is still loaded, but the runner wrote `stopped` and exited, so
  // nothing serves the panel. `start` must bootstrap again instead of saying
  // "already running".
  fs.mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(w.stateDir, 'service-runner.json'),
    JSON.stringify({ schemaVersion: 1, pid: 1, child: null, state: 'stopped' }), { mode: 0o600 });
  const before = w.calls.length;
  expect(w.service.start().state).toBe('started');
  expect(w.calls.slice(before).map(call => call.args[0])).toEqual(['print', 'bootstrap', 'kickstart']);
}, 20000);

// A connections-only configuration has no legacy `upstream` block. The service
// must still install from the private credentials file alone, and it must
// refuse a file that cannot supply a key some model actually routes through.
test('a connections-only setup installs from private credentials and refuses a missing connection key', () => {
  const w = workspace({ seed: false });
  const { config, connectionApiKeys } = normalizeSetupInput({
    connections: [
      { id: 'conn-a', name: 'Provider A', baseURL: 'https://a.example/v1', apiKey: KEY },
      { id: 'conn-b', name: 'Provider B', baseURL: 'https://b.example/v1', apiKey: 'conn-b-key' },
    ],
    models: [{ id: 'deepseek-v4-1-flash', protocol: 'responses', contextWindow: 131072,
      connectionId: 'conn-a', upstreamModelId: 'deepseek-chat' }],
    port: 3426, dns: false,
  });
  const saved = saveSetup({ paths: w.paths, config, connectionApiKeys });
  expect(saved.config.upstream).toBeUndefined();
  // A background start has no shell environment; only the private file counts.
  expect(w.service.preflight()).toEqual({ models: 1 });
  const installed = w.service.install();
  expect(installed.state).toBe('installed');
  // Neither key nor the token reached the definition or the service record.
  const plist = fs.readFileSync(installed.definition, 'utf8');
  const record = fs.readFileSync(path.join(w.stateDir, 'service.json'), 'utf8');
  for (const secret of [KEY, 'conn-b-key', saved.credentials.gatewayToken]) {
    expect(plist).not.toContain(secret);
    expect(record).not.toContain(secret);
  }
  // The connection a model uses is required; the unused one is not.
  const credentials = JSON.parse(fs.readFileSync(w.paths.credentials, 'utf8'));
  delete credentials.connectionApiKeys['conn-a'];
  fs.writeFileSync(w.paths.credentials, JSON.stringify(credentials), { mode: 0o600 });
  expect(() => w.service.preflight()).toThrow('service_credentials_missing');
  credentials.connectionApiKeys['conn-a'] = KEY;
  delete credentials.connectionApiKeys['conn-b'];
  fs.writeFileSync(w.paths.credentials, JSON.stringify(credentials), { mode: 0o600 });
  expect(w.service.preflight()).toEqual({ models: 1 });
});

test('a legacy setup keeps its exact credential rules, including the stored variable name', () => {
  // The private file stores the legacy key under one name; a config that names
  // another one cannot be started from it and is still refused.
  const w = workspace();
  const credentials = JSON.parse(fs.readFileSync(w.paths.credentials, 'utf8'));
  const document = JSON.parse(fs.readFileSync(w.paths.config, 'utf8'));
  fs.writeFileSync(w.paths.config, JSON.stringify({ ...document,
    upstream: { ...document.upstream, apiKeyEnv: 'CUSTOM_UPSTREAM_KEY' } }), { mode: 0o600 });
  expect(() => w.service.preflight()).toThrow('service_credentials_name_mismatch');
  fs.writeFileSync(w.paths.config, JSON.stringify(document), { mode: 0o600 });
  expect(w.service.preflight()).toEqual({ models: 1 });
  // A legacy file without the legacy key is still incomplete.
  delete credentials.upstreamApiKey;
  fs.writeFileSync(w.paths.credentials, JSON.stringify(credentials), { mode: 0o600 });
  expect(() => w.service.preflight()).toThrow('service_credentials_missing');
});

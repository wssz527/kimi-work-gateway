import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli.mjs';
import { defaultKimiDirectory, nativeFlagFile } from '../src/paths.mjs';
import { SubagentPolicy, readSubagentJSON } from '../src/subagent-policy.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kimi-work-gateway.mjs');
const KEY = 'kimi-cli-test-upstream-key';
const TOKEN = 'kimi-cli-test-local-token';
const KEY_ENV = 'KIMI_CLI_TEST_UPSTREAM_KEY';
const TOKEN_ENV = 'KIMI_CLI_TEST_WORK_TOKEN';
const MODELS = [
  { id: 'kimi-test-chat', protocol: 'chat', contextWindow: 128000, tools: true },
  { id: 'test-responses', protocol: 'responses', contextWindow: 128000 },
];

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'kimi-work-gateway-cli-'));
}

function clean(...dirs) {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

function childEnv(extra = {}) {
  const env = { ...process.env };
  delete env[KEY_ENV];
  delete env[TOKEN_ENV];
  return { ...env, ...extra };
}

function startUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url.endsWith('/responses')
        ? JSON.stringify({ id: 'resp-1', output: [] })
        : JSON.stringify({ id: 'chat-1', choices: [] }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen })));
}

function closeUpstream(server) {
  return new Promise(resolve => server.close(resolve));
}

const runners = [];

function spawnCLI(args, env, executable = process.execPath) {
  const child = spawn(executable, [bin, ...args], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const runner = { child, stdout: '', stderr: '' };
  runners.push(child);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { runner.stdout += chunk; });
  child.stderr.on('data', chunk => { runner.stderr += chunk; });
  return runner;
}

function stop(runner) {
  return new Promise(resolve => {
    const child = runner?.child;
    if (!child || child.exitCode !== null || child.signalCode) { resolve(); return; }
    const timer = setTimeout(resolve, 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function stopAll() {
  for (const child of runners.splice(0)) await stop({ child });
}

function exited(runner, limit = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('process did not exit; stderr: ' + runner.stderr)), limit);
    runner.child.once('close', code => { clearTimeout(timer); resolve(code); });
    runner.child.once('error', failure => { clearTimeout(timer); reject(failure); });
  });
}

function waitForStdout(runner, pattern, limit = 20000) {
  return new Promise((resolve, reject) => {
    const child = runner.child;
    const timer = setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error('timeout waiting for ' + pattern + '; got: ' + runner.stdout));
    }, limit);
    const onData = () => {
      if (!pattern.test(runner.stdout)) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      resolve(runner.stdout);
    };
    child.stdout.on('data', onData);
  });
}

async function runCLI(args, env = {}, limit = 10000) {
  const runner = spawnCLI(args, env);
  try {
    runner.code = await exited(runner, limit);
    return runner;
  } finally {
    await stop(runner);
  }
}

function writeConfig(dir, config) {
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

const testConfig = baseURL => ({
  upstream: { baseURL, apiKeyEnv: KEY_ENV },
  models: MODELS,
  tokenEnv: TOKEN_ENV,
  port: 0,
  dns: { enabled: false },
});

function capture() {
  const lines = { out: [], err: [] };
  return { lines, out: line => lines.out.push(line), err: line => lines.err.push(line) };
}

// prepare/remove-dns are only ever driven through these injected fakes; the
// real NativeSetup would prompt for administrator rights and touch /etc.
function fakeSetup(state, log = []) {
  return {
    NativeSetup: class {
      constructor(options) { log.push({ kind: 'options', options }); }
      async run(request, port) { log.push({ kind: 'run', request, port }); return { action: request.action, state }; }
    },
    log,
  };
}

// The real SubagentRuntime would adapt a local Kimi copy and could start the
// desktop app, so every subagents-* test drives an injected stand-in instead.
function fakeRuntime({ prepare, inspect, launch } = {}) {
  const log = [];
  return {
    SubagentRuntime: class {
      constructor(options) { log.push({ kind: 'options', options }); }
      prepare() { log.push({ kind: 'prepare' }); return prepare ?? { state: 'prepared', version: '3.2.21', runtimeId: 'a'.repeat(24), bundleDir: '/bundle' }; }
      inspect() { log.push({ kind: 'inspect' }); return inspect ?? { state: 'not-prepared' }; }
      async launch(options) { log.push({ kind: 'launch', options }); return launch ?? { state: 'starting', pid: 4242, runtimeId: 'a'.repeat(24) }; }
    },
    log,
  };
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function listening(port) {
  return new Promise(resolve => {
    const server = http.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const HOME = kimiDir => path.join(kimiDir, 'runtime', 'kimi-code', 'home');

afterAll(stopAll);

test('serve proxies catalog and inference, writes status, exits 0 on SIGTERM', async () => {
  const { server, seen } = await startUpstream();
  const configDir = tempDir();
  const stateDir = tempDir();
  let runner;
  try {
    const config = writeConfig(configDir, testConfig('http://127.0.0.1:' + server.address().port + '/v1'));
    runner = spawnCLI(['serve', '--config', config, '--state-dir', stateDir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN });
    const stdout = await waitForStdout(runner, /http:\/\/127\.0\.0\.1:\d+\/v1\n/);
    const port = stdout.match(/^http:\/\/127\.0\.0\.1:(\d+)\/v1$/m)[1];
    const url = 'http://127.0.0.1:' + port + '/v1';

    const catalog = await fetch(url + '/models', { headers: { Authorization: 'Bearer ' + TOKEN } });
    expect(catalog.status).toBe(200);
    expect((await catalog.json()).data.map(row => row.id)).toEqual(['kimi-test-chat', 'test-responses']);

    const inference = await fetch(url + '/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test-responses', input: 'hello' }),
    });
    expect(inference.status).toBe(200);
    expect(await inference.json()).toEqual({ id: 'resp-1', output: [] });

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/responses');
    expect(seen[0].authorization).toBe('Bearer ' + KEY);
    expect(JSON.parse(seen[0].body).model).toBe('test-responses');
    expect(JSON.parse(seen[0].body).input).toBe('hello');
    expect(JSON.stringify(seen)).not.toContain(TOKEN);

    const statusFile = path.join(stateDir, 'status.json');
    const raw = readFileSync(statusFile, 'utf8');
    const status = JSON.parse(raw);
    expect(status.url).toBe(url);
    expect(status.models).toBe(MODELS.length);
    expect(status.dns).toEqual({ enabled: false, port: 53535 });
    expect(Number.isInteger(status.pid)).toBe(true);
    expect(typeof status.at).toBe('string');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(TOKEN);
    expect(runner.stderr).toBe('');

    // Windows has no signal delivery to a child: `kill` there terminates the
    // process outright, so the graceful shutdown path (exit 0, status file
    // removed) can only be observed on POSIX. A real console Ctrl+C does reach
    // the handler on Windows, which is what the product relies on.
    if (process.platform === 'win32') {
      runner.child.kill();
      await exited(runner).catch(() => {});
    } else {
      runner.child.kill('SIGTERM');
      expect(await exited(runner)).toBe(0);
      expect(existsSync(statusFile)).toBe(false);
    }
  } finally {
    await stop(runner);
    await closeUpstream(server);
    clean(configDir, stateDir);
  }
}, 20000);

test('serve reads the config from stdin with --config -', async () => {
  const { server } = await startUpstream();
  const stateDir = tempDir();
  let runner;
  try {
    runner = spawnCLI(['serve', '--config', '-', '--state-dir', stateDir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN });
    runner.child.stdin.write(JSON.stringify(testConfig('http://127.0.0.1:' + server.address().port + '/v1')));
    runner.child.stdin.end();
    const stdout = await waitForStdout(runner, /http:\/\/127\.0\.0\.1:\d+\/v1\ndns disabled\n/);
    expect(stdout).toContain('dns disabled');
  } finally {
    await stop(runner);
    await closeUpstream(server);
    clean(stateDir);
  }
}, 20000);

test('serve exits 2 and names the missing upstream key env var', async () => {
  const { server } = await startUpstream();
  const configDir = tempDir();
  const stateDir = tempDir();
  let runner;
  try {
    const config = writeConfig(configDir, testConfig('http://127.0.0.1:' + server.address().port + '/v1'));
    runner = spawnCLI(['serve', '--config', config, '--state-dir', stateDir], { [TOKEN_ENV]: TOKEN });
    expect(await exited(runner)).toBe(2);
    expect(runner.stderr).toContain(KEY_ENV);
    expect(runner.stderr).not.toContain(KEY);
    expect(runner.stderr).not.toContain(TOKEN);
    expect(runner.stdout).toBe('');
    expect(existsSync(path.join(stateDir, 'status.json'))).toBe(false);
  } finally {
    await stop(runner);
    await closeUpstream(server);
    clean(configDir, stateDir);
  }
}, 20000);

test('serve exits 2 and names the missing gateway token env var', async () => {
  const configDir = tempDir();
  const stateDir = tempDir();
  let runner;
  try {
    const config = writeConfig(configDir, testConfig('http://127.0.0.1:9/v1'));
    runner = spawnCLI(['serve', '--config', config, '--state-dir', stateDir], { [KEY_ENV]: KEY });
    expect(await exited(runner)).toBe(2);
    expect(runner.stderr).toContain(TOKEN_ENV);
    expect(runner.stderr).not.toContain(TOKEN);
    expect(runner.stdout).toBe('');
    expect(existsSync(path.join(stateDir, 'status.json'))).toBe(false);
  } finally {
    await stop(runner);
    clean(configDir, stateDir);
  }
}, 20000);

test('serve exits 2 for bad JSON, bad shape and an unreadable config file', async () => {
  const configDir = tempDir();
  const stateDir = tempDir();
  try {
    const broken = writeConfig(configDir, {});
    writeFileSync(broken, '{not json');
    let runner = await runCLI(['serve', '--config', broken, '--state-dir', stateDir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN });
    expect(runner.code).toBe(2);
    expect(runner.stderr).toContain('invalid config');
    expect(runner.stderr).toContain('JSON');
    expect(runner.stdout).toBe('');

    const wrong = path.join(configDir, 'wrong.json');
    writeFileSync(wrong, JSON.stringify({ upstream: { baseURL: 'http://127.0.0.1:9/v1' } }));
    runner = await runCLI(['serve', '--config', wrong, '--state-dir', stateDir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN });
    expect(runner.code).toBe(2);
    expect(runner.stderr).toContain('invalid config');
    expect(runner.stdout).toBe('');

    runner = await runCLI(['serve', '--config', path.join(configDir, 'missing.json'), '--state-dir', stateDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN });
    expect(runner.code).toBe(2);
    expect(runner.stderr).toContain('cannot read config');

    expect(existsSync(path.join(stateDir, 'status.json'))).toBe(false);
  } finally {
    clean(configDir, stateDir);
  }
}, 20000);

test('help variants list every command and exit 0', async () => {
  for (const args of [['help'], ['--help'], []]) {
    const runner = await runCLI(args);
    expect(runner.code).toBe(0);
    for (const command of ['serve', 'prepare', 'remove-dns', 'status', 'copy-token',
      'subagents-prepare', 'subagents-status', 'subagents-launch', 'help']) {
      expect(runner.stdout).toContain(command);
    }
    expect(runner.stderr).toBe('');
  }
}, 20000);

test('unknown command exits 1 with usage on stderr', async () => {
  const runner = await runCLI(['frobnicate']);
  expect(runner.code).toBe(1);
  expect(runner.stderr).toContain('unknown command frobnicate');
  expect(runner.stderr).toContain('usage:');
  expect(runner.stdout).toBe('');
}, 20000);

test('unknown flag exits 1 with usage on stderr', async () => {
  const runner = await runCLI(['status', '--wat', '1']);
  expect(runner.code).toBe(1);
  expect(runner.stderr).toContain('usage:');
  expect(runner.stdout).toBe('');
}, 20000);

test('status reports absent files and exits 0', async () => {
  const stateDir = tempDir();
  try {
    const runner = await runCLI(['status', '--state-dir', stateDir]);
    expect(runner.code).toBe(0);
    expect(runner.stdout).toContain('gateway: absent');
    expect(runner.stdout).toContain('native setup: absent');
    expect(runner.stderr).toBe('');
  } finally {
    clean(stateDir);
  }
}, 20000);

test('status prints a summary plus the raw file contents', async () => {
  const stateDir = tempDir();
  try {
    writeFileSync(path.join(stateDir, 'status.json'), JSON.stringify({
      pid: 4242, url: 'http://127.0.0.1:3426/v1', models: 2, dns: { enabled: true, port: 53535 },
      at: '2026-01-01T00:00:00.000Z',
    }));
    writeFileSync(path.join(stateDir, 'native-setup-receipt.json'), JSON.stringify({
      id: 'a'.repeat(32), action: 'prepare', result: { action: 'prepare', state: 'done' },
      at: '2026-01-01T00:00:00.000Z',
    }));
    const runner = await runCLI(['status', '--state-dir', stateDir]);
    expect(runner.code).toBe(0);
    expect(runner.stdout).toContain('gateway: pid 4242 http://127.0.0.1:3426/v1, 2 models, dns listening on port 53535');
    expect(runner.stdout).toContain('native setup: done');
    expect(runner.stdout).toContain('"models":2');
  } finally {
    clean(stateDir);
  }
}, 20000);

test('prepare maps every setup state to its exit code and wires the request', async () => {
  const stateDir = tempDir();
  const kimiDir = tempDir();
  try {
    const codes = { done: 0, 'resolver-conflict': 4, cancelled: 5, interrupted: 6, failed: 7, 'unsupported-platform': 8 };
    for (const [state, expected] of Object.entries(codes)) {
      const log = [];
      const io = capture();
      const exit = await run(['prepare', '--state-dir', stateDir, '--kimi-dir', kimiDir, '--dns-port', '53531'], {}, io, fakeSetup(state, log));
      expect(exit).toBe(expected);
      expect(JSON.parse(io.lines.out.at(-1))).toEqual({ action: 'prepare', state });
      expect(io.lines.err).toEqual([]);
      expect(log[0].options.stateDir).toBe(stateDir);
      expect(log[0].options.flagFile).toBe(nativeFlagFile(kimiDir));
      expect(log[1].port).toBe(53531);
      expect(log[1].request.action).toBe('prepare');
      expect(log[1].request.id).toMatch(/^[a-f0-9]{32}$/);
      expect(Math.abs(Date.now() - log[1].request.at)).toBeLessThan(60000);
    }
  } finally {
    clean(stateDir, kimiDir);
  }
}, 20000);

test('remove-dns maps its state and falls back to the default dns port and kimi dir', async () => {
  const stateDir = tempDir();
  try {
    const log = [];
    const io = capture();
    const exit = await run(['remove-dns', '--state-dir', stateDir], {}, io, fakeSetup('resolver-conflict', log));
    expect(exit).toBe(4);
    expect(JSON.parse(io.lines.out.at(-1))).toEqual({ action: 'remove-dns', state: 'resolver-conflict' });
    expect(log[1].request.action).toBe('remove-dns');
    expect(log[1].port).toBe(53535);
    expect(log[0].options.flagFile).toBe(nativeFlagFile(defaultKimiDirectory()));
  } finally {
    clean(stateDir);
  }
}, 20000);

test('prepare rejects an invalid --dns-port without constructing a setup', async () => {
  const io = capture();
  const exit = await run(['prepare', '--dns-port', '80'], {}, io, { NativeSetup: undefined });
  expect(exit).toBe(1);
  expect(io.lines.err.join('\n')).toContain('usage:');
  expect(io.lines.out).toEqual([]);
}, 20000);

test('copy-token injects the key and prints the result', async () => {
  const stateDir = tempDir();
  try {
    const calls = [];
    const io = capture();
    const exit = await run(['copy-token', '--state-dir', stateDir, '--token-env', TOKEN_ENV], { [TOKEN_ENV]: TOKEN }, io, {
      copySetupToken: async input => { calls.push(input); return 'copied'; },
    });
    expect(exit).toBe(0);
    expect(io.lines.out).toEqual(['copied']);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(TOKEN);
    expect(calls[0].stateDir).toBe(stateDir);
    expect(calls[0].request.id).toMatch(/^[a-f0-9]{32}$/);
  } finally {
    clean(stateDir);
  }
}, 20000);

test('copy-token without the token env prints no-token and never copies', async () => {
  const io = capture();
  const exit = await run(['copy-token'], {}, io, { copySetupToken: () => { throw new Error('must not copy'); } });
  expect(exit).toBe(0);
  expect(io.lines.out).toEqual(['no-token']);
}, 20000);

test('copy-token prints unavailable when the clipboard fails', async () => {
  const io = capture();
  const exit = await run(['copy-token', '--token-env', TOKEN_ENV], { [TOKEN_ENV]: TOKEN }, io, {
    copySetupToken: async () => 'unavailable',
  });
  expect(exit).toBe(0);
  expect(io.lines.out).toEqual(['unavailable']);
}, 20000);

test('Windows serve uses hosts without creating a UDP listener and preserves a replacement status', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'status.json');
  const io = capture();
  try {
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:9/v1'), dns: { enabled: true } });
    const exit = await run(['serve', '--config', config, '--state-dir', dir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, {
      platform: 'win32',
      NativeByokDNS: class { constructor() { throw Error('must_not_start_dns'); } },
      waitForShutdown: async () => {
        const status = JSON.parse(readFileSync(file, 'utf8'));
        expect(status.dns).toEqual({ enabled: false, port: 53535, mode: 'hosts' });
        const response = await fetch(status.url + '/models/api.json', { headers: { Authorization: 'Bearer ' + TOKEN } });
        expect(response.status).toBe(200);
        expect(Object.keys(await response.json()).sort()).toEqual(['kimi', 'responses']);
        writeFileSync(file, '{"instanceId":"replacement"}');
      },
    });
    expect(exit).toBe(0);
    expect(io.lines.out).toContain('dns provided by Windows hosts');
    expect(readFileSync(file, 'utf8')).toBe('{"instanceId":"replacement"}');
  } finally { clean(dir); }
});

test('a duplicate serve failure preserves the existing instance status', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const file = path.join(dir, 'status.json');
  try {
    const original = '{"pid":4242,"instanceId":"running-instance"}';
    writeFileSync(file, original);
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:9/v1'), port: server.address().port });
    const exit = await run(['serve', '--config', config, '--state-dir', dir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, capture());
    expect(exit).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally { await closeUpstream(server); clean(dir); }
});

test('the Node CLI serves both catalogs and both inference protocols', async () => {
  const { server, seen } = await startUpstream();
  const dir = tempDir();
  let runner;
  try {
    const config = writeConfig(dir, testConfig('http://127.0.0.1:' + server.address().port + '/v1'));
    runner = spawnCLI(['serve', '--config', config, '--state-dir', dir], { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, 'node');
    const stdout = await waitForStdout(runner, /http:\/\/127\.0\.0\.1:\d+\/v1\n/);
    const url = stdout.split('\n')[0];
    const headers = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
    const catalog = await fetch(url + '/models/api.json', { headers });
    expect(catalog.status).toBe(200); expect(Object.keys(await catalog.json()).sort()).toEqual(['kimi', 'responses']);
    const list = await fetch(url + '/models', { headers });
    expect((await list.json()).data).toHaveLength(2);
    for (const [endpoint, model] of [['/chat/completions', MODELS[0].id], ['/responses', MODELS[1].id]]) {
      const response = await fetch(url + endpoint, { method: 'POST', headers, body: JSON.stringify({ model, messages: [], input: 'hello' }) });
      expect(response.status).toBe(200); await response.text();
    }
    expect(seen).toHaveLength(2);
    expect(seen.map(row => row.url)).toEqual(['/v1/chat/completions', '/v1/responses']);
  } finally { await stop(runner); await closeUpstream(server); clean(dir); }
}, 20000);

const FORCE_MODEL = MODELS[0].id;

// A subagent policy can only select a model that declares tools, so these
// policy tests use their own catalog with two selectable chat models.
const SUBAGENT_MODELS = [
  { id: 'kimi-test-chat', protocol: 'chat', contextWindow: 128000, tools: true },
  { id: 'kimi-test-child', protocol: 'chat', contextWindow: 64000, tools: true },
  { id: 'test-responses', protocol: 'responses', contextWindow: 128000, tools: true },
];
const CHILD_MODEL = 'kimi-test-child';

test('serve applies the configured subagent policy and restores inheritance on exit', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  const policyFile = path.join(dir, 'subagent-policy.json');
  try {
    const config = writeConfig(dir, {
      ...testConfig('http://127.0.0.1:' + server.address().port + '/v1'), models: SUBAGENT_MODELS,
      subagents: { mode: 'force', model: FORCE_MODEL },
    });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, {
        waitForShutdown: async () => {
          const document = readSubagentJSON(policyFile);
          expect(document.mode).toBe('force');
          expect(document.model).toBe(FORCE_MODEL);
          expect(document.modelAlias).toBe('byok-kth-kimi/' + FORCE_MODEL);
          expect(document.homeDir).toBe(HOME(kimiDir));
          const status = JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'));
          expect(status.subagents).toEqual({ mode: 'force', model: FORCE_MODEL, modelAlias: 'byok-kth-kimi/' + FORCE_MODEL });
        },
      });
    expect(exit).toBe(0);
    expect(io.lines.out).toContain('subagents force byok-kth-kimi/' + FORCE_MODEL);
    // The gateway is gone and its own policy is back to inheritance.
    expect(io.lines.err).toEqual([]);
    expect(readSubagentJSON(policyFile).mode).toBe('inherit');
    expect(existsSync(path.join(dir, 'status.json'))).toBe(false);
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('serve without a subagents section leaves the policy at inheritance', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:' + server.address().port + '/v1'), models: SUBAGENT_MODELS });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, {
        waitForShutdown: async () => {
          expect(readSubagentJSON(path.join(dir, 'subagent-policy.json')).mode).toBe('inherit');
        },
      });
    expect(exit).toBe(0);
    expect(io.lines.out).toContain('subagents inherit');
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('serve refuses an unusable subagents section before it listens or touches the policy', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  const policyFile = path.join(dir, 'subagent-policy.json');
  const port = await freePort();
  try {
    const running = new SubagentPolicy({ stateDir: dir, kimiDir });
    running.configure({ mode: 'force', model: FORCE_MODEL }, SUBAGENT_MODELS);
    const before = readFileSync(policyFile, 'utf8');
    const config = writeConfig(dir, {
      ...testConfig('http://127.0.0.1:' + server.address().port + '/v1'), models: SUBAGENT_MODELS, port,
      subagents: { mode: 'force', model: 'not-a-configured-model' },
    });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, { waitForShutdown: async () => { throw Error('must not serve'); } });
    expect(exit).toBe(2);
    expect(io.lines.err.join('\n')).toContain('invalid config');
    expect(io.lines.err.join('\n')).toContain('subagent_model_unavailable');
    expect(io.lines.out).toEqual([]);
    expect(existsSync(path.join(dir, 'status.json'))).toBe(false);
    // The running gateway keeps its policy, and this process never listened.
    expect(readFileSync(policyFile, 'utf8')).toBe(before);
    expect(await listening(port)).toBe(true);
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('a duplicate serve failure never rewrites the policy of the running gateway', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  const policyFile = path.join(dir, 'subagent-policy.json');
  try {
    const running = new SubagentPolicy({ stateDir: dir, kimiDir });
    running.configure({ mode: 'force', model: FORCE_MODEL }, SUBAGENT_MODELS);
    const before = readFileSync(policyFile, 'utf8');
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:9/v1'), models: SUBAGENT_MODELS, port: server.address().port });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io);
    expect(exit).toBe(3);
    expect(io.lines.err.join('\n')).toContain('cannot listen');
    expect(readFileSync(policyFile, 'utf8')).toBe(before);
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('serve releases the policy owner only while it still owns the file', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:' + server.address().port + '/v1'), models: SUBAGENT_MODELS });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, {
        waitForShutdown: async () => {
          // A newer instance takes over the policy while this one is still up.
          new SubagentPolicy({ stateDir: dir, kimiDir }).configure({ mode: 'force', model: CHILD_MODEL }, SUBAGENT_MODELS);
        },
      });
    expect(exit).toBe(0);
    expect(readSubagentJSON(path.join(dir, 'subagent-policy.json')).model).toBe(CHILD_MODEL);
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('subagents-prepare initializes inheritance, prepares the runtime and reports both', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const io = capture();
    const runtime = fakeRuntime({ inspect: { state: 'not-prepared' } });
    const exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', kimiDir, '--archive', '/Kimi/app.asar'], {}, io, runtime);
    expect(exit).toBe(0);
    const report = JSON.parse(io.lines.out.at(-1));
    expect(report.command).toBe('subagents-prepare');
    expect(report.homeDir).toBe(HOME(kimiDir));
    expect(report.policy).toEqual({ mode: 'inherit' });
    expect(report.runtime.state).toBe('prepared');
    expect(io.lines.err).toEqual([]);
    expect(runtime.log[0].options).toEqual({ stateDir: dir, archive: '/Kimi/app.asar' });
    expect(runtime.log.map(row => row.kind)).toEqual(['options', 'prepare']);
    // The missing policy became explicit inheritance so the runtime can read it.
    const document = readSubagentJSON(path.join(dir, 'subagent-policy.json'));
    expect(document.mode).toBe('inherit');
    expect(document.homeDir).toBe(HOME(kimiDir));
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-prepare keeps an existing policy for the same scope and refuses another one', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  const otherDir = tempDir();
  try {
    const running = new SubagentPolicy({ stateDir: dir, kimiDir });
    running.configure({ mode: 'force', model: FORCE_MODEL }, MODELS);
    const before = readFileSync(path.join(dir, 'subagent-policy.json'), 'utf8');
    const io = capture();
    let exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, fakeRuntime());
    expect(exit).toBe(0);
    expect(JSON.parse(io.lines.out.at(-1)).policy.mode).toBe('force');
    expect(readFileSync(path.join(dir, 'subagent-policy.json'), 'utf8')).toBe(before);

    // Same state directory, another Kimi scope: the adapted runtime would ignore
    // this policy, so the command refuses instead of reporting success.
    const foreign = capture();
    exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', otherDir], {}, foreign, fakeRuntime());
    expect(exit).toBe(3);
    expect(foreign.lines.err.join('\n')).toContain('subagent_policy_scope_conflict');
    expect(foreign.lines.out).toEqual([]);
    expect(readFileSync(path.join(dir, 'subagent-policy.json'), 'utf8')).toBe(before);
  } finally { clean(dir, kimiDir, otherDir); }
}, 20000);

test('unsupported desktop launch contracts return exit 9 for prepare, status and launch', async () => {
  const dir = tempDir(), kimiDir = tempDir();
  const overrides = fakeRuntime();
  overrides.SubagentRuntime = class {
    inspect() { return { state: 'unsupported', reason: 'packaged_bundle_override_disabled' }; }
    prepare() { throw Error('subagent_launch_unsupported'); }
    launch() { throw Error('must not launch'); }
  };
  try {
    for (const command of ['subagents-prepare', 'subagents-status', 'subagents-launch']) {
      const io = capture();
      expect(await run([command, '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, overrides)).toBe(9);
      if (command === 'subagents-status') expect(JSON.parse(io.lines.out.at(-1)).runtime.reason).toBe('packaged_bundle_override_disabled');
      else expect(io.lines.err.join('\n')).toContain('subagent_launch_unsupported');
    }
  } finally { clean(dir, kimiDir); }
});

test('subagents-prepare reports an incompatible runtime as exit 9 and a broken file as exit 3', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const io = capture();
    const incompatible = fakeRuntime();
    incompatible.SubagentRuntime = class {
      constructor() {}
      prepare() { throw Error('subagent_runtime_incompatible'); }
    };
    let exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, incompatible);
    expect(exit).toBe(9);
    expect(io.lines.err.join('\n')).toContain('subagent_runtime_incompatible');

    const missing = capture();
    const absent = fakeRuntime();
    absent.SubagentRuntime = class {
      constructor() {}
      prepare() { throw Error('subagent_kimi_unavailable'); }
    };
    exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', kimiDir], {}, missing, absent);
    expect(exit).toBe(3);
    expect(missing.lines.err.join('\n')).toContain('subagent_kimi_unavailable');

    const broken = capture();
    writeFileSync(path.join(dir, 'subagent-policy.json'), '{not json');
    exit = await run(['subagents-prepare', '--state-dir', dir, '--kimi-dir', kimiDir], {}, broken, fakeRuntime());
    expect(exit).toBe(3);
    expect(broken.lines.err.join('\n')).toContain('subagent_file_conflict');
    // A refused prepare leaves the unusable file exactly as it found it.
    expect(readFileSync(path.join(dir, 'subagent-policy.json'), 'utf8')).toBe('{not json');
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-status only reads and never creates a policy file', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  const policyFile = path.join(dir, 'subagent-policy.json');
  try {
    const io = capture();
    const runtime = fakeRuntime({ inspect: { state: 'waiting-launch', version: '3.2.21', runtimeId: 'b'.repeat(24) } });
    let exit = await run(['subagents-status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, runtime);
    expect(exit).toBe(0);
    expect(JSON.parse(io.lines.out.at(-1))).toEqual({ command: 'subagents-status', homeDir: HOME(kimiDir),
      policy: { state: 'absent' }, runtime: { state: 'waiting-launch', version: '3.2.21', runtimeId: 'b'.repeat(24) } });
    expect(existsSync(policyFile)).toBe(false);
    expect(existsSync(dir)).toBe(true);

    new SubagentPolicy({ stateDir: dir, kimiDir }).configure({ mode: 'force', model: FORCE_MODEL }, MODELS);
    const forced = capture();
    exit = await run(['subagents-status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, forced, fakeRuntime({ inspect: { state: 'loaded', mode: 'force' } }));
    expect(exit).toBe(0);
    const report = JSON.parse(forced.lines.out.at(-1));
    expect(report.policy.mode).toBe('force');
    expect(report.runtime.state).toBe('loaded');
    expect(forced.lines.err).toEqual([]);

    // A foreign scope is reported, not silently accepted.
    const foreign = capture();
    const otherDir = path.join(dir, 'other-kimi');
    exit = await run(['subagents-status', '--state-dir', dir, '--kimi-dir', otherDir], {}, foreign, fakeRuntime());
    expect(exit).toBe(3);
    expect(JSON.parse(foreign.lines.out.at(-1)).policy).toEqual({ state: 'scope-conflict' });
    expect(JSON.parse(foreign.lines.out.at(-1)).homeDir).not.toBe(HOME(kimiDir));
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents status reports failed states and blocked selections without changing files or launching', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    for (const [state, expected] of [['outdated', 3], ['conflict', 3], ['unavailable', 3],
      ['policy-unavailable', 3], ['heartbeat-stale', 3], ['not-prepared', 0]]) {
      const io = capture();
      const exit = await run(['subagents-status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, fakeRuntime({ inspect: { state } }));
      expect(exit).toBe(expected);
      expect(JSON.parse(io.lines.out.at(-1)).runtime).toEqual({ state });
      expect(existsSync(path.join(dir, 'subagent-policy.json'))).toBe(false);
    }
    const policy = new SubagentPolicy({ stateDir: dir, kimiDir });
    expect(() => policy.configure({ mode: 'force', model: 'removed/model' }, MODELS)).toThrow('subagent_model_unavailable');
    const before = readFileSync(policy.file, 'utf8');
    for (const command of ['subagents-status', 'subagents-launch']) {
      const io = capture();
      const runtime = fakeRuntime({ inspect: { state: 'loaded', mode: 'blocked' } });
      expect(await run([command, '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, runtime)).toBe(3);
      expect(runtime.log.some(row => row.kind === 'launch')).toBe(false);
      expect(readFileSync(policy.file, 'utf8')).toBe(before);
    }
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-launch starts a prepared runtime and reports where Kimi must exit first', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const prepared = new SubagentPolicy({ stateDir: dir, kimiDir });
    prepared.configure({ mode: 'force', model: FORCE_MODEL }, SUBAGENT_MODELS);

    const io = capture();
    const starting = fakeRuntime({ inspect: { state: 'waiting-launch' }, launch: { state: 'starting', pid: 4242, runtimeId: 'a'.repeat(24) } });
    let exit = await run(['subagents-launch', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, starting);
    expect(exit).toBe(0);
    expect(JSON.parse(io.lines.out.at(-1)).runtime).toEqual({ state: 'starting', pid: 4242, runtimeId: 'a'.repeat(24) });
    // The runtime is checked first so an unusable one fails before it is launched.
    expect(starting.log.map(row => row.kind)).toEqual(['options', 'inspect', 'launch']);
    expect(starting.log.at(-1).options.protectedEnvNames).toEqual(['KIMI_WORK_UPSTREAM_KEY', 'KIMI_WORK_GATEWAY_TOKEN', 'KIMI_WORK_TRANSLATION_API_KEY']);
    // --archive and --kimi-dir are per-invocation: they reach the runtime once
    // and are not remembered anywhere.
    expect(starting.log[0].options).toEqual({ stateDir: dir });

    const pinned = capture();
    const pinnedRuntime = fakeRuntime({ inspect: { state: 'waiting-launch' } });
    exit = await run(['subagents-launch', '--state-dir', dir, '--kimi-dir', kimiDir, '--archive', '/Kimi/app.asar'], {}, pinned, pinnedRuntime);
    expect(exit).toBe(0);
    expect(pinnedRuntime.log[0].options).toEqual({ stateDir: dir, archive: '/Kimi/app.asar' });
    expect(pinnedRuntime.log[1].options).toBeUndefined();

    const waiting = capture();
    exit = await run(['subagents-launch', '--state-dir', dir, '--kimi-dir', kimiDir], {}, waiting,
      fakeRuntime({ inspect: { state: 'loaded' }, launch: { state: 'waiting-kimi-exit' } }));
    expect(exit).toBe(0);
    expect(JSON.parse(waiting.lines.out.at(-1)).runtime.state).toBe('waiting-kimi-exit');
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-launch refuses an unprepared runtime and names the failure', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    const io = capture();
    const exit = await run(['subagents-launch', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io,
      fakeRuntime({ inspect: { state: 'not-prepared' }, launch: { state: 'starting' } }));
    expect(exit).toBe(3);
    expect(io.lines.err.join('\n')).toContain('subagent_runtime_not_ready');
    expect(io.lines.out).toEqual([]);
    // launch must not run before the runtime is usable.
    expect(existsSync(path.join(dir, 'subagent-policy.json'))).toBe(true);
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-launch hands the adapted copy to Kimi through the runtime environment only', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  const bundleDir = path.join(dir, 'native-runtime', 'a'.repeat(24), 'bundle');
  const application = path.join(dir, 'Kimi');
  try {
    writeFileSync(application, 'fixture');
    writeFileSync(path.join(dir, 'subagent-runtime.json'), JSON.stringify({
      schemaVersion: 1, runtimeId: 'a'.repeat(24), version: '3.2.21', sourceHash: 'b'.repeat(64),
      bundleDir, application, policyPath: path.join(dir, 'subagent-policy.json'),
      receiptPath: path.join(dir, 'subagent-runtime-status.json'),
    }));
    // The real runtime is used, but with the process probe and the app launch
    // replaced, so nothing is actually started here.
    const seen = [];
    const previous = process.env.DAIMON_BUNDLE_DIR;
    const real = (await import('../src/subagent-runtime.mjs')).SubagentRuntime;
    class Probed extends real {
      constructor(options) { super({ ...options, launchProbe: () => ({ state: 'supported' }) }); }
      inspect() { return { state: 'waiting-launch' }; }
      async launch({ spawnApp } = {}) {
        return super.launch({ isRunning: () => false, spawnApp: (command, args, options) => {
          seen.push({ command, args, env: options.env });
          const child = new EventEmitter();
          child.pid = 4321;
          child.unref = () => {};
          queueMicrotask(() => child.emit('spawn'));
          return child;
        } });
      }
    }
    const io = capture();
    const exit = await run(['subagents-launch', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, { SubagentRuntime: Probed });
    expect(exit).toBe(0);
    expect(JSON.parse(io.lines.out.at(-1)).runtime).toEqual({ state: 'starting', pid: 4321, runtimeId: 'a'.repeat(24) });
    expect(seen).toHaveLength(1);
    expect(seen[0].command).toBe(application);
    expect(seen[0].env.DAIMON_BUNDLE_DIR).toBe(bundleDir);
    expect(seen[0].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    // The override is passed to the child only; this process keeps its own env.
    expect(process.env.DAIMON_BUNDLE_DIR).toBe(previous);
    expect(io.lines.err).toEqual([]);
  } finally { clean(dir, kimiDir); }
}, 20000);

test('subagents-* rejects unknown flags and missing values with usage', async () => {
  for (const args of [['subagents-prepare', '--wat'], ['subagents-status', '--state-dir'],
    ['subagents-launch', '--archive']]) {
    const io = capture();
    const exit = await run(args, {}, io, fakeRuntime());
    expect(exit).toBe(1);
    expect(io.lines.err.join('\n')).toContain('usage:');
    expect(io.lines.out).toEqual([]);
  }
}, 20000);

test('status reports the subagent policy and runtime without writing anything', async () => {
  const dir = tempDir();
  const kimiDir = tempDir();
  try {
    new SubagentPolicy({ stateDir: dir, kimiDir }).configure({ mode: 'force', model: FORCE_MODEL }, MODELS);
    const io = capture();
    const exit = await run(['status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, fakeRuntime({ inspect: { state: 'not-prepared' } }));
    expect(exit).toBe(0);
    expect(io.lines.out).toContain('subagents: force byok-kth-kimi/' + FORCE_MODEL);
    expect(io.lines.out).toContain('subagent runtime: not-prepared');
    expect(io.lines.out.some(line => line.includes('another Kimi scope'))).toBe(false);

    const foreign = capture();
    await run(['status', '--state-dir', dir, '--kimi-dir', tempDir()], {}, foreign, fakeRuntime());
    expect(foreign.lines.out.some(line => line.includes('another Kimi scope'))).toBe(true);

    // An old status file without a subagent summary is not an error.
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ pid: 1, url: 'http://127.0.0.1:1/v1', models: 1, dns: { enabled: false, port: 53535 } }));
    const legacy = capture();
    expect(await run(['status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, legacy, fakeRuntime())).toBe(0);
    expect(legacy.lines.out).toContain('gateway subagents: unknown');
  } finally { clean(dir, kimiDir); }
}, 20000);

test('a policy write failure is reported, releases the port and leaves the file alone', async () => {
  const { server } = await startUpstream();
  const dir = tempDir();
  const kimiDir = tempDir();
  const port = await freePort();
  const policyPath = path.join(dir, 'subagent-policy.json');
  try {
    // A directory where the policy file belongs makes every read and write fail.
    mkdirSync(policyPath, { recursive: true });
    const config = writeConfig(dir, { ...testConfig('http://127.0.0.1:' + server.address().port + '/v1'), port });
    const io = capture();
    const exit = await run(['serve', '--config', config, '--state-dir', dir, '--kimi-dir', kimiDir],
      { [KEY_ENV]: KEY, [TOKEN_ENV]: TOKEN }, io, { waitForShutdown: async () => { throw Error('must not serve'); } });
    expect(exit).toBe(3);
    expect(io.lines.err.join('\n')).toContain('cannot apply the subagent policy');
    expect(io.lines.err.join('\n')).toContain('subagent_file_conflict');
    expect(io.lines.err.join('\n')).not.toContain(KEY);
    expect(io.lines.err.join('\n')).not.toContain(TOKEN);
    expect(io.lines.out).toEqual([]);
    expect(existsSync(path.join(dir, 'status.json'))).toBe(false);
    // The failure is reported, not hidden: the listener this process opened is
    // closed again instead of staying bound to a gateway that cannot serve.
    expect(await listening(port)).toBe(true);
    expect(statSync(policyPath).isDirectory()).toBe(true);
  } finally { await closeUpstream(server); clean(dir, kimiDir); }
}, 20000);

test('status tolerates malformed pool summaries and rejects incomplete policy files without writing', async () => {
  const dir = tempDir(), kimiDir = tempDir();
  try {
    const policy = new SubagentPolicy({ stateDir: dir, kimiDir });
    policy.configure({ mode: 'force', model: FORCE_MODEL }, MODELS);
    const malformed = { ...readSubagentJSON(policy.file), mode: 'pool', transport: 'native-config' };
    writeFileSync(policy.file, JSON.stringify(malformed));
    writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ pid: 1, url: 'local', models: 1, subagents: { mode: 'pool' } }));
    const before = readFileSync(policy.file, 'utf8'), io = capture();
    expect(await run(['status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, io, fakeRuntime())).toBe(0);
    expect(io.lines.out).toContain('subagents: unreadable or foreign policy file');
    const subagents = capture();
    expect(await run(['subagents-status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, subagents, fakeRuntime())).toBe(3);
    expect(readFileSync(policy.file, 'utf8')).toBe(before);
    policy.configure({ mode: 'force', model: FORCE_MODEL, transport: 'native-config' }, MODELS);
    const native = capture();
    expect(await run(['status', '--state-dir', dir, '--kimi-dir', kimiDir], {}, native, fakeRuntime())).toBe(0);
    expect(native.lines.out).toContain('subagent runtime: waiting-config (native-config)');
  } finally { clean(dir, kimiDir); }
});

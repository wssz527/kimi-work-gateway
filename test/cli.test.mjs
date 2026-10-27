import { afterAll, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../cli.mjs';
import { defaultKimiDirectory, nativeFlagFile } from '../src/paths.mjs';

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

function spawnCLI(args, env) {
  const child = spawn(process.execPath, [bin, ...args], { env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
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
    for (const command of ['serve', 'prepare', 'remove-dns', 'status', 'copy-token', 'help']) {
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

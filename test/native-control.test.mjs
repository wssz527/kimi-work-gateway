import { afterEach, expect, test } from 'bun:test';
import { NativeControlClient, controlEndpoint, processStartIdentity, windowsFiletimeToUnixMilliseconds } from '../src/native-control.mjs';
import { frame, fragment, controlServer } from './fixtures/native-control-server.mjs';

const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });

function state(url, token, overrides = {}) {
  const parsed = new URL(url);
  return { control: { endpoint: { url, host: parsed.hostname, port: Number(parsed.port), pid: 4242, auth: { token } } },
    daemonGeneration: { pid: 4242 }, ...overrides };
}

test('the endpoint is only accepted for an authenticated loopback ws control url', () => {
  const url = 'ws://127.0.0.1:57142/control';
  expect(controlEndpoint(state(url, 'token'))).toMatchObject({ host: '127.0.0.1', port: 57142, pid: 4242, token: 'token' });
  expect(controlEndpoint({ control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } } })).not.toBeNull();
  for (const bad of [
    'wss://127.0.0.1:1/control', 'ws://10.0.0.5:1/control', 'ws://127.0.0.1:1/other', 'ws://127.0.0.1:1/control?x=1',
    'ws://user:pass@127.0.0.1:1/control', 'ws://127.0.0.1/control',
  ]) {
    expect(controlEndpoint({ control: { endpoint: { url: bad, pid: 1, auth: { token: 't' } } } })).toBe(null);
  }
  expect(controlEndpoint({ control: { endpoint: { url, pid: 1 } } })).toBe(null);
  expect(controlEndpoint({ control: { endpoint: { url, pid: 1, auth: { token: '' } } } })).toBe(null);
  expect(controlEndpoint(null)).toBe(null);
});

test('a real handshake authenticates, round-trips JSON-RPC and refuses unknown methods', async () => {
  const token = 'synthetic-control-token';
  const server = await controlServer({ token, handler: input => ({ result: { echo: input.method, id: input.id } }) });
  servers.push(server);
  const client = new NativeControlClient({ endpoint: controlEndpoint(state(server.url, token)) });
  try {
    await client.connect();
    expect(client.upgraded).toBe(true);
    expect(await client.send('runtime.status', {})).toEqual({ echo: 'runtime.status', id: 1 });
    await expect(client.send('conversations.delete', {})).rejects.toThrow('native_control_method_refused');
    await expect(client.send('runtime.evaluate', {})).rejects.toThrow('native_control_method_refused');
  } finally { client.close(); }
});

test('a wrong token or a non-101 response is refused without echoing the secret', async () => {
  const server = await controlServer({ token: 'right-token', handler: () => ({ result: {} }) });
  servers.push(server);
  const secret = 'wrong-token-value';
  const refused = new NativeControlClient({ endpoint: controlEndpoint(state(server.url, secret)) });
  const error = await refused.connect().then(() => null, value => value);
  expect(error).not.toBe(null);
  expect(error.message).toBe('native_control_refused');
  expect(JSON.stringify(Object.keys(error)) + error.message).not.toContain(secret);
  refused.dispose('native_control_closed');
});

test('an unreachable endpoint fails closed and a closed client rejects further calls', async () => {
  const endpoint = controlEndpoint(state('ws://127.0.0.1:1/control', 'token'));
  const client = new NativeControlClient({ endpoint, connectTimeout: 200 });
  await expect(client.connect()).rejects.toThrow();
  client.dispose('native_control_closed');
  await expect(client.send('runtime.status', {})).rejects.toThrow('native_control_closed');
});

test('fragmented replies and server pings are handled', async () => {
  const token = 'fragment-token';
  const server = await controlServer({ token, handler: (input, { socket }) => {
    if (input.method !== 'capabilities.get') return { result: {} };
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { protocolVersion: 1, split: true } }));
    const half = Math.floor(body.length / 2);
    // A ping first, then a two-fragment text message.
    socket.write(Buffer.concat([
      Buffer.from([0x89, 2, 0x68, 0x69]),
      fragment(body.subarray(0, half), 0x1, false),
      fragment(body.subarray(half), 0x0, true),
    ]));
    return undefined;
  } });
  servers.push(server);
  const client = new NativeControlClient({ endpoint: controlEndpoint(state(server.url, token)) });
  try {
    await client.connect();
    expect(await client.send('capabilities.get', {})).toEqual({ protocolVersion: 1, split: true });
  } finally { client.close(); }
});

test('an oversized frame or an RPC error stops the exchange instead of being trusted', async () => {
  const token = 'bounded-token';
  const server = await controlServer({ token, handler: input => (input.method === 'runtime.status'
    ? { error: { code: -32000, message: 'private detail' } }
    : { result: {} }) });
  servers.push(server);
  const client = new NativeControlClient({ endpoint: controlEndpoint(state(server.url, token)) });
  try {
    await client.connect();
    const error = await client.send('runtime.status', {}).then(() => null, value => value);
    expect(error.message).toBe('native_control_error');
    expect(error.message).not.toContain('private detail');
  } finally { client.close(); }
});

// A reply larger than 125 bytes uses the 16-bit length form; getting the mask
// offset wrong there silently corrupts every real runtime.status response.
test('a reply crossing the 126-byte length boundary is parsed intact', async () => {
  const token = 'large-frame-token';
  const layout = { agents: { entries: Array.from({ length: 12 }, (_, index) => ({
    agentId: 'agent-' + index, runnerStatePath: '/kimi/agents/agent-' + index + '/runner.state.json' })) } };
  const server = await controlServer({ token, handler: input => ({ result: input.method === 'runtime.status'
    ? { checkedAt: new Date().toISOString(), operations: { activeCount: 0 }, layout } : { ok: true } }) });
  servers.push(server);
  const client = new NativeControlClient({ endpoint: controlEndpoint(state(server.url, token)) });
  try {
    await client.connect();
    const result = await client.send('runtime.status', {});
    expect(result.operations.activeCount).toBe(0);
    expect(result.layout.agents.entries).toHaveLength(12);
    expect(result.layout.agents.entries[11].runnerStatePath).toBe('/kimi/agents/agent-11/runner.state.json');
  } finally { client.close(); }
});

test('macOS process identity distinguishes a dead pid from a query failure', () => {
  expect(processStartIdentity(4242, { platform: 'darwin',
    run: () => ({ status: 1, stdout: '', stderr: '' }) })).toEqual({ kind: 'not_found' });
  expect(processStartIdentity(4242, { platform: 'darwin',
    run: () => ({ status: 0, stdout: 'Mon Oct 12 10:35:49 2026\n', stderr: '' }) }))
    .toEqual({ kind: 'darwin_ps_lstart', value: 'Mon Oct 12 10:35:49 2026' });
  expect(processStartIdentity(4242, { platform: 'darwin',
    run: () => ({ status: 2, stdout: '', stderr: 'ps: failed' }) })).toEqual({ kind: 'unknown' });
});

// Windows has to be usable for re-attach too: an `unknown` identity there would
// make every ordinary restart wait forever. The script and parsing are the
// daemon's own; the tests inject the process runner instead of executing
// powershell on a Mac.
test('windows process identity reads the creation FILETIME through the fixed powershell script', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '134379595770000000\r\n', stderr: '' };
  };
  const identity = processStartIdentity(4242, { platform: 'win32', run });
  expect(identity).toEqual({ kind: 'windows_process_creation_filetime', value: '134379595770000000' });
  expect(calls).toHaveLength(1);
  expect(calls[0].command).toBe('powershell.exe');
  expect(calls[0].args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  expect(calls[0].options).toMatchObject({ encoding: 'utf8', shell: false, windowsHide: true });
  const script = calls[0].args[4];
  expect(script).toContain('$ErrorActionPreference = \'Stop\';');
  expect(script).toContain('Get-Process -Id 4242 -ErrorAction Stop');
  expect(script).toContain('.StartTime.ToUniversalTime().ToFileTimeUtc()');
  expect(script).toContain('[Globalization.CultureInfo]::InvariantCulture');
  expect(script).toContain('__DAIMON_PROCESS_NOT_FOUND__');
  expect(script).toContain('__DAIMON_PROCESS_PERMISSION_DENIED__');
  // The pid is interpolated as a number, never as shell text.
  expect(script).not.toContain('; Remove');
  expect(windowsFiletimeToUnixMilliseconds('134379595770000000')).toBe(Date.UTC(2026, 9, 31, 22, 32, 57));
});

test('windows identity is unknown unless the pid, output and exit code all check out', () => {
  const at = (result, pid = 4242) => processStartIdentity(pid, { platform: 'win32', run: () => result });
  // A dead pid is reported as not_found, so the caller stops waiting on it
  // rather than treating it as unreadable evidence.
  expect(at({ status: 3, stdout: '', stderr: '' })).toEqual({ kind: 'not_found' });
  expect(at({ status: 1, stdout: '', stderr: '__DAIMON_PROCESS_NOT_FOUND__' })).toEqual({ kind: 'not_found' });
  expect(at({ status: 4, stdout: '', stderr: '' })).toEqual({ kind: 'unknown', reason: 'permission_denied' });
  expect(at({ status: 4, stdout: '', stderr: '__DAIMON_PROCESS_PERMISSION_DENIED__' }))
    .toEqual({ kind: 'unknown', reason: 'permission_denied' });
  expect(at({ status: 5, stdout: '', stderr: '' })).toEqual({ kind: 'unknown', reason: 'query_failed' });
  expect(at({ error: Error('spawn failed') })).toEqual({ kind: 'unknown' });
  // A syntactically valid but impossible tick count is not identity evidence,
  // and surviving the pid alone is explicitly not enough.
  for (const output of ['', '0', '-1', '0000', 'not-a-number', '99999999999999999999999999']) {
    expect(at({ status: 0, stdout: output, stderr: '' })).toEqual({ kind: 'unknown', reason: 'invalid_output' });
  }
  expect(at({ status: 0, stdout: '134379595770000000' }, 0)).toEqual({ kind: 'unknown' });
});

// The identity helper claims a real binding where it can actually obtain one:
// a `ps` start time on macOS and a creation FILETIME on Windows. Linux has
// neither, so there the answer is "unknown" and the caller keeps waiting.
test('process start identity is real on macOS and Windows and unknown on Linux', () => {
  expect(processStartIdentity(0)).toEqual({ kind: 'unknown' });
  // A non-positive pid is refused before any platform query runs.
  expect(processStartIdentity(0, { platform: 'win32' })).toEqual({ kind: 'unknown' });
  expect(processStartIdentity(0, { platform: 'darwin' })).toEqual({ kind: 'unknown' });
  if (process.platform === 'darwin') {
    const own = processStartIdentity(process.pid);
    expect(own.kind).toBe('darwin_ps_lstart');
    expect(typeof own.value).toBe('string');
    expect(own.value.length).toBeGreaterThan(4);
  }
  if (process.platform === 'win32') {
    const own = processStartIdentity(process.pid);
    expect(own.kind).toBe('windows_process_creation_filetime');
    expect(windowsFiletimeToUnixMilliseconds(own.value)).toBeNumber();
  }
  expect(processStartIdentity(process.pid, { platform: 'linux' })).toEqual({ kind: 'unknown' });
});

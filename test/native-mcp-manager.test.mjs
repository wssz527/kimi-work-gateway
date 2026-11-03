import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeMcpManager, findInstalledKernel, redactMcpServer } from '../src/native-mcp-manager.mjs';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// An isolated home plus a stand-in kernel file. The manager refuses to load a
// kernel that is not a real file, so every fake-client test has to name one:
// without it the manager falls back to `findInstalledKernel()`, which only
// succeeds on a machine that happens to have Kimi installed. The stand-in is
// empty on purpose — the injected `loadKernel` is what supplies the client.
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-mcp-'));
  roots.push(root);
  const kimiDir = path.join(root, 'kimi');
  fs.mkdirSync(path.join(kimiDir, 'runtime', 'kimi-code', 'home'), { recursive: true });
  const kernelPath = path.join(root, 'kernel.mjs');
  fs.writeFileSync(kernelPath, '// stand-in kernel: the injected loader provides the client\n');
  return { root, kimiDir, stateDir: path.join(root, 'state'), kernelPath };
}

const TOKEN = '{{SECRET_mp9c4t1z}}';
const HEADER_SECRET = '{{SECRET_hd7q3rm2}}';

// A stand-in kernel that keeps the same persistence shape the official client
// has: a name-keyed map, whole-object update, idempotent remove.
function fakeKernel(initial = {}) {
  const servers = new Map(Object.entries(initial).map(([name, value]) => [name, { name, ...value }]));
  const calls = [];
  const clients = [];
  const record = (method, ...args) => calls.push({ method, args });
  const client = {
    async listGlobalMcpServers() { record('list'); return [...servers.values()].map(entry => ({ ...entry })); },
    async addGlobalMcpServer(server) {
      record('add', server);
      if (servers.has(server.name)) throw Object.assign(Error('already exists'), { code: 'request.invalid' });
      servers.set(server.name, { ...server });
      return client.listGlobalMcpServers();
    },
    async updateGlobalMcpServer(server) {
      record('update', server);
      if (!servers.has(server.name)) throw Object.assign(Error('not found'), { code: 'mcp.server_not_found' });
      servers.set(server.name, { ...server });
      return client.listGlobalMcpServers();
    },
    async removeGlobalMcpServer(name) {
      record('remove', name);
      servers.delete(name);
      return client.listGlobalMcpServers();
    },
    async testGlobalMcpServer(name, options) {
      record('test', name, options);
      const entry = servers.get(name);
      if (!entry) throw Object.assign(Error('fresh install'), { code: 'mcp.server_not_found' });
      if (name === 'broken') return { success: false, output: 'Connection closed before initialize' };
      return { success: true, output: 'Connected to MCP server "' + name + '".\nAvailable tools: 2\n- echo: Echo text\n- status: Health' };
    },
    async close() { record('close'); },
  };
  return { calls, client, clients, servers,
    load: async () => ({ createKernelClient: options => { clients.push(options); return client; } }) };
}

describe('redaction', () => {
  test('state entries carry secret names, not secret values', () => {
    const state = redactMcpServer({ name: 'remote', transport: 'http',
      url: 'https://user:' + TOKEN + '@mcp.example.com/v1?api_key=' + TOKEN + '#frag',
      headers: { Authorization: 'Bearer ' + HEADER_SECRET }, bearerTokenEnvVar: 'MCP_TOKEN', enabledTools: ['echo'] });
    expect(state.url).toBe('https://mcp.example.com/v1');
    expect(state.headerNames).toEqual(['Authorization']);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain(HEADER_SECRET);
    expect(state.bearerTokenEnvVar).toBe('MCP_TOKEN');
  });

  test('an unrecognised transport is reported as unknown without borrowing another shape', () => {
    const state = redactMcpServer({ name: 'legacy', transport: 'websocket', url: 'wss://user:' + TOKEN + '@h/x?token=' + TOKEN, command: 'nc' });
    expect(state).toEqual({ name: 'legacy', transport: 'unknown', enabled: true });
  });

  test('stdio entries expose the command and an arg count but never arg text', () => {
    const state = redactMcpServer({ name: 'local', transport: 'stdio', command: 'npx', cwd: '/work',
      args: ['-y', 'server', '--token', TOKEN, '--api-key=' + TOKEN, '/work/' + TOKEN + '/tool'],
      env: { API_KEY: TOKEN, PLAIN: 'visible' }, enabled: false, startupTimeoutMs: 3000 });
    expect(state.command).toBe('npx');
    expect(state.args).toBeUndefined();
    expect(state.argsCount).toBe(6);
    expect(state.envNames).toEqual(['API_KEY', 'PLAIN']);
    expect(state.enabled).toBe(false);
    expect(state.startupTimeoutMs).toBe(3000);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(JSON.stringify(state)).not.toContain('server');
  });
});

describe('independent native MCP manager', () => {
  test('state lists native servers without launching anything', async () => {    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel({ local: { transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN } } });
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    const state = await manager.state();
    expect(state.available).toBe(true);
    expect(state.servers).toHaveLength(1);
    expect(state.servers[0].envNames).toEqual(['TOKEN']);
    expect(fake.calls.map(call => call.method)).toEqual(['list']);
    expect(path.join(kimiDir, 'runtime', 'kimi-code', 'home')).toBe(manager.nativeHome);
    await manager.close();
  });

  test('reports unavailable with an in-place reason when the kernel cannot be located', async () => {
    // This test must still fail for real: it names a path that does not exist,
    // so the manager's own file check refuses before any loader runs.
    const { kimiDir, stateDir } = workspace();
    const missing = new NativeMcpManager({ kimiDir, stateDir,
      loadKernel: async () => { throw Error('native_mcp_kernel_unavailable'); } , kernelPath: path.join(kimiDir, 'absent.mjs') });
    expect(await missing.state()).toEqual({ available: false, reason: 'native_mcp_kernel_unavailable', servers: [] });
    expect(await missing.add({ name: 'x', transport: 'stdio', command: 'node' }))
      .toMatchObject({ ok: false, state: 'unavailable', reason: 'native_mcp_kernel_unavailable' });
    await missing.close();

    const noDir = new NativeMcpManager({ kimiDir: path.join(kimiDir, 'nope'), stateDir, loadKernel: async () => ({}) });
    expect(await noDir.state()).toMatchObject({ available: false, reason: 'native_mcp_kimi_dir_unavailable', servers: [] });
    await noDir.close();

    fs.writeFileSync(path.join(kimiDir, 'kernel.mjs'), '// stand-in\n');
    const foreign = new NativeMcpManager({ kimiDir, stateDir, kernelPath: path.join(kimiDir, 'kernel.mjs'),
      loadKernel: async () => ({ createKernelClient: () => ({}) }) });
    expect(await foreign.state()).toMatchObject({ available: false, reason: 'native_mcp_kernel_incompatible' });
    await foreign.close();
  });

  test('add, update and remove go through the installed client and preserve omitted secrets', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });

    const added = await manager.add({ name: 'local', transport: 'stdio', command: 'node',
      args: ['server.mjs'], env: { API_TOKEN: TOKEN }, enabledTools: ['echo'], startupTimeoutMs: 4000 });
    expect(added.state).toBe('added');
    expect(added.server.envNames).toEqual(['API_TOKEN']);
    expect(JSON.stringify(added)).not.toContain(TOKEN);

    expect(await manager.add({ name: 'local', transport: 'stdio', command: 'node' }))
      .toEqual({ ok: false, state: 'exists', reason: 'native_mcp_server_exists', name: 'local' });

    const updated = await manager.update('local', { startupTimeoutMs: 9000 });
    expect(updated.state).toBe('updated');
    const stored = fake.servers.get('local');
    expect(stored.env).toEqual({ API_TOKEN: TOKEN });
    expect(stored.args).toEqual(['server.mjs']);
    expect(stored.enabledTools).toEqual(['echo']);
    expect(stored.startupTimeoutMs).toBe(9000);

    const cleared = await manager.update('local', { env: null, enabledTools: null });
    expect(cleared.state).toBe('updated');
    expect(fake.servers.get('local').env).toBeUndefined();

    // A patch omitting transport still edits the stored entry's own fields.
    expect((await manager.update('local', { args: ['other.mjs'], cwd: '/srv' })).state).toBe('updated');
    expect(fake.servers.get('local')).toMatchObject({ command: 'node', args: ['other.mjs'], cwd: '/srv' });
    expect((await manager.update('local', { command: '' })).field).toBe('command');
    expect((await manager.update('local', { url: 'https://example.com/mcp' })).field).toBe('url');
    expect((await manager.update('local', { headers: { Authorization: 'x' } })).field).toBe('headers');

    await manager.add({ name: 'remote', transport: 'http', url: 'https://example.com/mcp' });
    expect((await manager.update('remote', { headers: { Authorization: 'Bearer ' + TOKEN } })).state).toBe('updated');
    expect(fake.servers.get('remote').headers).toEqual({ Authorization: 'Bearer ' + TOKEN });
    expect((await manager.update('remote', { args: ['x'] })).field).toBe('args');

    expect(await manager.remove('local')).toEqual({ ok: true, state: 'removed', name: 'local' });
    expect(await manager.remove('local')).toEqual({ ok: true, state: 'absent', name: 'local' });
    expect(await manager.update('local', { startupTimeoutMs: 1000 }))
      .toMatchObject({ ok: false, state: 'not_found', name: 'local' });
    await manager.close();
  });

  test('test is explicit, redacted and bounded, and never runs during state', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel({ local: { transport: 'stdio', command: 'node', args: ['server.mjs'],
      env: { API_TOKEN: TOKEN } }, broken: { transport: 'stdio', command: 'node' } });
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    await manager.state();
    expect(fake.calls.some(call => call.method === 'test')).toBe(false);

    const tested = await manager.test('local');
    expect(tested).toMatchObject({ ok: true, state: 'connected', name: 'local', tools: ['echo', 'status'] });
    expect(tested.summary).toEqual({ toolCount: 2, declaredToolCount: 2 });
    expect(tested.detail.length).toBeLessThanOrEqual(1200);
    expect(fake.calls.filter(call => call.method === 'test')[0].args[1]).toEqual({});

    expect(await manager.test('broken')).toMatchObject({ ok: false, state: 'failed', reason: 'native_mcp_test_failed' });
    expect(await manager.test('missing')).toMatchObject({ ok: false, state: 'not_found' });
    await manager.close();
  });

  test('a server that echoes its own secret cannot leak it back through a test result', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    await manager.add({ name: 'local', transport: 'stdio', command: 'node',
      args: ['--region', 'eu-west-1'], env: { API_TOKEN: TOKEN } });
    const output = ['Connected to MCP server "local".', 'env API_TOKEN=' + TOKEN,
      'Authorization: Bearer ' + HEADER_SECRET, 'key sk-' + 'abcdefghijklmnop',
      'argv: eu-west-1'].join('\n');
    fake.client.testGlobalMcpServer = async () => ({ success: true, output });
    const result = await manager.test('local');
    expect(result).toMatchObject({ ok: true, state: 'connected', tools: [], summary: { toolCount: 0 } });
    expect(result.detail).not.toContain(TOKEN);
    expect(result.detail).not.toContain(HEADER_SECRET);
    expect(result.detail).not.toContain('sk-abcdefghijklmnop');
    // Args are scrubbed as exact values even though they are not secrets.
    expect(result.detail).not.toContain('eu-west-1');
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    await manager.close();
  });

  test('a stalled test is reported as timeout, never retried and never overlapped', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel({ local: { transport: 'stdio', command: 'node' } });
    let calls = 0;
    let release;
    const hanging = new Promise(resolve => { release = resolve; });
    fake.client.testGlobalMcpServer = () => { calls++; return hanging; };
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath, testTimeoutMs: 100 });
    try {
      expect(await manager.test('local')).toEqual({ ok: false, state: 'timeout', reason: 'native_mcp_test_timeout', name: 'local' });
      expect(calls).toBe(1);
      // The kernel probe is still running in the background; a second test must
      // not start another one on top of it.
      expect(await manager.test('local')).toEqual({ ok: false, state: 'busy', reason: 'native_mcp_test_in_progress', name: 'local' });
      expect(calls).toBe(1);
    } finally {
      release();
      await manager.close();
    }
    expect(fake.calls.filter(call => call.method === 'close')).toHaveLength(1);
  });

  test('short secrets are scrubbed exactly, not skipped for being short', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    const short = 'p1';
    await manager.add({ name: 'local', transport: 'stdio', command: 'node', env: { PW: short } });
    fake.client.testGlobalMcpServer = async () => ({ success: true, output: 'Connected. env PW=' + short + ' x' });
    const result = await manager.test('local');
    expect(result.state).toBe('connected');
    expect(result.detail).not.toContain('=' + short);
    expect(JSON.stringify(result)).not.toContain('PW=' + short);
    await manager.close();
  });

  test('a native error message is never echoed back, whatever it contains', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    // The kernel may put a rejected env value straight into its message.
    fake.client.addGlobalMcpServer = async () => {
      throw Object.assign(Error('Invalid MCP server "x": env.PW must not be "p1"'), { code: 'config.invalid' });
    };
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    const result = await manager.add({ name: 'x', transport: 'stdio', command: 'node', env: { PW: 'p1' } });
    expect(result).toEqual({ ok: false, state: 'invalid', reason: 'native_mcp_invalid_input', code: 'config.invalid' });
    expect(JSON.stringify(result)).not.toContain('p1');

    fake.client.addGlobalMcpServer = async () => { throw Error('EACCES: /home/u/secret-path'); };
    expect(await manager.add({ name: 'x', transport: 'stdio', command: 'node' }))
      .toEqual({ ok: false, state: 'unavailable', reason: 'native_mcp_operation_failed' });
    await manager.close();
  });

  test('the kernel client is created with the Work runtime home and its config', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    await manager.state();
    expect(fake.clients).toHaveLength(1);
    expect(fake.clients[0]).toMatchObject({
      homeDir: path.join(kimiDir, 'runtime', 'kimi-code', 'home'),
      configPath: path.join(kimiDir, 'runtime', 'kimi-code', 'home', 'config.toml'),
    });
    expect(fake.clients[0].identity).toMatchObject({ productName: 'Kimi Work Gateway', platform: process.platform });
    await manager.close();
  });

  test('malformed input is rejected before the kernel is touched', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    const cases = [
      [{ name: '../escape', transport: 'stdio', command: 'node' }, 'name'],
      [{ name: ' padded', transport: 'stdio', command: 'node' }, 'name'],
      [{ name: 'x', transport: 'websocket', url: 'http://127.0.0.1:1' }, 'transport'],
      [{ name: 'x', transport: 'stdio', command: '' }, 'command'],
      [{ name: 'x', transport: 'stdio', command: 'node', shell: true }, 'shell'],
      [{ name: 'x', transport: 'stdio', command: 'node', env: { 'BAD-NAME': 'v' } }, 'env'],
      [{ name: 'x', transport: 'http', url: 'ftp://example.com/mcp' }, 'url'],
      [{ name: 'x', transport: 'http', url: 'https://user:' + TOKEN + '@example.com/mcp' }, 'url'],
      [{ name: 'x', transport: 'http', url: 'https://example.com/mcp', headers: { 'Bad Header': 'v' } }, 'headers'],
      [{ name: 'x', transport: 'http', url: 'https://example.com/mcp', startupTimeoutMs: 0 }, 'startupTimeoutMs'],
      [{ name: 'x', transport: 'http', url: 'https://example.com/mcp', startupTimeoutMs: 1.5 }, 'startupTimeoutMs'],
      [{ name: 'x', transport: 'stdio', command: 'node', enabledTools: [1] }, 'enabledTools'],
    ];
    for (const [input, field] of cases) {
      const result = await manager.add(input);
      expect(result).toMatchObject({ ok: false, state: 'invalid', reason: 'native_mcp_invalid_input', field });
    }
    const prototypePollution = JSON.parse('{"name":"x","transport":"stdio","command":"node","env":{"__proto__":"v"}}');
    expect(await manager.add(prototypePollution)).toMatchObject({ ok: false, state: 'invalid', field: 'env' });
    expect(await manager.add(null)).toMatchObject({ ok: false, state: 'invalid' });
    expect(await manager.add('local')).toMatchObject({ ok: false, state: 'invalid' });
    expect(await manager.update('local', { transport: 'stdio', command: 'node', extra: 1 }))
      .toMatchObject({ ok: false, state: 'invalid', field: 'extra' });
    expect(await manager.update('local', { name: 'other' })).toMatchObject({ ok: false, field: 'name' });
    expect(await manager.update('bad name', { startupTimeoutMs: 1 })).toMatchObject({ ok: false, field: 'name' });
    expect(await manager.remove('')).toMatchObject({ ok: false, field: 'name' });
    expect(await manager.test('../escape')).toMatchObject({ ok: false, field: 'name' });
    expect(await manager.test('local', { cwd: 'relative/path' })).toMatchObject({ ok: false, field: 'cwd' });
    expect(fake.calls).toEqual([]);
    await manager.close();
  });

  test('a closed manager reports closed and close is idempotent', async () => {
    const { kimiDir, stateDir, kernelPath } = workspace();
    const fake = fakeKernel();
    const manager = new NativeMcpManager({ kimiDir, stateDir, loadKernel: fake.load, kernelPath });
    await manager.state();
    await manager.close();
    expect(fake.calls.filter(call => call.method === 'close')).toHaveLength(1);
    expect(await manager.state()).toMatchObject({ available: false, reason: 'native_mcp_manager_closed' });
    expect(await manager.add({ name: 'x', transport: 'stdio', command: 'node' }))
      .toMatchObject({ ok: false, state: 'closed' });
    await manager.close();
    expect(fake.calls.filter(call => call.method === 'close')).toHaveLength(1);
  });
});

// --- installed kernel ------------------------------------------------------

const kernelPath = findInstalledKernel();
const installed = Boolean(kernelPath) && process.platform === 'darwin' && fs.existsSync(kernelPath);

// The smallest real MCP stdio server: newline-delimited JSON-RPC 2.0, no
// dependencies and no network. Writing it into the isolated root keeps the
// evidence real — the native kernel launches a separate process, which a fake
// client never does.
const FIXTURE_SOURCE = `import fs from 'node:fs';
if (process.argv[2]) fs.appendFileSync(process.argv[2], 'launched\\n');
const tools = [
  { name: 'echo', description: 'Echo the provided text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'status', description: 'Fixture health probe', inputSchema: { type: 'object', properties: {} } },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\\r$/, '').trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...value }) + '\\n');
    if (message.method === 'initialize') {
      send({ result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'native-mcp-fixture', version: '1.0.0' } } });
    } else if (message.method === 'tools/list') {
      send({ result: { tools } });
    } else if (message.method === 'ping') {
      send({ result: {} });
    } else {
      send({ error: { code: -32601, message: 'Method not found: ' + message.method } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

test.skipIf(!installed)('the installed kernel owns isolated CRUD and an explicit local stdio probe', async () => {
  const { root, kimiDir, stateDir } = workspace();
  const fixture = path.join(root, 'native-mcp-server.mjs');
  // The fixture records each launch, so the assertions below can prove that
  // only the explicit `test` started it.
  const launches = path.join(root, 'launches.log');
  fs.writeFileSync(fixture, FIXTURE_SOURCE);
  const manager = new NativeMcpManager({ kimiDir, stateDir });
  try {
    const launchCount = () => (fs.existsSync(launches) ? fs.readFileSync(launches, 'utf8').trim().split('\n').filter(Boolean).length : 0);
    expect(await manager.state()).toEqual({ available: true, servers: [] });
    expect(launchCount()).toBe(0);

    const added = await manager.add({ name: 'fixture-local', transport: 'stdio', command: process.execPath,
      args: [fixture, launches], env: { FIXTURE_TOKEN: TOKEN }, enabledTools: ['echo'], startupTimeoutMs: 15000, toolTimeoutMs: 15000 });
    expect(added.state).toBe('added');
    expect(JSON.stringify(added)).not.toContain(TOKEN);
    expect(added.server.args).toBeUndefined();
    expect(added.server.argsCount).toBe(2);

    const persisted = JSON.parse(fs.readFileSync(path.join(kimiDir, 'runtime', 'kimi-code', 'home', 'mcp.json'), 'utf8'));
    expect(persisted.mcpServers['fixture-local'].env).toEqual({ FIXTURE_TOKEN: TOKEN });
    expect(persisted.mcpServers['fixture-local'].enabledTools).toEqual(['echo']);

    expect((await manager.update('fixture-local', { startupTimeoutMs: 12000 })).state).toBe('updated');
    const afterUpdate = await manager.state();
    expect(afterUpdate.servers[0]).toMatchObject({ name: 'fixture-local', transport: 'stdio', startupTimeoutMs: 12000, argsCount: 2 });
    expect(afterUpdate.servers[0].envNames).toEqual(['FIXTURE_TOKEN']);
    expect(launchCount()).toBe(0);

    const tested = await manager.test('fixture-local', { cwd: root, timeoutMs: 20000 });
    expect(tested).toMatchObject({ ok: true, state: 'connected', name: 'fixture-local' });
    expect(tested.tools).toEqual(['echo', 'status']);
    expect(tested.summary).toEqual({ toolCount: 2, declaredToolCount: 2 });
    expect(launchCount()).toBe(1);

    expect(await manager.remove('fixture-local')).toEqual({ ok: true, state: 'removed', name: 'fixture-local' });
    expect(await manager.state()).toEqual({ available: true, servers: [] });
    expect(launchCount()).toBe(1);
  } finally {
    await manager.close();
  }
}, 120000);

// Creating the native client loads the desktop's own config and providers. If
// that alone launched a configured stdio server, `state()` would start external
// processes just by being read. Verified against the installed kernel: it does
// not, so the manager can keep `state()` a pure read.
test.skipIf(!installed)('creating the native client and listing never launches a configured server', async () => {
  const { root, kimiDir, stateDir } = workspace();
  const nativeHome = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
  const marker = path.join(root, 'launched.log');
  const child = path.join(nativeHome, 'child.mjs');
  fs.writeFileSync(child, [
    "import fs from 'node:fs';",
    'fs.appendFileSync(' + JSON.stringify(marker) + ", 'launched\\n');",
    'process.stdin.resume();',
    "process.stdin.on('end', () => process.exit(0));",
  ].join('\n'));
  fs.writeFileSync(path.join(nativeHome, 'mcp.json'), JSON.stringify({ mcpServers: {
    probe: { transport: 'stdio', command: process.execPath, args: [child], startupTimeoutMs: 4000 },
  } }));
  const manager = new NativeMcpManager({ kimiDir, stateDir });
  try {
    const state = await manager.state();
    expect(state.available).toBe(true);
    expect(state.servers.map(server => server.name)).toEqual(['probe']);
    await new Promise(resolve => setTimeout(resolve, 1500));
    expect(fs.existsSync(marker)).toBe(false);
  } finally {
    await manager.close();
  }
  expect(fs.existsSync(marker)).toBe(false);
}, 60000);

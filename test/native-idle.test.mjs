import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confirmLiveIdle, identityOf, probeLiveIdle, runnerSnapshot } from '../src/native-idle.mjs';
import { controlEndpoint, processStartIdentity } from '../src/native-control.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';
import { controlServer } from './fixtures/native-control-server.mjs';

const roots = [];
const servers = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const START = 'Mon Oct 12 10:35:49 2026';

// A synthetic daemon: one agent, one page of conversations, all idle.
function daemon({ token, busy = {}, pages, operations = 0, runnerPath = null, generation = 'synthetic-generation-1',
  startIdentity = { kind: 'darwin_ps_lstart', value: START } } = {}) {
  const seen = [];
  const handler = input => {
    seen.push(input);
    if (input.method === 'capabilities.get') return { result: { protocolVersion: 1 } };
    if (input.method === 'runtime.status') {
      return { result: { checkedAt: new Date().toISOString(), operations: { activeCount: operations },
        layout: { agents: { defaultAgentId: 'main', entries: [{ agentId: 'main', runnerStatePath: runnerPath }] } } } };
    }
    if (input.method === 'conversations.list') {
      const list = pages || [{ conversations: [{ conversationKey: 'alpha' }, { conversationKey: 'beta' }],
        page: { hasMore: false } }];
      const index = input.params.cursor === undefined ? 0 : Number(input.params.cursor);
      return { result: list[index] || { conversations: [], page: { hasMore: false } } };
    }
    if (input.method === 'conversations.getBusy') {
      return { result: { conversationKey: input.params.conversationKey, busy: busy[input.params.conversationKey] === true } };
    }
    return { result: {} };
  };
  return { handler, seen };
}

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-idle-'));
  roots.push(root);
  const kimiDir = path.join(root, 'kimi');
  const runnerPath = path.join(kimiDir, 'agents', 'main', 'runner.state.json');
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  return { root, kimiDir, runnerPath, ...options };
}

async function running({ state = {}, ...options } = {}) {
  const f = fixture();
  const token = 'probe-token';
  const daemonOptions = daemon({ token, ...options });
  const server = await controlServer({ token, handler: daemonOptions.handler });
  servers.push(server);
  const base = {
    schemaVersion: 1, lifecycleStatus: 'running',
    // The whole point: an old snapshot is still the current event state.
    updatedAt: '2026-10-31T14:26:07.209Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: server.url, host: '127.0.0.1', port: server.port, pid: 28928,
      auth: { mode: 'bearer', token } } },
    daemonGeneration: { generationId: 'synthetic-generation-1', pid: 28928,
      processStartIdentity: { kind: 'darwin_ps_lstart', value: START } },
    ...state,
  };
  // The layout path is what the daemon reports; default it to the real file.
  if (!daemonOptions.seen) {}
  writeSubagentJSON(f.runnerPath, base);
  return { ...f, server, token, written: base, seen: daemonOptions.seen, port: server.port };
}

const identity = () => ({ kind: 'darwin_ps_lstart', value: START });

test('an hours-old idle snapshot is still idle: age is not evidence', () => {
  expect(runnerSnapshot({ lifecycleStatus: 'running', updatedAt: '2020-01-01T00:00:00Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [] }))
    .toMatchObject({ state: 'idle' });
  expect(runnerSnapshot({ lifecycleStatus: 'running', updatedAt: '2020-01-01T00:00:00Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [{}] }))
    .toMatchObject({ state: 'busy', active: 1 });
  expect(runnerSnapshot({ lifecycleStatus: 'idle', activeKernelTurns: [], activeKernelToolCalls: [],
    activeOperations: [], activePendingInteractions: [] })).toMatchObject({ state: 'busy' });
  // Every collection is required; a missing one is unknown, never zero.
  expect(runnerSnapshot({ lifecycleStatus: 'running', activeKernelTurns: [], activeKernelToolCalls: [],
    activeOperations: [] })).toMatchObject({ state: 'unknown', missing: 'activePendingInteractions' });
  expect(runnerSnapshot(null)).toMatchObject({ state: 'unknown' });
});

test('a complete live evidence chain makes an old snapshot provably idle', async () => {
  const f = await running();
  // Point the daemon layout at the real runner file for this fixture.
  const server = f.server;
  const token = f.token;
  servers.push(await controlServer({ token: 'unused', handler: () => ({ result: {} }) }));
  const result = await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: endpoint => {
    const client = controlEndpoint({ control: { endpoint: { url: server.url, pid: 28928, auth: { token } } } });
    return new (class {
      async connect() {}
      async send(method, params) { return handlerFor(f)(method, params); }
      close() {}
    })();
  } });
  expect(result.state).toBe('idle');
  expect(result.generationId).toBe('synthetic-generation-1');
});

// The handler used by the fake client: same daemon answers, no socket needed.
function handlerFor(f) {
  return (method, params) => {
    if (method === 'runtime.status') {
      return { checkedAt: new Date().toISOString(), operations: { activeCount: 0 },
        layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } };
    }
    if (method === 'conversations.list') {
      return { conversations: [{ conversationKey: 'alpha' }], page: { hasMore: false } };
    }
    if (method === 'conversations.getBusy') return { conversationKey: params.conversationKey, busy: false };
    return {};
  };
}

test('an idle report needs the running status, zero operations and matching layout', async () => {
  const f = fixture();
  const build = state => {
    writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running',
      updatedAt: '2020-01-01T00:00:00Z', activeKernelTurns: [], activeKernelToolCalls: [],
      activeOperations: [], activePendingInteractions: [],
      control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } },
      daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } },
      ...state });
  };
  const client = answer => new (class {
    async connect() {}
    async send(method, params) { return answer(method, params); }
    close() {}
  })();
  build({});
  const good = method => (method === 'runtime.status'
    ? { operations: { activeCount: 0 }, layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } }
    : { conversations: [{ conversationKey: 'a' }], page: { hasMore: false }, conversationKey: 'a', busy: false });
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => client(good) })).state).toBe('idle');

  const cases = [
    [method => (method === 'runtime.status' ? { operations: { activeCount: 2 },
      layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } } : { conversations: [], page: { hasMore: false } }),
      'native_idle_operations_active'],
    [method => (method === 'runtime.status' ? { layout: { agents: { entries: [] } } } : {}), 'native_idle_operations_unknown'],
    [method => (method === 'runtime.status' ? { operations: { activeCount: 0 },
      layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: '/somewhere/else/runner.state.json' }] } } } : {}),
      'native_idle_layout_mismatch'],
    [method => (method === 'runtime.status' ? { operations: { activeCount: 0 },
      layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } }
      : method === 'conversations.getBusy' ? { conversationKey: 'a', busy: true }
        : { conversations: [{ conversationKey: 'a' }], page: { hasMore: false } }), 'native_idle_conversation_busy'],
    [method => (method === 'runtime.status' ? { operations: { activeCount: 0 },
      layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } }
      : method === 'conversations.getBusy' ? { conversationKey: 'a' }
        : { conversations: [{ conversationKey: 'a' }], page: { hasMore: false } }), 'native_idle_busy_invalid'],
  ];
  for (const [answer, reason] of cases) {
    const result = await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => client(answer) });
    expect(result.state).not.toBe('idle');
    expect(result.reason).toBe(reason);
  }
});

test('pagination must terminate and every page is enumerated', async () => {
  const f = fixture();
  writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running', updatedAt: 'x',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } },
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
  const make = pages => new (class {
    async connect() {}
    async send(method, params) {
      if (method === 'runtime.status') {
        return { operations: { activeCount: 0 }, layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } };
      }
      if (method === 'conversations.list') return pages[params.cursor === undefined ? 0 : pages.length - 1] ?? pages[0];
      if (method === 'conversations.getBusy') return { conversationKey: params.conversationKey, busy: false };
      return {};
    }
    close() {}
  })();
  const twoPages = [
    { conversations: [{ conversationKey: 'a' }], page: { hasMore: true, nextCursor: '2' } },
    { conversations: [{ conversationKey: 'b' }], page: { hasMore: false } },
  ];
  const result = await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => make(twoPages) });
  expect(result.state).toBe('idle');
  for (const [pages, reason] of [
    [[{ conversations: [], page: { hasMore: true } }], 'native_idle_conversations_incomplete'],
    [[{ conversations: [], page: {} }], 'native_idle_conversations_incomplete'],
  ]) {
    const value = await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => make(pages) });
    expect(value.reason).toBe(reason);
  }
});

test('a changed or unverifiable process identity is never idle', async () => {
  const f = fixture();
  writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running', updatedAt: 'x',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } },
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity: () => ({ kind: 'darwin_ps_lstart', value: 'other' }),
    clientFactory: () => { throw Error('must not connect'); } })).reason).toBe('native_idle_process_identity_mismatch');
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity: () => ({ kind: 'unknown', value: null }),
    clientFactory: () => { throw Error('must not connect'); } })).reason).toBe('native_idle_process_identity_unknown');
  // Generation pid and control endpoint pid have to agree before anything else.
  writeSubagentJSON(f.runnerPath, { ...readSubagentJSON(f.runnerPath), control: { endpoint: {
    url: 'ws://127.0.0.1:1/control', pid: 2, auth: { token: 't' } } } });
  expect(identityOf(readSubagentJSON(f.runnerPath))).toBe(null);
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity,
    clientFactory: () => { throw Error('must not connect'); } })).reason).toBe('native_idle_identity_invalid');
});

test('an unstable generation across the reading is not idle, and a missing file is unknown', async () => {
  const f = fixture();
  writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running', updatedAt: 'x',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } },
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
  const rewriting = new (class {
    async connect() {}
    async send(method, params) {
      if (method === 'runtime.status') {
        // The daemon restarts between the two reads.
        writeSubagentJSON(f.runnerPath, { ...readSubagentJSON(f.runnerPath),
          daemonGeneration: { generationId: 'g2', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
        return { operations: { activeCount: 0 }, layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } };
      }
      if (method === 'conversations.list') return { conversations: [], page: { hasMore: false } };
      return {};
    }
    close() {}
  })();
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => rewriting })).reason)
    .toBe('native_idle_identity_changed');
  fs.rmSync(f.runnerPath);
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, identity })).reason).toBe('native_idle_runner_absent');
});

// Exercises the default client factory against a real socket. A factory that
// forgets to pass the parsed endpoint connects to nothing, which is exactly the
// defect that only shows up outside an injected client.
test('the default client factory connects to the endpoint it was given', async () => {
  const f = fixture();
  const token = 'default-path-token';
  const pages = [{ conversations: [{ conversationKey: 'alpha' }], page: { hasMore: false } }];
  const server = await controlServer({ token, handler: input => {
    if (input.method === 'runtime.status') {
      return { result: { checkedAt: new Date().toISOString(), operations: { activeCount: 0 },
        layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } } };
    }
    if (input.method === 'conversations.list') return { result: pages[0] };
    if (input.method === 'conversations.getBusy') return { result: { conversationKey: input.params.conversationKey, busy: false } };
    return { result: {} };
  } });
  servers.push(server);
  writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running', updatedAt: '2020-01-01T00:00:00Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: server.url, pid: 28928, auth: { mode: 'loopback-dev-token', token } } },
    daemonGeneration: { generationId: 'g', pid: 28928, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
  const result = await probeLiveIdle({ kimiDir: f.kimiDir, identity });
  expect(result.state).toBe('idle');
  expect(result.pid).toBe(28928);
});

test('a stopped daemon is idle only with zero activity, a dead generation and a stable snapshot', async () => {
  const f = fixture();
  const state = { schemaVersion: 1, lifecycleStatus: 'stopped', updatedAt: '2026-11-01T12:36:43.770Z',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } };
  writeSubagentJSON(f.runnerPath, state);
  const absent = () => ({ kind: 'not_found', value: null });
  const noClient = () => { throw Error('must not connect'); };
  expect(await probeLiveIdle({ kimiDir: f.kimiDir, identity: absent, clientFactory: noClient }))
    .toMatchObject({ state: 'idle', generationId: 'g', pid: 1, evidence: 'daemon-stopped' });

  expect(await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: noClient }))
    .toMatchObject({ state: 'unknown', reason: 'native_idle_process_still_running' });
  writeSubagentJSON(f.runnerPath, { ...state, activeKernelTurns: [{}] });
  expect(await probeLiveIdle({ kimiDir: f.kimiDir, identity: absent, clientFactory: noClient }))
    .toMatchObject({ state: 'busy', reason: 'native_idle_runner_active' });

  writeSubagentJSON(f.runnerPath, state);
  expect(await probeLiveIdle({ kimiDir: f.kimiDir, clientFactory: noClient, identity: () => {
    writeSubagentJSON(f.runnerPath, { ...state,
      daemonGeneration: { ...state.daemonGeneration, generationId: 'g2' } });
    return absent();
  } })).toMatchObject({ state: 'unknown', reason: 'native_idle_identity_changed' });
});

test('a Windows identity binds through FILETIME and a dead pid stops waiting as not_found', async () => {
  const f = fixture();
  const write = () => writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running',
    updatedAt: '2020-01-01T00:00:00Z', activeKernelTurns: [], activeKernelToolCalls: [],
    activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 't' } } },
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: {
      kind: 'windows_process_creation_filetime', value: '134379595770000000' } } });
  write();
  const client = () => new (class {
    async connect() {}
    async send(method, params) {
      if (method === 'runtime.status') {
        return { operations: { activeCount: 0 }, layout: { agents: { entries: [{ agentId: 'main', runnerStatePath: f.runnerPath }] } } };
      }
      if (method === 'conversations.list') return { conversations: [], page: { hasMore: false } };
      return { conversationKey: params.conversationKey, busy: false };
    }
    close() {}
  })();
  // A matching Windows FILETIME is a real binding, so the probe can reach idle.
  const windows = (pid, options) => processStartIdentity(pid, { ...options, platform: 'win32',
    run: () => ({ status: 0, stdout: '134379595770000000' }) });
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, platform: 'win32', identity: windows, clientFactory: client })).state)
    .toBe('idle');
  // A pid that no longer exists is its own answer, distinct from "unreadable".
  const missing = (pid, options) => processStartIdentity(pid, { ...options, platform: 'win32',
    run: () => ({ status: 3, stdout: '', stderr: '' }) });
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, platform: 'win32', identity: missing, clientFactory: client })).reason)
    .toBe('native_idle_process_not_found');
  // An unreadable identity still waits.
  const denied = (pid, options) => processStartIdentity(pid, { ...options, platform: 'win32',
    run: () => ({ status: 4, stdout: '', stderr: '' }) });
  expect((await probeLiveIdle({ kimiDir: f.kimiDir, platform: 'win32', identity: denied, clientFactory: client })).reason)
    .toBe('native_idle_process_identity_unknown');
});

test('a transport failure is unknown, never idle, and leaks no detail', async () => {  const f = fixture();
  writeSubagentJSON(f.runnerPath, { schemaVersion: 1, lifecycleStatus: 'running', updatedAt: 'x',
    activeKernelTurns: [], activeKernelToolCalls: [], activeOperations: [], activePendingInteractions: [],
    control: { endpoint: { url: 'ws://127.0.0.1:1/control', pid: 1, auth: { token: 'private-token' } } },
    daemonGeneration: { generationId: 'g', pid: 1, processStartIdentity: { kind: 'darwin_ps_lstart', value: START } } });
  const result = await probeLiveIdle({ kimiDir: f.kimiDir, identity, clientFactory: () => ({
    async connect() { const error = Error('native_control_refused'); error.code = 'native_control_refused'; throw error; },
    close() {},
  }) });
  expect(result.state).toBe('unknown');
  expect(result.reason).toBe('native_control_refused');
  expect(JSON.stringify(result)).not.toContain('private-token');
});

test('confirmLiveIdle requires two agreeing probes before it reports idle', async () => {
  let calls = 0;
  const probe = async () => {
    calls += 1;
    return calls === 1 ? { state: 'idle', generationId: 'g' } : { state: 'busy', reason: 'native_idle_conversation_busy' };
  };
  // The second reading disagrees, so nothing is confirmed.
  expect((await confirmLiveIdle({ kimiDir: '/nope' }, { attempts: 2, probe })).state).not.toBe('idle');
  calls = 0;
  const stable = async () => ({ state: 'idle', generationId: 'g' });
  expect(await confirmLiveIdle({ kimiDir: '/nope' }, { attempts: 2, probe: stable }))
    .toMatchObject({ state: 'idle', consecutive: 2 });
});

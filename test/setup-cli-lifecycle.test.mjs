import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const workspace = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-setup-cli-')); roots.push(root); return root; };
const result = (service, panel = { state: 'ready', entryURL: 'http://127.0.0.1:1/#key=synthetic' }) => ({
  state: { configuration: { file: 'gateway.json' }, models: [{ id: 'test' }] },
  gateway: { port: 3426 }, service, panel,
});

for (const pending of ['failed', 'waiting']) test('setup keeps the page alive after a ' + pending + ' service result', async () => {
  const stateDir = workspace(); let closed = false, retryObserved = false;
  class Server {
    constructor(options) { this.options = options; }
    async start() {
      setTimeout(() => {
        this.options.onSaved(result({ state: pending }, { state: pending === 'waiting' ? 'waiting' : 'manual' }));
        setTimeout(() => {
          retryObserved = !closed;
          this.options.onSaved(result({ state: 'installed' }));
        }, 10);
      }, 0);
      return 'http://127.0.0.1:1/#key=setup';
    }
    async stop() { closed = true; }
  }
  const output = [];
  expect(await run(['setup', '--state-dir', stateDir, '--no-open'], {},
    { out: value => output.push(value), err() {} }, { SetupServer: Server })).toBe(0);
  expect(retryObserved).toBe(true);
  expect(closed).toBe(true);
  expect(output).toContain('panel http://127.0.0.1:1/#key=synthetic');
});

test('saving over an installed service requests a supervised restart and waits for a fresh panel entry', async () => {
  const stateDir = workspace(); const actions = []; let installed;
  class Service {
    install() { return { state: 'unchanged', kind: 'launchd' }; }
    start() { throw Error('must_not_start_a_live_service'); }
  }
  class Server {
    constructor(options) { this.options = options; }
    async start() {
      setTimeout(async () => {
        installed = await this.options.installService();
        this.options.onSaved(result(installed));
      }, 0);
      return 'http://127.0.0.1:1/#key=setup';
    }
    async stop() {}
  }
  const code = await run(['setup', '--state-dir', stateDir, '--no-open'], {}, { out() {}, err() {} }, {
    SetupServer: Server, GatewayService: Service,
    inspectRunner: () => ({ runnerAlive: true }),
    requestRunner: async request => { actions.push(request.action); return { state: 'restarted' }; },
  });
  expect(code).toBe(0);
  expect(actions).toEqual(['restart']);
  expect(installed).toEqual({ state: 'started', kind: 'launchd', needsFreshEntry: true });
});

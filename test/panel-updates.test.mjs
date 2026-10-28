import { afterEach, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../cli.mjs';
import { readConfig } from '../src/config.mjs';
import { KimiWorkGateway } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';
import { PanelController } from '../src/panel-controller.mjs';
import { GatewayPanel } from '../src/panel.mjs';
import { SubagentPolicy } from '../src/subagent-policy.mjs';

const fixtures = [];
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-panel-updates-'));
  const configFile = path.join(dir, 'gateway.json');
  const config = readConfig({ upstream: { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'UPDATE_TEST_KEY' },
    tokenEnv: 'UPDATE_TEST_TOKEN', models: [{ id: 'kimi-update-parent', protocol: 'chat', contextWindow: 32768, tools: true }] });
  fs.writeFileSync(configFile, JSON.stringify(config));
  const backend = new OpenAIBackend({ ...config.upstream, apiKey: 'synthetic-update-key', models: config.models });
  const gateway = new KimiWorkGateway({ backend });
  await gateway.configure({ key: 'synthetic-update-token', port: 0 });
  const policy = new SubagentPolicy({ stateDir: dir, kimiDir: path.join(dir, 'kimi') });
  policy.configure(undefined, config.models);
  const calls = [];
  let status = { currentVersion: '0.6.0', state: 'not-checked' };
  const updater = {
    inspect: () => ({ ...status }),
    async check() { calls.push('check'); status = { ...status, state: 'available', latestVersion: '0.6.1', checkedAt: Date.now(),
      releaseURL: 'https://github.com/wssz527/kimi-work-gateway/releases/tag/v0.6.1' }; return this.inspect(); },
    async install() { calls.push('install'); status = { ...status, state: 'staged', pendingVersion: '0.6.1', rollbackVersion: '0.6.0' }; return this.inspect(); },
    async rollback() { calls.push('rollback'); status = { ...status, state: 'staged', pendingVersion: '0.6.0' }; return this.inspect(); },
  };
  const controller = new PanelController({ configFile, config, gateway, backend, stateDir: dir, kimiDir: path.join(dir, 'kimi'), policy, updater,
    runtime: { inspect: () => ({ state: 'not-prepared' }) }, probe: { check: async () => ({ revealed: false, intranet: { passed: false } }) } });
  const panel = new GatewayPanel({ controller }); await panel.start({ port: 0 });
  const f = { dir, controller, panel, policy, gateway, updater, calls }; fixtures.push(f); return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.panel.stop(); await f.controller.close(); f.policy.close(); await f.gateway.stop();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
const intent = action => ({ id: crypto.randomUUID(), at: Date.now(), action });
const request = (f, route, body, headers = {}) => fetch(f.panel.url + route, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { Authorization: 'Bearer ' + f.panel.key, Origin: f.panel.url,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
});
async function perform(f, operation) {
  const response = await request(f, '/api/actions', operation);
  expect(response.status).toBe(202); await f.controller.operationTask;
  return (await (await request(f, '/api/state')).json());
}

test('authenticated update actions expose current and pending versions separately and deduplicate downloads', async () => {
  const f = await fixture();
  expect((await (await request(f, '/api/state')).json()).updates).toEqual({ currentVersion: '0.6.0', state: 'not-checked' });
  const checked = await perform(f, intent('check-update'));
  expect(checked.updates).toMatchObject({ currentVersion: '0.6.0', latestVersion: '0.6.1', state: 'available' });
  const install = intent('install-update');
  const staged = await perform(f, install);
  expect(staged.operation.state).toBe('staged');
  expect(staged.updates).toMatchObject({ currentVersion: '0.6.0', pendingVersion: '0.6.1', rollbackVersion: '0.6.0', state: 'staged' });
  await perform(f, install);
  expect(f.calls).toEqual(['check', 'install']);
  const conflict = await request(f, '/api/actions', { ...install, action: 'rollback-update' });
  expect(conflict.status).toBe(409);
  expect((await perform(f, intent('rollback-update'))).updates.pendingVersion).toBe('0.6.0');
});

test('failed update checks keep the inference listener available and reject unauthorised update writes', async () => {
  const f = await fixture();
  f.updater.check = async () => { throw Error('update_network_error'); };
  const state = await perform(f, intent('check-update'));
  expect(state.operation).toMatchObject({ state: 'failed', reason: 'update_network_error' });
  expect((await fetch(f.gateway.url + '/models', { headers: { Authorization: 'Bearer synthetic-update-token' } })).status).toBe(200);
  expect((await request(f, '/api/actions', intent('install-update'), { Authorization: '' })).status).toBe(401);
  expect((await request(f, '/api/actions', intent('install-update'), { Origin: 'https://untrusted.example' })).status).toBe(403);
  expect(f.calls).toEqual([]);
});

test('CLI update commands work without upstream credentials and sanitise unexpected errors', async () => {
  const calls = [], out = [], err = [];
  class Updater {
    constructor(options) { expect(options.updateDir).toBe(path.resolve(os.tmpdir(), 'synthetic-update-cli')); }
    async check() { calls.push('check'); return { currentVersion: '0.6.0', state: 'available', latestVersion: '0.6.1' }; }
    async install() { calls.push('install'); return { currentVersion: '0.6.0', state: 'staged', pendingVersion: '0.6.1' }; }
    async rollback() { throw Error('https://untrusted.example/private?credential=synthetic'); }
  }
  const env = { KIMI_WORK_GATEWAY_UPDATE_DIR: path.resolve(os.tmpdir(), 'synthetic-update-cli') };
  const io = { out: value => out.push(value), err: value => err.push(value) };
  for (const command of ['check-update', 'update']) expect(await run([command], env, io, { GatewayUpdater: Updater })).toBe(0);
  expect(calls).toEqual(['check', 'install']);
  expect(JSON.parse(out.at(-1))).toMatchObject({ currentVersion: '0.6.0', state: 'staged', pendingVersion: '0.6.1' });
  expect(await run(['rollback-update'], env, io, { GatewayUpdater: Updater })).toBe(3);
  expect(err.at(-1)).toContain('update_failed'); expect(err.join(' ')).not.toContain('credential=');
});

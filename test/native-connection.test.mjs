import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeDesktopRuntime } from '../src/native-desktop-runtime.mjs';
import { createNativeConnection } from '../src/native-connection.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-connection-')); roots.push(root);
  const calls = [];
  let enabled = false;
  const supervisor = { inspect: () => ({ enabled }), start: options => { enabled = true; calls.push(['start', options]); return { state: 'starting' }; },
    ensure: () => { calls.push(['ensure']); return { state: 'inactive' }; }, close: () => { calls.push(['close']); }, stop: () => { enabled = false; calls.push(['stop']); } };
  const runtime = { configure: value => calls.push(['configure', value]), desiredSettings() { throw Object.assign(Error(), { code: 'ENOENT' }); } };
  return { stateDir: root, kimiDir: path.join(root, 'kimi'), calls, supervisor, runtime };
}

test('first connection starts once; subsequent recovery preserves intent and does not request another launch', async () => {
  const env = fixture(); const desktop = new NativeDesktopRuntime(env);
  expect((await desktop.ensure()).state).toBe('starting');
  expect(env.calls).toEqual([['configure', { enabled: false }], ['start', { takeover: true, controlOnly: true }]]);
  env.calls.length = 0;
  expect((await desktop.ensure()).state).toBe('inactive');
  expect(env.calls).toEqual([['ensure']]);
  desktop.close(); expect(desktop.inspect().enabled).toBe(true);
  desktop.stop(); expect(desktop.inspect().enabled).toBe(false);
});

test('the default desktop supervisor never requests a remote companion or credential helper', () => {
  const env = fixture();
  const desktop = new NativeDesktopRuntime({ stateDir: env.stateDir, kimiDir: env.kimiDir });
  expect(desktop.supervisor.launchOptions).toEqual({ controlOnly: true });
  desktop.close();
});

test('a ready remote launch is never reused as the official shared application', async () => {
  for (const launch of [{ remoteModels: true }, { remoteModels: true, remoteRevision: 'stale' }]) {
    const env = fixture();
    env.runtime.activeLaunch = () => launch;
    const desktop = new NativeDesktopRuntime({ ...env,
      request: async () => ({ ok: true, state: 'ready', remote: { state: 'ready', catalog: 'catalog-extended' } }) });
    expect((await desktop.ensure()).state).toBe('starting');
    expect(env.calls.at(-1)).toEqual(['start', { takeover: true, controlOnly: true }]);
    expect(desktop.inspect().remote).toBeUndefined();
  }
});

test('an official ready bridge is shared without starting another application', async () => {
  for (const launch of [undefined, { remoteModels: false }]) {
    const env = fixture();
    env.runtime.activeLaunch = () => launch;
    const desktop = new NativeDesktopRuntime({ ...env, request: async () => ({ ok: true, state: 'ready' }) });
    expect(await desktop.ensure()).toEqual({ state: 'active', shared: true });
    expect(env.calls).toEqual([]);
    expect(desktop.inspect()).toEqual({ state: 'active', shared: true });
  }
});

test('a custom Kimi directory never prepares the system or takes over the default application', async () => {
  const env = fixture(); let preparations = 0;
  const connection = createNativeConnection({ stateDir: env.stateDir, kimiDir: env.kimiDir,
    onboarding: { ensure: async () => { preparations++; return { state: 'ready' }; } },
    config: { upstream: { apiKeyEnv: 'TEST_KEY' }, tokenEnv: 'TEST_TOKEN', dns: { port: 53535 }, translation: { enabled: false } },
    gateway: { inflight: new Set() } });
  expect((await connection.ensure()).reason).toBe('native_scope_unverified');
  expect((await connection.retry()).reason).toBe('native_scope_unverified');
  expect(preparations).toBe(0);
  connection.close();
});

test('cancelled native preparation does not start Kimi; explicit retry resumes the saved connection', async () => {
  const env = fixture(); let state = 'cancelled'; const calls = [];
  const desktop = { configure: value => calls.push(['configure', value]), ensure: async () => { calls.push(['desktop']); return { state: 'starting' }; }, close() {} };
  const onboarding = { ensure: async options => { calls.push(['prepare', options.retry]); return { state }; } };
  const importer = { sync: async input => input, after: 100, retry: false };
  const connection = createNativeConnection({ ...env, desktop, onboarding, importer,
    config: { upstream: { apiKeyEnv: 'TEST_KEY' }, tokenEnv: 'TEST_TOKEN', dns: { port: 53535 }, translation: { enabled: false } },
    gateway: { inflight: new Set() } });
  expect((await connection.ensure()).state).toBe('cancelled');
  expect(calls.some(row => row[0] === 'desktop')).toBe(false);
  state = 'done';
  expect((await connection.retry()).state).toBe('starting');
  expect(importer.after).toBe(0); expect(importer.retry).toBe(true);
  expect(calls).toContainEqual(['prepare', true]); expect(calls).toContainEqual(['desktop']);
});

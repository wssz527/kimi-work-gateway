import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TranslationRuntime, sameInstallation } from '../src/translation-runtime.mjs';
import { TranslationSession } from '../src/translation-host.mjs';
import { readSubagentJSON, writeSubagentJSON } from '../src/subagent-policy.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function installation(root, platform = process.platform) {
  return { application: path.join(root, ...(platform === 'darwin' ? ['MacOS', 'Kimi'] : ['Kimi.exe'])),
    archive: path.join(root, 'Resources', 'app.asar'), platform, version: 'next-nightly' };
}
function child() {
  const value = new EventEmitter(); value.pid = 424242; value.unref = () => {};
  value.stdio = [null, null, null, {}, {}]; queueMicrotask(() => value.emit('spawn')); return value;
}

test('matching metadata cannot substitute a foreign executable or archive on macOS and Windows layouts', () => {
  for (const platform of ['darwin', 'win32']) {
    const source = installation('/synthetic/source', platform);
    const foreign = installation('/synthetic/foreign', platform);
    expect(sameInstallation({ ...source, discoveredApplication: source.application }, platform)).toBe(true);
    expect(sameInstallation({ ...source, application: foreign.application, discoveredApplication: source.application }, platform)).toBe(false);
    expect(sameInstallation({ ...source, archive: foreign.archive, discoveredApplication: source.application }, platform)).toBe(false);
    expect(sameInstallation(source, platform)).toBe(false);
  }
});

test('an explicitly supplied application remains valid for a custom archive without weakening foreign-install rejection', () => {
  for (const platform of ['darwin', 'win32']) {
    const source = { ...installation('/custom/archive-layout', platform), explicitApplication: true };
    expect(sameInstallation({ ...source, discoveredApplication: source.application }, platform)).toBe(true);
    expect(sameInstallation({ ...source, discoveredApplication: '/foreign/Kimi' }, platform)).toBe(false);
  }
});

test('credential names travel through the launch record and are removed at the actual Kimi spawn boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-isolation-')); roots.push(root);
  const located = installation(root);
  const env = { TRANSLATOR_KEY: 'translator-only', UPSTREAM_KEY: 'upstream-only', PANEL_TOKEN: 'panel-only', PATH: '/usr/bin', SAFE: 'retained' };
  let hostEnv, launched;
  const runtime = new TranslationRuntime({ stateDir: path.join(root, 'state'), kimiDir: path.join(root, 'kimi'), env,
    locate: () => located, spawnHost: (_app, _args, options) => { hostEnv = options.env; return child(); } });
  runtime.configure({ enabled: true, apiKeyEnv: 'TRANSLATOR_KEY' });
  await runtime.launch({ isRunning: () => false, protectedEnvNames: ['UPSTREAM_KEY', 'PANEL_TOKEN', 'PATH'] });
  const request = readSubagentJSON(runtime.launchFile);
  expect(request.protectedEnvNames).toEqual(['UPSTREAM_KEY', 'PANEL_TOKEN']);
  expect(JSON.stringify(request)).not.toContain('upstream-only');
  let application;
  const pipe = new EventEmitter(); pipe.closed = false; pipe.dispose = () => {};
  pipe.send = async () => ({ targetInfos: [] });
  const session = new TranslationSession({ stateDir: runtime.stateDir, id: request.id, env: hostEnv,
    spawnApp: (_app, _args, options) => { launched = options.env; application = child(); return application; }, pipeFactory: () => pipe });
  const run = session.run(); await new Promise(resolve => setImmediate(resolve));
  expect(launched.UPSTREAM_KEY).toBeUndefined(); expect(launched.PANEL_TOKEN).toBeUndefined();
  expect(launched.TRANSLATOR_KEY).toBeUndefined(); expect(launched.PATH).toBe('/usr/bin');
  expect(launched.SAFE).toBe('retained'); expect(session.env.TRANSLATOR_KEY).toBe('translator-only');
  application.emit('exit', 0); await run;
  expect(readSubagentJSON(runtime.receiptFile).state).toBe('exited');
});

test('force mode rejects a mismatched installation before starting any helper', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-translation-force-')); roots.push(root);
  const runtime = new TranslationRuntime({ stateDir: root, kimiDir: path.join(root, 'kimi'), locate: () => installation(root),
    spawnHost: () => { throw Error('must not spawn'); } });
  runtime.configure({ enabled: true });
  const subagentRuntime = { launchContext: () => ({ ...installation(path.join(root, 'foreign')), bundleDir: '/synthetic/bundle' }) };
  await expect(runtime.launch({ force: true, subagentRuntime, isRunning: () => false })).rejects.toThrow('subagent_bundle_application_mismatch');
  expect(fs.existsSync(runtime.launchFile)).toBe(false);
});

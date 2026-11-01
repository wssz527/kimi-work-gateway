import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { remoteAsar, remoteDigest, remoteBundleMetadata } from '../src/remote-bundle.mjs';
import { readAsarEntry } from '../src/kimi-contract.mjs';
import { cleanupRemoteRevisions, verifiedRemoteApplication } from '../src/remote-companion.mjs';
import { startRemoteCompanion } from '../src/remote-companion-runtime.mjs';
import { writeSubagentJSON } from '../src/subagent-policy.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-remote-artifact-'))); roots.push(stateDir);
  const revision = 'a'.repeat(32), id = crypto.randomUUID();
  const artifact = path.join(stateDir, 'remote-runtime/apps', revision);
  const bundle = path.join(artifact, 'Kimi Work Remote.app');
  const application = path.join(bundle, 'Contents/MacOS/Kimi');
  const original = path.join(stateDir, 'Kimi.app/Contents/MacOS/Kimi');
  const archive = path.join(stateDir, 'Kimi.app/Contents/Resources/app.asar');
  const payload = path.join(bundle, 'Contents/Resources/app.asar');
  fs.mkdirSync(path.dirname(payload), { recursive: true }); fs.writeFileSync(payload, 'synthetic-bootstrap');
  const manifest = { schemaVersion: 1, revision, application, originalApplication: original, archive,
    mainSHA256: 'b'.repeat(64), archiveSHA256: remoteDigest('synthetic-bootstrap') };
  const manifestFile = path.join(artifact, 'manifest.json');
  writeSubagentJSON(manifestFile, manifest);
  const configFile = path.join(stateDir, 'remote-runtime/config-' + id + '.json');
  writeSubagentJSON(configFile, { sessionID: id, application: original, archive, mainSHA256: manifest.mainSHA256 });
  const launch = { id, homeDir: path.join(stateDir, 'home'), application: original, discoveredApplication: original,
    archive, remoteModels: true };
  const receipt = { id, homeDir: launch.homeDir, runtimeApplication: application };
  return { stateDir, launch, receipt, manifest, manifestFile, configFile, payload, application };
}

test('bootstrap asar is readable with the installed parser and preserves UTF-8 content', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-remote-asar-')); roots.push(root);
  const file = path.join(root, 'app.asar');
  const value = remoteAsar({ 'package.json': '{"type":"module"}', 'bootstrap.mjs': 'export const text = "合成";\n' });
  fs.writeFileSync(file, value.data);
  expect(readAsarEntry(file, 'bootstrap.mjs')).toBe('export const text = "合成";\n');
  expect(value.headerHash).toMatch(/^[a-f0-9]{64}$/);
  expect(() => remoteAsar({ '../escape': 'bad' })).toThrow('remote_bundle_entry_invalid');
});

test('companion remains a Dock and menu application while the credential helper stays headless', () => {
  const source = { CFBundleName: 'Original', CFBundleURLTypes: ['original'], LSUIElement: true };
  const companion = remoteBundleMetadata(source, { bundleID: 'dev.kimi-work-gateway.remote',
    displayName: 'Kimi Work', executableName: 'Kimi', lsuiElement: false });
  const helper = remoteBundleMetadata(source, { bundleID: 'dev.kimi-work-gateway.credentials',
    displayName: 'Kimi Work Credentials', executableName: 'KimiWorkCredentials', lsuiElement: true });
  expect(companion.LSUIElement).toBe(false);
  expect(helper.LSUIElement).toBe(true);
  expect(companion.CFBundleURLTypes).toBeUndefined();
  expect(source.CFBundleName).toBe('Original');
  expect(() => remoteBundleMetadata(source, { lsuiElement: undefined })).toThrow('remote_bundle_config_invalid');
});

test('only expired non-current runtime revisions are removed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-remote-revisions-')); roots.push(root);
  const current = 'a'.repeat(32), recent = 'b'.repeat(32), expired = 'c'.repeat(32);
  for (const name of [current, recent, expired]) fs.mkdirSync(path.join(root, name));
  const now = Date.now(), old = new Date(now - 48 * 60 * 60 * 1000);
  fs.utimesSync(path.join(root, current), old, old);
  fs.utimesSync(path.join(root, expired), old, old);
  expect(cleanupRemoteRevisions(root, current, { now })).toEqual([expired]);
  expect(fs.existsSync(path.join(root, current))).toBe(true);
  expect(fs.existsSync(path.join(root, recent))).toBe(true);
  expect(fs.existsSync(path.join(root, expired))).toBe(false);
});

test.skipIf(process.platform !== 'darwin')('runtime ownership requires manifest, launch, configuration and exact artifact bytes', () => {
  const f = fixture();
  expect(verifiedRemoteApplication(f)).toBe(f.application);
  expect(verifiedRemoteApplication({ ...f, receipt: { ...f.receipt, id: crypto.randomUUID() } })).toBeNull();
  expect(verifiedRemoteApplication({ ...f, launch: { ...f.launch, remoteModels: false } })).toBeNull();
  expect(verifiedRemoteApplication({ ...f, receipt: { ...f.receipt, runtimeApplication: '/Applications/Other.app/Contents/MacOS/Kimi' } })).toBeNull();
  fs.writeFileSync(f.payload, 'changed-bootstrap');
  expect(verifiedRemoteApplication(f)).toBeNull();
});

test.skipIf(process.platform !== 'darwin')('runtime ownership refuses insecure or redirected provenance files', () => {
  const f = fixture();
  fs.chmodSync(f.manifestFile, 0o644);
  expect(verifiedRemoteApplication(f)).toBeNull();
  fs.chmodSync(f.manifestFile, 0o600);
  fs.rmSync(f.configFile); fs.symlinkSync(f.manifestFile, f.configFile);
  expect(verifiedRemoteApplication(f)).toBeNull();
});

const runtimeSource = `class RenamedPlane {
  #localMethods;
  #isRemoteAllowed;
  async #dispatchInner() {}
  #invokeLocal() {}
  async dispatch() {}
}
register(channels["BYOK_GET_PROFILE"], async () => {
    return {"profile": await readProfile(nativeAPI["getUserId"]())};
  });`;

function runtimeFixture() {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-remote-runtime-'))); roots.push(stateDir);
  const application = path.join(stateDir, 'Kimi.app/Contents/MacOS/Kimi');
  const archive = path.join(stateDir, 'Kimi.app/Contents/Resources/app.asar');
  const config = { schemaVersion: 1, sessionID: crypto.randomUUID(), stateDir,
    kimiDir: path.join(stateDir, 'home'), archive, application, userDataDir: path.join(stateDir, 'user-data'),
    helper: path.join(stateDir, 'update-helper.mjs'), addon: path.join(stateDir, 'updater.node'),
    version: '3.2.23', mainSHA256: remoteDigest(runtimeSource), credentials: { synthetic: true } };
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const originals = { ...safeStorage };
  const installCredentials = (safe, credentials) => {
    expect(credentials).toBe(config.credentials);
    for (const name of Object.keys(originals)) safe[name] = () => 'delegated';
    return { uninstall() {
      for (const name of Object.keys(originals)) safe[name] = originals[name];
    } };
  };
  return { config, safeStorage, originals, installCredentials };
}

test.skipIf(process.platform !== 'darwin')('companion startup failure uninstalls credential delegation', async () => {
  const f = runtimeFixture();
  const app = { setPath() { throw Error('synthetic-startup-failure'); } };
  await expect(startRemoteCompanion(f.config, { electron: { app, safeStorage: f.safeStorage, autoUpdater: {} },
    installCredentials: f.installCredentials, registerHooks: () => ({ deregister() {} }) }))
    .rejects.toThrow('remote_runtime_unverified');
  expect(f.safeStorage.isEncryptionAvailable).toBe(f.originals.isEncryptionAvailable);
  expect(f.safeStorage.encryptString).toBe(f.originals.encryptString);
  expect(f.safeStorage.decryptString).toBe(f.originals.decryptString);
});

test.skipIf(process.platform !== 'darwin')('companion will-quit restores safeStorage after a ready launch', async () => {
  const f = runtimeFixture();
  const handlers = {};
  const app = { setPath() {}, setAppPath() {}, setName() {}, setAsDefaultProtocolClient() {}, quit() {},
    on(event, handler) { handlers[event] = handler; } };
  const autoUpdater = new EventEmitter();
  Object.assign(autoUpdater, { setFeedURL() {}, getFeedURL() { return ''; }, checkForUpdates() {}, quitAndInstall() {} });
  let hook, installProfile;
  const runtime = await startRemoteCompanion(f.config, {
    electron: { app, autoUpdater, safeStorage: f.safeStorage }, installCredentials: f.installCredentials,
    runtimeProcess: { execPath: 'synthetic-runtime' }, decodeSource: () => value => value,
    createUpdateClient: () => ({ request: async () => ({ ok: true, supportsOfficialUpdates: true }) }),
    registerHooks(options) { hook = { ...options, deregister() {} }; return hook; },
    async importMain(target) {
      hook.load(target, {}, () => ({ source: runtimeSource }));
      const installKey = Object.keys(globalThis).find(key => key.startsWith('__kwgRemoteInstall_'));
      class Plane { async dispatch() {} }
      globalThis[installKey](Plane);
      installProfile = () => {
        const profileKey = Object.keys(globalThis).find(key => key.startsWith('__kwgRemoteProfile_'));
        globalThis[profileKey](async () => ({ profile: null }));
      };
    },
  });
  expect(runtime.inspect().state).toBe('starting');
  installProfile();
  expect(runtime.inspect().state).toBe('ready');
  expect(Object.keys(globalThis).some(key => key.startsWith('__kwgRemoteProfile_'))).toBe(false);
  handlers['will-quit']();
  expect(runtime.inspect().state).toBe('exited');
  expect(f.safeStorage.isEncryptionAvailable).toBe(f.originals.isEncryptionAvailable);
  expect(f.safeStorage.encryptString).toBe(f.originals.encryptString);
  expect(f.safeStorage.decryptString).toBe(f.originals.decryptString);
});

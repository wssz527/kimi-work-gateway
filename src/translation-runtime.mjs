import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { archiveCandidates, installedVersion } from './kimi-contract.mjs';
import { normalizeTranslationConfig } from './translation-config.mjs';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';

const HOST = fileURLToPath(new URL('./translation-host.mjs', import.meta.url));
const STATES = new Set(['starting', 'attaching', 'active', 'inactive', 'legacy-running', 'failed', 'exited']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TRANSLATION_KIMI_VERSIONS = new Set(['3.2.21']);
export const translationRevision = (settings, homeDir) => digest({ homeDir, settings });
export const translationAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

export function readTranslationSettings(file, homeDir) {
  const value = readSubagentJSON(file);
  if (value.schemaVersion !== 1 || typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir)
    || homeDir !== undefined && value.homeDir !== homeDir) throw Error('translation_scope_conflict');
  const settings = normalizeTranslationConfig(value.settings);
  if (value.revision !== translationRevision(settings, value.homeDir)) throw Error('translation_settings_conflict');
  return { ...value, settings };
}

export function translationInstallation({ archive, application, platform = process.platform, env = process.env } = {}) {
  const file = archive || archiveCandidates({ platform, env }).find(candidate => fs.existsSync(candidate));
  if (!file || !fs.existsSync(file)) throw Error('translation_kimi_unavailable');
  const directory = path.dirname(path.resolve(file));
  const candidates = platform === 'darwin'
    ? [path.join(path.dirname(directory), 'MacOS', 'Kimi')]
    : [path.join(path.dirname(directory), 'Kimi.exe'), path.join(path.dirname(directory), 'kimi-desktop.exe')];
  const executable = application || candidates.find(candidate => fs.existsSync(candidate));
  if (!executable || !fs.existsSync(executable)) throw Error('translation_kimi_unavailable');
  const version = installedVersion(file);
  if (!TRANSLATION_KIMI_VERSIONS.has(version)) throw Error('translation_runtime_incompatible');
  return { archive: path.resolve(file), application: path.resolve(executable), version, platform };
}

export function kimiProcessRunning(application, platform = process.platform) {
  const name = path.basename(application).replace(/\.exe$/i, '');
  const result = platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process -Name '" + name.replaceAll("'", "''") + "' -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"], { windowsHide: true, timeout: 10000 })
    : spawnSync('pgrep', ['-x', name], { timeout: 10000 });
  if (result.error || ![0, 1].includes(result.status)) throw Error('translation_process_check_failed');
  return result.status === 0;
}

export class TranslationRuntime {
  constructor({ stateDir, kimiDir, env = process.env, installation, spawnHost = spawn,
    locate = translationInstallation, isAlive = translationAlive } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.homeDir = path.resolve(kimiDir);
    this.settingsFile = path.join(this.stateDir, 'translation-settings.json');
    this.receiptFile = path.join(this.stateDir, 'translation-runtime.json');
    this.launchFile = path.join(this.stateDir, 'translation-launch.json');
    this.env = env;
    this.installationOptions = installation || {};
    this.locate = locate;
    this.spawnHost = spawnHost;
    this.isAlive = isAlive;
    this.settings = normalizeTranslationConfig();
  }

  configure(value) {
    const settings = normalizeTranslationConfig(value);
    const desired = { schemaVersion: 1, homeDir: this.homeDir, settings,
      revision: translationRevision(settings, this.homeDir) };
    let previous;
    try { previous = readTranslationSettings(this.settingsFile, this.homeDir); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous?.revision !== desired.revision) writeSubagentJSON(this.settingsFile, desired);
    this.settings = settings;
    return settings;
  }

  inspect() {
    let desired;
    try { desired = readTranslationSettings(this.settingsFile, this.homeDir); }
    catch (error) {
      if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_settings_conflict' };
      return { state: this.settings.enabled ? 'not-started' : 'disabled' };
    }
    let receipt;
    try { receipt = readSubagentJSON(this.receiptFile); }
    catch (error) { if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_session_conflict' }; }
    if (receipt) {
      if (receipt.schemaVersion !== 1 || receipt.homeDir !== this.homeDir || !STATES.has(receipt.state)
        || typeof receipt.id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.id)) {
        return { state: 'failed', reason: 'translation_session_conflict' };
      }
      const info = { ...(typeof receipt.version === 'string' ? { version: receipt.version } : {}),
        ...(Number.isInteger(receipt.pid) ? { pid: receipt.pid } : {}),
        ...(typeof receipt.reason === 'string' && /^[a-z][a-z0-9_-]{0,100}$/.test(receipt.reason) ? { reason: receipt.reason } : {}) };
      if (this.isAlive(receipt.pid) && receipt.state !== 'exited') {
        const age = Date.now() - receipt.at;
        if (!Number.isFinite(age) || age < 0 || age > 15000) return { ...info, state: 'stale' };
        if (receipt.revision !== desired.revision) return { ...info, state: 'pending-settings' };
        if (receipt.state === 'active' && !desired.settings.enabled) return { ...info, state: 'pending-settings' };
        return { ...info, state: receipt.state };
      }
      if (receipt.state === 'failed') return { ...info, state: 'failed' };
    }
    try {
      const launch = readSubagentJSON(this.launchFile);
      if (launch.homeDir !== this.homeDir) return { state: 'failed', reason: 'translation_scope_conflict' };
      if (this.isAlive(launch.pid) && Date.now() - launch.at < 15000) return { state: 'starting' };
    } catch (error) { if (error.code !== 'ENOENT') return { state: 'failed', reason: 'translation_session_conflict' }; }
    return { state: desired.settings.enabled ? 'not-started' : 'disabled' };
  }

  check() {
    const current = this.inspect();
    if (!['disabled', 'not-started'].includes(current.state)) return current;
    try {
      const { version } = this.locate({ ...this.installationOptions, env: this.env });
      return { ...current, version };
    } catch (error) {
      return { state: error.message === 'translation_runtime_incompatible' ? 'incompatible' : 'failed',
        reason: error.message === 'translation_runtime_incompatible' ? error.message : 'translation_kimi_unavailable' };
    }
  }

  async launch({ subagentRuntime, force = false, isRunning, userDataDir } = {}) {
    const desired = readTranslationSettings(this.settingsFile, this.homeDir);
    if (!desired.settings.enabled) throw Error('translation_not_enabled');
    const current = this.inspect();
    if (current.state === 'stale') throw Error('translation_host_stale');
    let context;
    if (force) {
      context = subagentRuntime?.launchContext();
      if (!context) throw Error('subagent_runtime_not_ready');
    }
    if (['active', 'attaching', 'starting', 'pending-settings', 'inactive', 'legacy-running'].includes(current.state)) {
      if (context) {
        let request;
        try { request = readSubagentJSON(this.launchFile); } catch { throw Error('translation_session_conflict'); }
        if (request.homeDir !== this.homeDir) throw Error('translation_scope_conflict');
        if (request.bundleDir !== context.bundleDir || request.application !== context.application) {
          return { state: 'waiting-kimi-exit', ...(current.version ? { version: current.version } : {}) };
        }
      }
      return current;
    }
    const installation = this.locate({ ...this.installationOptions, env: this.env });
    if (!force && subagentRuntime && ['loaded', 'pending-policy', 'waiting-launch'].includes(subagentRuntime.inspect().state)) {
      context = subagentRuntime.launchContext();
    }
    const application = context?.application || installation.application;
    const running = isRunning === undefined ? kimiProcessRunning(application, installation.platform) : isRunning();
    if (running) return { state: 'waiting-kimi-exit', version: installation.version };
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.stateDir).isSymbolicLink()) throw Error('translation_session_conflict');
    let previous;
    try { previous = readSubagentJSON(this.launchFile); }
    catch (error) { if (error.code !== 'ENOENT') throw Error('translation_session_conflict'); }
    if (previous && this.isAlive(previous.pid) && Date.now() - previous.at < 15000) return { state: 'starting' };
    if (previous) fs.rmSync(this.launchFile);
    const id = crypto.randomUUID();
    const request = { schemaVersion: 1, id, pid: process.pid, at: Date.now(), homeDir: this.homeDir,
      ...installation, application, ...(context ? { bundleDir: context.bundleDir } : {}),
      ...(userDataDir ? { userDataDir: path.resolve(userDataDir) } : {}) };
    fs.writeFileSync(this.launchFile, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = this.spawnHost(process.execPath, [HOST, this.stateDir, id], { env, detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } catch {
      if (readSubagentJSON(this.launchFile).id === id) fs.rmSync(this.launchFile);
      throw Error('translation_host_start_failed');
    }
    return { state: 'starting', pid: child.pid, version: installation.version };
  }
}

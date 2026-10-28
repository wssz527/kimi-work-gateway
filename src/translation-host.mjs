import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { readTranslationSettings, translationAlive } from './translation-runtime.mjs';
import { TranslationPipe } from './translation-pipe.mjs';
import { translateReasoning } from './translation-service.mjs';

const RENDERER = fileURLToPath(new URL('../ui/translation-renderer.js', import.meta.url));
const safeReason = error => /^translation_[a-z0-9_-]{1,80}$/.test(error?.message) ? error.message : 'translation_session_failed';
const publicSettings = settings => Object.fromEntries(['enabled', 'provider', 'targetLanguage', 'view'].map(key => [key, settings[key]]));

export function isTranslationTarget(target) {
  if (target?.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    return ['file:', 'app:', 'kimi:'].includes(url.protocol) && /\/kimi-agent\.html$/.test(url.pathname);
  } catch { return false; }
}

export class TranslationSession {
  constructor({ stateDir, id, env = process.env, spawnApp = spawn, translate = translateReasoning,
    pipeFactory = (readable, writable) => new TranslationPipe(readable, writable), interval = 1000 } = {}) {
    this.stateDir = stateDir;
    this.id = id;
    this.env = env;
    this.spawnApp = spawnApp;
    this.translate = translate;
    this.pipeFactory = pipeFactory;
    this.interval = interval;
    this.launchFile = path.join(stateDir, 'translation-launch.json');
    this.settingsFile = path.join(stateDir, 'translation-settings.json');
    this.receiptFile = path.join(stateDir, 'translation-runtime.json');
    this.sessions = new Map();
    this.jobs = new Map();
    this.status = 'starting';
    this.stopped = false;
  }

  record() {
    const owner = readSubagentJSON(this.launchFile);
    if (owner.id !== this.id || owner.homeDir !== this.request.homeDir) throw Error('translation_session_conflict');
    writeSubagentJSON(this.receiptFile, { schemaVersion: 1, id: this.id, pid: process.pid,
      ...(Number.isInteger(this.child?.pid) ? { applicationPid: this.child.pid } : {}),
      homeDir: this.request.homeDir, version: this.request.version, revision: this.revision,
      state: this.status, ...(this.reason ? { reason: this.reason } : {}), at: Date.now() });
  }

  async evaluate(sessionId, expression) {
    const result = await this.pipe.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw Error('translation_renderer_failed');
    return result.result?.value;
  }

  source() {
    const revision = JSON.stringify(this.revision);
    return 'if(globalThis.__kwgTranslationScope!==' + revision + '){globalThis.__kwgTranslation?.__cache?.clear();'
      + 'globalThis.__kwgTranslationScope=' + revision + ';}\n'
      + 'globalThis.__kwgTranslationConfig=' + JSON.stringify(publicSettings(this.settings)) + ';\n' + this.payload;
  }

  async inject(entry) {
    if (this.pipe.closed) throw Error('translation_pipe_closed');
    await this.pipe.send('Runtime.enable', {}, entry.sessionId);
    await this.pipe.send('Page.enable', {}, entry.sessionId);
    await this.pipe.send('Runtime.addBinding', { name: '__kwgTranslate' }, entry.sessionId);
    if (entry.scriptId) await this.pipe.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId }, entry.sessionId);
    const source = this.source();
    const script = await this.pipe.send('Page.addScriptToEvaluateOnNewDocument', { source }, entry.sessionId);
    entry.scriptId = script.identifier;
    const result = await this.evaluate(entry.sessionId, source);
    if (!result || result.version !== 1 || !['active', 'inactive', 'legacy-running'].includes(result.state)) {
      throw Error('translation_renderer_unconfirmed');
    }
    entry.state = result.state;
    entry.revision = this.revision;
  }

  async reply(sessionId, id, value) {
    if (this.pipe.closed || this.stopped) return;
    const expression = 'globalThis.__kwgTranslationReceive?.(' + JSON.stringify(id) + ',' + JSON.stringify(value) + ')';
    await this.evaluate(sessionId, expression).catch(() => {});
  }

  async binding(message) {
    const sessionId = message.sessionId;
    const entry = [...this.sessions.values()].find(value => value.sessionId === sessionId);
    if (!entry || message.params?.name !== '__kwgTranslate') return;
    let input;
    try {
      if (typeof message.params.payload !== 'string' || Buffer.byteLength(message.params.payload) > 1024 * 1024) return;
      input = JSON.parse(message.params.payload);
    } catch { return; }
    if (!input || input.type !== 'translate' || typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return;
    const reject = code => this.reply(sessionId, input.id, { error: code });
    if (!this.settings.enabled) { await reject('translation_disabled'); return; }
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 131072
      || !Array.isArray(input.protectedTexts) || input.protectedTexts.length > 1024
      || input.protectedTexts.some(value => typeof value !== 'string' || value.length > 131072)
      || input.protectedTexts.reduce((sum, value) => sum + value.length, 0) > 262144) {
      await reject('translation_input_invalid'); return;
    }
    const key = sessionId + ':' + input.id;
    if (this.jobs.size >= 2 || this.jobs.has(key)) { await reject('translation_busy'); return; }
    const controller = new AbortController();
    const revision = this.revision;
    this.jobs.set(key, controller);
    try {
      const text = await this.translate(input.text, this.settings, {
        env: this.env, protectedTexts: input.protectedTexts, signal: controller.signal,
      });
      if (typeof text !== 'string' || !text.trim()) throw Error('translation_response_invalid');
      if (revision === this.revision && !controller.signal.aborted) await this.reply(sessionId, input.id, { text });
    } catch (error) {
      if (revision === this.revision) await reject(safeReason(error));
    } finally { this.jobs.delete(key); }
  }

  async update() {
    if (this.stopped || this.updating) return;
    this.updating = true;
    try {
      const desired = readTranslationSettings(this.settingsFile, this.request.homeDir);
      if (desired.revision !== this.revision) {
        for (const job of this.jobs.values()) job.abort();
        this.settings = desired.settings;
        this.revision = desired.revision;
        for (const entry of this.sessions.values()) entry.revision = null;
      }
      const { targetInfos = [] } = await this.pipe.send('Target.getTargets');
      const targets = targetInfos.filter(isTranslationTarget);
      const current = new Set(targets.map(target => target.targetId));
      for (const [targetId, entry] of this.sessions) {
        if (!current.has(targetId)) {
          this.sessions.delete(targetId);
          await this.pipe.send('Target.detachFromTarget', { sessionId: entry.sessionId }).catch(() => {});
        }
      }
      for (const target of targets) {
        let entry = this.sessions.get(target.targetId);
        if (!entry) {
          const attached = await this.pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          if (typeof attached.sessionId !== 'string') throw Error('translation_renderer_unconfirmed');
          entry = { sessionId: attached.sessionId };
          this.sessions.set(target.targetId, entry);
        }
        try {
          if (entry.revision !== this.revision) await this.inject(entry);
          else {
            const observed = await this.evaluate(entry.sessionId, 'globalThis.__kwgTranslation?.status()');
            if (!observed || observed.version !== 1 || !['active', 'inactive', 'legacy-running'].includes(observed.state)) {
              throw Error('translation_renderer_unconfirmed');
            }
            entry.state = observed.state;
          }
          entry.reason = undefined;
          if (entry.state === 'inactive' && this.settings.enabled) entry.revision = null;
        } catch (error) {
          entry.revision = null;
          entry.state = 'failed'; entry.reason = safeReason(error);
        }
      }
      const entries = [...this.sessions.values()];
      this.reason = undefined;
      if (entries.some(entry => entry.state === 'legacy-running')) {
        this.status = 'legacy-running'; this.reason = 'translation_legacy_running';
      } else if (!this.settings.enabled && entries.every(entry => !['active', 'failed'].includes(entry.state))) {
        this.status = 'inactive';
      } else if (entries.some(entry => entry.state === 'active' && entry.revision === this.revision) && this.settings.enabled) {
        this.status = 'active';
      } else if (entries.some(entry => entry.state === 'failed')) {
        this.status = 'failed'; this.reason = entries.find(entry => entry.state === 'failed').reason;
      } else {
        this.status = 'attaching'; this.reason = 'translation_waiting_work_view';
      }
      this.record();
    } catch (error) {
      this.status = 'failed'; this.reason = safeReason(error);
      if (this.settings) {
        const disabled = publicSettings({ ...this.settings, enabled: false });
        for (const entry of this.sessions.values()) {
          await this.evaluate(entry.sessionId, 'globalThis.__kwgTranslation?.configure(' + JSON.stringify(disabled) + ')').catch(() => {});
        }
      }
      try { this.record(); } catch {}
    } finally { this.updating = false; }
  }

  async run() {
    this.request = readSubagentJSON(this.launchFile);
    if (this.request.schemaVersion !== 1 || this.request.id !== this.id || !path.isAbsolute(this.request.homeDir)
      || !path.isAbsolute(this.request.application) || typeof this.request.version !== 'string'
      || !this.request.version || this.request.version.length > 128 || /[\u0000-\u001f\u007f]/.test(this.request.version)
      || !translationAlive(this.request.pid)) throw Error('translation_launch_invalid');
    const desired = readTranslationSettings(this.settingsFile, this.request.homeDir);
    this.settings = desired.settings;
    this.revision = desired.revision;
    this.payload = fs.readFileSync(RENDERER, 'utf8');
    this.record();
    const args = ['-remote-debugging-pipe'];
    if (this.request.userDataDir) args.push('--user-data-dir=' + this.request.userDataDir);
    const env = { ...this.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env[this.settings.apiKeyEnv];
    if (this.request.bundleDir) env.DAIMON_BUNDLE_DIR = this.request.bundleDir;
    else delete env.DAIMON_BUNDLE_DIR;
    this.child = this.spawnApp(this.request.application, args, { env, detached: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false });
    const ended = new Promise(resolve => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => { this.reason = 'translation_application_start_failed'; resolve(); });
    });
    try {
      await new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
      this.status = 'attaching';
      this.record();
      if (!this.child.stdio[4] || !this.child.stdio[3]) throw Error('translation_pipe_unavailable');
      this.pipe = this.pipeFactory(this.child.stdio[4], this.child.stdio[3]);
      this.pipe.on('message', message => {
        if (message.method === 'Runtime.bindingCalled') void this.binding(message).catch(() => {});
        if (message.method === 'Runtime.executionContextsCleared' || message.method === 'Page.loadEventFired') {
          for (const entry of this.sessions.values()) if (entry.sessionId === message.sessionId) entry.revision = null;
        }
      });
      this.pipe.on('closed', reason => {
        this.status = 'failed'; this.reason = reason;
        for (const job of this.jobs.values()) job.abort();
        try { this.record(); } catch {}
      });
      const timer = setInterval(() => { void this.update(); }, this.interval);
      await this.update();
      await ended;
      clearInterval(timer);
    } catch (error) {
      this.status = 'failed'; this.reason = safeReason(error);
      try { this.record(); } catch {}
      await ended;
    } finally {
      this.stopped = true;
      for (const job of this.jobs.values()) job.abort();
      this.pipe?.dispose();
      this.status = this.reason === 'translation_application_start_failed' ? 'failed' : 'exited';
      try { this.record(); } catch {}
      try { if (readSubagentJSON(this.launchFile).id === this.id) fs.rmSync(this.launchFile); } catch {}
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [stateDir, id] = process.argv.slice(2);
  if (!stateDir || !path.isAbsolute(stateDir) || !/^[a-f0-9-]{36}$/.test(id || '')) process.exitCode = 2;
  else await new TranslationSession({ stateDir, id }).run().catch(() => { process.exitCode = 1; });
}

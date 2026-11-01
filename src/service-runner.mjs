// A stable parent process for the background gateway.
//
// The service definition (launchd plist / scheduled task) points at this
// runner, not at the panel itself. The runner owns one `panel` child, and:
//
//   - restarts the child when it exits unexpectedly (Windows ONLOGON has no
//     KeepAlive, and launchd only restarts when the runner itself exits);
//   - restarts or stops it on an explicit control request, but never while a
//     request or a Kimi turn is in flight: it waits for a quiet window and then
//     sends SIGTERM, waiting for the child to really exit;
//   - reports `waiting` instead of killing anything when the child does not go
//     quiet in time, or when the activity state cannot be read.
//
// Activity comes from live signals, never from a file timestamp: the panel's own
// `/api/state` (the gateway's in-flight count) and the Kimi Work kernel probe in
// native-idle.mjs (runner snapshot plus the daemon's read-only control RPCs,
// confirmed twice in a row). A stale `updatedAt` alone is not used to decide the
// child is dead, because a healthy idle gateway leaves it unchanged for hours.
// The one native reading that still allows a restart is "Kimi is not running at
// all", proven by the installation's own executable path having no process.
//
// Control is local only: a 0600 request file in the state directory, or the
// authenticated panel API. Nothing here ends Kimi, touches `/etc`, or deletes a
// persisted import intent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { archiveCandidates } from './kimi-contract.mjs';
import { confirmLiveIdle } from './native-idle.mjs';
import { defaultKimiDirectory } from './paths.mjs';
import { readPanelEntry } from './service-manager.mjs';
import { inspectApplicationProcesses, translationInstallation } from './translation-runtime.mjs';

export const RUNNER_SCHEMA_VERSION = 1;
export const RUNNER_STATE_FILE = 'service-runner.json';
export const RUNNER_REQUEST_FILE = 'service-runner-request.json';
export const RUNNER_RECEIPT_FILE = 'service-runner-receipt.json';
export const RUNNER_LOG_FILE = 'service.log';
export const NATIVE_DISABLED_FLAG = '--no-native';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

function readJson(file, limit = 64 * 1024) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw Error('runner_file_conflict');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('runner_file_conflict'); }
}

function writeAtomic(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

// Reads the value of `--name value` or `--name=value` from an argv array.
export function argumentValue(argv, name) {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === name) {
      const next = argv[index + 1];
      return typeof next === 'string' && !next.startsWith('--') ? next : null;
    }
    if (typeof value === 'string' && value.startsWith(name + '=')) return value.slice(name.length + 1) || null;
  }
  return null;
}

// Reads the live in-flight count from the panel. The link and its key come from
// the private entry file, so this never needs the user's upstream credentials.
export async function probePanelActivity({ entryFile, fetchImpl = globalThis.fetch, timeoutMs = 2000 } = {}) {
  const entry = readPanelEntry(entryFile);
  if (!entry) return { state: 'unavailable', reason: 'panel_entry_absent' };
  const key = entry.entryURL.slice(entry.entryURL.lastIndexOf('#key=') + 5);
  let response;
  try {
    response = await fetchImpl(entry.url + '/api/state', {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
  } catch { return { state: 'unavailable', reason: 'panel_probe_failed' }; }
  if (!response.ok) {
    await response.body?.cancel?.();
    return { state: 'unavailable', reason: 'panel_probe_status' };
  }
  let payload;
  try { payload = await response.json(); } catch { return { state: 'unavailable', reason: 'panel_probe_invalid' }; }
  const active = payload?.gateway?.activeRequests;
  if (!Number.isSafeInteger(active) || active < 0) return { state: 'unavailable', reason: 'panel_probe_invalid' };
  return { state: 'ok', requests: active };
}

// The native half of one activity reading, for a session whose Kimi directory
// may or may not have the Work integration installed.
//
// `busy` and `unknown` both mean "do not interrupt". `idle` is only returned
// after two agreeing live probes, and `not_running` only when nothing can be in
// flight: either the installation's exact executable path has no process, or no
// Kimi installation exists at all. A name-only match is ambiguity, not evidence,
// because another build sharing the name would still be hidden by it.
//
// `confirm`, `locate`, `inspect` and `archives` are injectable so the decision
// table is testable without a socket, a running Kimi, or a platform process
// table.
export async function probeNativeActivity({ kimiDir, platform = process.platform, env = process.env,
  confirm = confirmLiveIdle, locate = translationInstallation, inspect = inspectApplicationProcesses,
  archives = archiveCandidates } = {}) {
  if (typeof kimiDir !== 'string' || !path.isAbsolute(kimiDir)) {
    return { state: 'unknown', reason: 'native_activity_unknown', detail: 'native_kimi_dir_missing' };
  }
  // Two agreeing idle probes, same daemon generation, as required by native-idle.
  const confirmed = await confirm({ kimiDir, platform }, { attempts: 2 });
  if (confirmed?.state === 'idle' && confirmed.consecutive === 2) {
    return { state: 'idle', generationId: confirmed.generationId ?? null, pid: confirmed.pid ?? null };
  }
  if (confirmed?.state === 'busy') {
    return { state: 'busy', reason: 'native_busy', detail: confirmed.reason ?? null };
  }
  const detail = confirmed?.reason ?? 'native_activity_unknown';
  let application;
  try { application = locate({ platform, env }).application; }
  catch {
    // No installation at all means no turn can be running, so a restart is
    // safe. An installation that exists but cannot be matched to its executable
    // is a corrupt or unknown build, which is not evidence of anything.
    let installed = false;
    try { installed = archives({ platform, env }).some(file => fs.existsSync(file)); }
    catch { return { state: 'unknown', reason: 'native_activity_unknown', detail }; }
    if (!installed) return { state: 'not_running', reason: 'native_kimi_not_installed', detail };
    return { state: 'unknown', reason: 'native_activity_unknown', detail };
  }
  let processes;
  try { processes = inspect(application, platform); }
  catch { return { state: 'unknown', reason: 'native_activity_unknown', detail: 'native_process_check_failed' }; }
  const pids = Array.isArray(processes?.pids) ? processes.pids : null;
  if (!pids) return { state: 'unknown', reason: 'native_activity_unknown', detail: 'native_process_check_invalid' };
  if (pids.length === 0) {
    if (processes.nameMatches === 0) return { state: 'not_running', reason: 'native_kimi_not_running', detail };
    return { state: 'unknown', reason: 'native_activity_unknown', detail: 'native_process_ambiguous' };
  }
  return { state: 'unknown', reason: 'native_activity_unknown', detail };
}

export class ServiceRunner {
  constructor({ stateDir, launcherPath, nodePath = process.execPath, argv = [], env, platform = process.platform,
    logFile, spawnImpl = spawn, fetchImpl = globalThis.fetch, workProbe, kimiDir, native,
    quietMs = 5000, drainTimeoutMs = 120000, restartDelayMs = 2000, maxRestarts = 5, uid, exitOnStop = true } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.stateFile = path.join(this.stateDir, RUNNER_STATE_FILE);
    this.requestFile = path.join(this.stateDir, RUNNER_REQUEST_FILE);
    this.receiptFile = path.join(this.stateDir, RUNNER_RECEIPT_FILE);
    this.entryFile = path.join(this.stateDir, 'panel-entry.json');
    this.logFile = path.resolve(logFile ?? path.join(this.stateDir, RUNNER_LOG_FILE));
    this.launcherPath = path.resolve(launcherPath);
    this.nodePath = path.resolve(nodePath);
    this.argv = [...argv];
    this.childArgv = native === false && !this.argv.includes(NATIVE_DISABLED_FLAG)
      ? [...this.argv, NATIVE_DISABLED_FLAG] : [...this.argv];
    this.env = env;
    this.platform = platform;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.kimiDir = path.resolve(kimiDir || argumentValue(this.argv, '--kimi-dir') || defaultKimiDirectory(undefined, platform));
    this.nativeEnabled = native !== false && !this.argv.includes(NATIVE_DISABLED_FLAG);
    this.workProbe = workProbe ?? (options => probeNativeActivity(options));
    this.quietMs = quietMs;
    this.drainTimeoutMs = drainTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;
    this.uid = uid;
    this.exitOnStop = exitOnStop;
    this.child = null;
    this.expectedExit = null;
    this.restartTimer = null;
    this.stopping = false;
    this.restarts = 0;
    this.lastExit = null;
    this.observed = { requests: null, at: null, native: null };
  }

  signature() {
    return digest(JSON.stringify({ launcher: this.launcherPath, node: this.nodePath, argv: this.childArgv }));
  }

  spawnChild() {
    this.cancelRestart();
    const child = this.spawnImpl(this.nodePath, [this.launcherPath, ...this.childArgv], {
      // The panel child inherits the runner's environment, which the service
      // definition built from the credentials file; nothing is added here.
      env: this.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // A separate process group lets a stop signal reach the panel only.
      detached: false,
    });
    const append = chunk => {
      try { fs.appendFileSync(this.logFile, chunk); } catch {}
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    // Pipe streams on the parent side hold the event loop open on their own.
    // The runner exits when its loop ends, so the child and its pipes must not
    // be allowed to keep it resident after a stop request.
    child.unref?.();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
    // The stdout/stderr pipes keep the parent's event loop alive even after the
    // child is gone, so they are released as soon as the child closes. Without
    // this a runner would stay resident after a stop and the platform would
    // report a service that is still running.
    child.once('close', () => {
      for (const stream of [child.stdout, child.stderr]) {
        try { stream?.removeAllListeners?.('data'); stream?.destroy?.(); } catch {}
      }
    });
    child.once('exit', (code, signal) => {
      // A child that was already replaced must never clear or restart its
      // successor, whatever order the two exit events arrive in.
      if (this.child !== child) return;
      const expected = this.expectedExit === child;
      if (expected) this.expectedExit = null;
      this.lastExit = { code, signal, at: new Date().toISOString() };
      this.child = null;
      if (!this.stopping && !expected) this.onUnexpectedExit();
    });
    child.once('error', () => {});
    this.child = child;
    return child;
  }

  // Cancels a pending restart. Every deliberate action and every fresh spawn
  // runs this, so a scheduled restart can never race an explicit one.
  cancelRestart() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  onUnexpectedExit() {
    if (this.restarts >= this.maxRestarts) {
      this.writeState({ state: 'crashed', restarts: this.restarts });
      return;
    }
    this.restarts++;
    this.cancelRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      // A child may already exist again: an explicit restart, or a second exit
      // report, can land while this timer is pending. Spawning here anyway is
      // exactly how two panels end up fighting for the same port.
      if (this.stopping || this.child) return;
      this.spawnChild();
      this.writeState({ state: this.child ? 'running' : 'starting' });
    }, this.restartDelayMs);
    this.restartTimer.unref?.();
  }

  writeState(extra = {}) {
    try {
      writeAtomic(this.stateFile, { schemaVersion: RUNNER_SCHEMA_VERSION, pid: process.pid,
        child: this.child?.pid ?? null, signature: this.signature(), launcher: this.launcherPath,
        restarts: this.restarts, ...(this.lastExit ? { lastExit: this.lastExit } : {}),
        observed: this.observed, at: new Date().toISOString(), ...extra }, 0o600);
    } catch {}
  }

  // Panel half of one reading. Polled while waiting for a quiet window, because
  // it is a single loopback call and the native probe is not.
  async samplePanel() {
    const panel = await probePanelActivity({ entryFile: this.entryFile, fetchImpl: this.fetchImpl });
    if (panel.state !== 'ok') return { state: 'unknown', reason: 'panel_activity_unknown', detail: panel.reason };
    this.observed = { ...this.observed, requests: panel.requests, at: Date.now() };
    return { state: panel.requests === 0 ? 'idle' : 'busy', requests: panel.requests };
  }

  // Native half: `idle` only when the Work kernel agreed twice; `not_running`
  // (Kimi genuinely absent) also permits a restart. Everything else refuses.
  async sampleWork() {
    if (!this.nativeEnabled) return { state: 'idle', native: 'disabled' };
    let result;
    try { result = await this.workProbe({ kimiDir: this.kimiDir, platform: this.platform, env: this.env }); }
    catch { return { state: 'unknown', reason: 'native_activity_unknown', detail: 'native_probe_failed' }; }
    this.observed = { ...this.observed, native: result?.state ?? 'unknown' };
    if (result?.state === 'idle' || result?.state === 'not_running') {
      return { state: 'idle', native: result.state, ...(result.reason ? { detail: result.reason } : {}) };
    }
    if (result?.state === 'busy') return { state: 'busy', reason: 'native_busy', detail: result.reason ?? null };
    return { state: 'unknown', reason: 'native_activity_unknown', detail: result?.reason ?? null };
  }

  // One complete activity sample: gateway idle *and* Work idle. `unknown` is
  // deliberately distinct from `idle`: a request is only stopped when both
  // halves answered that nothing is running.
  async sample() {
    const panel = await this.samplePanel();
    if (panel.state === 'busy') return panel;
    if (panel.state !== 'idle') return panel;
    const work = await this.sampleWork();
    if (work.state === 'idle') return { state: 'idle', requests: 0 };
    return work;
  }

  // Waits for a quiet window. Returns `drained` or `waiting` with a reason; only
  // `drained` permits a stop. The native probe runs once, after the panel has
  // been quiet for the whole window, so a busy turn is never interrupted and a
  // quiet gateway is not probed on every loop pass.
  async drain({ timeoutMs = this.drainTimeoutMs, quietMs = this.quietMs } = {}) {
    const deadline = Date.now() + timeoutMs;
    const window = Math.max(0, quietMs);
    let quietSince = null;
    for (;;) {
      const panel = await this.samplePanel();
      if (panel.state === 'unknown') return { state: 'waiting', reason: 'panel_activity_unknown', detail: panel.detail };
      if (panel.state === 'busy') quietSince = null;
      else {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= window) {
          const work = await this.sampleWork();
          if (work.state === 'idle') return { state: 'drained', requests: 0 };
          return { state: 'waiting', reason: work.reason, detail: work.detail };
        }
      }
      if (Date.now() >= deadline) {
        // A panel busy for the whole window, or one that never stayed quiet
        // long enough, is left running rather than guessed about.
        return { state: 'waiting', reason: panel.state === 'busy' ? 'panel_busy' : 'panel_activity_unknown',
          requests: panel.requests ?? null };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // SIGTERM and a real wait for exit. Escalation to SIGKILL is intentionally
  // absent: a hung panel is reported, not destroyed, so a request can still
  // finish and the operator keeps the evidence.
  async stopChild({ signal = 'SIGTERM', timeoutMs = 15000 } = {}) {
    this.cancelRestart();
    const child = this.child;
    if (!child) return { state: 'absent' };
    // Marked before the signal: the exit this signal causes is deliberate and
    // must not be reported as a crash.
    this.expectedExit = child;
    let timer = null;
    let onExit;
    const exited = new Promise(resolve => {
      onExit = (code, exitSignal) => resolve({ code, signal: exitSignal });
      child.once('exit', onExit);
    });
    try { child.kill(signal); }
    catch {
      this.expectedExit = null;
      return { state: 'failed', reason: 'runner_signal_failed' };
    }
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs); });
    try {
      const result = await Promise.race([exited, timeout]);
      if (result.timedOut) {
        // The child is still alive, so it is not being stopped: leave it
        // supervised and let a later exit be treated as a crash again.
        this.expectedExit = null;
        return { state: 'waiting', reason: 'panel_exit_timeout' };
      }
      if (this.child === child) this.child = null;
      return { state: 'stopped', code: result.code ?? null, signal: result.signal ?? null };
    } finally {
      // The exit wins the race in the normal case; without this the 15 s timer
      // outlives the stop and keeps a handle alive for every restart.
      if (timer !== null) clearTimeout(timer);
      if (this.expectedExit === child) this.expectedExit = null;
      child.off?.('exit', onExit);
    }
  }

  // A restart request: drain, stop, spawn. A busy or unreadable state reports
  // `waiting` and leaves the panel alone.
  async restartChild() {
    this.cancelRestart();
    if (this.child) {
      const drain = await this.drain();
      if (drain.state !== 'drained') {
        // Report and leave the running panel alone. A timeout or an unreadable
        // state must never interrupt a conversation.
        this.writeState({ state: 'waiting', reason: drain.reason });
        return { state: 'waiting', reason: drain.reason };
      }
      const stopped = await this.stopChild();
      if (stopped.state !== 'stopped' && stopped.state !== 'absent') {
        this.writeState({ state: 'waiting', reason: stopped.reason || 'panel_exit_timeout' });
        return { state: 'waiting', reason: stopped.reason || 'panel_exit_timeout' };
      }
    }
    this.restarts = 0;
    this.lastExit = null;
    fs.rmSync(this.entryFile, { force: true });
    this.spawnChild();
    this.writeState({ state: 'restarted' });
    return { state: 'restarted' };
  }

  // A stop request or a termination signal: the same drain the restart uses, so
  // a stop never cuts a running turn short. `waiting` means nothing was
  // signalled and the caller may try again later.
  //
  // `persistent` records the intent to keep trying. A platform termination
  // signal is persistent: the service is being taken down, so the runner keeps
  // re-draining instead of pretending it stopped. A stop *request* is not: the
  // caller was told `waiting` and decides what happens next.
  async shutdown({ persistent = false } = {}) {
    this.cancelRestart();
    // Nothing to stop: the child is already gone (a crash during an earlier
    // drain, or a stop that already completed). Reporting `stopped` here keeps
    // the loop from waiting forever on a panel link that has no owner.
    if (!this.child) return { state: 'stopped' };
    const drain = await this.drain();
    if (drain.state !== 'drained') {
      // `stopping` mirrors the standing intent only: a stop request that could
      // not proceed must not suppress the crash restart of a child that died
      // while it was being examined.
      this.stopping = persistent;
      this.writeState({ state: 'waiting', reason: drain.reason });
      return { state: 'waiting', reason: drain.reason };
    }
    this.stopping = true;
    const stopped = await this.stopChild();
    if (stopped.state === 'stopped' || stopped.state === 'absent') return { state: 'stopped' };
    // A panel that refused to exit is still supervised, so the runner keeps
    // living and a later attempt can retry instead of claiming a stop.
    this.stopping = persistent;
    return { state: 'waiting', reason: stopped.reason || 'panel_exit_timeout' };
  }

  // Control requests are small 0600 JSON files. A request id makes replaying
  // the same file harmless.
  readRequest() {
    let request;
    try { request = readJson(this.requestFile); } catch { return null; }
    if (!request || typeof request !== 'object' || !['restart', 'stop'].includes(request.action)) return null;
    if (typeof request.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(request.id)) return null;
    return request;
  }

  async handleRequest(request) {
    const base = { id: request.id, action: request.action, at: new Date().toISOString() };
    const outcome = request.action === 'restart' ? await this.restartChild() : await this.shutdown();
    // The receipt is the CLI's only confirmation, so it is written before the
    // request file is removed and uses exactly the fields the CLI reads.
    const receipt = { ...base, state: outcome.state,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(Number.isSafeInteger(outcome.requests) ? { requests: outcome.requests } : {}),
      finishedAt: new Date().toISOString() };
    try { writeAtomic(this.receiptFile, receipt, 0o600); } catch {}
    return receipt;
  }

  // The supervisor loop. It owns the process lifetime: a stop that really
  // stopped the panel ends the runner, anything else keeps it (and the service)
  // alive.
  async run() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    this.spawnChild();
    this.writeState({ state: 'running' });
    // `on`, not `once`: a signal that arrives while a turn is running is
    // recorded and re-examined after the drain instead of being consumed.
    const shutdownSignal = () => { this.stopping = true; };
    process.on('SIGTERM', shutdownSignal);
    process.on('SIGINT', shutdownSignal);
    try {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const request = this.readRequest();
        if (request) {
          const outcome = await this.handleRequest(request);
          try { fs.rmSync(this.requestFile, { force: true }); } catch {}
          if (request.action === 'stop' && outcome.state === 'stopped') break;
          continue;
        }
        if (this.stopping) {
          // A platform termination signal is a standing intent: keep retrying
          // every loop pass until the panel is really drained and gone.
          const outcome = await this.shutdown({ persistent: true });
          if (outcome.state === 'stopped') break;
          // Known busy: the panel keeps running and the reason is on record.
          this.writeState({ state: 'waiting', reason: outcome.reason });
          continue;
        }
        this.writeState({ state: this.child ? 'running' : 'starting' });
      }
    } finally {
      this.cancelRestart();
      process.off('SIGTERM', shutdownSignal);
      process.off('SIGINT', shutdownSignal);
    }
    this.writeState({ state: 'stopped' });
    try { fs.rmSync(this.entryFile, { force: true }); } catch {}
    // Nothing is left to supervise, so the runner ends the process explicitly.
    // Waiting for a natural exit depends on every handle being released, and a
    // resident runner would make the platform report a stopped service as
    // running.
    if (this.exitOnStop) setImmediate(() => process.exit(0));
    return 0;
  }
}

// Writes a control request for a running runner and waits for its receipt.
// The caller is the CLI; nothing here talks to launchd directly.
export async function requestRunner({ stateDir, action, id = crypto.randomBytes(16).toString('hex'),
  timeoutMs = 30000, pollMs = 250 } = {}) {
  if (!['restart', 'stop'].includes(action)) throw Error('runner_action_invalid');
  const directory = path.resolve(stateDir);
  const requestFile = path.join(directory, RUNNER_REQUEST_FILE);
  const receiptFile = path.join(directory, RUNNER_RECEIPT_FILE);
  try { fs.rmSync(receiptFile, { force: true }); } catch {}
  writeAtomic(requestFile, { schemaVersion: RUNNER_SCHEMA_VERSION, id, action, at: Date.now() }, 0o600);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let receipt;
    try { receipt = readJson(receiptFile); } catch { receipt = null; }
    if (receipt?.id === id) return receipt;
    if (Date.now() >= deadline) return { id, action, state: 'waiting', reason: 'runner_receipt_timeout' };
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

// Read-only view for `service status`: the runner's own record plus whether the
// child pid it names is alive. `updatedAt` is reported but never used as proof
// of death.
export function inspectRunner({ stateDir, uid, platform = process.platform } = {}) {
  const directory = path.resolve(stateDir);
  let state;
  try { state = readJson(path.join(directory, RUNNER_STATE_FILE)); } catch { return { state: 'conflict' }; }
  if (!state || state.schemaVersion !== RUNNER_SCHEMA_VERSION || !Number.isInteger(state.pid)) return { state: 'absent' };
  const runnerAlive = alive(state.pid);
  const childAlive = alive(state.child);
  const entry = readPanelEntry(path.join(directory, 'panel-entry.json'), { uid });
  return { state: runnerAlive ? (childAlive ? 'running' : 'starting') : 'stopped',
    pid: state.pid, child: state.child ?? null, childAlive, runnerAlive,
    restarts: state.restarts ?? 0, observed: state.observed ?? null, at: state.at ?? null,
    ...(entry ? { panel: { url: entry.url } } : {}) };
}

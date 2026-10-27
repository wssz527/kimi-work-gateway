import crypto from 'node:crypto';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { SubagentPolicy, normalizeSubagentPolicy, readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { SubagentRuntime } from './subagent-runtime.mjs';
import { NativeSetup } from './native-setup.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { copySetupToken } from './native-clipboard.mjs';
import { nativeFlagFile } from './paths.mjs';

const ACTIONS = new Set(['prepare-runtime', 'launch-kimi', 'prepare-native', 'remove-dns', 'copy-token']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const base = config => ({ upstream: config.upstream, tokenEnv: config.tokenEnv, port: config.port, dns: config.dns, models: config.models });
const reason = error => /^[a-z][a-z0-9_-]{0,100}$/.test(error?.message) ? error.message : 'panel_operation_failed';
const summarize = value => ({ mode: value.mode,
  ...(value.mode === 'force' ? { model: value.model, modelAlias: value.modelAlias, ...(value.effort === undefined ? {} : { effort: value.effort }) } : {}),
  ...(value.mode === 'blocked' ? { reason: value.reason } : {}) });

export class PanelError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.status = status; this.details = details; }
}

export class PanelController {
  constructor({ configFile, config, gateway, backend, stateDir, kimiDir, policy,
    runtime, setup, probe, copyToken = copySetupToken, onPolicy } = {}) {
    this.configFile = path.resolve(configFile);
    this.config = config;
    this.baseHash = digest(base(config));
    this.gateway = gateway;
    this.backend = backend;
    this.stateDir = stateDir;
    this.policy = policy || new SubagentPolicy({ stateDir, kimiDir });
    this.runtime = runtime || new SubagentRuntime({ stateDir: path.resolve(stateDir) });
    this.setup = setup || new NativeSetup({ stateDir, flagFile: nativeFlagFile(kimiDir) });
    this.probe = probe || new NativeSetupProbe({ flagFile: nativeFlagFile(kimiDir) });
    this.copyToken = copyToken;
    this.onPolicy = onPolicy;
    this.receiptFile = path.join(stateDir, 'panel-operation-receipt.json');
    this.tail = Promise.resolve();
    this.operation = null;
    this.closed = false;
  }

  readConfiguration() {
    const document = readSubagentJSON(this.configFile);
    const config = readConfig(document);
    return { document, config, revision: digest(document), compatible: this.baseHash === digest(base(config)) };
  }

  serialize(work) {
    const task = this.tail.then(() => {
      if (this.closed) throw new PanelError('panel_stopping', 503);
      return work();
    });
    this.tail = task.catch(() => {});
    return task;
  }

  ownedPolicy() {
    let actual;
    try { actual = readSubagentJSON(this.policy.file); } catch { throw new PanelError('subagent_policy_unavailable', 409); }
    if (actual?.ownerID !== this.policy.ownerID || actual?.homeDir !== this.policy.homeDir) {
      throw new PanelError('subagent_policy_owner_conflict', 409);
    }
    let value;
    try {
      value = actual.mode === 'blocked' && /^[a-z][a-z0-9_-]{0,100}$/.test(actual.reason)
        ? { mode: 'blocked', reason: actual.reason } : normalizeSubagentPolicy(actual, this.backend.models);
      if (actual.schemaVersion !== 1 || !['inherit', 'force', 'blocked'].includes(actual.mode)
        || value.mode === 'force' && actual.modelAlias !== value.modelAlias
        || digest({ ...summarize(actual), homeDir: this.policy.homeDir }) !== actual.revision) throw Error();
    } catch { throw new PanelError('subagent_policy_unavailable', 409); }
    return value;
  }

  async state() {
    let current;
    try { current = this.readConfiguration(); } catch {}
    const configured = (current ? current.config.subagents : this.config.subagents) ?? { mode: 'inherit' };
    const setup = await this.probe.check().catch(() => ({ revealed: false, intranet: { passed: false, error: 'probe_unavailable' } }));
    if (Date.now() >= (this.runtimeAfter || 0)) {
      try { this.runtimeStatus = this.runtime.inspect(); } catch { this.runtimeStatus = { state: 'unavailable' }; }
      this.runtimeAfter = Date.now() + 2000;
    }
    let policy;
    try { policy = this.ownedPolicy(); } catch (error) { policy = { mode: 'blocked', reason: error.message }; }
    const runtime = Object.fromEntries(['state', 'version', 'mode', 'modelAlias', 'reason']
      .filter(field => typeof this.runtimeStatus[field] === 'string').map(field => [field, this.runtimeStatus[field]]));
    const lastSpawn = this.runtimeStatus.lastSpawn;
    if (typeof lastSpawn?.modelAlias === 'string' && Number.isFinite(lastSpawn.at)) {
      runtime.lastSpawn = { modelAlias: lastSpawn.modelAlias, at: lastSpawn.at };
    }
    return { schemaVersion: 1, revision: current?.revision ?? null,
      configuration: { state: current ? (current.compatible ? 'ready' : 'changed') : 'unavailable', file: path.basename(this.configFile) },
      gateway: { state: this.gateway.server ? 'running' : 'stopped', url: this.gateway.url,
        modelCount: this.backend.models.length, activeRequests: this.gateway.inflight.size },
      models: this.backend.models.map(model => ({ ...model })),
      subagents: { configured: summarize(configured), policy, runtime },
      setup, operation: this.operation ? { ...this.operation } : null };
  }

  async apply(input) {
    await this.serialize(async () => {
      if (!input || !['inherit', 'force'].includes(input.mode)) throw new PanelError('invalid_subagent_policy');
      let current;
      try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
      if (!current.compatible) throw new PanelError('configuration_changed', 409);
      if (typeof input.revision !== 'string' || input.revision !== current.revision) throw new PanelError('configuration_conflict', 409);
      const desired = { mode: input.mode, ...(input.mode === 'force' ? { model: input.model,
        ...(input.effort == null ? {} : { effort: input.effort }) } : {}) };
      const normalized = normalizeSubagentPolicy(desired, this.backend.models);
      this.ownedPolicy();
      if (digest(readSubagentJSON(this.configFile)) !== current.revision) throw new PanelError('configuration_conflict', 409);
      writeSubagentJSON(this.configFile, { ...current.document, subagents: desired });
      this.config = { ...this.config, subagents: normalized };
      try { this.policy.configure(desired, this.backend.models); }
      catch (error) {
        this.runtimeAfter = 0;
        throw new PanelError('subagent_policy_apply_failed', 503, { saved: true, reason: reason(error) });
      }
      this.onPolicy?.(normalized);
      this.runtimeAfter = 0;
    });
    return this.state();
  }

  async action(input) {
    return this.serialize(async () => {
      if (!input || !ACTIONS.has(input.action) || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.id)
        || !Number.isFinite(input.at) || Math.abs(Date.now() - input.at) > 300000) throw new PanelError('invalid_panel_action');
      let history = [];
      try { history = readSubagentJSON(this.receiptFile).history; }
      catch (error) { if (error.code !== 'ENOENT') throw new PanelError('panel_receipt_conflict', 409); }
      if (!Array.isArray(history) || history.some(row => !row || typeof row.id !== 'string' || !ACTIONS.has(row.action) || !Number.isFinite(row.at))) {
        throw new PanelError('panel_receipt_conflict', 409);
      }
      const previous = history.find(row => row.id === input.id);
      if (previous) {
        if (previous.action !== input.action || previous.at !== input.at) throw new PanelError('panel_action_conflict', 409);
        const result = { id: previous.id, action: previous.action, ...(previous.result || { state: 'interrupted' }) };
        if (!this.operationTask) this.operation = result;
        return this.operation?.id === input.id ? this.operation : result;
      }
      if (this.operationTask) throw new PanelError('panel_action_busy', 409);
      this.ownedPolicy();
      history = history.filter(row => Date.now() - row.at < 300000);
      if (history.length >= 128) throw new PanelError('panel_action_limit', 429);
      const record = { id: input.id, action: input.action, at: input.at };
      history.push(record);
      writeSubagentJSON(this.receiptFile, { schemaVersion: 1, history });
      this.operation = { id: input.id, action: input.action, state: 'running' };
      this.operationTask = Promise.resolve().then(async () => {
        let result;
        try {
          this.ownedPolicy();
          if (input.action === 'prepare-runtime') result = this.runtime.prepare();
          else if (input.action === 'launch-kimi') result = await this.runtime.launch();
          else if (input.action === 'copy-token') result = { state: await this.copyToken({ request: input,
            stateDir: this.stateDir, key: this.gateway.connection?.key }) };
          else result = await this.setup.run({ id: input.id, at: input.at,
            action: input.action === 'prepare-native' ? 'prepare' : 'remove-dns' }, this.config.dns.port);
          const safe = result?.state ? { state: result.state,
            ...(result.version ? { version: result.version } : {}), ...(result.reason ? { reason: result.reason } : {}) }
            : { state: 'failed', reason: 'panel_operation_failed' };
          this.operation = { id: input.id, action: input.action, ...safe };
        } catch (error) { this.operation = { id: input.id, action: input.action, state: 'failed', reason: reason(error) }; }
        record.result = { state: this.operation.state, ...(this.operation.reason ? { reason: this.operation.reason } : {}) };
        try { writeSubagentJSON(this.receiptFile, { schemaVersion: 1, history }); }
        catch { this.operation = { id: input.id, action: input.action, state: 'failed', reason: 'panel_receipt_conflict' }; }
        this.runtimeAfter = 0;
        this.probe.cached = null;
      }).finally(() => { this.operationTask = null; });
      return { ...this.operation };
    });
  }

  async close() {
    this.closed = true;
    await this.tail;
    await this.operationTask;
  }
}

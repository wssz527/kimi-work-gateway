import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readConfig } from './config.mjs';
import { SubagentPolicy, normalizeSubagentPolicy, currentDocumentRevision, readSubagentJSON, writeSubagentJSON } from './subagent-policy.mjs';
import { SubagentRuntime } from './subagent-runtime.mjs';
import { NativeSetup } from './native-setup.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { copySetupToken } from './native-clipboard.mjs';
import { nativeFlagFile } from './paths.mjs';
import { inspect as inspectKimiContract } from './kimi-contract.mjs';
import { checkUpstream, connectionFields, connectionRows, discoverModels, presetById, searchCatalog,
  validateConnection, validateConnections, validatePanelModels } from './panel-settings.mjs';
import { providerPresets } from './provider-catalog.mjs';
import { NativeContextPolicy } from './native-context-policy.mjs';
import { NativeMcpManager } from './native-mcp-manager.mjs';
import { readCredentials, writeConnectionKeys } from './setup.mjs';
import { SERVICE_LABEL, SERVICE_SCHEMA_VERSION } from './service-manager.mjs';
import { normalizeTranslationConfig } from './translation-config.mjs';
import { TranslationRuntime } from './translation-runtime.mjs';
import { GatewayUpdater, gatewayUpdateDirectory } from './update-manager.mjs';

const ACTIONS = new Set(['prepare-runtime', 'launch-kimi', 'prepare-native', 'remove-dns', 'copy-token', 'check-upstream', 'check-compat',
  'launch-translated-kimi', 'check-translation', 'check-update', 'install-update', 'rollback-update', 'connect-kimi']);
const MODEL_FIELDS = new Set(['id', 'name', 'protocol', 'contextWindow', 'contextLimit', 'metadataSource',
  'maxOutputTokens', 'tools', 'reasoning', 'inputModalities', 'reasoningEfforts', 'defaultEffort',
  'connectionId', 'upstreamModelId']);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The desktop rewrites `config.toml` on its own schedule, so the saved context
// policy is checked often enough to come back within seconds of a rewrite and
// never on the polling read path.
const CONTEXT_POLICY_INTERVAL_MS = 10000;
const CONTEXT_POLICY_DEBOUNCE_MS = 250;

// A discovery belongs to one exact endpoint. Keying the cache by connection id
// alone would keep answering with the previous vendor's catalog after the saved
// connection pointed at a new base URL or preset, so identity is the key.
const discoveryKey = connection => JSON.stringify([connection.id, connection.baseURL,
  connection.providerPresetId ?? null]);

const base = config => ({ ...connectionFields(config), models: config.models, translation: normalizeTranslationConfig(config.translation) });
const reason = error => /^[a-z][a-z0-9_-]{0,100}$/.test(error?.message) ? error.message : 'panel_operation_failed';
const summarize = value => ({ mode: value.mode,
  ...(value.transport ? { transport: value.transport } : {}),
  ...(['force', 'pool'].includes(value.mode) ? { model: value.model, modelAlias: value.modelAlias,
    ...(value.mode === 'pool' ? { models: value.models } : {}),
    ...(value.effort === undefined ? {} : { effort: value.effort }) } : {}),
  ...(value.mode === 'blocked' ? { reason: value.reason } : {}) });

export class PanelError extends Error {
  constructor(code, status = 400, details = {}) { super(code); this.status = status; this.details = details; }
}

// The product needs a status and a tool list, not a diagnostics console. The
// kernel's raw test output is redacted best-effort, so it is dropped here
// rather than shown as if it were safe.
const TOOL_RESULT_FIELDS = ['ok', 'state', 'reason', 'name', 'field', 'code', 'toolCount', 'declaredToolCount'];
const TOOL_RESULT_STATES = new Set(['added', 'updated', 'removed', 'absent', 'unchanged', 'exists', 'invalid',
  'not_found', 'unavailable', 'connected', 'failed', 'timeout', 'busy', 'closed']);

export function toolResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, state: 'unavailable', reason: 'native_mcp_operation_failed' };
  const result = {};
  for (const field of TOOL_RESULT_FIELDS) {
    const item = value[field];
    if (field === 'ok' ? typeof item === 'boolean' : field === 'toolCount' || field === 'declaredToolCount'
      ? Number.isInteger(item) && item >= 0 : typeof item === 'string' && item.length <= 256) {
      if (field === 'state' && !TOOL_RESULT_STATES.has(item)) continue;
      result[field] = item;
    }
  }
  result.ok = value.ok === true;
  // The server row `add`/`update` returns is the same redacted shape `state()`
  // gives, so it is passed through unchanged; `tools` is the parsed tool-name
  // list from a `test`, which is what a user asked for.
  if (value.server && typeof value.server === 'object' && !Array.isArray(value.server)) result.server = value.server;
  if (Array.isArray(value.tools)) result.tools = value.tools.filter(name => typeof name === 'string' && name.length <= 128).slice(0, 100);
  if (value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)) {
    const summary = {};
    for (const field of ['toolCount', 'declaredToolCount']) {
      if (Number.isInteger(value.summary[field]) && value.summary[field] >= 0) summary[field] = value.summary[field];
    }
    if (Object.keys(summary).length) result.summary = summary;
  }
  return result;
}

export class PanelController {
  constructor({ configFile, config, gateway, backend, stateDir, kimiDir, policy,
    runtime, setup, probe, copyToken = copySetupToken, onPolicy, env = process.env,
    inspectContract = inspectKimiContract, translationRuntime, updater, nativeConnection,
    credentialsFile = null, contextPolicy, mcpManager, service = null } = {}) {
    this.configFile = path.resolve(configFile);
    this.config = config;
    this.credentialsFile = credentialsFile ? path.resolve(credentialsFile) : null;
    this.baseHash = digest(base(config));
    this.gateway = gateway;
    this.backend = backend;
    this.stateDir = stateDir;
    this.policy = policy || new SubagentPolicy({ stateDir, kimiDir });
    this.runtime = runtime || new SubagentRuntime({ stateDir: path.resolve(stateDir) });
    this.setup = setup || new NativeSetup({ stateDir, flagFile: nativeFlagFile(kimiDir) });
    this.probe = probe || new NativeSetupProbe({ flagFile: nativeFlagFile(kimiDir) });
    this.nativeConnection = nativeConnection;
    this.desktop = nativeConnection?.desktop;
    this.translation = translationRuntime || this.desktop?.runtime || new TranslationRuntime({ stateDir, kimiDir, env });
    this.updater = updater || new GatewayUpdater({ updateDir: gatewayUpdateDirectory(env) });
    try { this.translation.configure(config.translation); }
    catch { this.translationError = 'translation_settings_conflict'; }
    this.copyToken = copyToken;
    this.onPolicy = onPolicy;
    this.env = env;
    this.inspectContract = inspectContract;
    this.diagnostics = {};
    this.receiptFile = path.join(stateDir, 'panel-operation-receipt.json');
    // Both native surfaces are optional: without a Kimi installation the panel
    // still reports models and connections, and these two simply say so. One
    // manager per process is the rule for MCP — the kernel client is shared by
    // every request and closed once at shutdown.
    this.contextPolicy = contextPolicy === undefined
      ? new NativeContextPolicy({ stateDir, kimiDir }) : contextPolicy;
    this.mcpManager = mcpManager === undefined
      ? new NativeMcpManager({ kimiDir, stateDir }) : mcpManager;
    this.mcpSnapshot = null;
    // An optional read-only view of the background service. The panel never
    // installs, starts or stops anything: it only reports whether this state
    // directory's service record covers the config file it is serving, so the
    // UI can name the actual restart command instead of a terminal guess.
    this.service = service;
    // The last successful discovery per connection, kept in memory only: it is
    // a lookup table for search, never a saved catalog, and it holds no key and
    // no raw payload.
    this.lastDiscovery = Object.create(null);
    this.tail = Promise.resolve();
    this.operation = null;
    this.closed = false;
  }

  get protectedEnvNames() {
    const config = this.config;
    const names = [config.upstream?.apiKeyEnv, ...(config.connections || []).map(connection => connection.apiKeyEnv), config.tokenEnv];
    return names.filter(name => typeof name === 'string' && name);
  }

  readConfiguration() {
    const document = readSubagentJSON(this.configFile);
    const config = readConfig(document);
    return { document, config, revision: digest(document), compatible: this.baseHash === digest(base(config)) };
  }

  currentConfiguration(input, { allowPending = false } = {}) {
    if (this.operationTask) throw new PanelError('panel_action_busy', 409);
    let current;
    try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
    if (!allowPending && !current.compatible) throw new PanelError('configuration_changed', 409);
    if (typeof input?.revision !== 'string' || input.revision !== current.revision) throw new PanelError('configuration_conflict', 409);
    this.ownedPolicy();
    return current;
  }

  persist(current, document) {
    if (digest(readSubagentJSON(this.configFile)) !== current.revision) throw new PanelError('configuration_conflict', 409);
    writeSubagentJSON(this.configFile, document);
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
        ? { mode: 'blocked', reason: actual.reason } : normalizeSubagentPolicy(actual, this.backend.models, this.policy.aliases);
      if (actual.schemaVersion !== 1 || !['inherit', 'force', 'pool', 'blocked'].includes(actual.mode)
        || ['force', 'pool'].includes(value.mode) && actual.modelAlias !== value.modelAlias
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
    const native = this.policy.nativeSubagents;
    if (native && (policy.transport === 'native-config' || configured.transport === 'native-config' || native.policy?.transport === 'native-config')) {
      if (this.policy.nativeSync) { this.policy.nativeSync(); this.runtimeStatus = native.inspect(); }
      else if (policy.mode !== 'blocked') this.runtimeStatus = native.update({ ...policy, transport: 'native-config' });
      else this.runtimeStatus = native.inspect?.() || { state: 'conflict', reason: policy.reason };
    }
    const runtime = Object.fromEntries(['state', 'version', 'mode', 'modelAlias', 'reason', 'transport']
      .filter(field => typeof this.runtimeStatus[field] === 'string').map(field => [field, this.runtimeStatus[field]]));
    if (this.runtimeStatus.observed?.state === 'observed-schema') runtime.observed = { ...this.runtimeStatus.observed };
    if (this.runtimeStatus.compatibility?.state === 'source-compatible') runtime.compatibility = { ...this.runtimeStatus.compatibility };
    const lastSpawn = this.runtimeStatus.lastSpawn;
    if (typeof lastSpawn?.modelAlias === 'string' && Number.isFinite(lastSpawn.at)) {
      runtime.lastSpawn = { modelAlias: lastSpawn.modelAlias, at: lastSpawn.at };
    }
    const saved = current ? connectionFields(current.config) : null;
    const active = connectionFields(this.config);
    const translationSettings = normalizeTranslationConfig((current?.config ?? this.config).translation);
    let translationStatus;
    try { translationStatus = this.translationError ? { state: 'failed', reason: this.translationError } : this.translation.inspect(); }
    catch { translationStatus = { state: 'failed', reason: 'translation_session_failed' }; }
    const translationRuntime = Object.fromEntries(['state', 'version', 'reason', 'warning', 'verification']
      .filter(field => typeof translationStatus?.[field] === 'string').map(field => [field, translationStatus[field]]));
    if (Number.isInteger(translationStatus?.pid)) translationRuntime.pid = translationStatus.pid;
    // Per-surface state travels beside the aggregate state: it is what tells
    // "Chat is attached but shows no reasoning yet" apart from "the page is
    // translating" and from "the selectors drifted". `TranslationRuntime`
    // already reduced it to an allowlisted shape.
    if (translationStatus?.surfaces) translationRuntime.surfaces = translationStatus.surfaces;
    if (this.diagnostics.translationWarning?.reason) translationRuntime.warning = this.diagnostics.translationWarning.reason;
    const compatibility = this.runtimeStatus?.compatibility;
    if (compatibility && ['structural', 'existing'].includes(compatibility.strategy)
      && Number.isInteger(compatibility.adapterVersion)) runtime.compatibility = { ...compatibility };
    let updates;
    try { updates = this.updater.inspect(); }
    catch { updates = { currentVersion: 'unknown', state: 'failed', reason: 'update_state_invalid' }; }
    let desktopInspect;
    try { desktopInspect = this.desktop?.inspect(); } catch { desktopInspect = {}; }
    return { schemaVersion: 1, updates, revision: current?.revision ?? null,
      configuration: { state: current ? (current.compatible ? 'ready' : 'changed') : 'unavailable', file: path.basename(this.configFile) },
      service: this.serviceState(),
      gateway: { state: this.gateway.server ? 'running' : 'stopped', url: this.gateway.url,
        modelCount: this.backend.models.length, activeRequests: this.gateway.inflight.size },
      integration: { ...(this.gateway.nativeIntegration?.status || { state: 'unchecked', imported: false }),
        ...(this.nativeConnection ? { preparation: Object.fromEntries(Object.entries(this.nativeConnection.status || {})
          .filter(([key]) => ['state', 'reason', 'stage'].includes(key))),
          desktop: Object.fromEntries(Object.entries(desktopInspect || {})
            .filter(([key]) => ['state', 'reason', 'version', 'enabled'].includes(key))) } : {}) },
      models: this.backend.models.map(model => ({ ...model })),
      subagents: { configured: summarize(configured), policy, runtime },
      translation: { configured: translationSettings,
        // The revision the translation host compares against, sanitized: it is
        // derived from the settings plus the home dir, not from gateway.json,
        // so it only moves when translation settings move and it names no
        // path. A settings file that cannot be read yet reports `null` and the
        // UI sends no revision, which the write accepts for a first save.
        revision: this.translationRevisionOf(),
        environment: { keySet: Boolean(this.env[translationSettings.apiKeyEnv]) }, runtime: translationRuntime },
      connection: { active, saved, environment: { apiKeySet: Boolean(this.env[saved?.upstream?.apiKeyEnv || active.upstream?.apiKeyEnv]),
        tokenSet: Boolean(this.env[saved?.tokenEnv || active.tokenEnv]) } },
      connections: { active: connectionRows(this.config, this.env),
        saved: current ? connectionRows(current.config, this.env) : null,
        restartRequired: Boolean(current && !current.compatible) },
      metrics: structuredClone(this.gateway.metrics), diagnostics: structuredClone(this.diagnostics),
      context: this.contextState(), tools: this.toolsState(),
      setup, operation: this.operation ? { ...this.operation } : null };
  }

  // A read of the native surfaces never writes: `state()` is what the panel
  // polls every two seconds, so it must not keep re-asserting a policy over a
  // value someone else wrote, and it must not start an MCP server. A missing
  // installation degrades to a reason code instead of failing the whole state.
  contextState() {
    try { return this.contextPolicy?.state() ?? null; } catch { return { policy: { mode: 'inherit' }, status: 'conflict', reason: 'context_policy_unavailable' }; }
  }

  // How this panel process is actually being run, derived only from the state
  // directory's service record and the paths it names. Everything here is a
  // file read: no launchctl, no schtasks, no credential value, no panel entry
  // URL. A record counts only when its label and config path match this
  // process, because an unrelated or stale service.json must not make the page
  // claim a background service that is not serving this config.
  serviceState() {
    if (!this.service) return null;
    const record = this.service.record?.();
    if (!record) return null;
    if (record.schemaVersion !== SERVICE_SCHEMA_VERSION || record.label !== SERVICE_LABEL
      || record.config !== this.configFile) return { mode: 'unrecognized' };
    const runner = this.service.runnerState?.();
    return { mode: 'service', label: SERVICE_LABEL, config: this.configFile,
      ...(typeof record.log === 'string' ? { log: record.log } : {}),
      ...(runner?.state === 'running' && Number.isInteger(runner.pid) ? { pid: runner.pid } : {}) };
  }

  // The CAS token the settings write compares against: the digest of the whole
  // translation-settings.json document, produced by `currentDocumentRevision`
  // — the same token `TranslationRuntime.configure(settings, {expectedRevision})`
  // hands to `writeSubagentJSON`. Digesting only the settings payload (the
  // document's inner `revision` field) would name a different domain, and
  // every save would then be refused by the real runtime no matter how fresh
  // the page's view was. A missing or unreadable file is `null`, the
  // legitimate first-save state the write accepts.
  translationRevisionOf() {
    try {
      const file = this.translation?.settingsFile;
      if (typeof file !== 'string') return null;
      return currentDocumentRevision(file);
    } catch {
      return null;
    }
  }

  toolsState() {
    if (!this.mcpManager) return { available: false, reason: 'native_mcp_manager_unavailable', servers: [] };
    // `state()` launches nothing, but it is a real kernel read, so the panel
    // reports the last resolved snapshot and refreshes behind the answer. The
    // first read is kicked off here so a freshly started panel fills the card
    // without the page having to ask for the list first.
    if (!this.mcpSnapshot && !this.mcpRefreshing) void this.refreshTools();
    return this.mcpSnapshot ?? { available: false, reason: 'native_mcp_reading', servers: [] };
  }

  // Called once at startup: fills the MCP snapshot before the page polls it.
  // Reconciling the context policy happens on its own schedule (see
  // `startContextWatch`), not from here and never from `state()`.
  async loadNativeState() {
    await this.refreshTools();
  }

  // The desktop owns `config.toml` and rewrites it wholesale, which drops the
  // policy this tool saved. `state()` must stay read-only, so the re-assert runs
  // on its own trigger: a directory watch for the rewrite, plus a slow timer as
  // the fallback a watch cannot cover (an editor writing in place, a missed
  // event, a platform without rename notifications).
  //
  // Re-applying is safe by construction: `NativeContextPolicy.reconcile` only
  // re-asserts a value the file has lost, and a key someone else moved to a
  // different number is reported as `foreign_value` and left alone.
  startContextWatch({ intervalMs = CONTEXT_POLICY_INTERVAL_MS, debounceMs = CONTEXT_POLICY_DEBOUNCE_MS } = {}) {
    if (this.contextWatch || this.closed || !this.contextPolicy) return;
    const file = this.contextPolicy.configPath;
    const directory = path.dirname(file);
    const reconcile = () => this.reconcileContextPolicy();
    // A lowercase once so a burst of writes costs one reconcile.
    const schedule = () => {
      if (this.contextDebounce) clearTimeout(this.contextDebounce);
      this.contextDebounce = setTimeout(() => { this.contextDebounce = null; reconcile(); }, debounceMs);
      this.contextDebounce.unref?.();
    };
    try {
      // Watching the directory, not the file: the desktop writes a temporary
      // file and renames it over `config.toml`, which detaches a file watch.
      this.contextWatch = fs.watch(directory, (event, name) => {
        if (!name || name === path.basename(file)) schedule();
      });
      this.contextWatch.on('error', () => { this.contextWatch?.close?.(); this.contextWatch = null; });
      this.contextWatch.unref?.();
    } catch { this.contextWatch = null; }
    this.contextTimer = setInterval(reconcile, intervalMs);
    this.contextTimer.unref?.();
    reconcile();
  }

  reconcileContextPolicy() {
    if (this.closed || !this.contextPolicy) return;
    try { this.contextPolicy.reconcile(); } catch {}
  }

  stopContextWatch() {
    if (this.contextDebounce) { clearTimeout(this.contextDebounce); this.contextDebounce = null; }
    if (this.contextTimer) { clearInterval(this.contextTimer); this.contextTimer = null; }
    try { this.contextWatch?.close?.(); } catch {}
    this.contextWatch = null;
  }

  async refreshTools() {
    if (!this.mcpManager || this.mcpRefreshing) return this.toolsState();
    this.mcpRefreshing = true;
    try {
      this.mcpSnapshot = await this.mcpManager.state();
    } catch {
      this.mcpSnapshot = { available: false, reason: 'native_mcp_operation_failed', servers: [] };
    } finally {
      this.mcpRefreshing = false;
    }
    return this.mcpSnapshot;
  }

  providers() {
    return { presets: providerPresets() };
  }

  async modelSearch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || typeof input.query !== 'string' || input.query.length > 200) throw new PanelError('invalid_model_search');
    const presetId = input.presetId === undefined ? undefined : input.presetId;
    if (presetId !== undefined && typeof presetId !== 'string') throw new PanelError('invalid_model_search');
    const connectionId = input.connectionId === undefined ? undefined : input.connectionId;
    if (connectionId !== undefined && typeof connectionId !== 'string') throw new PanelError('invalid_model_search');
    let preset = presetId === undefined ? null : presetById(presetId);
    if (presetId !== undefined && !preset) throw new PanelError('invalid_model_search');
    let discovery = null;
    if (connectionId !== undefined) {
      let current;
      try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
      const connection = current.config.connections.find(row => row.id === connectionId);
      if (!connection) throw new PanelError('connection_unavailable', 409);
      // The saved connection describes one endpoint, so its own preset is the
      // authority. An explicit *different* preset is a contradiction, not a
      // preference to honour: searching the wrong vendor's catalog while
      // attributing it to this connection would mislabel every candidate.
      const own = connection.providerPresetId ? presetById(connection.providerPresetId) : null;
      if (own) {
        if (preset && preset.id !== own.id) throw new PanelError('preset_connection_mismatch');
        preset = own;
      }
      discovery = this.lastDiscovery[discoveryKey(connection)] ?? null;
    }
    const models = searchCatalog({ preset, discovery, query: input.query });
    return { query: input.query, models };
  }

  async apply(input) {
    await this.serialize(async () => {
      if (!input || !['inherit', 'force', 'pool'].includes(input.mode)) throw new PanelError('invalid_subagent_policy');
      const current = this.currentConfiguration(input);
      const desired = { mode: input.mode, transport: 'native-config',
        ...(['force', 'pool'].includes(input.mode) ? { model: input.model,
          ...(input.mode === 'pool' ? { models: input.models } : {}),
          ...(input.effort == null ? {} : { effort: input.effort }) } : {}) };
      const normalized = normalizeSubagentPolicy(desired, this.backend.models, this.policy.aliases);
      this.persist(current, { ...current.document, subagents: desired });
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

  async saveModels(input) {
    await this.serialize(async () => {
      const current = this.currentConfiguration(input);
      const models = validatePanelModels(input.models);
      let normalized;
      try { normalized = normalizeSubagentPolicy(current.config.subagents, models, this.policy.aliases); }
      catch { throw new PanelError('subagent_model_in_use', 409); }
      const previous = new Map(current.document.models.map(row => [row.id, row]));
      const stored = models.map(model => ({ ...Object.fromEntries(Object.entries(previous.get(model.id) || {})
        .filter(([key]) => !MODEL_FIELDS.has(key))), ...model }));
      // A catalog that still references a connection the file no longer has
      // would persist a configuration that cannot load again.
      const connectionIds = new Set((current.document.connections || []).map(row => row.id));
      const orphan = stored.find(model => model.connectionId !== undefined && !connectionIds.has(model.connectionId));
      if (orphan) throw new PanelError('connection_unavailable', 409, { models: [orphan.id] });
      this.persist(current, { ...current.document, models: stored });
      this.backend.models = models;
      this.gateway.models = models;
      this.config = { ...this.config, models: stored, subagents: normalized };
      this.baseHash = digest(base(this.config));
      this.diagnostics.compat = undefined;
      try { this.policy.configure(current.document.subagents, models); }
      catch (error) { throw new PanelError('configuration_apply_failed', 503, { saved: true, reason: reason(error) }); }
      this.onPolicy?.(normalized);
      this.runtimeAfter = 0;
    });
    return this.state();
  }

  async saveConnection(input) {
    await this.serialize(async () => {
      const current = this.currentConfiguration(input, { allowPending: true });
      const connection = validateConnection(input, current.document);
      this.persist(current, { ...current.document, ...connection,
        upstream: connection.upstream ? { ...current.document.upstream, ...connection.upstream } : current.document.upstream,
        dns: { ...current.document.dns, ...connection.dns } });
    });
    return this.state();
  }

  // Replaces the whole connection set. The running gateway keeps its endpoints
  // until the panel restarts, which is why the response reports the saved set
  // and `restartRequired` instead of pretending the change is live.
  async saveConnections(input) {
    await this.serialize(async () => {
      const current = this.currentConfiguration(input, { allowPending: true });
      let validated;
      try { validated = validateConnections(input, current.document); }
      catch (error) { throw new PanelError(reason(error), 400); }
      const { connections, apiKeys } = validated;
      if (Object.keys(apiKeys).length && !this.credentialsFile) throw new PanelError('credentials_file_unavailable', 409);
      // A model pointing at a removed connection would fail every request it
      // serves; refusing the save keeps the two lists consistent.
      const referenced = current.config.models.filter(model => model.connectionId !== undefined
        && !connections.some(connection => connection.id === model.connectionId));
      if (referenced.length) {
        throw new PanelError('connection_in_use', 409, { models: referenced.map(model => model.id) });
      }
      const document = { ...current.document, connections };
      try { readConfig(document); } catch (error) { throw new PanelError(reason(error), 400); }
      // Credentials are written first: a key failure must leave the saved
      // configuration untouched rather than produce a config whose key is
      // missing from the file.
      if (Object.keys(apiKeys).length) this.storeConnectionKeys(apiKeys);
      this.persist(current, document);
      // The running gateway keeps its endpoints and its environment: `config`
      // stays the *active* view, and the next `state()` reports the saved set
      // beside it with `restartRequired`. Pretending the save is live would let
      // a model route to an endpoint this process cannot reach.
    });
    return this.state();
  }

  // Keys are written to the private credential file only, merged with whatever
  // is already there so an omitted key keeps its value. The live process keeps
  // its old environment on purpose: the saved key becomes active on restart,
  // which is what `restartRequired` reports.
  storeConnectionKeys(apiKeys) {
    try { writeConnectionKeys(this.credentialsFile, { apiKeys }); }
    catch (error) { throw new PanelError(reason(error), 409); }
  }

  // Discovery reads one already-saved connection's catalog. It never writes a
  // model and never reaches an inference endpoint, so it is safe to run while
  // the other writes are busy - but two discoveries at once are pointless
  // work, so the second is refused.
  async discover(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.connectionId !== 'string') {
      throw new PanelError('invalid_discovery', 400);
    }
    // `revision` is optional here: discovery writes nothing, so a stale one
    // must not block a read-only probe. A caller that sends it gets the same
    // conflict answer as the other endpoints.
    if (input.revision !== undefined) {
      let current;
      try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
      if (input.revision !== current.revision) throw new PanelError('configuration_conflict', 409);
    }
    if (this.discoveryTask) throw new PanelError('discovery_busy', 409);
    const connectionId = input.connectionId;
    let probed = null;
    this.discoveryTask = Promise.resolve().then(async () => {
      let saved;
      try { saved = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
      const connection = saved.config.connections.find(row => row.id === connectionId);
      if (!connection) throw new PanelError('connection_unavailable', 409);
      probed = connection;
      let apiKey;
      try { apiKey = this.connectionKey(connection); } catch { apiKey = undefined; }
      try {
        return await discoverModels({ connection, apiKey, fetchImpl: this.discoveryFetch,
          presetId: connection.providerPresetId });
      } catch (error) {
        const code = /^discovery_[a-z_]+$/.test(error?.message) ? error.message : 'discovery_unavailable';
        return { connectionId, state: 'failed', reason: code, models: [], modelCount: 0,
          ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}) };
      }
    }).then(result => {
      // Only a passed discovery is remembered, and only as a search source: a
      // failed read replaces nothing, so the last real catalog keeps answering.
      // It is stored under the endpoint that answered it, never under a bare id.
      if (result?.state === 'passed' && Array.isArray(result.models) && probed) {
        this.lastDiscovery[discoveryKey(probed)] = { models: result.models,
          sourceURL: result.sourceURL, checkedAt: result.checkedAt };
      }
      return result;
    }).finally(() => { this.discoveryTask = null; });
    return this.discoveryTask;
  }

  // The key for a saved connection. Discovery and a freshly saved key are about
  // the *file*, so the private credential file wins: a key saved one moment ago
  // must be the one probed, even while this process still carries the older
  // value in its environment. Only a connection with no stored key (an
  // environment-only install) falls back to the running environment.
  connectionKey(connection) {
    let stored;
    if (this.credentialsFile) {
      const credentials = readCredentials(this.credentialsFile, { requirePrivate: true });
      stored = credentials?.connectionApiKeys?.[connection.id];
    }
    if (typeof stored === 'string' && stored) return stored;
    if (typeof connection.apiKeyEnv === 'string' && this.env?.[connection.apiKeyEnv]) return this.env[connection.apiKeyEnv];
    return undefined;
  }

  // Saving a policy is a native write: `triggerRatio` is the decimal the
  // kernel's schema takes (0.50 … 0.99), never a percentage, and the response
  // is the policy's real state — `applied` only says the file was observed to
  // carry it. A running session is not affected; the next one reads the file.
  async saveContext(input) {
    const policy = input?.policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new PanelError('invalid_context_policy');
    if (!this.contextPolicy) throw new PanelError('context_policy_unavailable', 503);
    const result = this.contextPolicy.update(policy);
    if (result?.status === 'conflict' && result.reason === 'invalid_policy') throw new PanelError('invalid_context_policy');
    return { context: result };
  }

  // Fixed operations only. Anything else — an arbitrary eval, a shell field, a
  // second transport — is refused before the manager sees it, and `test` is the
  // one call that may start a real server, which is why it is never implicit.
  async tools(input) {
    if (!this.mcpManager) throw new PanelError('native_mcp_unavailable', 503);
    const action = input?.action;
    if (!['add', 'update', 'remove', 'test'].includes(action)) throw new PanelError('invalid_tool_action');
    let result;
    if (action === 'add') result = await this.mcpManager.add(input.server);
    else if (action === 'update') result = await this.mcpManager.update(input.name, input.patch ?? {});
    else if (action === 'remove') result = await this.mcpManager.remove(input.name);
    else result = await this.mcpManager.test(input.name, input.options === undefined ? {} : input.options);
    this.mcpSnapshot = await this.mcpManager.state();
    return { tools: this.mcpSnapshot, result: toolResult(result) };
  }

  async saveTranslation(input) {
    await this.serialize(async () => {
      // The historical whole-document lock stays the default: `revision` still
      // names the gateway.json revision the caller saw, so an old client that
      // sends it keeps the exact protection it always had, and a save without
      // one is still refused once the file exists. `translationRevision` is
      // the newer, narrower lock: it names the translation settings the host
      // currently carries, and when present it is handed to the runtime as a
      // compare-and-swap token, so a stale save fails inside the write instead
      // of silently overwriting another process's change. Either lock alone is
      // enough; sending both requires both to match.
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PanelError('invalid_translation_config');
      const { revision, translationRevision: settingsRevision, documentRevision, ...value } = input;
      let current;
      try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
      if (!current.compatible) throw new PanelError('configuration_changed', 409);
      const documentToken = documentRevision ?? revision;
      if (documentToken !== undefined && documentToken !== current.revision) {
        throw new PanelError('configuration_conflict', 409);
      }
      let settings;
      try { settings = normalizeTranslationConfig(value); }
      catch (error) { throw new PanelError(reason(error)); }
      // When no document lock was sent, the settings token is required: a page
      // that saw neither revision could overwrite anything blindly.
      if (documentToken === undefined && typeof settingsRevision !== 'string') {
        throw new PanelError('translation_settings_conflict', 409);
      }
      const expected = this.translationRevisionOf();
      if (typeof settingsRevision === 'string') {
        if (expected === null || settingsRevision !== expected) {
          throw new PanelError('translation_settings_conflict', 409, { expectedRevision: expected });
        }
      }
      this.persist(current, { ...current.document, translation: settings });
      this.config = { ...this.config, translation: settings };
      this.baseHash = digest(base(this.config));
      try {
        // A caller that proved it knows the current settings hands its token
        // to the runtime, which re-reads the file immediately before the
        // rename; a save racing another process fails there instead of
        // overwriting it. Callers without a settings token keep the runtime's
        // historical last-writer-wins path.
        this.translation.configure(settings,
          typeof settingsRevision === 'string' ? { expectedRevision: settingsRevision } : {});
        this.translationError = undefined;
        delete this.diagnostics.translationWarning;
      } catch (error) {
        if (error?.message === 'translation_settings_conflict') {
          throw new PanelError('translation_settings_conflict', 409, { saved: true, reason: 'translation_settings_conflict' });
        }
        this.translationError = 'translation_settings_conflict';
        throw new PanelError('translation_apply_failed', 503, { saved: true, reason: reason(error) });
      }
    });
    return this.state();
  }

  async launchTranslation() {
    let current;
    try { current = this.readConfiguration(); } catch { throw new PanelError('configuration_unavailable', 409); }
    if (!current.compatible) throw new PanelError('configuration_changed', 409);
    const policy = this.ownedPolicy();
    if (policy.mode === 'blocked') throw new PanelError('subagent_policy_unavailable', 409);
    this.translation.configure(current.config.translation);
    this.translationError = undefined;
    const options = { subagentRuntime: policy.transport === 'native-config' ? undefined : this.runtime,
      force: policy.mode === 'force' && policy.transport !== 'native-config',
      protectedEnvNames: this.protectedEnvNames };
    const result = await (this.desktop ? this.desktop.start(options) : this.translation.launch(options));
    if (result?.warning) this.diagnostics.translationWarning = { at: Date.now(), reason: result.warning };
    else delete this.diagnostics.translationWarning;
    return result;
  }

  async diagnose(action, { connectionId = null } = {}) {
    if (action === 'check-upstream') {
      // The named connection is the whole scope of one check: the panel passes
      // the row the user clicked, and a null here means the legacy single
      // upstream exactly as before — never an implicit pick of the first row.
      const result = { ...(await checkUpstream(this.backend, { connectionId })), connectionId };
      this.diagnostics.upstream = result;
      return result;
    }
    const result = await this.inspectContract({ models: this.backend.models });
    const safe = { state: ['verified', 'incompatible', 'unavailable', 'unverified'].includes(result?.state) ? result.state : 'unverified',
      at: Date.now(), modelCount: this.backend.models.length,
      ...(typeof result?.version === 'string' ? { version: result.version } : {}),
      ...(Array.isArray(result?.accepted) ? { acceptedCount: result.accepted.length } : {}),
      ...(Array.isArray(result?.skipped) ? { skippedCount: result.skipped.length } : {}),
      ...(typeof result?.reason === 'string' && /^[a-z][a-z0-9_-]{0,100}$/.test(result.reason) ? { reason: result.reason } : {}) };
    this.diagnostics.compat = safe;
    return safe;
  }

  async action(input) {
    return this.serialize(async () => {
      if (!input || !ACTIONS.has(input.action) || typeof input.id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.id)
        || !Number.isFinite(input.at) || Math.abs(Date.now() - input.at) > 300000) throw new PanelError('invalid_panel_action');
      // Only check-upstream carries a connection id today. It must name a
      // configured endpoint of the *running* backend: the check probes what
      // this process can reach, not what a draft or a stale file says, and it
      // never falls back to an implicit first row.
      let connectionId = null;
      if (input.action === 'check-upstream') {
        const requested = input.connectionId;
        if (requested !== undefined && requested !== null && (typeof requested !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(requested))) throw new PanelError('invalid_panel_action');
        connectionId = typeof requested === 'string' ? requested : null;
        if (!this.backend?.has?.(connectionId ?? null)) throw new PanelError('connection_unavailable', 409);
      }
      let history = [];
      try { history = readSubagentJSON(this.receiptFile).history; }
      catch (error) { if (error.code !== 'ENOENT') throw new PanelError('panel_receipt_conflict', 409); }
      if (!Array.isArray(history) || history.some(row => !row || typeof row.id !== 'string' || !ACTIONS.has(row.action) || !Number.isFinite(row.at))) {
        throw new PanelError('panel_receipt_conflict', 409);
      }
      const previous = history.find(row => row.id === input.id);
      if (previous) {
        // A replayed id answers with its original result only when the whole
        // payload matches; a re-sent id with a different connection must not
        // silently adopt (or re-run against) another row's target.
        const payload = () => JSON.stringify({ action: previous.action, connectionId: previous.connectionId ?? null });
        if (previous.action !== input.action || previous.at !== input.at
          || payload() !== JSON.stringify({ action: input.action, connectionId })) {
          throw new PanelError('panel_action_conflict', 409);
        }
        const result = { id: previous.id, action: previous.action, ...(previous.result || { state: 'interrupted' }) };
        if (!this.operationTask) this.operation = result;
        return this.operation?.id === input.id ? this.operation : result;
      }
      if (this.operationTask) throw new PanelError('panel_action_busy', 409);
      this.ownedPolicy();
      history = history.filter(row => Date.now() - row.at < 300000);
      if (history.length >= 128) throw new PanelError('panel_action_limit', 429);
      const record = { id: input.id, action: input.action, at: input.at };
      if (input.action === 'check-upstream') record.connectionId = connectionId;
      history.push(record);
      writeSubagentJSON(this.receiptFile, { schemaVersion: 1, history });
      this.operation = { id: input.id, action: input.action, state: 'running' };
      this.operationTask = Promise.resolve().then(async () => {
        let result;
        try {
          this.ownedPolicy();
          if (input.action === 'check-update') result = await this.updater.check();
          else if (input.action === 'install-update') result = await this.updater.install();
          else if (input.action === 'rollback-update') result = await this.updater.rollback();
          else if (input.action === 'check-upstream') result = await this.diagnose(input.action, { connectionId });
          else if (input.action === 'check-compat') result = await this.diagnose(input.action);
          else if (input.action === 'prepare-runtime') result = this.runtime.prepare();
          else if (input.action === 'launch-translated-kimi') result = await this.launchTranslation();
          else if (input.action === 'check-translation') result = this.translation.check();
          else if (input.action === 'connect-kimi') {
            if (!this.nativeConnection) throw new PanelError('native_connection_unavailable', 503);
            result = await this.nativeConnection.retry();
          }
          else if (input.action === 'launch-kimi') {
            if (normalizeTranslationConfig(this.config.translation).enabled) result = await this.launchTranslation();
            else {
              const policy = this.ownedPolicy();
              result = policy.mode === 'inherit' || policy.transport === 'native-config'
                ? this.desktop ? await this.desktop.start() : await this.runtime.launchOriginal({ protectedEnvNames: this.protectedEnvNames })
                : await this.runtime.launch({ protectedEnvNames: this.protectedEnvNames });
            }
          }
          else if (input.action === 'copy-token') result = { state: await this.copyToken({ request: input,
            stateDir: this.stateDir, key: this.gateway.connection?.key }) };
          else result = await this.setup.run({ id: input.id, at: input.at,
            action: input.action === 'prepare-native' ? 'prepare' : 'remove-dns' }, this.config.dns.port);
          const safe = result?.state ? { state: result.state,
            ...(result.version ? { version: result.version } : {}), ...(result.reason ? { reason: result.reason } : {}),
            ...(result.warning ? { warning: result.warning } : {}) }
            : { state: 'failed', reason: 'panel_operation_failed' };
          if (input.action === 'check-upstream') {
            safe.connectionId = connectionId;
            // The per-row summary is what the row's check line renders; it is
            // bounded metadata, never a catalog body or a credential.
            if (Number.isInteger(result?.modelCount)) safe.modelCount = result.modelCount;
            if (Number.isFinite(result?.ms)) safe.ms = result.ms;
            if (Number.isInteger(result?.httpStatus)) safe.httpStatus = result.httpStatus;
          }
          this.operation = { id: input.id, action: input.action, ...safe };
        } catch (error) { this.operation = { id: input.id, action: input.action, state: 'failed', reason: reason(error) }; }
        // The stored result keeps the row id so a replay answers for the same
        // connection it originally probed, with the same bounded summary.
        record.result = { state: this.operation.state,
          ...(this.operation.reason ? { reason: this.operation.reason } : {}),
          ...(this.operation.warning ? { warning: this.operation.warning } : {}),
          ...(this.operation.connectionId !== undefined ? { connectionId: this.operation.connectionId } : {}),
          ...(Number.isInteger(this.operation.modelCount) ? { modelCount: this.operation.modelCount } : {}),
          ...(Number.isFinite(this.operation.ms) ? { ms: this.operation.ms } : {}),
          ...(Number.isInteger(this.operation.httpStatus) ? { httpStatus: this.operation.httpStatus } : {}) };
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
    this.stopContextWatch();
    await this.tail;
    await this.operationTask;
    this.nativeConnection?.close();
    // The MCP client is the only native handle this controller owns; it is
    // released once, and a later call reports `native_mcp_manager_closed`
    // instead of reaching a half-closed client.
    try { await this.mcpManager?.close(); } catch {}
  }
}

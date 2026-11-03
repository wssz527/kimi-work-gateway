// First-run setup: one local page, one save.
//
// The page collects the upstream Base URL, the upstream key and the model
// declarations in a single step. Nothing is guessed: each model's protocol and
// capabilities come from the user's declarations, and a model that cannot be
// declared unambiguously is refused instead of defaulted.
//
// The upstream key and the gateway token are written only to a private
// `credentials.json` in the user's state directory (regular file, owned by this
// user, mode 0600). They are never returned to the page, never written to a
// log, and never stored in the configuration JSON or the npm package.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.mjs';
import { presetById, searchCatalog, validatePanelModels } from './panel-settings.mjs';
import { providerPresets } from './provider-catalog.mjs';
import { validateBaseURL } from './openai-backend.mjs';
import { defaultStateDirectory } from './paths.mjs';
import { readPanelEntry } from './service-manager.mjs';

export const SETUP_SCHEMA_VERSION = 2;
export const SETUP_CONFIG_FILE = 'gateway.json';
export const SETUP_CREDENTIALS_FILE = 'credentials.json';
export const SETUP_RECEIPT_FILE = 'setup-receipt.json';
export const SETUP_BODY_LIMIT = 64 * 1024;
export const UPSTREAM_KEY_ENV = 'KIMI_WORK_UPSTREAM_KEY';
export const GATEWAY_TOKEN_ENV = 'KIMI_WORK_GATEWAY_TOKEN';
export const DEFAULT_GATEWAY_PORT = 3426;
const MODEL_FIELDS = new Set(['id', 'name', 'protocol', 'contextWindow', 'contextLimit', 'metadataSource',
  'maxOutputTokens', 'tools', 'reasoning', 'inputModalities', 'reasoningEfforts', 'defaultEffort',
  'connectionId', 'upstreamModelId']);
const CREDENTIAL_FIELDS = new Set(['schemaVersion', 'upstreamApiKey', 'connectionApiKeys', 'gatewayToken',
  'createdAt', 'updatedAt']);
const CONNECTION_FIELDS = new Set(['id', 'name', 'providerPresetId', 'baseURL', 'apiKeyEnv', 'protocols', 'apiKey']);
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export class SetupError extends Error {
  constructor(code, status = 400, details = {}) {
    super(code);
    this.status = status;
    this.details = details;
  }
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function currentUid(platform = process.platform) {
  return platform === 'win32' ? null : typeof process.getuid === 'function' ? process.getuid() : null;
}

// Any file this tool rewrites must be a regular file owned by the current user.
// A symlink could redirect the credential write elsewhere, and a foreign owner
// means the file is not ours to change.
export function inspectOwnedFile(file, { platform = process.platform, uid = currentUid(platform) } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw new SetupError('setup_file_unreadable', 409);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new SetupError('setup_file_conflict', 409);
  if (platform !== 'win32' && uid !== null && stat.uid !== uid) throw new SetupError('setup_file_owner_conflict', 409);
  if (stat.size > 1024 * 1024) throw new SetupError('setup_file_conflict', 409);
  return { state: 'ok', stat };
}

function readJson(file, options) {
  const inspected = inspectOwnedFile(file, options);
  if (inspected.state === 'absent') return null;
  // Windows reports a mode of its own making (0666 for a file only the owner's
  // ACL protects), so the POSIX privacy check applies to the host platform
  // unless the caller named one explicitly.
  const platform = options?.platform ?? process.platform;
  if (options?.requirePrivate && platform !== 'win32' && (inspected.stat.mode & 0o077) !== 0) {
    throw new SetupError('setup_credentials_permissions', 409);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new SetupError('setup_file_conflict', 409); }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SetupError('setup_directory_conflict', 409);
}

// Secrets are written with an exclusive temporary file, mode 0600, then
// renamed into place. On POSIX the mode is re-asserted before the rename so a
// permissive umask cannot widen it.
export function writePrivateJson(file, value, { platform = process.platform } = {}) {
  ensureDirectory(path.dirname(file));
  const temporary = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function setupPaths({ stateDir, configPath } = {}) {
  const directory = path.resolve(stateDir ?? defaultStateDirectory());
  return {
    stateDir: directory,
    config: path.resolve(configPath ?? path.join(directory, SETUP_CONFIG_FILE)),
    credentials: path.join(directory, SETUP_CREDENTIALS_FILE),
    receipt: path.join(directory, SETUP_RECEIPT_FILE),
    // Written by the gateway once its control panel is up; `servicePaths` uses
    // the same name so setup and `service status` read one file.
    entry: path.join(directory, 'panel-entry.json'),
  };
}

// The credentials file is created only by this module, so its own schema is
// proof of ownership. Anything else at that path is a conflict, not an
// invitation to overwrite. Version 1 stored a single upstream key; it is still
// read so an existing installation keeps working without a re-run of setup.
export function readCredentials(file, options = {}) {
  const document = readJson(file, options);
  if (document === null) return null;
  if (typeof document !== 'object' || Array.isArray(document)
    || Object.keys(document).some(key => !CREDENTIAL_FIELDS.has(key))
    || ![1, 2].includes(document.schemaVersion)
    || document.upstreamApiKey !== undefined && (typeof document.upstreamApiKey !== 'string'
      || !KEY_PATTERN.test(document.upstreamApiKey))
    || typeof document.gatewayToken !== 'string' || !TOKEN_PATTERN.test(document.gatewayToken)) {
    throw new SetupError('setup_credentials_conflict', 409);
  }
  const connectionApiKeys = readConnectionApiKeys(document.connectionApiKeys);
  if (document.schemaVersion === 1 && (document.upstreamApiKey === undefined || document.connectionApiKeys !== undefined)) {
    throw new SetupError('setup_credentials_conflict', 409);
  }
  return { upstreamApiKey: document.upstreamApiKey, connectionApiKeys,
    gatewayToken: document.gatewayToken, createdAt: document.createdAt, updatedAt: document.updatedAt };
}

// Only `<connection id>: <key>` pairs are stored, and a malformed map is a
// conflict rather than a silently dropped credential.
function readConnectionApiKeys(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupError('setup_credentials_conflict', 409);
  const keys = {};
  for (const [id, key] of Object.entries(value)) {
    if (!CONNECTION_ID.test(id) || typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new SetupError('setup_credentials_conflict', 409);
    }
    keys[id] = key;
  }
  return keys;
}

export function newGatewayToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Keeps the existing token so the value Kimi already stores keeps working; a
// missing or empty file gets a fresh random one. Per-connection keys are
// merged, never replaced wholesale, so saving one connection cannot drop the
// credential of another.
export function writeCredentials(file, { upstreamApiKey, connectionApiKeys, existing } = {}, options = {}) {
  const keys = { ...(existing?.connectionApiKeys || {}) };
  for (const [id, key] of Object.entries(connectionApiKeys || {})) {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) throw new SetupError('invalid_api_key');
    keys[id] = key;
  }
  const value = { schemaVersion: SETUP_SCHEMA_VERSION,
    ...(upstreamApiKey === undefined ? existing?.upstreamApiKey === undefined ? {} : { upstreamApiKey: existing.upstreamApiKey }
      : { upstreamApiKey }),
    ...(Object.keys(keys).length ? { connectionApiKeys: keys } : {}),
    gatewayToken: existing?.gatewayToken ?? newGatewayToken(),
    createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() };
  writePrivateJson(file, value, options);
  return value;
}

// A connection key saved from the panel lands in the same private file as the
// other credentials. Removing a connection leaves its key alone: a stale key is
// harmless, and deleting one on a mistyped edit could not be undone.
export function writeConnectionKeys(file, { apiKeys } = {}, options = {}) {
  if (!file) throw new SetupError('setup_credentials_missing', 409);
  if (!apiKeys || typeof apiKeys !== 'object' || Array.isArray(apiKeys) || !Object.keys(apiKeys).length) {
    throw new SetupError('invalid_api_key');
  }
  const existing = readCredentials(file, { ...options, requirePrivate: true });
  if (!existing) throw new SetupError('setup_credentials_missing', 409);
  return writeCredentials(file, { connectionApiKeys: apiKeys, existing }, options);
}

export function normalizeSetupModels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new SetupError('invalid_models');
  const models = value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SetupError('invalid_models');
    for (const key of Object.keys(row)) if (!MODEL_FIELDS.has(key)) throw new SetupError('invalid_models');
    // A missing protocol is never filled in: a Chat-Completions-only service
    // must not be silently declared as Responses.
    if (!['chat', 'responses'].includes(row.protocol)) throw new SetupError('invalid_models');
    return {
      id: row.id, ...(row.name === undefined ? {} : { name: row.name }), protocol: row.protocol,
      contextWindow: row.contextWindow,
      ...(row.contextLimit === undefined ? {} : { contextLimit: row.contextLimit }),
      ...(row.metadataSource === undefined ? {} : { metadataSource: row.metadataSource }),
      ...(row.maxOutputTokens === undefined ? {} : { maxOutputTokens: row.maxOutputTokens }),
      ...(row.tools === undefined ? {} : { tools: row.tools }),
      ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
      ...(row.inputModalities === undefined ? {} : { inputModalities: row.inputModalities }),
      ...(row.reasoningEfforts === undefined ? {} : { reasoningEfforts: row.reasoningEfforts }),
      ...(row.defaultEffort === undefined ? {} : { defaultEffort: row.defaultEffort }),
      ...(row.connectionId === undefined ? {} : { connectionId: row.connectionId }),
      ...(row.upstreamModelId === undefined ? {} : { upstreamModelId: row.upstreamModelId }),
    };
  });
  try { return validatePanelModels(models); }
  catch (error) {
    const known = ['protocol_conflict', 'context_window_exceeds_limit'];
    throw new SetupError(known.includes(error.message) ? error.message : 'invalid_models');
  }
}

// Connections are optional: an empty list keeps the single-upstream page that
// shipped before connections existed. A key given here belongs to the private
// credential file, so it is split off before anything reaches the config.
function normalizeSetupConnections(value) {
  if (value === undefined) return { connections: undefined, apiKeys: {} };
  if (!Array.isArray(value) || value.length > 32) throw new SetupError('invalid_connections');
  const apiKeys = {};
  const connections = value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new SetupError('invalid_connections');
    for (const key of Object.keys(row)) if (!CONNECTION_FIELDS.has(key)) throw new SetupError('invalid_connections');
    if (row.apiKey !== undefined) {
      if (typeof row.apiKey !== 'string' || !KEY_PATTERN.test(row.apiKey.trim())) throw new SetupError('invalid_api_key');
      apiKeys[row.id] = row.apiKey.trim();
    }
    const { apiKey, ...connection } = row;
    return connection;
  });
  return { connections, apiKeys };
}

export function normalizeSetupInput(input, { port = DEFAULT_GATEWAY_PORT, dns = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SetupError('invalid_setup');
  // An omitted key means "keep the stored one"; a present but malformed key is
  // rejected instead of being silently ignored.
  const apiKey = input.apiKey === undefined ? '' : input.apiKey;
  if (typeof apiKey !== 'string' || apiKey && !KEY_PATTERN.test(apiKey.trim())) throw new SetupError('invalid_api_key');
  const models = normalizeSetupModels(input.models);
  const { connections, apiKeys } = normalizeSetupConnections(input.connections);
  // Without a legacy upstream block there is nothing to validate; with one,
  // the page must supply the address it was always required to send.
  let upstream;
  if (input.baseURL !== undefined || !connections?.length) {
    let baseURL;
    try { baseURL = validateBaseURL(input.baseURL); } catch { throw new SetupError('invalid_base_url'); }
    upstream = { baseURL, apiKeyEnv: UPSTREAM_KEY_ENV };
  }
  const gatewayPort = input.port === undefined ? port : Number(input.port);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1024 || gatewayPort > 65535) throw new SetupError('invalid_port');
  const dnsEnabled = input.dns === undefined ? dns : input.dns === true;
  const config = { ...(upstream ? { upstream } : {}), ...(connections ? { connections } : {}), tokenEnv: GATEWAY_TOKEN_ENV,
    port: gatewayPort, dns: { enabled: dnsEnabled, port: 53535 }, models };
  try { readConfig(config); } catch (error) {
    throw new SetupError(error.message === 'protocol_conflict' ? 'protocol_conflict' : 'invalid_config');
  }
  return { config, apiKey: apiKey.trim(), connectionApiKeys: apiKeys };
}

export function readSetupReceipt(file) {
  let document;
  try { document = readJson(file); } catch { return null; }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.schemaVersion !== SETUP_SCHEMA_VERSION || typeof document.config !== 'string'
    || typeof document.credentials !== 'string' || typeof document.token !== 'string'
    || !/^[a-f0-9]{32}$/.test(document.token)) return null;
  return document;
}

// Ownership is a stable token plus the paths this tool wrote, not a hash of the
// current content: the panel legitimately edits models, subagents and
// translation after setup, and a content digest would make the next setup run
// believe the file had become foreign.
function ownershipMatches(receipt, paths, resolvedConfig) {
  return Boolean(receipt && receipt.config === resolvedConfig
    && receipt.credentials === path.resolve(paths.credentials) && receipt.stateDir === path.resolve(paths.stateDir));
}

// Fields this tool owns. Everything else in an existing document (translation,
// subagents a user wrote by hand, future settings) is preserved verbatim, so a
// re-run of setup never rebuilds the file and drops configuration.
const OWNED_CONFIG_FIELDS = new Set(['upstream', 'connections', 'tokenEnv', 'port', 'dns', 'models']);

export function mergeSetupConfig(current, next) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return next;
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    // `subagents` and `translation` are the panel's to manage; keep them even
    // though setup does not produce them.
    if (!OWNED_CONFIG_FIELDS.has(key) && current[key] !== undefined) continue;
    merged[key] = value;
  }
  // A connections-only save replaces the legacy upstream, and a leftover block
  // would keep demanding a key no model uses. Only a save that did not send an
  // upstream of its own may drop the stored one.
  if (next && next.upstream === undefined && merged.upstream !== undefined
    && !merged.models?.some(model => model?.connectionId === undefined)) {
    delete merged.upstream;
  }
  return merged;
}

// A hand-written configuration is never replaced: an existing file is only
// accepted when the receipt proves this tool wrote that file before.
export function saveSetup({ paths, config, apiKey, connectionApiKeys, platform = process.platform,
  uid = currentUid(platform) } = {}) {
  if (!paths) throw new SetupError('invalid_setup');
  const criteria = { platform, uid };
  const receipt = readSetupReceipt(paths.receipt);
  const resolvedConfig = path.resolve(paths.config);
  let currentConfig = null;
  try { currentConfig = readJson(paths.config, criteria); } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('setup_config_conflict', 409);
  }
  const owned = ownershipMatches(receipt, paths, resolvedConfig);
  if (currentConfig !== null && !owned) throw new SetupError('setup_config_conflict', 409);
  let existing = null;
  try { existing = readCredentials(paths.credentials, { ...criteria, requirePrivate: true }); } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('setup_credentials_conflict', 409);
  }
  // Credentials without our receipt were written by something else (an older
  // tool, a copied directory, a hand edit). Reusing their token would silently
  // adopt a secret this tool never created.
  if (existing && !owned) throw new SetupError('setup_credentials_conflict', 409);
  // Preserve everything setup does not own, and keep the current models when
  // the page did not declare any change.
  let document = mergeSetupConfig(currentConfig, config);
  try { readConfig(document); } catch (error) {
    throw new SetupError(error.message === 'protocol_conflict' ? 'protocol_conflict' : 'invalid_config');
  }
  // A blank key keeps the stored one; there is nothing to keep the first time.
  // A legacy key is required only when a model still routes through `upstream`.
  const upstreamApiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : existing?.upstreamApiKey;
  const legacyModels = document.models?.some(model => model && typeof model === 'object' && model.connectionId === undefined);
  if (document.upstream && legacyModels && !upstreamApiKey) throw new SetupError('invalid_api_key');
  writePrivateJson(paths.config, document, criteria);
  const credentials = writeCredentials(paths.credentials,
    { ...(upstreamApiKey ? { upstreamApiKey } : {}), connectionApiKeys, existing }, criteria);
  writePrivateJson(paths.receipt, { schemaVersion: SETUP_SCHEMA_VERSION, config: resolvedConfig,
    credentials: path.resolve(paths.credentials), stateDir: path.resolve(paths.stateDir),
    token: receipt?.token ?? crypto.randomBytes(16).toString('hex'),
    createdAt: receipt?.createdAt ?? new Date().toISOString(),
    at: new Date().toISOString() }, criteria);
  return { credentials, config: document, receiptWritten: true };
}

// Public view for the page: never includes an upstream key, a connection key or
// the gateway token. Each connection reports only whether its key is present.
export function setupState({ paths, platform = process.platform, uid = currentUid(platform) }) {
  let config = null;
  let credentials = null;
  const criteria = { platform, uid };
  try { config = readConfig(readJson(paths.config, criteria)); } catch {}
  try { credentials = readCredentials(paths.credentials, criteria); } catch {}
  const receipt = readSetupReceipt(paths.receipt);
  const owned = ownershipMatches(receipt, paths, path.resolve(paths.config));
  return {
    schemaVersion: SETUP_SCHEMA_VERSION,
    platform,
    configured: Boolean(config && credentials),
    baseURL: config?.upstream?.baseURL ?? null,
    port: config?.port ?? null,
    dns: config ? { ...config.dns } : null,
    models: config?.models ?? [],
    connections: (config?.connections ?? []).map(connection => ({ id: connection.id, name: connection.name,
      ...(connection.providerPresetId ? { providerPresetId: connection.providerPresetId } : {}),
      baseURL: connection.baseURL, apiKeyEnv: connection.apiKeyEnv,
      ...(connection.protocols ? { protocols: [...connection.protocols] } : {}),
      apiKeySet: Boolean(credentials?.connectionApiKeys?.[connection.id]) })),
    apiKeySet: Boolean(credentials?.upstreamApiKey),
    tokenSet: Boolean(credentials?.gatewayToken),
    configuration: { state: config ? 'ready' : 'absent', file: paths.config },
    credentials: { state: credentials ? 'ready' : 'absent', file: paths.credentials },
    receipt: owned ? 'owned' : config || credentials ? 'foreign' : 'absent',
    stateDir: paths.stateDir,
  };
}

const UI = new URL('../ui/', import.meta.url);
const CSP = "default-src 'none'; script-src 'nonce-__NONCE__'; style-src 'nonce-__NONCE__'; "
  + "img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
  + "form-action 'none'; object-src 'none'";

function authorized(actual, key) {
  if (typeof actual !== 'string' || typeof key !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new SetupError('json_required', 415);
  if (Number(req.headers['content-length']) > SETUP_BODY_LIMIT) throw new SetupError('request_too_large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > SETUP_BODY_LIMIT) throw new SetupError('request_too_large', 413);
    chunks.push(Buffer.from(chunk));
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SetupError('invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupError('invalid_json');
  return value;
}

// Only these service fields ever leave the setup server. The installer also
// records paths and a launcher, but the page needs the outcome, not the
// layout, and a whitelist keeps an unexpected installer value out of the API.
const SERVICE_VIEW_FIELDS = ['state', 'reason', 'kind', 'platform', 'label', 'running', 'needsFreshEntry'];

export function serviceView(service) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) return null;
  const view = {};
  for (const key of SERVICE_VIEW_FIELDS) {
    const value = service[key];
    if (typeof value === 'string' || typeof value === 'boolean') view[key] = value;
  }
  return Object.keys(view).length ? view : null;
}
function entryView(entry) {
  return entry ? { url: entry.url, entryURL: entry.entryURL } : null;
}

function flushResponse(res) {
  if (res.writableFinished) return Promise.resolve();
  return new Promise(resolve => {
    res.once('finish', resolve);
    res.once('close', resolve);
  });
}

// Loopback only, random per-run session key, exact Host and Origin checks, and
// a bounded JSON body. The page is one self-contained file served with a
// per-response nonce, so it needs no external assets and no relaxed CSP.
export class SetupServer {
  constructor({ stateDir, configPath, platform = process.platform, uiDir = fileURLToPath(UI),
    onSaved, logger, installService, panelWaitMs = 20000, uid, now, sleep, pollMs = 250 } = {}) {
    this.paths = setupPaths({ stateDir, configPath });
    this.platform = platform;
    this.uid = uid ?? currentUid(platform);
    this.uiDir = uiDir;
    this.onSaved = onSaved;
    this.logger = logger;
    this.installService = installService;
    this.panelWaitMs = panelWaitMs;
    this.pollMs = pollMs;
    // A panel that is still starting is tracked in memory so the authenticated
    // page can ask for it later. Both clocks are injectable so a test never
    // sits in a real wait loop.
    this.now = typeof now === 'function' ? now : Date.now;
    this.sleep = typeof sleep === 'function' ? sleep
      : ms => new Promise(resolve => setTimeout(resolve, ms));
    // What the last save left behind, re-served to the page (and to the caller
    // waiting on the handoff) while the panel boots.
    this.lastSaved = null;
    this.lastPanel = null;
    this.pendingPanel = null;
    this.serviceState = null;
    this.key = crypto.randomBytes(32).toString('hex');
    this.failures = 0;
    this.pending = false;
    this.server = null;
  }

  async start({ port = 0 } = {}) {
    if (this.server) throw Error('setup_already_running');
    this.template = fs.readFileSync(path.join(this.uiDir, 'setup.html'), 'utf8');
    if (!this.template.includes('__SETUP_NONCE__')) throw Error('setup_page_invalid');
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 20000;
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch { server.close(); throw Error('setup_port_unavailable'); }
    this.server = server;
    this.hostHeader = '127.0.0.1:' + server.address().port;
    this.origin = 'http://' + this.hostHeader;
    this.url = this.origin;
    this.entryURL = this.origin + '/#key=' + this.key;
    return this.entryURL;
  }

  async handle(req, res) {
    const nonce = crypto.randomBytes(18).toString('base64');
    const base = {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP.replaceAll('__NONCE__', nonce),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
    };
    const json = (status, value) => {
      res.writeHead(status, { ...base, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.headers.host !== this.hostHeader) throw new SetupError('origin_refused', 403);
      if (req.headers.origin !== undefined && req.headers.origin !== this.origin) throw new SetupError('origin_refused', 403);
      const site = req.headers['sec-fetch-site'];
      if (site !== undefined && !['same-origin', 'none'].includes(site)) throw new SetupError('origin_refused', 403);
      if (req.url === '/' || req.url === '/index.html' || req.url === '/setup.html') {
        if (!['GET', 'HEAD'].includes(req.method)) throw new SetupError('method_not_allowed', 405);
        res.writeHead(200, { ...base, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : this.template.replaceAll('__SETUP_NONCE__', nonce));
        return;
      }
      if (req.url === '/favicon.ico') throw new SetupError('not_found', 404);
      if (!['/api/state', '/api/save', '/api/providers', '/api/model-search'].includes(req.url)) {
        throw new SetupError('not_found', 404);
      }
      if (this.failures >= 20) throw new SetupError('too_many_attempts', 429);
      if (!authorized(req.headers.authorization, this.key)) {
        this.failures++;
        throw new SetupError('unauthorized', 401);
      }
      // The catalog endpoints are static-only: they expose the shipped presets
      // and rank them locally. No network call is made, no saved connection is
      // read (there may be none), and no native surface is reachable before an
      // authenticated save has happened.
      if (req.method === 'GET' && req.url === '/api/providers') {
        json(200, { presets: providerPresets() });
        return;
      }
      if (req.method === 'GET' && req.url === '/api/state') {
        // A save that left the panel starting keeps its expectation in memory,
        // so this authenticated read can complete the handoff later. The
        // response is flushed before the caller is released, for the same
        // reason the save response is: a command that exits on completion
        // closes the listener.
        const completion = this.completePendingPanel();
        const payload = { ok: true, state: setupState({ paths: this.paths, platform: this.platform }),
          service: this.serviceState, panel: this.panelState() };
        json(200, payload);
        if (completion) {
          await flushResponse(res);
          this.onSaved?.(completion);
        }
        return;
      }
      if (req.method !== 'POST') throw new SetupError('method_not_allowed', 405);
      if (req.headers.origin !== this.origin) throw new SetupError('origin_refused', 403);
      // Static catalog search during the first run: the page names a preset and
      // gets that preset's own documented models, ranked locally. The address is
      // never fetched here, so this cannot become an open network proxy before
      // the user has authenticated a configuration.
      if (req.url === '/api/model-search') {
        const input = await readBody(req);
        if (typeof input.query !== 'string' || input.query.length > 200
          || input.presetId !== undefined && typeof input.presetId !== 'string') {
          throw new SetupError('invalid_model_search');
        }
        const preset = input.presetId === undefined ? null : presetById(input.presetId);
        if (input.presetId !== undefined && !preset) throw new SetupError('invalid_model_search');
        json(200, { query: input.query, models: preset ? searchCatalog({ preset, query: input.query }) : [] });
        return;
      }
      if (this.pending) throw new SetupError('setup_busy', 409);
      this.pending = true;
      try {
        const input = await readBody(req);
        const saved = await this.save(input);
        // The page is told first and the caller is released only after the
        // response is flushed: a command that exits on save closes the listener,
        // and closing it mid-response would reset the save the user just made.
        await new Promise(resolve => {
          res.once('finish', resolve);
          res.once('close', resolve);
          json(200, saved);
        });
        this.onSaved?.(saved);
      } finally { this.pending = false; }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const code = error instanceof SetupError && /^[a-z][a-z0-9_-]{0,100}$/.test(error.message) ? error.message : 'setup_failed';
      json(error instanceof SetupError ? error.status : 503, { error: { code } });
    }
  }

  // The files are written atomically, and one request at a time is enforced by
  // `pending`, so two page saves cannot interleave. Installing the service is
  // a separate, best-effort step: the setup is saved either way, and a failed
  // service is reported to the page instead of being reported as a failure.
  //
  // After a successful save the page is handed the real control panel: the
  // gateway publishes its link to a private entry file once its panel is up.
  // The link is only returned to this authenticated page, and it is read from
  // the 0600 file rather than printed into a log.
  async save(input) {
    const { config, apiKey, connectionApiKeys } = normalizeSetupInput(input);
    let previous = null;
    try { previous = readJson(this.paths.config); } catch {}
    // A restart replaces the panel process, and with it the session key in the
    // entry file. The entry that exists before the install therefore proves
    // nothing about the configuration just saved; only a different entryURL can.
    const previousEntry = readPanelEntry(this.paths.entry, { uid: this.uid });
    const { config: document } = saveSetup({ paths: this.paths, config, apiKey, connectionApiKeys, platform: this.platform });
    const state = setupState({ paths: this.paths, platform: this.platform });
    const changed = previous === null || digest(previous) !== digest(document);
    const result = { ok: true, changed, state, gateway: { baseURL: config.upstream?.baseURL ?? null, port: config.port },
      service: null, panel: null };
    if (input.installService === true) {
      if (typeof this.installService !== 'function') result.service = { state: 'unavailable', reason: 'service_unavailable' };
      else {
        try {
          result.service = await this.installService({ paths: this.paths, config: document, stateDir: this.paths.stateDir });
        } catch (error) {
          result.service = { state: 'failed', reason: /^[a-z][a-z0-9_-]{0,100}$/.test(error?.message)
            ? error.message : 'service_install_failed' };
        }
      }
    }
    result.service = serviceView(result.service);
    const serviceState = result.service?.state;
    // An install launches a new process, `started` restarted one, and `waiting`
    // means the restart is still in flight (busy or timed out). All three can
    // publish a different entry than the one that existed before this save.
    const requiresFreshEntry = ['installed', 'started', 'waiting'].includes(serviceState)
      || result.service?.needsFreshEntry === true;
    const applied = input.installService === true
      && ['installed', 'unchanged', 'started', 'waiting'].includes(serviceState);
    let panel;
    if (applied) {
      panel = await this.awaitPanel({ previousEntryURL: requiresFreshEntry ? previousEntry?.entryURL ?? null : null });
    } else if (input.installService === true) {
      // A failed or unsupported service applied nothing: an entry left over from
      // the previous configuration must not be offered as this one's panel.
      panel = { state: 'manual' };
    } else {
      panel = previousEntry ? { state: 'ready', ...entryView(previousEntry) } : { state: 'manual' };
    }
    result.panel = panel;
    this.lastSaved = { state: result.state, gateway: result.gateway };
    this.lastPanel = panel;
    this.serviceState = result.service;
    // A panel that is still starting stays in memory, so an authenticated
    // GET can finish the handoff once the gateway publishes its entry. Nothing
    // is remembered for a manual save: there is no process to wait for.
    this.pendingPanel = panel.state === 'waiting'
      ? { reason: panel.reason, previousEntryURL: requiresFreshEntry ? previousEntry?.entryURL ?? null : null }
      : null;
    this.logger?.('saved', { models: state.models.length, port: config.port,
      service: serviceState ?? 'manual', panel: panel.state });
    return result;
  }

  // A freshly installed or restarted service needs a moment to launch, bind the
  // gateway and write its entry. This only computes the state; the session link
  // itself is added per request so it never appears in a log line or a receipt.
  async awaitPanel({ previousEntryURL = null } = {}) {
    const deadline = this.now() + this.panelWaitMs;
    // Waiting only makes sense after the service step; a manual save has no
    // process that could create the entry, so it must not stall the page.
    for (;;) {
      const entry = readPanelEntry(this.paths.entry, { uid: this.uid });
      if (entry && entry.entryURL !== previousEntryURL) return { state: 'ready', ...entryView(entry) };
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return previousEntryURL === null
          ? { state: 'waiting', reason: 'panel_not_ready' }
          : { state: 'waiting', reason: 'panel_restarting' };
      }
      await this.sleep(Math.min(this.pollMs, Math.max(20, remaining)));
    }
  }

  // Public panel view. The entry is re-read on every call, so a waiting save
  // turns ready as soon as the gateway publishes its own link, and an entry
  // older than the save is never presented as the new configuration.
  panelState() {
    const pending = this.pendingPanel;
    if (!pending) return this.lastPanel ?? null;
    const entry = readPanelEntry(this.paths.entry, { uid: this.uid });
    if (entry && entry.entryURL !== pending.previousEntryURL) {
      return { state: 'ready', ...entryView(entry) };
    }
    return { state: 'waiting', reason: pending.reason };
  }

  // Completes a waiting save when the panel it expects appears. Called once
  // from the authenticated state read; returns the same result shape a save
  // returns so the caller can be released exactly as it would have been.
  completePendingPanel() {
    const pending = this.pendingPanel;
    if (!pending) return null;
    const panel = this.panelState();
    if (panel.state !== 'ready') return null;
    this.pendingPanel = null;
    this.lastPanel = panel;
    // A safe restart that timed out was reported as `waiting`; the new entry
    // proves it finished, so the caller learns the configuration applied.
    this.serviceState = this.serviceState?.state === 'waiting'
      ? { ...this.serviceState, state: 'started', needsFreshEntry: false } : this.serviceState;
    this.logger?.('panel', { service: this.serviceState?.state ?? 'manual' });
    return { ok: true, changed: false, ...(this.lastSaved ?? {}), service: this.serviceState, panel };
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

// Reads the credential values for a background run. They stay in memory only:
// a service definition carries neither an upstream key nor the token, and the
// environment it launches with is built from this function. A connection whose
// key is absent from the private file is left out rather than filled with an
// empty value, so startup reports exactly which variable is missing.
export function readCredentialEnvironment(configPath, credentialsPath, options = {}) {
  let config;
  try { config = readConfig(readJson(configPath, options)); }
  catch { throw new SetupError(configPath && fs.existsSync(configPath) ? 'invalid_config' : 'setup_config_missing', 409); }
  if (!config) throw new SetupError('setup_config_missing', 409);
  const credentials = readCredentials(credentialsPath, { ...options, requirePrivate: true });
  if (!credentials) throw new SetupError('setup_credentials_missing', 409);
  return { config, environment: credentialEnvironment(config, credentials) };
}

// The named variables a saved configuration plus its credential file provide.
// Values never leave this object; it is spread into the gateway process only.
// A missing or partially written credential file yields fewer names rather
// than throwing, so a caller can report exactly what is absent.
export function credentialEnvironment(config, credentials) {
  const environment = {};
  if (!credentials) return environment;
  if (config.upstream && credentials.upstreamApiKey) environment[config.upstream.apiKeyEnv] = credentials.upstreamApiKey;
  for (const connection of config.connections) {
    const key = credentials.connectionApiKeys?.[connection.id];
    if (key) environment[connection.apiKeyEnv] = key;
  }
  if (credentials.gatewayToken) environment[config.tokenEnv] = credentials.gatewayToken;
  return environment;
}

// The variables a configuration needs before it can serve. A model without a
// connection routes through the legacy upstream, so only that path requires
// the legacy key.
export function requiredCredentialNames(config) {
  const names = [];
  if (config.upstream && config.models.some(model => model?.connectionId === undefined)) names.push(config.upstream.apiKeyEnv);
  for (const connection of config.connections) {
    if (config.models.some(model => model?.connectionId === connection.id)) names.push(connection.apiKeyEnv);
  }
  names.push(config.tokenEnv);
  return [...new Set(names)];
}

// The panel entry file holds the panel URL with its session fragment. It is
// rewritten on every start and removed on exit, so `service status` can offer
// a link the user can actually open.
export function writePanelEntry(file, value, { platform = process.platform } = {}) {
  writePrivateJson(file, { schemaVersion: 1, ...value, at: new Date().toISOString() }, { platform });
}

export function removePanelEntry(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

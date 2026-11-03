import { readConfig } from './config.mjs';
import { validateModels } from './gateway.mjs';
import { validateBaseURL } from './openai-backend.mjs';
import { parseDiscoveredModels, providerPresets, searchModels } from './provider-catalog.mjs';

export const connectionFields = config => ({
  upstream: config.upstream ? { baseURL: validateBaseURL(config.upstream.baseURL), apiKeyEnv: config.upstream.apiKeyEnv } : null,
  connections: config.connections.map(connection => ({ id: connection.id, name: connection.name,
    ...(connection.providerPresetId ? { providerPresetId: connection.providerPresetId } : {}),
    baseURL: connection.baseURL, apiKeyEnv: connection.apiKeyEnv,
    ...(connection.protocols ? { protocols: [...connection.protocols] } : {}) })),
  tokenEnv: config.tokenEnv, port: config.port, dns: { ...config.dns },
});

export function validatePanelModels(value) {
  const models = validateModels(value);
  for (const model of models) {
    if (model.id !== model.id.trim() || model.reasoningEfforts?.some(effort => !/^[a-z][a-z0-9_-]{0,31}$/.test(effort))
      || model.reasoning !== true && (model.reasoningEfforts?.length || model.defaultEffort !== undefined)
      || model.inputModalities && !model.inputModalities.includes('text')) throw Error('invalid_models');
  }
  return models;
}

export function validateConnection(value, document) {
  if (!value || typeof value.upstream !== 'object' || !value.upstream || Array.isArray(value.upstream)
    || Object.keys(value.upstream).some(key => !['baseURL', 'apiKeyEnv'].includes(key))
    || typeof value.upstream.baseURL !== 'string' || typeof value.upstream.apiKeyEnv !== 'string'
    || typeof value.tokenEnv !== 'string' || !Number.isInteger(value.port)
    || !value.dns || typeof value.dns !== 'object' || Array.isArray(value.dns)
    || typeof value.dns.enabled !== 'boolean' || !Number.isInteger(value.dns.port)) throw Error('invalid_connection_config');
  const upstream = { baseURL: validateBaseURL(value.upstream.baseURL), apiKeyEnv: value.upstream.apiKeyEnv };
  const config = readConfig({ ...document, upstream, tokenEnv: value.tokenEnv, port: value.port,
    dns: { enabled: value.dns.enabled, port: value.dns.port } });
  return connectionFields(config);
}

// The row shape the panel exposes for a connection. `apiKeySet` describes the
// running process, never the file: a key written but not yet applied shows as
// unset until the gateway restarts with it.
export function connectionRow(connection, config, env = {}) {
  const modelCount = config.models.filter(model => (model.connectionId ?? null) === connection.id).length;
  return { id: connection.id, name: connection.name,
    ...(connection.providerPresetId ? { providerPresetId: connection.providerPresetId } : {}),
    baseURL: connection.baseURL, apiKeyEnv: connection.apiKeyEnv,
    ...(connection.protocols ? { protocols: [...connection.protocols] } : {}),
    legacy: false, modelCount, apiKeySet: Boolean(env[connection.apiKeyEnv]) };
}

// The legacy `upstream` block is reported as its own row so a UI can show one
// list without special-casing it. Its id is null because it has no name.
export function legacyRow(config, env = {}) {
  if (!config?.upstream) return null;
  return { id: null, name: 'legacy', baseURL: config.upstream.baseURL, apiKeyEnv: config.upstream.apiKeyEnv,
    legacy: true, modelCount: config.models.filter(model => model.connectionId === undefined).length,
    apiKeySet: Boolean(env[config.upstream.apiKeyEnv]) };
}

export function connectionRows(config, env = {}) {
  return [...(legacyRow(config, env) ? [legacyRow(config, env)] : []),
    ...config.connections.map(connection => connectionRow(connection, config, env))];
}

// A model naming its connection keeps the connection shape in one place, so
// only the rows are validated here; the model cross-check happens after the
// caller has confirmed that no surviving model still points at a removed
// connection (which would otherwise be reported as a confusing invalid_config).
export function validateConnections(input, document) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(input.connections) || input.connections.length > 32) throw Error('invalid_connections');
  const apiKeys = Object.create(null);
  const seen = new Set();
  const connections = input.connections.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw Error('invalid_connections');
    if (Object.keys(row).some(key => !['id', 'name', 'providerPresetId', 'baseURL', 'apiKeyEnv', 'protocols', 'apiKey'].includes(key))) {
      throw Error('invalid_connections');
    }
    if (typeof row.id !== 'string' || seen.has(row.id)) throw Error('invalid_connections');
    seen.add(row.id);
    if (row.apiKey !== undefined) {
      if (typeof row.apiKey !== 'string' || !row.apiKey.trim()) throw Error('invalid_api_key');
      apiKeys[row.id] = row.apiKey.trim();
    }
    // Drop only the credential; every other field is validated by readConfig,
    // which is the one place the connection shape is defined.
    const { apiKey, ...connection } = row;
    return connection;
  });
  readConfig({ ...document, connections, models: [] });
  return { connections, apiKeys };
}

const positive = value => Number.isSafeInteger(value) && value > 0;
const label = value => typeof value === 'string' && value.length <= 1024 && !/[\x00-\x1f]/.test(value) ? value : undefined;

// Upstream catalogs describe the same capability in several spellings
// (`context_length`, `context_window`, `max_output_tokens`). Only values that
// are unambiguous are kept; anything unrecognised is omitted rather than
// guessed, because a wrong capability silently breaks a conversation later.
export function discoveredModel(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = label(row.id);
  if (!id) return null;
  const model = { id };
  const name = label(row.name) ?? label(row.display_name);
  if (name) model.name = name;
  if (typeof row.owned_by === 'string' && row.owned_by) model.ownedBy = row.owned_by.slice(0, 128);
  if (positive(row.created)) model.created = row.created;
  const context = [row.contextWindow, row.context_window, row.context_length, row.max_context_length]
    .find(value => positive(value));
  if (context) model.contextWindow = context;
  const output = [row.maxOutputTokens, row.max_output_tokens, row.max_completion_tokens].find(value => positive(value));
  if (output) model.maxOutputTokens = output;
  const tools = [row.tools, row.supports_tool_call, row.tool_call].find(value => typeof value === 'boolean');
  if (tools !== undefined) model.tools = tools;
  const reasoning = [row.reasoning, row.supports_reasoning, row.reasoning_supported]
    .find(value => typeof value === 'boolean');
  if (reasoning !== undefined) model.reasoning = reasoning;
  const modalities = Array.isArray(row.inputModalities) ? row.inputModalities
    : Array.isArray(row.input_modalities) ? row.input_modalities
      : Array.isArray(row.modalities?.input) ? row.modalities.input : null;
  if (modalities) {
    const kept = modalities.filter(value => ['text', 'image'].includes(value));
    if (kept.length) model.inputModalities = [...new Set(kept)];
  }
  const efforts = [row.reasoningEfforts, row.reasoning_efforts, row.support_efforts]
    .find(value => Array.isArray(value));
  if (efforts) {
    const kept = efforts.filter(value => label(value) && /^[a-z][a-z0-9_-]{0,31}$/.test(value));
    if (kept.length) model.reasoningEfforts = [...new Set(kept)];
  }
  const protocols = [row.protocols, row.supported_protocols].find(value => Array.isArray(value));
  if (protocols) {
    const kept = ['chat', 'responses'].filter(protocol => protocols.includes(protocol));
    if (kept.length) model.protocols = kept;
  }
  return model;
}

const DISCOVERY_LIMIT = 1024 * 1024;
const DISCOVERY_TIMEOUT_MS = 8000;

// Reads the upstream's own catalog for one saved connection. The caller passes
// the connection definition and its key, so a connection that was just saved
// can be probed before the gateway restarts with it. This is a bounded GET: no
// inference, no redirect following, and a capped body so a hostile or broken
// endpoint cannot exhaust memory.
export async function discoverModels({ connection, apiKey, fetchImpl, timeoutMs = DISCOVERY_TIMEOUT_MS,
  presetId, signal } = {}) {
  if (!connection || typeof connection.baseURL !== 'string' || typeof apiKey !== 'string' || !apiKey) {
    throw Error('discovery_unavailable');
  }
  const baseURL = validateBaseURL(connection.baseURL);
  if (signal?.aborted) throw Error('discovery_timeout');
  const abort = AbortSignal.timeout(timeoutMs);
  const fetch = fetchImpl || globalThis.fetch;
  const checkedAt = new Date().toISOString();
  let response;
  try {
    response = await fetch(baseURL + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, abort]) : abort, redirect: 'error',
    });
  } catch (failure) {
    throw Error(signal?.aborted || failure?.name === 'TimeoutError' || failure?.name === 'AbortError'
      ? 'discovery_timeout' : 'discovery_unavailable');
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch {}
    throw Object.assign(Error('discovery_http_error'), { httpStatus: response.status });
  }
  if (Number(response.headers.get('content-length')) > DISCOVERY_LIMIT) {
    try { await response.body?.cancel(); } catch {}
    throw Error('discovery_too_large');
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > DISCOVERY_LIMIT) throw Error('discovery_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (failure) {
    throw Error(failure?.message === 'discovery_too_large' ? 'discovery_too_large' : 'discovery_unavailable');
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('discovery_invalid_catalog'); }
  // The envelope is still required: a body that is neither a list nor a
  // `{data}`/`{models}` list is a broken catalog, not an empty one. How each
  // entry is read is the shared catalog parser's job, so a candidate keeps the
  // upstream id verbatim and its protocol list — including "unknown", which is
  // an empty list rather than a silent chat/responses default.
  if (!Array.isArray(payload) && !Array.isArray(payload?.data) && !Array.isArray(payload?.models)) {
    throw Error('discovery_invalid_catalog');
  }
  const models = parseDiscoveredModels(payload, { presetId, url: baseURL + '/models', checkedAt });
  // One view of the parse, published as-is: the parser already decided what the
  // endpoint actually declared, so a candidate keeps its id, its aliases, the
  // per-model provenance and an empty protocol list — which means "unknown or
  // no overlap here" and must reach the caller instead of being hidden.
  return { connectionId: connection.id, state: 'passed', models,
    modelCount: models.length, httpStatus: response.status, source: 'discovery',
    sourceURL: baseURL + '/models', ...(presetId ? { presetId } : {}), checkedAt };
}

export async function checkUpstream(backend, { connectionId = null } = {}) {
  const endpoint = backend.connection(connectionId ?? null);
  const at = Date.now();
  let response;
  try {
    response = await backend.fetchImpl(endpoint.baseURL + '/models', {
      headers: { Authorization: 'Bearer ' + endpoint.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000), redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { state: 'failed', at, httpStatus: response.status, ms: Date.now() - at, reason: 'upstream_http_error' };
    }
    if (Number(response.headers.get('content-length')) > 1024 * 1024) throw Error('upstream_catalog_invalid');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Error('upstream_catalog_invalid');
      chunks.push(Buffer.from(chunk));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('upstream_catalog_invalid'); }
    if (!Array.isArray(payload?.data) || payload.data.some(row => !row || typeof row.id !== 'string')) {
      throw Error('upstream_catalog_invalid');
    }
    return { state: 'passed', at, httpStatus: response.status, modelCount: payload.data.length, ms: Date.now() - at };
  } catch (error) {
    try { await response?.body?.cancel(); } catch {}
    return { state: 'failed', at, ms: Date.now() - at,
      reason: error?.message === 'upstream_catalog_invalid' ? 'upstream_catalog_invalid' : 'upstream_connection_failed' };
  }
}

export const DISCOVERY_CAPABILITY_FIELDS = ['id', 'name', 'ownedBy', 'created', 'contextWindow',
  'maxOutputTokens', 'tools', 'reasoning', 'inputModalities', 'reasoningEfforts', 'protocols'];

// --- catalog context -------------------------------------------------------

// The panel's catalog is assembled, never stored: the static presets say what
// the vendor documents, and one connection's last successful discovery says
// what that endpoint actually reported. One upstream id is one candidate, so
// the two sources are merged per id rather than listed twice.
//
// `aliases` and `source` are carried through because they are what make a
// candidate useful: aliases drive the ranking, and the per-model provenance is
// what a caller saves alongside a budget so the number keeps its evidence.
const CATALOG_FIELDS = ['name', 'contextWindow', 'maxOutputTokens', 'tools', 'reasoning',
  'inputModalities', 'reasoningEfforts', 'protocols', 'description'];

// Which source supplied a field. The endpoint's own statement wins field by
// field: `false` is a refusal and stays `false`, and `protocols: []` means
// "unknown or no overlap with this endpoint", a fact never backfilled from the
// preset. A field the endpoint did not mention is not a statement, so the
// preset's value survives — and the provenance recorded for that field follows
// whichever side actually supplied it.
//
// Both sides are always passed explicitly (never chained through a previous
// merge result), because a merged row cannot tell you which of its fields came
// from where.
function sourcingOf(kind, preset, row, endpointURL) {
  // The row's own evidence page wins over the preset's root page on both sides.
  // For a discovery the endpoint is the truth (its URL is the one that answered);
  // for a preset row the parser's per-model `source` points at the page that
  // documents *that* model's limits, while the root page may be a plan or
  // membership guide. Only a model with no source of its own inherits the root.
  const own = kind === 'discovery'
    ? { ...(preset?.source || {}), ...(row?.source || {}), ...(endpointURL ? { url: endpointURL } : {}) }
    : { ...(preset?.source || {}), ...(row?.source || {}) };
  return { kind,
    ...(own?.url ? { url: own.url } : {}), ...(own?.checkedAt ? { checkedAt: own.checkedAt } : {}) };
}

function mergeCandidate(presetModel, presetSource, discoveredModel, endpointURL) {
  const merged = { id: discoveredModel?.id ?? presetModel?.id };
  const sources = {};
  const from = {};
  const discoverySource = () => sourcingOf('discovery', presetSource, discoveredModel, endpointURL);
  const presetProvenance = () => sourcingOf('preset', presetSource, presetModel);
  for (const field of CATALOG_FIELDS) {
    if (discoveredModel?.[field] !== undefined) {
      merged[field] = discoveredModel[field];
      from[field] = 'discovery';
      sources.discovery ??= discoverySource();
    } else if (presetModel?.[field] !== undefined) {
      merged[field] = presetModel[field];
      from[field] = 'preset';
      sources.preset ??= presetProvenance();
    }
  }
  // Aliases are not chosen per side: the endpoint's own aliases add to the
  // preset's, because a nickname a catalog accepts is useful either way.
  const aliases = [...new Set([...(presetModel?.aliases || []), ...(discoveredModel?.aliases || [])])];
  if (aliases.length) {
    merged.aliases = aliases;
    if (presetModel?.aliases?.length) sources.preset ??= presetProvenance();
    if (discoveredModel?.aliases?.length) sources.discovery ??= discoverySource();
  }
  for (const field of ['inputModalities', 'reasoningEfforts']) {
    if (Array.isArray(merged[field])) merged[field] = [...merged[field]];
  }
  if (Object.keys(sources).length) merged.sources = sources;
  // `metadataSource` is the provenance of `contextWindow` specifically, because
  // that is the field a saved budget is derived from. A discovery that reported
  // other capabilities but no context size must not make a preset context limit
  // look discovered.
  if (from.contextWindow) merged.metadataSource = { ...sources[from.contextWindow] };
  // The per-model `source` row the parser produced, kept as-is.
  const own = discoveredModel?.source ?? presetModel?.source;
  if (own && typeof own === 'object') merged.source = { ...own };
  return merged;
}

// Every candidate the caller could pick for this request, keyed by upstream id.
// A discovery row always merges against the preset row for the same id — never
// against a previously merged row, which could not say which fields it owned.
export function catalogCandidates({ preset, discovery } = {}) {
  const presetById = new Map();
  for (const model of preset?.models || []) {
    if (!model || typeof model.id !== 'string' || !model.id) continue;
    presetById.set(model.id, model);
  }
  const byId = new Map();
  for (const model of preset?.models || []) {
    if (!model || typeof model.id !== 'string' || !model.id) continue;
    byId.set(model.id, mergeCandidate(model, preset, null, null));
  }
  for (const model of discovery?.models || []) {
    if (!model || typeof model.id !== 'string' || !model.id) continue;
    byId.set(model.id, mergeCandidate(presetById.get(model.id) ?? null, preset, model, discovery.sourceURL ?? null));
  }
  return [...byId.values()];
}

const BROWSE_DEFAULT = 20;
const BROWSE_LIMIT = 50;

function browseLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) return BROWSE_DEFAULT;
  return Math.min(value, BROWSE_LIMIT);
}

// One entry point for both ways a caller uses the catalog. A nonempty query is
// a ranked search. An empty one is browsing — the first-run page sends the
// blank input as `query: ''`, and answering that with an empty list would mean a
// vendor's documented models could never be listed without guessing an id. The
// browse result is a bounded slice of the same merged candidates, so it keeps
// ids, aliases, `sources` and an explicit `protocols: []`; `limit` follows the
// ranked rules, where an explicit `0` still means nothing.
//
// A caller with neither a preset nor a discovery has nothing to search or
// browse; presets are never merged into one bag, because a candidate belongs to
// the endpoint that offers it.
export function searchCatalog({ preset, discovery, query, limit } = {}) {
  const models = catalogCandidates({ preset, discovery });
  const text = typeof query === 'string' ? query.trim() : '';
  if (!text) return models.slice(0, browseLimit(limit));
  return searchModels(models, text, { limit });
}

export function presetById(id) {
  if (typeof id !== 'string') return null;
  return providerPresets().find(preset => preset.id === id) ?? null;
}

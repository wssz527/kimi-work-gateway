import { readConfig } from './config.mjs';
import { validateModels } from './gateway.mjs';
import { validateBaseURL } from './openai-backend.mjs';

export const connectionFields = config => ({
  upstream: { baseURL: validateBaseURL(config.upstream.baseURL), apiKeyEnv: config.upstream.apiKeyEnv },
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

export async function checkUpstream(backend) {
  const at = Date.now();
  let response;
  try {
    response = await backend.fetchImpl(backend.baseURL + '/models', {
      headers: { Authorization: 'Bearer ' + backend.apiKey, Accept: 'application/json' },
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

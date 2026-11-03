// Independent management of Kimi's own global MCP servers.
//
// Everything here goes through the installed official kernel: the module never
// writes `mcp.json` itself, never starts an MCP server to answer a read, never
// evaluates caller-supplied code, and never touches `config.toml`. The kernel
// client is created against the Work runtime home
// (`<kimiDir>/runtime/kimi-code/home`, beside `config.toml`), so the desktop
// and this package share one server list while each keeps its own defaults and
// built-in tools.
//
// Secrets only ever flow towards the kernel. `env` values, header values and
// credential-bearing URL parts are accepted on input and then dropped from
// every value this module returns: state lists carry names, not values, and a
// test result is redacted against the stored secrets before it is truncated.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveCandidates } from './kimi-contract.mjs';

const KERNEL_RELATIVE = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
const CLIENT_METHODS = ['listGlobalMcpServers', 'addGlobalMcpServer', 'updateGlobalMcpServer',
  'removeGlobalMcpServer', 'testGlobalMcpServer'];

const MAX_SERVERS = 500;
const MAX_NAME = 64;
const MAX_COMMAND = 1024;
const MAX_ARG = 1024;
const MAX_ARGS = 64;
const MAX_ENV = 64;
const MAX_ENV_NAME = 128;
const MAX_ENV_VALUE = 8192;
const MAX_URL = 2048;
const MAX_TOOLS = 256;
const MAX_TOOL_NAME = 128;
const MAX_TOOL_LINES = 100;
const MAX_OUTPUT = 1200;
const MAX_OUTPUT_LINES = 40;
const MAX_MESSAGE = 400;
const MAX_TIMEOUT_MS = 2147483647;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SERVER_KEYS = new Set(['name', 'transport', 'enabled', 'deferred', 'enabledTools', 'disabledTools',
  'startupTimeoutMs', 'toolTimeoutMs']);
const STDIO_KEYS = new Set([...SERVER_KEYS, 'command', 'args', 'env', 'cwd', 'executor', 'environment_id']);
const URL_KEYS = new Set([...SERVER_KEYS, 'url', 'headers', 'auth', 'bearerTokenEnvVar']);
const ALL_KEYS = new Set([...STDIO_KEYS, ...URL_KEYS]);
const SECRET_WORD = 'key|token|secret|passwd|pwd|auth|credential|bearer';

const GENERIC_SECRETS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/g, 'Bearer [redacted]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{10,}/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/((?:api[_-]?key|token|secret|passwd|authorization)["']?\s*[=:]\s*)("?[^\s"',}]{6,}"?)/gi, '$1[redacted]'],
  [/\{\{[A-Za-z0-9_]{6,}\}\}/g, '[redacted]'],
];

const problem = reason => Object.assign(new Error(reason), { reason });

const finite = (state, reason, extra = {}) => ({ ok: false, state, reason, ...extra });

const INVALID = field => finite('invalid', 'native_mcp_invalid_input', field ? { field } : {});

const NATIVE_CODES = new Map([
  ['mcp.server_not_found', ['not_found', 'native_mcp_server_not_found']],
  ['request.invalid', ['invalid', 'native_mcp_invalid_input']],
  ['config.invalid', ['invalid', 'native_mcp_invalid_input']],
]);

function plainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clean(value) {
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(value, max) {
  const text = clean(value);
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// Exact replacement runs for every known secret, however short: a two-character
// value is still a credential, and a length filter would let exactly those short
// values through into a redacted row or a test message.
function redactSecrets(value, secrets) {
  let text = typeof value === 'string' ? value : String(value);
  for (const [pattern, replacement] of GENERIC_SECRETS) text = text.replace(pattern, replacement);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret && text.includes(secret)) text = text.split(secret).join('[redacted]');
  }
  return text;
}

function sanitizeText(value, secrets, max = MAX_OUTPUT) {
  return clip(redactSecrets(value, secrets), max);
}


// The userinfo and query of a URL are the two places a credential can hide, so
// the visible form is rebuilt from origin and path only.
function redactUrl(value) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return clip(parsed.origin + parsed.pathname, MAX_URL);
  } catch {
    return clip(raw.split(/[?#]/)[0].replace(/\/\/[^/@]*@/, '//'), MAX_URL);
  }
}

// Every value that can carry a credential, collected for an exact scrub of
// server output. Args are included because a server may echo its own argv.
function secretValues(entry) {
  const secrets = new Set();
  for (const source of [entry.env, entry.headers]) {
    if (!plainObject(source)) continue;
    for (const value of Object.values(source)) if (typeof value === 'string') secrets.add(value);
  }
  if (Array.isArray(entry.args)) {
    for (const argument of entry.args) if (typeof argument === 'string') secrets.add(argument);
  }
  if (typeof entry.url === 'string') {
    try {
      const parsed = new URL(entry.url);
      splitUserinfo(parsed).forEach(secret => secrets.add(secret));
      for (const value of parsed.searchParams.values()) if (value) secrets.add(value);
    } catch {}
  }
  return [...secrets].filter(Boolean);
}

function splitUserinfo(parsed) {
  const href = parsed.href;
  const start = href.indexOf('//');
  if (start < 0) return [];
  const authorityStart = start + 2;
  const pathAt = href.indexOf('/', authorityStart);
  const authorityEnd = pathAt < 0 ? href.length : pathAt;
  const at = href.lastIndexOf('@', authorityEnd);
  if (at < authorityStart) return [];
  const userinfo = href.slice(authorityStart, at);
  const colon = userinfo.indexOf(':');
  const values = colon < 0 ? [userinfo] : [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
  return values.filter(Boolean).map(value => {
    try { return decodeURIComponent(value); } catch { return value; }
  });
}

export function redactMcpServer(entry) {
  if (!plainObject(entry)) return { name: '', transport: 'unknown' };
  const secrets = secretValues(entry);
  const name = typeof entry.name === 'string' ? clip(entry.name, MAX_NAME) : '';
  const transport = ['stdio', 'http', 'sse'].includes(entry.transport) ? entry.transport : 'unknown';
  const state = { name, transport, enabled: entry.enabled !== false };
  if (entry.deferred === true) state.deferred = true;
  if (transport === 'stdio') {
    if (typeof entry.command === 'string') state.command = clip(redactSecrets(entry.command, secrets), MAX_COMMAND);
    // Args are omitted, not masked: any position of any argument can be a
    // secret, so a partially redacted list is not safe to hand back. The count
    // is enough for a UI that keeps omitted args unchanged on edit.
    if (Array.isArray(entry.args)) state.argsCount = Math.min(entry.args.length, MAX_ARGS);
    if (plainObject(entry.env)) state.envNames = Object.keys(entry.env).slice(0, MAX_ENV).map(name => clip(name, MAX_ENV_NAME));
    if (typeof entry.cwd === 'string') state.cwd = clip(redactSecrets(entry.cwd, secrets), MAX_COMMAND);
    if (entry.executor === 'local' || entry.executor === 'kaos') state.executor = entry.executor;
    if (typeof entry.environment_id === 'string') state.environmentId = clip(entry.environment_id, MAX_ENV_NAME);
  } else if (transport === 'http' || transport === 'sse') {
    state.url = redactUrl(entry.url);
    if (plainObject(entry.headers)) {
      state.headerNames = Object.keys(entry.headers).slice(0, MAX_ENV).map(name => clip(name, MAX_ENV_NAME));
    }
    if (entry.auth === 'oauth') state.auth = 'oauth';
    if (typeof entry.bearerTokenEnvVar === 'string') state.bearerTokenEnvVar = clip(entry.bearerTokenEnvVar, MAX_ENV_NAME);
  }
  for (const key of ['enabledTools', 'disabledTools']) {
    const list = entry[key];
    if (Array.isArray(list) && list.length) {
      state[key] = list.slice(0, MAX_TOOLS).map(name => clip(name, MAX_TOOL_NAME));
    }
  }
  for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) {
    if (Number.isInteger(entry[key]) && entry[key] > 0) state[key] = entry[key];
  }
  return state;
}

// --- input validation ------------------------------------------------------

function validName(value) {
  return typeof value === 'string' && value === value.trim()
    && value.length > 0 && value.length <= MAX_NAME && NAME_PATTERN.test(value);
}

function stringField(value, max) {
  return typeof value === 'string' && value.length <= max && !value.includes('\u0000');
}

function nonEmptyString(value, max) {
  return stringField(value, max) && value.trim().length > 0;
}

function timeoutField(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS;
}

function toolListField(value) {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return false;
  return value.every(name => nonEmptyString(name, MAX_TOOL_NAME) && clean(name) === name);
}

function stringRecord(value, namePattern, nameMax) {
  if (!plainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV) return null;
  const record = {};
  for (const [key, item] of entries) {
    if (BLOCKED_KEYS.has(key)) return null;
    if (!namePattern.test(key) || key.length > nameMax) return null;
    if (!stringField(item, MAX_ENV_VALUE)) return null;
    record[key] = item;
  }
  return record;
}

function httpUrl(value) {
  if (!nonEmptyString(value, MAX_URL)) return false;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    // Credentials in a URL survive every log line that prints it; headers and
    // `bearerTokenEnvVar` are the supported places for them.
    if (splitUserinfo(parsed).length > 0) return false;
    return true;
  } catch { return false; }
}

// Validates one server description. `partial` checks only the fields that are
// present, which is all an update patch needs: everything omitted is preserved
// from the stored entry instead of being resent.
function validateServer(input, { partial = false } = {}) {
  if (!plainObject(input)) return INVALID();
  for (const key of Object.keys(input)) {
    if (BLOCKED_KEYS.has(key)) return INVALID(key);
  }
  // `null` is an explicit delete in an update patch, not a value to validate.
  const source = { ...input };
  if (partial) {
    for (const key of Object.keys(source)) if (source[key] === null && key !== 'name') delete source[key];
  }
  const transport = source.transport;
  if (!partial || transport !== undefined) {
    if (!['stdio', 'http', 'sse'].includes(transport)) return INVALID('transport');
  }
  const keys = transport === 'stdio' ? STDIO_KEYS : transport === 'http' || transport === 'sse' ? URL_KEYS : ALL_KEYS;
  for (const key of Object.keys(source)) {
    if (!keys.has(key)) return INVALID(key);
    if (source[key] === undefined) return INVALID(key);
  }
  if (!partial || source.name !== undefined) {
    if (!validName(source.name)) return INVALID('name');
  }
  const value = { ...source };
  if ((transport === 'stdio' || !partial) && value.command !== undefined) {
    if (!nonEmptyString(value.command, MAX_COMMAND)) return INVALID('command');
  }
  if (transport === 'stdio' && !partial && value.command === undefined) return INVALID('command');
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) return INVALID('args');
    if (!value.args.every(argument => stringField(argument, MAX_ARG))) return INVALID('args');
    value.args = [...value.args];
  }
  if (value.env !== undefined) {
    const env = stringRecord(value.env, ENV_NAME_PATTERN, MAX_ENV_NAME);
    if (!env) return INVALID('env');
    value.env = env;
  }
  if (value.cwd !== undefined && !nonEmptyString(value.cwd, MAX_COMMAND)) return INVALID('cwd');
  if (value.executor !== undefined && value.executor !== 'local' && value.executor !== 'kaos') return INVALID('executor');
  if (value.environment_id !== undefined && !nonEmptyString(value.environment_id, MAX_ENV_NAME)) return INVALID('environment_id');
  if ((transport === 'http' || transport === 'sse' || !partial) && value.url !== undefined) {
    if (!httpUrl(value.url)) return INVALID('url');
  }
  if ((transport === 'http' || transport === 'sse') && !partial && value.url === undefined) return INVALID('url');
  if (value.headers !== undefined) {
    const headers = stringRecord(value.headers, HEADER_NAME_PATTERN, MAX_ENV_NAME);
    if (!headers) return INVALID('headers');
    value.headers = headers;
  }
  if (value.auth !== undefined && value.auth !== 'oauth') return INVALID('auth');
  if (value.bearerTokenEnvVar !== undefined && !nonEmptyString(value.bearerTokenEnvVar, MAX_ENV_NAME)) {
    return INVALID('bearerTokenEnvVar');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return INVALID('enabled');
  if (value.deferred !== undefined && typeof value.deferred !== 'boolean') return INVALID('deferred');
  for (const key of ['enabledTools', 'disabledTools']) {
    if (value[key] !== undefined) {
      if (!toolListField(value[key])) return INVALID(key);
      value[key] = [...value[key]];
    }
  }
  for (const key of ['startupTimeoutMs', 'toolTimeoutMs']) {
    if (value[key] !== undefined && !timeoutField(value[key])) return INVALID(key);
  }
  // Deletions are carried separately so the merge can drop the stored field.
  const removed = partial
    ? Object.keys(input).filter(key => input[key] === null && key !== 'name')
    : [];
  return { ok: true, value, transport, removed };
}

// A stored entry is only re-validated where the patch left it incomplete; the
// kernel validates the merged object again before it is written.
function familyKeys(transport) {
  return transport === 'stdio' ? STDIO_KEYS : transport === 'http' || transport === 'sse' ? URL_KEYS : ALL_KEYS;
}

function structurallyComplete(value) {
  if (!plainObject(value)) return false;
  if (!validName(value.name)) return false;
  if (value.transport === 'stdio') return nonEmptyString(value.command, MAX_COMMAND);
  if (value.transport === 'http' || value.transport === 'sse') return httpUrl(value.url);
  return false;
}

function storedEntry(value) {
  if (!plainObject(value) || typeof value.name !== 'string') return null;
  return { ...value, name: value.name.trim() };
}

// --- client plumbing -------------------------------------------------------

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function findInstalledKernel({ platform = process.platform, env = process.env } = {}) {
  for (const archive of archiveCandidates({ platform, env })) {
    if (!archive) continue;
    const resources = path.dirname(archive);
    for (const bundle of [path.join(resources, 'resources', 'daimon-bundle'), path.join(resources, 'daimon-bundle')]) {
      const file = path.join(bundle, KERNEL_RELATIVE);
      if (isFile(file)) return file;
    }
  }
  return null;
}

// The timer is deliberately referenced: an unref'd timer lets the process exit
// mid-wait when nothing else keeps the loop alive, so a stalled kernel call
// would silently never produce its `timeout` state. It is always cleared.
function withTimeout(work, ms, reason) {
  const guarded = Promise.resolve(work);
  guarded.catch(() => {});
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(problem(reason)), ms);
  });
  return Promise.race([guarded, expired]).finally(() => clearTimeout(timer));
}

export class NativeMcpManager {
  constructor({ kimiDir, stateDir, kernelPath, loadKernel, identity, platform = process.platform,
    env = process.env, connectTimeoutMs = 15000, operationTimeoutMs = 15000, testTimeoutMs = 30000,
    closeTimeoutMs = 5000 } = {}) {
    if (!nonEmptyString(kimiDir, 4096) || !path.isAbsolute(kimiDir)) throw Error('native_mcp_invalid_input');
    if (stateDir !== undefined && (!nonEmptyString(stateDir, 4096) || !path.isAbsolute(stateDir))) {
      throw Error('native_mcp_invalid_input');
    }
    if (kernelPath !== undefined && (!nonEmptyString(kernelPath, 4096) || !path.isAbsolute(kernelPath))) {
      throw Error('native_mcp_invalid_input');
    }
    if (loadKernel !== undefined && typeof loadKernel !== 'function') throw Error('native_mcp_invalid_input');
    this.kimiDir = path.resolve(kimiDir);
    this.stateDir = stateDir === undefined ? null : path.resolve(stateDir);
    this.kernelPath = kernelPath === undefined ? null : path.resolve(kernelPath);
    this.loadKernel = loadKernel ?? (file => import(pathToFileURL(file).href));
    this.platform = platform;
    this.env = env;
    this.identity = { productName: 'Kimi Work Gateway', version: '0.9.0', platform, ...identity };
    this.connectTimeoutMs = connectTimeoutMs;
    this.operationTimeoutMs = operationTimeoutMs;
    this.testTimeoutMs = Math.min(testTimeoutMs, 120000);
    this.closeTimeoutMs = closeTimeoutMs;
    this.nativeHome = path.join(this.kimiDir, 'runtime', 'kimi-code', 'home');
    // The kernel reads `<home>/config.toml`, and so does the rest of this
    // package: NativeSubagentConfig derives its configPath the same way, so the
    // two modules must never disagree about which file the desktop owns.
    this.nativeConfig = path.join(this.nativeHome, 'config.toml');
    this.clientPromise = null;
    this.pendingTest = null;
    this.closed = false;
    this.tail = Promise.resolve();
  }

  // --- public contract -----------------------------------------------------

  async state() {
    return this.#run(async client => {
      const servers = await this.#list(client);
      return { available: true, servers: servers.slice(0, MAX_SERVERS).map(redactMcpServer) };
    }, listed => !listed.ok
      ? { available: false, reason: listed.reason, servers: [] }
      : listed);
  }

  async add(server) {
    const checked = validateServer(server);
    if (!checked.ok) return checked;
    return this.#run(async client => {
      const existing = await this.#list(client);
      if (existing.some(entry => entry.name === checked.value.name)) {
        return finite('exists', 'native_mcp_server_exists', { name: checked.value.name });
      }
      await withTimeout(client.addGlobalMcpServer({ ...checked.value }), this.operationTimeoutMs, 'native_mcp_timeout');
      const after = await this.#list(client);
      return { ok: true, state: 'added', server: project(after, checked.value.name) };
    });
  }

  async update(name, patch) {
    if (!validName(name)) return INVALID('name');
    if (!plainObject(patch)) return INVALID('patch');
    if (Object.keys(patch).length === 0) return { ok: true, state: 'unchanged', name };
    if (Object.hasOwn(patch, 'name') && patch.name !== name) return INVALID('name');
    const described = { ...patch, name };
    if (patch.transport !== undefined) described.transport = patch.transport;
    const checked = validateServer(described, { partial: true });
    if (!checked.ok) return checked;
    return this.#run(async client => {
      const existing = await this.#list(client);
      const current = existing.find(entry => entry.name === name);
      if (!current) return finite('not_found', 'native_mcp_server_not_found', { name });
      const merged = mergePatch(current, checked.value, checked.transport, checked.removed);
      // Without an explicit transport switch, a patch may only name fields of
      // the server's own family; otherwise a valid http field could be written
      // into a stdio entry (or the reverse) and rejected later by the kernel.
      if (checked.transport === undefined) {
        const family = familyKeys(current.transport);
        for (const key of [...Object.keys(checked.value), ...checked.removed]) {
          if (!family.has(key)) return INVALID(key);
        }
      }
      if (!structurallyComplete(merged)) {
        return INVALID(merged.transport === 'stdio' ? 'command' : 'url');
      }
      await withTimeout(client.updateGlobalMcpServer(merged), this.operationTimeoutMs, 'native_mcp_timeout');
      const after = await this.#list(client);
      return { ok: true, state: 'updated', server: project(after, name) };
    });
  }

  async remove(name) {
    if (!validName(name)) return INVALID('name');
    return this.#run(async client => {
      const existing = await this.#list(client);
      if (!existing.some(entry => entry.name === name)) {
        return { ok: true, state: 'absent', name };
      }
      await withTimeout(client.removeGlobalMcpServer(name), this.operationTimeoutMs, 'native_mcp_timeout');
      const after = await this.#list(client);
      return after.some(entry => entry.name === name)
        ? finite('unavailable', 'native_mcp_operation_failed', { name })
        : { ok: true, state: 'removed', name };
    });
  }

  // The one operation that can start an external process, and only when the
  // caller asks for it by name.
  //
  // A timeout here abandons the wait, not the kernel: `withProbe` still owns the
  // connection manager and only shuts it down when its own startup timeout
  // fires, so the answer arrives later than we were willing to wait. That is
  // why the outstanding probe is tracked: a second `test` while one is unsettled
  // would run two probes of the same server at once, so it is refused instead of
  // silently overlapping. Nothing is retried automatically.
  async test(name, options = {}) {
    if (!validName(name)) return INVALID('name');
    const cwd = options?.cwd;
    if (cwd !== undefined && (!nonEmptyString(cwd, MAX_COMMAND) || !path.isAbsolute(cwd))) return INVALID('cwd');
    if (this.pendingTest) return finite('busy', 'native_mcp_test_in_progress', { name });
    const requested = options?.timeoutMs;
    const timeoutMs = timeoutField(requested) ? Math.min(requested, 120000) : this.testTimeoutMs;
    return this.#run(async client => {
      const existing = await this.#list(client);
      const entry = existing.find(item => item.name === name);
      if (!entry) return finite('not_found', 'native_mcp_server_not_found', { name });
      const secrets = secretValues(entry);
      // The guard tracks the kernel call itself, not our wait for it: a timeout
      // abandons the wait while `withProbe` keeps its connection manager open
      // until its own startup timeout fires. Clearing on our timeout instead
      // would let a second test start a second probe of the same server.
      const call = Promise.resolve().then(() => client.testGlobalMcpServer(name, cwd === undefined ? {} : { cwd }));
      const tracked = call.then(() => undefined, () => undefined)
        .finally(() => { if (this.pendingTest === tracked) this.pendingTest = null; });
      this.pendingTest = tracked;
      let result;
      try {
        result = await withTimeout(call, timeoutMs, 'native_mcp_test_timeout');
      } catch (error) {
        if (error?.reason === 'native_mcp_test_timeout') {
          return finite('timeout', 'native_mcp_test_timeout', { name });
        }
        throw error;
      }
      const output = typeof result?.output === 'string' ? result.output : '';
      const redacted = boundedOutput(output, secrets);
      const tools = toolNames(output, secrets);
      const summary = summarize(output, tools);
      if (result?.success === true) {
        return { ok: true, state: 'connected', name, tools, summary, detail: redacted };
      }
      return { ok: false, state: 'failed', reason: 'native_mcp_test_failed', name,
        tools, summary, detail: redacted };
    });
  }

  async close() {
    this.closed = true;
    await this.tail.catch(() => {});
    const pending = this.clientPromise;
    this.clientPromise = null;
    if (!pending) return { closed: true };
    try {
      const client = await withTimeout(pending, this.closeTimeoutMs, 'native_mcp_timeout');
      if (typeof client?.close === 'function') {
        await withTimeout(client.close(), this.closeTimeoutMs, 'native_mcp_timeout');
      }
    } catch {}
    return { closed: true };
  }

  // --- internals -----------------------------------------------------------

  async #run(action, project = value => value) {
    if (this.closed) return project(finite('closed', 'native_mcp_manager_closed'));
    const task = this.tail.then(async () => {
      if (this.closed) return project(finite('closed', 'native_mcp_manager_closed'));
      let client;
      try {
        client = await this.#client();
      } catch (error) {
        return project(this.#failure(error));
      }
      try {
        return await action(client);
      } catch (error) {
        return project(this.#failure(error));
      }
    });
    this.tail = task.then(() => undefined, () => undefined);
    return task;
  }

  async #client() {
    if (this.clientPromise) {
      return withTimeout(this.clientPromise, this.connectTimeoutMs, 'native_mcp_timeout');
    }
    let stats;
    try { stats = fs.statSync(this.kimiDir); } catch { stats = null; }
    if (!stats?.isDirectory()) throw problem('native_mcp_kimi_dir_unavailable');
    const kernelPath = this.kernelPath ?? findInstalledKernel({ platform: this.platform, env: this.env });
    if (!kernelPath || !isFile(kernelPath)) throw problem('native_mcp_kernel_unavailable');
    const pending = (async () => {
      const kernel = await this.loadKernel(kernelPath);
      if (typeof kernel?.createKernelClient !== 'function') throw problem('native_mcp_kernel_incompatible');
      const client = kernel.createKernelClient({
        homeDir: this.nativeHome,
        configPath: this.nativeConfig,
        identity: { ...this.identity },
      });
      try {
        for (const method of CLIENT_METHODS) {
          if (typeof client?.[method] !== 'function') throw problem('native_mcp_kernel_incompatible');
        }
      } catch (error) {
        try { await client?.close?.(); } catch {}
        throw error;
      }
      return client;
    })();
    this.clientPromise = pending;
    try {
      return await withTimeout(pending, this.connectTimeoutMs, 'native_mcp_timeout');
    } catch (error) {
      if (this.clientPromise === pending) this.clientPromise = null;
      pending.then(client => { try { client?.close?.(); } catch {} }, () => {});
      throw error;
    }
  }

  async #list(client) {
    const list = await withTimeout(client.listGlobalMcpServers(), this.operationTimeoutMs, 'native_mcp_timeout');
    if (!Array.isArray(list)) throw problem('native_mcp_kernel_incompatible');
    const entries = [];
    for (const entry of list.slice(0, MAX_SERVERS)) {
      const stored = storedEntry(entry);
      if (stored) entries.push(stored);
    }
    return entries;
  }

  // A native error message is not part of this module's data: the kernel may put
  // a rejected env value or header into it verbatim, and there is no reliable list
  // of "secrets" to scrub it against here. The code is the whole payload;
  // anything else would be an unverifiable promise that the text is safe.
  #failure(error) {
    const reason = error?.reason;
    if (reason === 'native_mcp_timeout') return finite('unavailable', 'native_mcp_timeout');
    if (reason === 'native_mcp_kernel_unavailable' || reason === 'native_mcp_kimi_dir_unavailable'
      || reason === 'native_mcp_kernel_incompatible') {
      return finite('unavailable', reason);
    }
    const native = NATIVE_CODES.get(error?.code);
    if (native) return finite(native[0], native[1], { code: String(error.code) });
    return finite('unavailable', 'native_mcp_operation_failed');
  }
}

function project(entries, name) {
  const entry = entries.find(item => item.name === name);
  return entry ? redactMcpServer(entry) : null;
}

function mergePatch(current, patch, transport, removed = []) {
  const merged = { ...current, name: current.name, transport: transport ?? current.transport };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'name' || value === null) continue;
    merged[key] = value;
  }
  for (const key of removed) delete merged[key];
  // Switching transport leaves the other family's fields behind; they would
  // either be rejected by the kernel or silently survive as dead config.
  if (merged.transport !== current.transport) {
    const dropped = merged.transport === 'stdio'
      ? ['url', 'headers', 'auth', 'bearerTokenEnvVar']
      : ['command', 'args', 'env', 'cwd', 'executor', 'environment_id'];
    for (const key of dropped) delete merged[key];
  }
  return merged;
}

// The kernel's test output is text it composed from whatever the server sent
// back. Known secrets are removed exactly and common token shapes generically,
// but an unknown secret cannot be detected, so the raw text is never presented
// as safe: callers get a bounded copy plus the structured summary above it.
function boundedOutput(output, secrets) {
  const text = redactSecrets(String(output), secrets);
  return clip(text.split(/\r?\n/).slice(0, MAX_OUTPUT_LINES).join('\n'), MAX_OUTPUT);
}

// Tools are read from the original text by position, then redacted: reading
// Tool lines are read from the original text by position, then redacted: they
// are not read from the clipped copy, where a cut line loses its `- ` prefix.
function toolNames(output, secrets) {
  const tools = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.startsWith('- ')) continue;
    const name = clip(redactSecrets(line.slice(2).split(':')[0], secrets), MAX_TOOL_NAME);
    if (!name || name.includes('[redacted]') || name.length > MAX_TOOL_NAME) continue;
    tools.push(name);
    if (tools.length >= MAX_TOOL_LINES) break;
  }
  return tools.slice(0, MAX_TOOLS);
}

function summarize(output, tools) {
  const lines = String(output).split(/\r?\n/);
  const declared = lines.map(line => /^Available tools:\s*(\d+)/.exec(line)).find(Boolean);
  return { toolCount: tools.length, ...(declared ? { declaredToolCount: Number(declared[1]) } : {}) };
}

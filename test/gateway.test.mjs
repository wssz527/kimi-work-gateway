import { test, expect } from 'bun:test';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { KimiWorkGateway, nativeCatalog, validateModels } from '../src/gateway.mjs';
import { OpenAIBackend } from '../src/openai-backend.mjs';

const KEY = 'gateway-secret';
const MODELS = [
  { id: 'kimi-plain-model', protocol: 'chat', contextWindow: 8192, maxOutputTokens: 1024, tools: true },
  { id: 'vendor/model', protocol: 'responses', contextWindow: 16384, reasoning: true },
];

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    const failed = error => reject(error);
    server.once('error', failed);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', failed);
      resolve();
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  const closed = new Promise(resolve => server.close(resolve));
  server.closeAllConnections?.();
  await closed;
}

function request(url, { key = KEY, method, body, headers = {} } = {}) {
  const outputHeaders = { ...headers };
  if (key !== null) outputHeaders.Authorization = 'Bearer ' + key;
  let outputBody = body;
  if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
    outputBody = JSON.stringify(body);
    outputHeaders['Content-Type'] = 'application/json';
  }
  return fetch(url, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: outputHeaders,
    body: outputBody,
  });
}

async function fixture({ models = MODELS, upstream, instructionsFile } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then(async body => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (upstream) return await upstream(req, res, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch(() => res.destroy());
  });
  await listen(server);
  const backend = new OpenAIBackend({
    baseURL: 'http://127.0.0.1:' + server.address().port + '/upstream/v1',
    apiKey: 'upstream-secret',
    models,
  });
  const gateway = new KimiWorkGateway({
    backend,
    instructionsFile,
    timeoutMs: 5000,
    catalogTimeoutMs: 2000,
  });
  try {
    const url = await gateway.configure({ key: KEY, port: 0 });
    return {
      url,
      gateway,
      backend,
      requests,
      close: async () => {
        await gateway.stop();
        await close(server);
      },
    };
  } catch (error) {
    await gateway.stop();
    await close(server);
    throw error;
  }
}

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('condition_timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('nativeCatalog groups models, includes limits and efforts, and drops empty groups', () => {
  const models = validateModels([
    { id: 'kimi-plain', protocol: 'chat', contextWindow: 4096, tools: true },
    {
      id: 'vendor/reasoner', protocol: 'responses', contextWindow: 32768, maxOutputTokens: 2048,
      reasoning: true, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultEffort: 'high',
    },
  ]);
  const catalog = nativeCatalog(models);
  expect(catalog.kimi).toEqual({
    type: 'kimi',
    models: {
      'kimi-plain': {
        name: 'kimi-plain',
        limit: { context: 4096 },
        tool_call: true,
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  });
  expect(catalog.responses).toEqual({
    type: 'openai_responses',
    models: {
      'vendor/reasoner': {
        name: 'vendor/reasoner',
        limit: { context: 32768, output: 2048 },
        tool_call: false,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        support_efforts: ['low', 'high'],
        default_effort: 'high',
      },
    },
  });
  expect('responses' in nativeCatalog([models[0]])).toBe(false);
  expect('kimi' in nativeCatalog([models[1]])).toBe(false);
  expect(nativeCatalog([])).toEqual({});
});

test('catalog endpoints use explicit protocols and expose the OpenAI list shape', async () => {
  const models = [
    { id: 'kimi-chat-no-slash', protocol: 'chat', contextWindow: 1000, tools: true },
    { id: 'vendor/kimi-chat', protocol: 'chat', contextWindow: 2000, inputModalities: ['image', 'text'] },
    { id: 'responses-no-slash', protocol: 'responses', contextWindow: 3000, reasoning: true },
    { id: 'vendor/model', protocol: 'responses', contextWindow: 4000, maxOutputTokens: 500 },
  ];
  const app = await fixture({ models });
  try {
    const nativeResponse = await request(app.url + '/models/api.json', { headers: { 'Sec-Fetch-Site': 'none' } });
    expect(nativeResponse.status).toBe(200);
    const catalog = await nativeResponse.json();
    expect(catalog.kimi.type).toBe('kimi');
    expect(Object.keys(catalog.kimi.models)).toEqual(['kimi-chat-no-slash', 'vendor/kimi-chat']);
    expect(catalog.responses.type).toBe('openai_responses');
    expect(Object.keys(catalog.responses.models)).toEqual(['responses-no-slash', 'vendor/model']);
    expect(catalog.kimi.models['kimi-chat-no-slash'].limit).toEqual({ context: 1000 });
    expect(catalog.responses.models['vendor/model'].limit).toEqual({ context: 4000, output: 500 });
    expect(app.gateway.lastCatalogRequest).toMatchObject({
      authorized: true,
      hasOrigin: false,
      fetchSite: 'none',
      status: 200,
    });

    const listResponse = await request(app.url + '/models');
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      object: 'list',
      data: [
        { id: 'kimi-chat-no-slash', object: 'model', context_length: 1000, supports_tool_call: true, supports_reasoning: false, supports_image_in: false },
        { id: 'vendor/kimi-chat', object: 'model', context_length: 2000, supports_tool_call: false, supports_reasoning: false, supports_image_in: true },
        { id: 'responses-no-slash', object: 'model', context_length: 3000, supports_tool_call: false, supports_reasoning: true, supports_image_in: false },
        { id: 'vendor/model', object: 'model', context_length: 4000, supports_tool_call: false, supports_reasoning: false, supports_image_in: false },
      ],
    });
    expect(app.gateway.lastCatalogRequest).toMatchObject({
      authorized: true,
      hasOrigin: false,
      fetchSite: 'absent',
      status: 200,
    });
    const metadata = app.gateway.lastCatalogRequest;
    const inference = await request(app.url + '/chat/completions', { body: { model: 'kimi-chat-no-slash', messages: [] } });
    expect(inference.status).toBe(200);
    await inference.text();
    expect(app.gateway.lastCatalogRequest).toBe(metadata);
    expect(app.requests).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('catalog re-reads the backend and stores normalized models', async () => {
  const app = await fixture();
  try {
    const initial = await app.gateway.catalog();
    expect(initial).toBe(app.gateway.models);
    expect(initial.map(row => row.id)).toEqual(['kimi-plain-model', 'vendor/model']);
    app.backend.models = validateModels([{ id: 'kimi-replacement', protocol: 'chat', contextWindow: 512 }]);
    const refreshed = await app.gateway.catalog();
    expect(refreshed).toEqual([{ id: 'kimi-replacement', protocol: 'chat', contextWindow: 512 }]);
    expect(refreshed).toBe(app.gateway.models);
    expect(refreshed).not.toBe(app.backend.models);
    const controller = new AbortController();
    controller.abort();
    await expect(app.gateway.catalog(controller.signal)).rejects.toThrow('catalog_unavailable');
    expect(app.gateway.models).toBe(refreshed);
  } finally {
    await app.close();
  }
});

test('chat and responses routes preserve complete payloads byte-for-byte', async () => {
  const app = await fixture();
  const chatPayload = {
    model: 'kimi-plain-model',
    messages: [
      { role: 'system', content: 'Keep every field.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in Paris?' }] },
      {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temperature":20}' },
      { role: 'user', content: 'Summarize it.' },
    ],
    tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
    reasoning_effort: 'high',
    temperature: 0.25,
  };
  const responsesPayload = {
    model: 'vendor/model',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Continue exactly.' }] },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"id":7}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"value":"ok"}' },
    ],
    tools: [{ type: 'function', name: 'lookup' }],
    reasoning: { effort: 'medium', summary: 'detailed' },
    include: ['reasoning.encrypted_content'],
    previous_response_id: 'resp_previous',
  };
  try {
    const chatResponse = await request(app.url + '/chat/completions', { body: chatPayload });
    expect(chatResponse.status).toBe(200);
    await chatResponse.text();
    const responsesResponse = await request(app.url + '/responses', { body: responsesPayload });
    expect(responsesResponse.status).toBe(200);
    await responsesResponse.text();
    expect(app.requests.map(row => row.url)).toEqual([
      '/upstream/v1/chat/completions',
      '/upstream/v1/responses',
    ]);
    expect(app.requests.map(row => row.method)).toEqual(['POST', 'POST']);
    expect(app.requests[0].body).toBe(JSON.stringify(chatPayload));
    expect(app.requests[1].body).toBe(JSON.stringify(responsesPayload));
    expect(JSON.parse(app.requests[0].body).model).toBe('kimi-plain-model');
    expect(JSON.parse(app.requests[1].body).model).toBe('vendor/model');
  } finally {
    await app.close();
  }
});

test('alias prefixes are removed for lookup and upstream delivery', async () => {
  const app = await fixture();
  const chat = { model: 'byok-kth-kimi/kimi-plain-model', messages: [{ role: 'user', content: 'chat' }] };
  const responses = { model: 'byok-kth-resp/vendor/model', input: 'respond' };
  try {
    const chatResponse = await request(app.url + '/chat/completions', { body: chat });
    expect(chatResponse.status).toBe(200);
    await chatResponse.text();
    const responsesResponse = await request(app.url + '/responses', { body: responses });
    expect(responsesResponse.status).toBe(200);
    await responsesResponse.text();
    expect(app.requests.map(row => JSON.parse(row.body).model)).toEqual(['kimi-plain-model', 'vendor/model']);
    expect(app.requests[0].body).toBe(JSON.stringify({ ...chat, model: 'kimi-plain-model' }));
    expect(app.requests[1].body).toBe(JSON.stringify({ ...responses, model: 'vendor/model' }));
  } finally {
    await app.close();
  }
});

test('streaming responses forward each upstream chunk to the client', async () => {
  const gate = deferred();
  const chunks = ['data: first\n\n', 'data: second\n\n', 'data: [DONE]\n\n'];
  const app = await fixture({
    upstream: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunks[0]);
      await gate.promise;
      res.write(chunks[1]);
      res.end(chunks[2]);
    },
  });
  try {
    const response = await request(app.url + '/chat/completions', {
      body: { model: 'kimi-plain-model', messages: [], stream: true },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value, { stream: true })).toBe(chunks[0]);
    gate.resolve();
    let rest = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    rest += decoder.decode();
    expect(rest).toBe(chunks[1] + chunks[2]);
    expect(app.requests).toHaveLength(1);
  } finally {
    gate.resolve();
    await app.close();
  }
});

test('client disconnect closes the upstream stream and clears inflight state', async () => {
  let upstreamClosed = false;
  const app = await fixture({
    upstream: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('close', () => {
        if (!res.writableEnded) upstreamClosed = true;
      });
      res.write('data: waiting\n\n');
    },
  });
  try {
    const endpoint = new URL(app.url + '/chat/completions');
    const client = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    }, response => {
      response.once('data', () => response.destroy());
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ model: 'kimi-plain-model', messages: [], stream: true }));
    await until(() => upstreamClosed);
    expect(upstreamClosed).toBe(true);
    await until(() => app.gateway.inflight.size === 0);
    expect(app.gateway.inflight.size).toBe(0);
    expect(app.requests).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('upstream errors preserve status, body, headers, and request count', async () => {
  const bodies = {
    429: '{"error":"rate limited"}',
    401: '{"error":"bad upstream key"}',
    502: '{"error":"bad gateway"}',
  };
  const app = await fixture({
    upstream: (req, res, body) => {
      const status = JSON.parse(body).status;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Retry-After': String(status === 429 ? 17 : 23),
        'X-Request-Id': 'request-' + status,
      });
      res.end(bodies[status]);
    },
  });
  try {
    for (const status of [429, 401, 502]) {
      const response = await request(app.url + '/chat/completions', {
        body: { model: 'kimi-plain-model', messages: [], status },
      });
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe(String(status === 429 ? 17 : 23));
      expect(response.headers.get('x-request-id')).toBe('request-' + status);
      expect(await response.text()).toBe(bodies[status]);
    }
    expect(app.requests.map(row => JSON.parse(row.body).status)).toEqual([429, 401, 502]);
    expect(app.requests).toHaveLength(3);
  } finally {
    await app.close();
  }
});

test('a model revoked from the current backend list is rejected', async () => {
  const app = await fixture();
  try {
    expect((await app.gateway.catalog()).map(row => row.id)).toContain('kimi-plain-model');
    app.backend.models = [];
    const response = await request(app.url + '/chat/completions', {
      body: { model: 'kimi-plain-model', messages: [] },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('model_not_enabled_for_kimi');
    expect(app.requests).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('authentication, browser protections, and exact routes reject invalid requests', async () => {
  const app = await fixture();
  try {
    for (const key of ['wrong-key', null]) {
      const response = await request(app.url + '/models', { key });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('unauthorized');
    }
    const origin = await request(app.url + '/models', { headers: { Origin: 'https://example.com' } });
    expect(origin.status).toBe(403);
    expect((await origin.json()).error.code).toBe('browser_request_refused');
    for (const fetchSite of ['same-origin', 'same-site', 'cross-site', 'other']) {
      const response = await request(app.url + '/models', { headers: { 'Sec-Fetch-Site': fetchSite } });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe('browser_request_refused');
    }
    const allowed = await request(app.url + '/chat/completions', {
      headers: { 'Sec-Fetch-Site': 'none' },
      body: { model: 'kimi-plain-model', messages: [] },
    });
    expect(allowed.status).toBe(200);
    await allowed.text();
    for (const [method, suffix] of [['GET', '/chat/completions'], ['POST', '/models'], ['GET', '/not-a-route']]) {
      const response = await request(app.url + suffix, { method });
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('not_found');
    }
    expect(app.requests).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('malformed JSON and bodies over 32 MiB are rejected before forwarding', async () => {
  const app = await fixture();
  try {
    const malformed = await request(app.url + '/chat/completions', { body: '{' });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe('invalid_json');
    const tooLargeBody = '{"model":"plain-chat","padding":"' + 'x'.repeat(32 * 1024 * 1024) + '"}';
    const tooLarge = await request(app.url + '/chat/completions', { body: tooLargeBody });
    expect(tooLarge.status).toBe(413);
    expect((await tooLarge.json()).error.code).toBe('request_too_large');
    expect(app.requests).toHaveLength(0);
  } finally {
    await app.close();
  }
});

test('instructionsFile inserts one managed system message idempotently', async () => {
  // Under the system temp dir, not the repository: a run that is interrupted
  // must not leave a tracked-looking directory behind in `test/`.
  const directory = await mkdtemp(path.join(tmpdir(), 'kwg-instructions-'));
  const file = path.join(directory, 'AGENTS.md');
  await writeFile(file, 'Use the shared rules.', 'utf8');
  const app = await fixture({ instructionsFile: file });
  const payload = {
    model: 'kimi-plain-model',
    messages: [
      { role: 'system', content: 'First system.' },
      { role: 'developer', content: 'Developer instruction.' },
      { role: 'user', content: 'Question.' },
      { role: 'system', content: 'Later system remains in place.' },
    ],
  };
  const managed = {
    role: 'system',
    content: '<shared-instructions>\nUse the shared rules.\n</shared-instructions>',
  };
  try {
    const firstResponse = await request(app.url + '/chat/completions', { body: payload });
    expect(firstResponse.status).toBe(200);
    await firstResponse.text();
    const firstMessages = JSON.parse(app.requests[0].body).messages;
    expect(firstMessages).toEqual([
      payload.messages[0],
      payload.messages[1],
      managed,
      ...payload.messages.slice(2),
    ]);
    expect(firstMessages).toHaveLength(payload.messages.length + 1);

    const repeatedResponse = await request(app.url + '/chat/completions', {
      body: { ...payload, messages: firstMessages },
    });
    expect(repeatedResponse.status).toBe(200);
    await repeatedResponse.text();
    const repeatedMessages = JSON.parse(app.requests[1].body).messages;
    expect(repeatedMessages).toEqual(firstMessages);
    expect(repeatedMessages.filter(message => message.content === managed.content)).toHaveLength(1);
    expect(app.requests).toHaveLength(2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a model cannot be sent to an endpoint for another protocol', async () => {
  const app = await fixture();
  try {
    for (const [endpoint, model] of [['/responses', 'byok-kth-kimi/kimi-plain-model'], ['/chat/completions', 'vendor/model']]) {
      const response = await request(app.url + endpoint, { body: { model, input: 'hello', messages: [] } });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('model_protocol_mismatch');
    }
    expect(app.requests).toHaveLength(0);
  } finally { await app.close(); }
});

import { test, expect } from 'bun:test';
import http from 'node:http';
import { validateModels } from '../src/gateway.mjs';
import { OpenAIBackend, validateBaseURL } from '../src/openai-backend.mjs';

function model(fields = {}) {
  return { id: 'kimi-model-id', protocol: 'chat', contextWindow: 4096, ...fields };
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

async function fixture(upstream) {
  const requests = [];
  const server = http.createServer((req, res) => {
    void readBody(req).then(async body => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (upstream) return await upstream(req, res, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    }).catch(() => res.destroy());
  });
  await listen(server);
  return {
    baseURL: 'http://127.0.0.1:' + server.address().port + '/root/v1',
    requests,
    close: () => close(server),
  };
}

test('validateModels accepts empty and slashless IDs and returns normalized copies', () => {
  const rows = [
    {
      id: 'kimi-plain', protocol: 'chat', contextWindow: 4096, name: 'Plain model', maxOutputTokens: 512,
      tools: true, reasoning: false, inputModalities: ['text', 'image', 'text'],
      reasoningEfforts: ['low', 'high', 'low'], defaultEffort: 'high', ignored: 'value',
    },
    { id: 'vendor/model', protocol: 'responses', contextWindow: 8192 },
    { id: 'kimi-empty-options', protocol: 'chat', contextWindow: 1024, inputModalities: [], reasoningEfforts: [] },
  ];
  const snapshot = structuredClone(rows);
  const result = validateModels(rows);
  expect(rows).toEqual(snapshot);
  expect(result).toEqual([
    {
      id: 'kimi-plain', protocol: 'chat', contextWindow: 4096, name: 'Plain model', maxOutputTokens: 512,
      tools: true, reasoning: false, inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high'], defaultEffort: 'high',
    },
    { id: 'vendor/model', protocol: 'responses', contextWindow: 8192 },
    { id: 'kimi-empty-options', protocol: 'chat', contextWindow: 1024, inputModalities: [], reasoningEfforts: [] },
  ]);
  expect(result).not.toBe(rows);
  expect(result[0]).not.toBe(rows[0]);
  expect(result[0].inputModalities).not.toBe(rows[0].inputModalities);
  expect(result[0].reasoningEfforts).not.toBe(rows[0].reasoningEfforts);
  expect(validateModels([])).toEqual([]);
  expect(() => validateModels([model({ reasoningEfforts: ['low'], defaultEffort: 'missing' })])).toThrow('invalid_models');
  expect(() => validateModels([model({ defaultEffort: 'high' })])).toThrow('invalid_models');
});

test('validateModels rejects invalid containers, rows, IDs, protocols, and context windows', () => {
  const invalid = [
    undefined,
    null,
    {},
    'models',
    [null],
    ['model'],
    [[]],
    [1],
    [{ protocol: 'chat', contextWindow: 4096 }],
    [model({ id: '' })],
    [model({ id: 42 })],
    [model({ id: 'bad\nid' })],
    [model({ id: 'bad\u0000id' })],
    [model({ id: 'x'.repeat(2049) })],
    [model(), model()],
    [{ id: 'vendor/model', contextWindow: 4096 }],
    [model({ protocol: 'openai' })],
    [model({ protocol: 'CHAT' })],
    [model({ protocol: null })],
    [model({ contextWindow: 0 })],
    [model({ contextWindow: -1 })],
    [model({ contextWindow: 1.5 })],
    [model({ contextWindow: '4096' })],
    [model({ contextWindow: Number.MAX_SAFE_INTEGER + 1 })],
    [model({ contextWindow: Number.POSITIVE_INFINITY })],
  ];
  for (const value of invalid) expect(() => validateModels(value)).toThrow('invalid_models');
});

test('a model whose declared protocol contradicts its Kimi-routed name is rejected', () => {
  const conflicts = [
    { id: 'kimi-k3.1-pro', protocol: 'responses', contextWindow: 4096 },
    { id: 'vendor/glm-5-3-flash', protocol: 'chat', contextWindow: 4096 },
    { id: 'vendor/Kimi-Mixed', protocol: 'responses', contextWindow: 4096 },
    { id: 'glm-chat', protocol: 'chat', contextWindow: 4096 },
    { id: 'vendor/has/kimi-nested', protocol: 'responses', contextWindow: 4096 },
  ];
  for (const row of conflicts) expect(() => validateModels([row])).toThrow('protocol_conflict');
  expect(validateModels([{ id: 'vendor/has/kimi-nested', protocol: 'chat', contextWindow: 4096 }]))
    .toEqual([{ id: 'vendor/has/kimi-nested', protocol: 'chat', contextWindow: 4096 }]);
  expect(validateModels([{ id: 'KIMI-upper', protocol: 'chat', contextWindow: 4096 }]))
    .toEqual([{ id: 'KIMI-upper', protocol: 'chat', contextWindow: 4096 }]);
  expect(validateModels([{ id: 'kimiko-1', protocol: 'responses', contextWindow: 4096 }]))
    .toEqual([{ id: 'kimiko-1', protocol: 'responses', contextWindow: 4096 }]);
});

test('validateModels rejects every invalid optional field type and value', () => {
  const invalid = [
    { maxOutputTokens: 0 },
    { maxOutputTokens: -10 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: '512' },
    { maxOutputTokens: null },
    { tools: 'true' },
    { tools: 1 },
    { tools: null },
    { reasoning: 'false' },
    { reasoning: 0 },
    { reasoning: null },
    { inputModalities: 'text' },
    { inputModalities: ['audio'] },
    { inputModalities: ['text', null] },
    { reasoningEfforts: 'low' },
    { reasoningEfforts: [1] },
    { reasoningEfforts: [''] },
    { reasoningEfforts: ['bad\neffort'] },
    { reasoningEfforts: ['x'.repeat(65)] },
    { defaultEffort: 1 },
    { defaultEffort: null },
    { defaultEffort: 'x'.repeat(65) },
  ];
  for (const fields of invalid) expect(() => validateModels([model(fields)])).toThrow('invalid_models');
});

test('validateBaseURL accepts HTTPS paths and loopback HTTP URLs', () => {
  const accepted = [
    ['https://example.com', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['https://example.com/v1', 'https://example.com/v1'],
    ['https://example.com/v1/', 'https://example.com/v1'],
    ['https://example.com:8443/deep/path', 'https://example.com:8443/deep/path'],
    ['http://127.0.0.1:8080/v1/', 'http://127.0.0.1:8080/v1'],
    ['http://[::1]:8080/v1/', 'http://[::1]:8080/v1'],
    ['http://localhost:3000', 'http://localhost:3000'],
  ];
  for (const [value, expected] of accepted) expect(validateBaseURL(value)).toBe(expected);
});

test('validateBaseURL rejects remote HTTP, credentials, query, fragments, and other schemes', () => {
  const rejected = [
    '',
    'not a URL',
    null,
    undefined,
    'ftp://example.com/v1',
    'file:///tmp/models',
    'http://example.com/v1',
    'http://192.168.1.10/v1',
    'http://127.0.0.1.example.com/v1',
    'https://user@example.com/v1',
    'https://user:password@example.com/v1',
    'http://user@localhost/v1',
    'https://example.com/v1?key=value',
    'http://localhost/v1?key=value',
    'https://example.com/v1#fragment',
    'http://localhost/v1#fragment',
  ];
  for (const value of rejected) expect(() => validateBaseURL(value)).toThrow('invalid_base_url');
});

test('OpenAIBackend listModels returns the validated model list', async () => {
  const backend = new OpenAIBackend({
    baseURL: 'https://example.com/v1/',
    apiKey: 'secret',
    models: [model({ inputModalities: ['image', 'image', 'text'] })],
  });
  const models = await backend.listModels();
  expect(backend.baseURL).toBe('https://example.com/v1');
  expect(models).toBe(backend.models);
  expect(models).toEqual([model({ inputModalities: ['image', 'text'] })]);
});

test('OpenAIBackend request preserves base paths, methods, headers, and bodies', async () => {
  const app = await fixture();
  const backend = new OpenAIBackend({ baseURL: app.baseURL, apiKey: 'backend-secret', models: [model()] });
  const chat = { model: 'model-id', messages: [{ role: 'user', content: 'hello' }], temperature: 0.5 };
  const responses = { model: 'model-id', input: [{ role: 'user', content: 'respond' }], reasoning: { effort: 'low' } };
  try {
    const chatResponse = await backend.request('chat', chat, {
      headers: { 'X-Session-Id': 'session-1' },
      signal: AbortSignal.timeout(2000),
    });
    expect(chatResponse.status).toBe(200);
    expect(await chatResponse.text()).toBe('{"ok":true}');
    const responsesResponse = await backend.request('responses', responses, {
      headers: { 'R-Timezone': 'UTC' },
      signal: AbortSignal.timeout(2000),
    });
    expect(responsesResponse.status).toBe(200);
    await responsesResponse.text();
    expect(app.requests.map(row => row.method)).toEqual(['POST', 'POST']);
    expect(app.requests.map(row => row.url)).toEqual(['/root/v1/chat/completions', '/root/v1/responses']);
    expect(app.requests[0].headers.authorization).toBe('Bearer backend-secret');
    expect(app.requests[1].headers.authorization).toBe('Bearer backend-secret');
    expect(app.requests[0].headers['content-type']).toBe('application/json');
    expect(app.requests[0].headers['x-session-id']).toBe('session-1');
    expect(app.requests[1].headers['r-timezone']).toBe('UTC');
    expect(app.requests[0].body).toBe(JSON.stringify(chat));
    expect(app.requests[1].body).toBe(JSON.stringify(responses));
    await expect(backend.request('unknown', chat)).rejects.toThrow('invalid_protocol');
    expect(app.requests).toHaveLength(2);
  } finally {
    await app.close();
  }
});

test('OpenAIBackend request refuses redirects', async () => {
  const app = await fixture((req, res) => {
    if (req.url === '/root/v1/chat/completions') {
      res.writeHead(302, { Location: '/redirected' });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end('followed');
  });
  const backend = new OpenAIBackend({ baseURL: app.baseURL, apiKey: 'secret', models: [model()] });
  try {
    await expect(backend.request('chat', { model: 'model-id', messages: [] })).rejects.toThrow();
    expect(app.requests.map(row => row.url)).toEqual(['/root/v1/chat/completions']);
  } finally {
    await app.close();
  }
});

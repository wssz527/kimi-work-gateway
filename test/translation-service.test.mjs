import { expect, test } from 'bun:test';
import { translateReasoning } from '../src/translation-service.mjs';

const CUSTOM = 'https://translate.example.test/v1/chat/completions';
const SETTINGS = { enabled: true, provider: 'bing', targetLanguage: 'zh', view: 'translated',
  customEndpoint: '', customModel: '', apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY' };
const settings = (overrides = {}) => ({ ...SETTINGS, ...overrides });

function jsonResponse(value, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(value);
  const bytes = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() { return body; },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; },
          async cancel() {},
        };
      },
    },
  };
}

// Every call is recorded and answered by a synthetic provider, so no test
// touches a real translation endpoint or a paid model.
function recorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: { ...(init.headers || {}) },
      body: init.body, signal: init.signal };
    calls.push(call);
    return handler(call, calls);
  };
  return { calls, fetchImpl };
}

function bingEcho(prefix = '译:') {
  return recorder((call) => {
    const texts = JSON.parse(call.body);
    return jsonResponse(texts.map(text => ({ translations: [{ text: prefix + text }] })));
  });
}

test('every segment of a long reasoning text is translated, in order, without truncation', async () => {
  const lines = Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1} explains step ${index + 1} of the plan.`);
  const source = lines.join('\n\n');
  const { calls, fetchImpl } = bingEcho();
  const out = await translateReasoning(source, settings(), { env: {}, fetchImpl });
  const sent = calls.flatMap(call => JSON.parse(call.body));
  expect(sent).toHaveLength(40);
  expect(sent).toEqual(lines.map(line => line));
  const expected = lines.map(line => '译:' + line).join('\n\n');
  expect(out).toBe(expected);
  expect(out.length).toBeGreaterThan(source.length);
  expect(out.split('\n\n')).toHaveLength(40);
  for (const call of calls) {
    expect(call.method).toBe('POST');
    expect(call.url).toContain('edge.microsoft.com/translate/translatetext');
    expect(call.url).toContain('to=zh-Hans');
    expect(call.headers.authorization).toBeUndefined();
  }
});

test('markdown fences, inline code, urls and host-protected texts stay byte-identical', async () => {
  const source = [
    'Run the command below and read `config.value` before the URL https://example.test/a?b=1.',
    '```js',
    'const token = "keep-me";',
    '```',
    'Then open (https://example.test/docs) and check done.',
  ].join('\n');
  const { calls, fetchImpl } = bingEcho();
  const out = await translateReasoning(source, settings(), { env: {}, fetchImpl, protectedTexts: ['keep-me'] });
  const sent = calls.flatMap(call => JSON.parse(call.body)).join('\n');
  expect(sent).not.toContain('```');
  expect(sent).not.toContain('https://example.test');
  expect(sent).not.toContain('`config.value`');
  expect(sent).not.toContain('keep-me');
  expect(out).toContain('```js\nconst token = "keep-me";\n```');
  expect(out).toContain('`config.value`');
  expect(out).toContain('https://example.test/a?b=1');
  expect(out).toContain('(https://example.test/docs)');
  expect(out.split('\n')).toHaveLength(source.split('\n').length);
});

test('segments split across requests keep paragraph and blank-line boundaries', async () => {
  const paragraphs = ['Alpha beta.', 'Gamma delta epsilon.', 'Zeta.'];
  const source = paragraphs.join('\n\n');
  const out = await translateReasoning(source, settings(), { env: {}, fetchImpl: bingEcho('[').fetchImpl });
  expect(out.split('\n\n')).toHaveLength(3);
  expect(out).toBe(paragraphs.map(text => '[' + text).join('\n\n'));
});

test('a provider failure throws a safe code instead of returning the source as success', async () => {
  const twoUnits = 'Hello world.\n\nSecond part.';
  const cases = [
    ['Hello world.', () => jsonResponse({ error: 'nope' }), 'translation_invalid_response'],
    ['Hello world.', () => jsonResponse([{ translations: [{ text: '' }] }]), 'translation_invalid_response'],
    [twoUnits, () => jsonResponse([{ translations: [{ text: 'only one' }] }]), 'translation_invalid_response'],
    [twoUnits, () => jsonResponse([{}, { translations: [] }]), 'translation_invalid_response'],
    ['Hello world.', () => jsonResponse(null, { status: 500 }), 'translation_http_error'],
    ['Hello world.', () => jsonResponse(null, { status: 429 }), 'translation_http_error'],
    ['Hello world.', () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'not json', body: null }), 'translation_invalid_response'],
  ];
  for (const [text, handler, code] of cases) {
    const { fetchImpl } = recorder(handler);
    const error = await translateReasoning(text, settings(), { env: {}, fetchImpl }).then(() => null, value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.message).toStartWith('translation_');
    expect(error.message).not.toContain('nope');
  }
});

test('a request that never answers times out, and an abort signal stops promptly', async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
  const started = Date.now();
  const timedOut = await translateReasoning('Hello there.', settings(), { env: { KIMI_WORK_TRANSLATION_TIMEOUT_MS: '250' }, fetchImpl: hanging })
    .then(() => null, error => error);
  expect(timedOut.code).toBe('translation_timeout');
  expect(Date.now() - started).toBeLessThan(3000);

  const controller = new AbortController();
  let calls = 0;
  const pending = translateReasoning('Hello there.', settings(), { env: {}, signal: controller.signal,
    fetchImpl: (url, init) => { calls++; return hanging(url, init); } });
  setTimeout(() => controller.abort(), 20);
  const aborted = await pending.then(() => null, error => error);
  expect(aborted.code).toBe('translation_aborted');
  expect(calls).toBe(1);

  const already = new AbortController();
  already.abort();
  let called = 0;
  const early = await translateReasoning('Hello.', settings(), { env: {}, signal: already.signal,
    fetchImpl: async () => { called++; return jsonResponse([]); } }).then(() => null, error => error);
  expect(early.code).toBe('translation_aborted');
  expect(called).toBe(0);
});

test('oversized responses and oversized inputs are rejected, not truncated', async () => {
  const huge = () => ({
    ok: true, status: 200, headers: { get: name => (name === 'content-length' ? String(8 * 1024 * 1024) : null) },
    text: async () => '[]', body: null,
  });
  const oversized = await translateReasoning('Hello world.', settings(), { env: {}, fetchImpl: huge })
    .then(() => null, error => error);
  expect(oversized.code).toBe('translation_response_too_large');

  const streamed = () => {
    const chunk = new Uint8Array(64 * 1024);
    return {
      ok: true, status: 200, headers: { get: () => null }, body: {
        getReader() {
          let sent = 0;
          return {
            async read() {
              sent += 1;
              if (sent > 16) return { done: true };
              return { done: false, value: chunk };
            },
            async cancel() {},
          };
        },
      },
    };
  };
  const streamedError = await translateReasoning('Hello world.', settings(), { env: {}, fetchImpl: streamed })
    .then(() => null, error => error);
  expect(streamedError.code).toBe('translation_response_too_large');

  let calls = 0;
  const inputError = await translateReasoning('x'.repeat(120001), settings(), { env: {},
    fetchImpl: async () => { calls++; return jsonResponse([]); } }).then(() => null, error => error);
  expect(inputError.code).toBe('translation_text_too_large');
  expect(calls).toBe(0);
});

test('google splits work per segment and joins every translated row', async () => {
  const { calls, fetchImpl } = recorder((call) => {
    const text = new URLSearchParams(call.body).get('q');
    return jsonResponse([[[`G(${text})`, text]], null, 'en']);
  });
  const out = await translateReasoning('One line.\nTwo line.', settings({ provider: 'google' }), { env: {}, fetchImpl });
  expect(calls).toHaveLength(2);
  expect(calls[0].url).toContain('translate.googleapis.com/translate_a/single');
  expect(calls[0].url).toContain('tl=zh-CN');
  expect(out).toBe('G(One line.)\nG(Two line.)');

  const empty = recorder(() => jsonResponse([null, null]));
  const error = await translateReasoning('One line.', settings({ provider: 'google' }), { env: {}, fetchImpl: empty.fetchImpl })
    .then(() => null, value => value);
  expect(error.code).toBe('translation_invalid_response');
});

test('a custom chat endpoint receives only its own key and aligns every reply item', async () => {
  const key = 'synthetic-custom-secret';
  const bodies = [];
  const { calls, fetchImpl } = recorder((call) => {
    const body = JSON.parse(call.body);
    bodies.push(body);
    const user = body.messages[1].content;
    const items = JSON.parse(user);
    return jsonResponse({ choices: [{ message: { content: JSON.stringify(items.map(text => 'C:' + text)) } }] });
  });
  const out = await translateReasoning('First part.\n\nSecond part.', settings({ provider: 'custom', customEndpoint: CUSTOM,
    customModel: 'synthetic-model', apiKeyEnv: 'SYNTH_TRANSLATION_KEY' }),
  { env: { SYNTH_TRANSLATION_KEY: key, KIMI_WORK_TRANSLATION_API_KEY: 'ignored' }, fetchImpl });
  expect(calls).toHaveLength(1);
  expect(calls[0].headers.authorization).toBe('Bearer ' + key);
  expect(calls[0].url).toBe(CUSTOM);
  expect(bodies[0].model).toBe('synthetic-model');
  expect(out).toBe('C:First part.\n\nC:Second part.');

  const noKey = recorder((call) => {
    expect(call.headers.authorization).toBeUndefined();
    const items = JSON.parse(JSON.parse(call.body).messages[1].content);
    return jsonResponse({ choices: [{ message: { content: items.map(text => 'N:' + text).join('\n') } }] });
  });
  const plain = await translateReasoning('Alpha.\n\nBeta.', settings({ provider: 'custom', customEndpoint: CUSTOM }),
    { env: { SYNTH_TRANSLATION_KEY: key }, fetchImpl: noKey.fetchImpl });
  expect(plain).toBe('N:Alpha.\n\nN:Beta.');
});

test('a misaligned custom reply falls back to one segment per request instead of dropping text', async () => {
  let batch = 0;
  const { calls, fetchImpl } = recorder((call) => {
    const user = JSON.parse(call.body).messages[1].content;
    batch += 1;
    if (batch === 1) return jsonResponse({ choices: [{ message: { content: 'only one merged answer' } }] });
    const items = typeof user === 'string' && user.startsWith('[') ? JSON.parse(user) : [user];
    return jsonResponse({ choices: [{ message: { content: 'S:' + items[0] } }] });
  });
  const out = await translateReasoning('Alpha one.\n\nBeta two.\n\nGamma three.',
    settings({ provider: 'custom', customEndpoint: CUSTOM }), { env: {}, fetchImpl });
  expect(calls).toHaveLength(4);
  expect(out).toBe('S:Alpha one.\n\nS:Beta two.\n\nS:Gamma three.');

  const fenced = recorder((call) => {
    const items = JSON.parse(JSON.parse(call.body).messages[1].content);
    return jsonResponse({ choices: [{ message: { content: '```json\n' + JSON.stringify(items.map(text => 'F:' + text)) + '\n```' } }] });
  });
  expect(await translateReasoning('One here.\n\nTwo here.', settings({ provider: 'custom', customEndpoint: CUSTOM }),
    { env: {}, fetchImpl: fenced.fetchImpl })).toBe('F:One here.\n\nF:Two here.');
});

test('provider credentials never appear in errors, and bing/google never receive them', async () => {
  const key = 'synthetic-leaky-secret';
  const env = { SYNTH_TRANSLATION_KEY: key, KIMI_WORK_TRANSLATION_API_KEY: key };
  const failing = recorder(() => { throw Error('upstream rejected ' + key); });
  const error = await translateReasoning('Hello world.', settings({ provider: 'custom', customEndpoint: CUSTOM,
    apiKeyEnv: 'SYNTH_TRANSLATION_KEY' }), { env, fetchImpl: failing.fetchImpl }).then(() => null, value => value);
  expect(error.code).toBe('translation_network_error');
  expect(error.message).toBe('translation_network_error');
  expect(JSON.stringify(error)).not.toContain(key);
  expect(String(error.stack)).not.toContain(key);

  for (const provider of ['bing', 'google']) {
    const ok = recorder((call) => (provider === 'bing'
      ? jsonResponse([{ translations: [{ text: 'T' }] }])
      : jsonResponse([[[`T`, 'Hello world.']]])));
    await translateReasoning('Hello world.', settings({ provider }), { env, fetchImpl: ok.fetchImpl });
    expect(ok.calls[0].headers.authorization).toBeUndefined();
  }
});

test('invalid configuration and empty input are handled before any network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse([]); };
  for (const [value, code] of [
    [settings({ provider: 'custom', customEndpoint: '' }), 'translation_endpoint_required'],
    [settings({ provider: 'unknown' }), 'translation_invalid_config'],
    [{ ...settings(), customKey: 'stored-key' }, 'translation_invalid_config'],
  ]) {
    const error = await translateReasoning('Hello.', value, { env: {}, fetchImpl }).then(() => null, value => value);
    expect(error.code).toBe(code);
  }
  expect(await translateReasoning('   \n  ', settings(), { env: {}, fetchImpl })).toBe('   \n  ');
  expect(await translateReasoning('', settings(), { env: {}, fetchImpl })).toBe('');
  expect(calls).toBe(0);
});

test('provider concurrency stays bounded while a long text is dispatched', async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url, init) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    const texts = JSON.parse(init.body);
    return jsonResponse(texts.map(text => ({ translations: [{ text: 'T:' + text }] })));
  };
  const source = Array.from({ length: 24 }, (_, index) => `Line number ${index + 1} has content.`).join('\n\n');
  const out = await translateReasoning(source, settings(), { env: {}, fetchImpl });
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(3);
  expect(out.split('\n\n')).toHaveLength(24);
});

test('a single-character code token is protected, together with its surrounding spaces', async () => {
  const { calls, fetchImpl } = bingEcho();
  const out = await translateReasoning('Press x now.', settings(), { env: {}, fetchImpl, protectedTexts: ['x'] });
  const sent = calls.flatMap(call => JSON.parse(call.body));
  expect(sent).toEqual(['Press', 'now.']);
  expect(out).toBe('译:Press x 译:now.');
  expect(out).toContain(' x ');

  const two = recorder((call) => {
    const texts = JSON.parse(call.body);
    return jsonResponse(texts.map(text => ({ translations: [{ text: 'T:' + text }] })));
  });
  const combined = await translateReasoning('Call f(x) twice.', settings(), { env: {},
    fetchImpl: two.fetchImpl, protectedTexts: ['f(x)'] });
  expect(two.calls.flatMap(call => JSON.parse(call.body))).toEqual(['Call', 'twice.']);
  expect(combined).toBe('T:Call f(x) T:twice.');
});

test('one failing batch aborts its in-flight siblings instead of finishing them', async () => {
  const signals = [];
  let started = 0;
  const fetchImpl = (url, init) => {
    started += 1;
    signals.push(init.signal);
    const index = started;
    if (index === 1) {
      return Promise.resolve(jsonResponse(null, { status: 503 }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse([{ translations: [{ text: 'late' }] }])), 50);
      init.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const source = Array.from({ length: 30 }, (_, index) => `Sentence number ${index + 1} here.`).join('\n\n');
  const error = await translateReasoning(source, settings(), { env: {}, fetchImpl }).then(() => null, value => value);
  expect(error.code).toBe('translation_http_error');
  expect(signals.length).toBeGreaterThan(1);
  // The sibling requests share the batch scope and were cancelled by the failure.
  expect(signals.slice(1).every(signal => signal.aborted)).toBe(true);
  expect(started).toBeLessThan(30);
});

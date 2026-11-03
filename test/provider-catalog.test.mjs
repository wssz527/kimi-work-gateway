import { describe, expect, test } from 'bun:test';
import { providerPresets, searchModels, parseDiscoveredModels } from '../src/provider-catalog.mjs';

const presets = providerPresets();
const byId = id => presets.filter(preset => preset.id === id);
const one = id => {
  const [preset] = byId(id);
  expect(preset).toBeDefined();
  return preset;
};
const ids = models => models.map(model => model.id);
const raw = value => JSON.parse(JSON.stringify(value));

const KINDS = ['api', 'coding'];
const PROTOCOLS = ['chat', 'responses'];
const SOURCE_KEYS = ['url', 'checkedAt'];
const PRESET_KEYS = ['id', 'name', 'kind', 'baseURL', 'protocols', 'models', 'source', 'notes'];
const MODEL_KEYS = ['id', 'name', 'protocols', 'contextWindow', 'maxOutputTokens', 'tools', 'reasoning',
  'inputModalities', 'reasoningEfforts', 'aliases', 'description', 'source'];

describe('preset contract', () => {
  test('every preset is source-labelled and uses the documented shape', () => {
    expect(presets.length).toBeGreaterThan(8);
    const seen = new Set();
    for (const preset of presets) {
      for (const key of Object.keys(preset)) expect(PRESET_KEYS).toContain(key);
      expect(typeof preset.id).toBe('string');
      expect(seen.has(preset.id)).toBe(false);
      seen.add(preset.id);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(KINDS).toContain(preset.kind);
      expect(new URL(preset.baseURL).protocol).toBe('https:');
      expect(preset.baseURL.endsWith('/')).toBe(false);
      expect(preset.protocols.length).toBeGreaterThan(0);
      for (const protocol of preset.protocols) expect(PROTOCOLS).toContain(protocol);
      expect(Object.keys(preset.source).sort()).toEqual([...SOURCE_KEYS].sort());
      expect(preset.source.url.startsWith('https://')).toBe(true);
      expect(preset.source.checkedAt).toBe('2026-11-02');
      expect(Array.isArray(preset.notes)).toBe(true);
      expect(preset.notes.length).toBeGreaterThan(0);
      expect(preset.models.length).toBeGreaterThan(0);
      for (const note of preset.notes) expect(typeof note).toBe('string');

      for (const model of preset.models) {
        for (const key of Object.keys(model)) expect(MODEL_KEYS).toContain(key);
        expect(model.id.length).toBeGreaterThan(0);
        expect(model.id).toBe(model.id.trim());
        expect(model.protocols.length).toBeGreaterThan(0);
        for (const protocol of model.protocols) expect(PROTOCOLS).toContain(protocol);
        for (const protocol of model.protocols) expect(preset.protocols).toContain(protocol);
        if (model.contextWindow !== undefined) expect(Number.isSafeInteger(model.contextWindow)).toBe(true);
        if (model.maxOutputTokens !== undefined) {
          expect(model.maxOutputTokens).toBeLessThanOrEqual(model.contextWindow);
        }
        if (model.inputModalities !== undefined) {
          for (const modality of model.inputModalities) expect(['text', 'image']).toContain(modality);
        }
        if (model.reasoningEfforts !== undefined) {
          for (const effort of model.reasoningEfforts) expect(effort).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        }
      }
    }
  });

  test('returns a deep copy that cannot be used to rewrite the shipped catalog', () => {
    const first = providerPresets();
    first[0].baseURL = 'https://attacker.example/v1';
    first[0].models[0].id = 'rewritten';
    first[0].models[0].protocols.push('chat');
    first[0].notes.push('injected');
    first[0].source.checkedAt = '1999-01-01';
    const second = providerPresets();
    expect(second[0].baseURL).toBe('https://api.kimi.com/coding/v1');
    expect(second[0].models[0].id).toBe('k3');
    expect(second[0].models[0].protocols).toEqual(['chat', 'responses']);
    expect(second[0].notes).not.toContain('injected');
    expect(second[0].source.checkedAt).toBe('2026-11-02');
    expect(second[0]).not.toBe(first[0]);
  });

  test('no preset declares a capability the gateway cannot forward', () => {
    for (const preset of presets) {
      for (const model of preset.models) {
        expect(model.inputModalities ?? []).not.toContain('video');
        expect(model.inputModalities ?? []).not.toContain('audio');
        if (model.reasoning === false) expect(model.reasoningEfforts).toBeUndefined();
      }
    }
  });

  test('coding presets never pretend to be pay-as-you-go and API presets never pretend to be subscriptions', () => {
    const api = presets.filter(preset => preset.kind === 'api');
    const coding = presets.filter(preset => preset.kind === 'coding');
    expect(api.length).toBeGreaterThan(0);
    expect(coding.length).toBeGreaterThan(0);
    for (const preset of coding) expect(preset.notes.join(' ')).toMatch(/套餐|Coding Plan/);
    for (const preset of api) {
      expect(preset.notes.join(' ')).toMatch(/按量|按官方价格/);
      expect(preset.kind).toBe('api');
    }
    const codingURLs = new Set(coding.map(preset => preset.baseURL));
    for (const preset of api) expect(codingURLs.has(preset.baseURL)).toBe(false);
  });
});

describe('official provider presets', () => {
  test('Kimi Code ships both regions with the four documented model ids and limits', () => {
    const domestic = one('kimi-code-cn');
    const global = one('kimi-code-global');
    expect(domestic.baseURL).toBe('https://api.kimi.com/coding/v1');
    expect(global.baseURL).toBe('https://api.kimi.ai/coding/v1');
    expect(domestic.kind).toBe('coding');
    expect(ids(domestic.models)).toEqual(['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed']);
    expect(ids(global.models)).toEqual(ids(domestic.models));
    expect(domestic.protocols).toEqual(['chat', 'responses']);
    expect(raw(domestic.models)).toEqual(raw(global.models));

    const k3 = domestic.models.find(model => model.id === 'k3');
    expect(k3.contextWindow).toBe(1048576);
    expect(k3.reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(domestic.models.find(model => model.id === 'k3-256k').contextWindow).toBe(262144);
    expect(domestic.models.find(model => model.id === 'kimi-for-coding').contextWindow).toBe(1048576);
    expect(domestic.models.find(model => model.id === 'kimi-for-coding-highspeed').contextWindow).toBe(262144);
    expect(domestic.notes.join(' ')).toContain('262144');
    expect(domestic.notes.join(' ')).toMatch(/User-Agent/);
    expect(domestic.notes.join(' ')).toContain('互不通用');
  });

  test('DeepSeek keeps the documented /models metadata contract and does not invent a subscription', () => {
    const deepseek = one('deepseek');
    expect(deepseek.kind).toBe('api');
    expect(deepseek.baseURL).toBe('https://api.deepseek.com');
    expect(deepseek.protocols).toEqual(['chat', 'responses']);
    expect(ids(deepseek.models)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(deepseek.models[0].contextWindow).toBe(1000000);
    expect(deepseek.models[0].maxOutputTokens).toBe(384000);
    expect(deepseek.source.url).toBe('https://api-docs.deepseek.com/api/list-models');
    const notes = deepseek.notes.join(' ');
    expect(notes).toContain('context_window');
    expect(notes).toContain('max_output_tokens');
    expect(notes).toContain('input_modalities');
    expect(notes).toMatch(/未查到/);
    expect(notes).not.toMatch(/没有订阅|绝不提供订阅/);
    expect(presets.filter(preset => preset.id.startsWith('deepseek') && preset.kind === 'coding')).toEqual([]);
  });

  test('GLM keeps coding chat, coding responses and pay-as-you-go on their own endpoints', () => {
    const domesticChat = one('zhipu-coding-cn-chat');
    const domesticResponses = one('zhipu-coding-cn-responses');
    const domesticApi = one('zhipu-api-cn');
    const globalChat = one('zai-coding-global-chat');
    const globalResponses = one('zai-coding-global-responses');
    const globalApi = one('zai-api-global');

    expect(domesticChat.baseURL).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(domesticResponses.baseURL).toBe('https://open.bigmodel.cn/api/v1');
    expect(domesticApi.baseURL).toBe('https://open.bigmodel.cn/api/paas/v4');
    expect(globalChat.baseURL).toBe('https://api.z.ai/api/coding/paas/v4');
    expect(globalResponses.baseURL).toBe('https://api.z.ai/api/v1');
    expect(globalApi.baseURL).toBe('https://api.z.ai/api/paas/v4');

    expect(new Set([domesticChat.baseURL, domesticResponses.baseURL, domesticApi.baseURL]).size).toBe(3);
    expect(domesticChat.protocols).toEqual(['chat']);
    expect(domesticResponses.protocols).toEqual(['responses']);
    for (const model of domesticChat.models) expect(model.protocols).toEqual(['chat']);
    for (const model of domesticResponses.models) expect(model.protocols).toEqual(['responses']);
    expect(globalResponses.protocols).toEqual(['responses']);

    const glm53 = domesticChat.models.find(model => model.id === 'glm-5.3');
    expect(glm53.contextWindow).toBe(1048576);
    expect(glm53.reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(glm53.inputModalities).toEqual(['text']);
    expect(domesticChat.models.find(model => model.id === 'glm-5.3-flash').inputModalities).toEqual(['text', 'image']);
    expect(ids(globalChat.models)).toEqual(['glm-5.3']);

    expect(domesticChat.notes.join(' ')).toMatch(/不能混用/);
    expect(domesticChat.notes.join(' ')).toMatch(/指定工具/);
    expect(domesticChat.notes.join(' ')).toMatch(/不伪造客户端标识/);
    expect(domesticChat.notes.join(' ')).toMatch(/互不通用/);
  });

  test('Qwen separates the coding subscription from the regional pay-as-you-go endpoint', () => {
    const coding = one('qwen-coding');
    const api = one('qwen-api');
    expect(coding.kind).toBe('coding');
    expect(coding.baseURL).toBe('https://coding.dashscope.aliyuncs.com/v1');
    expect(coding.protocols).toEqual(['chat']);
    expect(ids(coding.models)).toEqual(['qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus']);
    expect(coding.notes.join(' ')).toContain('sk-sp-');
    expect(coding.notes.join(' ')).toMatch(/禁止/);

    expect(api.kind).toBe('api');
    expect(api.baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(api.protocols).toEqual(['chat', 'responses']);
    expect(ids(api.models)).toEqual(['qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus']);
    expect(api.models[0].contextWindow).toBe(1000000);
    expect(api.models[0].maxOutputTokens).toBe(131072);
    expect(api.models[0].reasoningEfforts).toEqual(['none', 'low', 'medium', 'xhigh']);
    expect(api.notes.join(' ')).toMatch(/业务空间专属域名|WorkspaceId/);
    expect(api.notes.join(' ')).toMatch(/地域/);
    expect(coding.baseURL).not.toBe(api.baseURL);
  });

  test('OpenAI ships the four verified GPT-6 models without inventing a plan', () => {
    const openai = one('openai');
    expect(openai.baseURL).toBe('https://api.openai.com/v1');
    expect(openai.kind).toBe('api');
    expect(ids(openai.models)).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna']);
    for (const model of openai.models) {
      expect(model.contextWindow).toBe(1050000);
      expect(model.maxOutputTokens).toBe(128000);
      expect(model.tools).toBe(true);
      expect(model.reasoning).toBe(true);
      expect(model.inputModalities).toEqual(['text', 'image']);
      expect(model.protocols).toEqual(['chat', 'responses']);
    }
    expect(openai.models[0].reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(openai.source.url).toBe('https://developers.openai.com/api/docs/models');
    expect(openai.notes.join(' ')).toContain('272K');
  });
});

describe('model search', () => {
  const openai = one('openai');
  const kimi = one('kimi-code-cn');

  test('GPT6 aster resolves to the real gpt-6-astra id', () => {
    const found = searchModels(openai.models, 'GPT6 aster');
    expect(ids(found)).toEqual(['gpt-6-astra']);
    expect(found[0]).toBe(openai.models[0]);
    expect(searchModels(openai.models, 'gpt6aster')[0].id).toBe('gpt-6-astra');
    expect(searchModels(openai.models, 'GPT-6 Astra')[0].id).toBe('gpt-6-astra');
    expect(searchModels(openai.models, 'gpt 6 astra')[0].id).toBe('gpt-6-astra');
  });

  test('GPT6.1sol matches without the missing space and without guessing another id', () => {
    expect(ids(searchModels(openai.models, 'GPT6.1sol'))).toEqual(['gpt-6.1-sol']);
    expect(ids(searchModels(openai.models, 'gpt-6.1-sol'))).toEqual(['gpt-6.1-sol']);
    expect(ids(searchModels(openai.models, 'GPT 6.1 SOL'))).toEqual(['gpt-6.1-sol']);
    expect(ids(searchModels(openai.models, 'gpt6_1_sol'))).toEqual(['gpt-6.1-sol']);
  });

  test('casing and separator variants never rewrite the upstream id', () => {
    for (const query of ['KIMI-FOR-CODING', 'kimi for coding', 'kimiForCoding', 'Kimi_For_Coding']) {
      const found = searchModels(kimi.models, query);
      expect(found[0].id).toBe('kimi-for-coding');
      expect(kimi.models).toContain(found[0]);
    }
    const before = raw(kimi.models);
    searchModels(kimi.models, 'k3');
    expect(raw(kimi.models)).toEqual(before);
  });

  test('rank order is exact, alias, prefix, then bounded fuzzy', () => {
    const models = [
      { id: 'vendor/gpt-6-astra-extra' },
      { id: 'vendor/gpt-6-astra' },
      { id: 'gpt-6-astra', aliases: [] },
      { id: 'sibling', aliases: ['gpt6astra'] },
      { id: 'unrelated-model' },
    ];
    const ranked = ids(searchModels(models, 'gpt6astra'));
    expect(ranked).toEqual(['gpt-6-astra', 'sibling', 'vendor/gpt-6-astra', 'vendor/gpt-6-astra-extra']);

    const prefixed = ids(searchModels(models, 'vendor/gpt-6'));
    expect(prefixed.slice(0, 2)).toEqual(['vendor/gpt-6-astra-extra', 'vendor/gpt-6-astra']);

    const aliasOnly = [{ id: 'upstream-a', aliases: ['Astra'] }, { id: 'upstream-b' }];
    expect(ids(searchModels(aliasOnly, 'astra'))).toEqual(['upstream-a']);
  });

  test('fuzzy matching is bounded and never returns a weak guess', () => {
    expect(searchModels(openai.models, 'lunaa').map(model => model.id)).toEqual(['gpt-6-luna']);
    expect(searchModels(openai.models, 'zzzz')).toEqual([]);
    expect(searchModels(openai.models, 'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq')).toEqual([]);
    expect(searchModels(openai.models, 'a')).toEqual([]);
  });

  test('limit, empty query and malformed options stay bounded', () => {
    expect(searchModels(openai.models, 'gpt').length).toBe(4);
    expect(searchModels(openai.models, 'gpt', { limit: 2 }).length).toBe(2);
    expect(searchModels(openai.models, 'gpt', { limit: -1 }).length).toBe(4);
    expect(searchModels(openai.models, 'gpt', { limit: 1000 }).length).toBe(4);
    expect(searchModels(openai.models, 'gpt', null).length).toBe(4);
    expect(searchModels(openai.models, 'gpt', { limit: 'x' }).length).toBe(4);
    expect(searchModels(openai.models, '   ')).toEqual([]);
    expect(searchModels(openai.models, '')).toEqual([]);
    expect(searchModels(openai.models, 'x'.repeat(201))).toEqual([]);
    expect(searchModels(openai.models, 'gpt', { limit: 0 })).toEqual([]);
    expect(searchModels(openai.models, 'gpt', { limit: 60 }).length).toBe(4);
    expect(searchModels(null, 'gpt')).toEqual([]);
    expect(searchModels(openai.models, 42)).toEqual([]);
    expect(searchModels([null, 'x', { id: '' }, { id: 'gpt-6-astra' }], 'astra').map(model => model.id))
      .toEqual(['gpt-6-astra']);
  });

  test('search is stateless and never selects or saves a candidate', () => {
    const first = searchModels(openai.models, 'sol');
    const second = searchModels(openai.models, 'sol');
    expect(first[0]).toBe(second[0]);
    expect(openai.models.filter(model => model.default === true)).toEqual([]);
    expect(searchModels(openai.models, 'sol')[0].selected).toBeUndefined();
  });
});

describe('discovery parsing', () => {
  const deepseekPayload = {
    object: 'list',
    data: [
      {
        id: 'deepseek-flash',
        object: 'model',
        owned_by: 'deepseek',
        name: 'DeepSeek V4.1 Flash',
        context_window: 1000000,
        max_output_tokens: 384000,
        input_modalities: ['text', 'image'],
        effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
        api_capabilities: { chat_completions: {}, responses: {}, anthropic_messages: {} },
      },
      {
        id: 'deepseek-v4-pro',
        object: 'model',
        owned_by: 'deepseek',
        api_capabilities: { chat_completions: {} },
      },
    ],
  };

  test('parses the documented DeepSeek metadata and keeps the upstream ids verbatim', () => {
    const models = parseDiscoveredModels(deepseekPayload, {
      presetId: 'deepseek',
      url: 'https://api.deepseek.com/models',
      checkedAt: '2026-11-02',
    });
    expect(ids(models)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    const flash = models[0];
    expect(flash.name).toBe('DeepSeek V4.1 Flash');
    expect(flash.contextWindow).toBe(1000000);
    expect(flash.maxOutputTokens).toBe(384000);
    expect(flash.inputModalities).toEqual(['text', 'image']);
    expect(flash.reasoningEfforts).toEqual(['low', 'high', 'max']);
    expect(flash.protocols).toEqual(['chat', 'responses']);
    expect(flash.source).toEqual({ url: 'https://api.deepseek.com/models', checkedAt: '2026-11-02' });
    expect(models[1].protocols).toEqual(deepseekPayload.data[1].api_capabilities.chat_completions ? ['chat'] : []);
  });

  test('missing metadata stays undefined instead of becoming false or zero', () => {
    const [model] = parseDiscoveredModels({ data: [{ id: 'k3' }] }, { presetId: 'kimi-code-cn' });
    expect(model).toEqual({
      id: 'k3',
      protocols: ['chat', 'responses'],
      source: { checkedAt: new Date().toISOString().slice(0, 10) },
    });
    expect(model.tools).toBeUndefined();
    expect(model.reasoning).toBeUndefined();
    expect(model.contextWindow).toBeUndefined();
    expect(model.maxOutputTokens).toBeUndefined();
    expect(model.inputModalities).toBeUndefined();
    expect(model.reasoningEfforts).toBeUndefined();
    expect(model.aliases).toBeUndefined();
    expect(model.description).toBeUndefined();
    expect('tools' in model).toBe(false);
  });

  test('a preset narrows protocols but never widens them', () => {
    const payload = { data: [{ id: 'glm-5.3', api_capabilities: { responses: {}, chat_completions: {} } }] };
    expect(parseDiscoveredModels(payload, { presetId: 'zhipu-coding-cn-chat' })[0].protocols).toEqual(['chat']);
    expect(parseDiscoveredModels(payload, { presetId: 'zhipu-coding-cn-responses' })[0].protocols)
      .toEqual(['responses']);
    expect(parseDiscoveredModels(payload)[0].protocols).toEqual(['chat', 'responses']);
  });

  test('a zero-intersection declaration yields no protocols instead of the whole preset', () => {
    const responsesOnly = { data: [{ id: 'glm-5.3', api_capabilities: { responses: {} } }] };
    expect(parseDiscoveredModels(responsesOnly, { presetId: 'zhipu-coding-cn-chat' })[0].protocols).toEqual([]);
    const chatOnly = { data: [{ id: 'glm-5.3', api_capabilities: { chat_completions: {} } }] };
    expect(parseDiscoveredModels(chatOnly, { presetId: 'zhipu-coding-cn-responses' })[0].protocols).toEqual([]);
    const qwenChat = { data: [{ id: 'qwen3.7-plus', api_capabilities: { responses: {} } }] };
    expect(parseDiscoveredModels(qwenChat, { presetId: 'qwen-coding' })[0].protocols).toEqual([]);
    // The id survives so the user can still confirm it by hand.
    expect(parseDiscoveredModels(responsesOnly, { presetId: 'zhipu-coding-cn-chat' })[0].id).toBe('glm-5.3');
  });

  test('a preset still supplies static protocols when the vendor declares nothing', () => {
    const undeclared = { data: [{ id: 'kimi-for-coding' }] };
    expect(parseDiscoveredModels(undeclared, { presetId: 'qwen-coding' })[0].protocols).toEqual(['chat']);
    expect(parseDiscoveredModels(undeclared, { presetId: 'kimi-code-cn' })[0].protocols)
      .toEqual(['chat', 'responses']);
    expect(parseDiscoveredModels(undeclared, { presetId: 'zhipu-coding-cn-responses' })[0].protocols)
      .toEqual(['responses']);
  });

  test('an explicit empty declaration never falls back to the preset', () => {
    // A missing field may fall back; an explicit empty set may not. Both leave
    // every protocol unmentioned, so only `stated` can tell them apart.
    for (const presetId of ['kimi-code-cn', 'qwen-coding', 'zhipu-coding-cn-responses', 'deepseek', 'openai']) {
      const emptyArray = { data: [{ id: 'x', protocols: [] }] };
      expect(parseDiscoveredModels(emptyArray, { presetId })[0].protocols).toEqual([]);
      const emptyCaps = { data: [{ id: 'x', api_capabilities: {} }] };
      expect(parseDiscoveredModels(emptyCaps, { presetId })[0].protocols).toEqual([]);
      // Only keys outside the two known protocols: still an explicit, empty set.
      const foreignCaps = { data: [{ id: 'x', api_capabilities: { anthropic_messages: {} } }] };
      expect(parseDiscoveredModels(foreignCaps, { presetId })[0].protocols).toEqual([]);
    }
    const emptyArray = { data: [{ id: 'x', protocols: [] }] };
    expect(parseDiscoveredModels(emptyArray)[0].protocols).toEqual([]);
    expect(parseDiscoveredModels(emptyArray)[0].id).toBe('x');
    // The same rows without the field still get the preset's static protocols.
    const missing = { data: [{ id: 'x' }] };
    expect(parseDiscoveredModels(missing, { presetId: 'kimi-code-cn' })[0].protocols)
      .toEqual(['chat', 'responses']);
  });

  test('DeepSeek section objects still affirm while an empty caps object does not', () => {
    const perProtocol = { data: [{ id: 'd', api_capabilities: { chat_completions: {}, responses: {} } }] };
    expect(parseDiscoveredModels(perProtocol, { presetId: 'deepseek' })[0].protocols)
      .toEqual(['chat', 'responses']);
    const chatOnly = { data: [{ id: 'd', api_capabilities: { chat_completions: {} } }] };
    expect(parseDiscoveredModels(chatOnly, { presetId: 'deepseek' })[0].protocols).toEqual(['chat']);
    const empty = { data: [{ id: 'd', api_capabilities: {} }] };
    expect(parseDiscoveredModels(empty, { presetId: 'deepseek' })[0].protocols).toEqual([]);
  });

  test('no preset and no declaration claims nothing at all', () => {
    const undeclared = { data: [{ id: 'mystery-model' }] };
    const [model] = parseDiscoveredModels(undeclared);
    expect(model.protocols).toEqual([]);
    expect(model.id).toBe('mystery-model');
    expect(parseDiscoveredModels(undeclared, { presetId: 'not-a-preset' })[0].protocols).toEqual([]);
    expect(parseDiscoveredModels({ data: [{ id: 'mystery-model', protocols: [] }] })[0].protocols).toEqual([]);
  });

  test('an explicit refusal is never turned into support', () => {
    const refusals = {
      data: [{
        id: 'glm-5.3',
        api_capabilities: {
          responses: false,
          chat_completions: null,
        },
      }],
    };
    expect(parseDiscoveredModels(refusals, { presetId: 'zhipu-coding-cn-chat' })[0].protocols).toEqual([]);
    expect(parseDiscoveredModels(refusals, { presetId: 'zhipu-coding-cn-responses' })[0].protocols).toEqual([]);
    expect(parseDiscoveredModels(refusals)[0].protocols).toEqual([]);

    const supportedFalse = { data: [{ id: 'x', api_capabilities: { responses: { supported: false } } }] };
    expect(parseDiscoveredModels(supportedFalse)[0].protocols).toEqual([]);

    // Only chat is refused and responses is never mentioned: the refused
    // protocol is dropped and the untouched one still comes from the preset,
    // which is preset-minus-negative rather than guessing chat back.
    const deniedChat = { data: [{ id: 'x', api_capabilities: { chat_completions: false } }] };
    expect(parseDiscoveredModels(deniedChat, { presetId: 'kimi-code-cn' })[0].protocols).toEqual(['responses']);
    expect(parseDiscoveredModels(deniedChat, { presetId: 'qwen-coding' })[0].protocols).toEqual([]);
    expect(parseDiscoveredModels(deniedChat)[0].protocols).toEqual([]);
    expect(parseDiscoveredModels({ data: [{ id: 'x', api_capabilities: { chat_completions: null } }] },
      { presetId: 'kimi-code-cn' })[0].protocols).toEqual(['responses']);
    expect(parseDiscoveredModels({ data: [{ id: 'x', api_capabilities: { chat_completions: { supported: false } } }] },
      { presetId: 'kimi-code-cn' })[0].protocols).toEqual(['responses']);

    // An affirmation next to a refusal keeps only the affirmation.
    const mixed = { data: [{ id: 'x', api_capabilities: { responses: {}, chat_completions: false } }] };
    expect(parseDiscoveredModels(mixed, { presetId: 'kimi-code-cn' })[0].protocols).toEqual(['responses']);
  });

  test('malformed capability sections never count as support', () => {
    // Responses is listed by the preset, so a readable section would return
    // ['responses']; an unreadable one must leave the protocol unconfirmed.
    for (const value of ['yes', 1, [], { supported: 'yes' }, { supported: null }, { supported: 1 }]) {
      const payload = { data: [{ id: 'x', api_capabilities: { responses: value } }] };
      const protocols = parseDiscoveredModels(payload, { presetId: 'zhipu-coding-cn-responses' })[0].protocols;
      expect(protocols).toEqual([]);
    }
    // An affirmation still wins over a preset that lists both protocols.
    const affirmed = { data: [{ id: 'x', api_capabilities: { responses: { supported: true } } }] };
    expect(parseDiscoveredModels(affirmed, { presetId: 'kimi-code-cn' })[0].protocols).toEqual(['responses']);
    expect(parseDiscoveredModels(affirmed)[0].protocols).toEqual(['responses']);
  });

  test('unknown and hostile discovery inputs are bounded, filtered and never throw', () => {
    const hostile = {
      data: [
        { id: 'k3', context_window: -1, max_output_tokens: 10 ** 12, tools: 'yes', reasoning: 1 },
        { id: 'model with spaces' },
        { id: 'ctrl\u0000id' },
        { id: 'x'.repeat(600) },
        { id: 'k3' },
        { id: '../../etc/passwd' },
        { id: 42 },
        null,
        'k3',
        { id: 'aliases', aliases: Array.from({ length: 40 }, (_, index) => 'alias-' + index) },
        { id: 'bad-alias', aliases: ['ok', 'bad\nline', 'x'.repeat(400)] },
        { id: 'efforts', reasoning_efforts: ['high', 'HIGH', 'bad effort', 'x'.repeat(80), 'low'] },
        { id: 'modalities', input_modalities: ['text', 'video', 'audio', 'image', 'text'] },
      ],
    };
    const models = parseDiscoveredModels(hostile, { presetId: 'kimi-code-cn' });
    expect(ids(models)).toEqual(['k3', 'aliases', 'bad-alias', 'efforts', 'modalities']);
    const [k3] = models;
    expect(k3.contextWindow).toBeUndefined();
    expect(k3.maxOutputTokens).toBeUndefined();
    expect(k3.tools).toBeUndefined();
    expect(k3.reasoning).toBeUndefined();
    const aliasModel = models.find(model => model.id === 'aliases');
    expect(aliasModel.aliases.length).toBeLessThanOrEqual(8);
    expect(models.find(model => model.id === 'bad-alias').aliases).toEqual(['ok']);
    expect(models.find(model => model.id === 'efforts').reasoningEfforts).toEqual(['high', 'low']);
    expect(models.find(model => model.id === 'modalities').inputModalities).toEqual(['text', 'image']);
    expect(() => JSON.stringify(models)).not.toThrow();
  });

  test('oversized and malformed payloads stay bounded', () => {
    const many = { data: Array.from({ length: 1200 }, (_, index) => ({ id: 'model-' + index })) };
    expect(parseDiscoveredModels(many).length).toBe(500);
    expect(parseDiscoveredModels({ data: many.data.slice(0, 600) }).length).toBe(500);
    expect(parseDiscoveredModels({ data: many.data.slice(0, 300) }).length).toBe(300);
    const duplicateHeavy = { data: Array.from({ length: 1200 }, (_, index) => ({ id: 'model-' + (index % 400) })) };
    expect(parseDiscoveredModels(duplicateHeavy).length).toBe(400);
    const sparse = { data: Array.from({ length: 1200 }, (_, index) => index % 2 ? { id: 'ok-' + index } : null) };
    expect(parseDiscoveredModels(sparse).length).toBe(500);
    expect(parseDiscoveredModels({ data: 'nope' })).toEqual([]);
    expect(parseDiscoveredModels({ data: { id: 'k3' } })).toEqual([]);
    expect(parseDiscoveredModels(null)).toEqual([]);
    expect(parseDiscoveredModels(undefined)).toEqual([]);
    expect(parseDiscoveredModels('{"data":[]}')).toEqual([]);
    expect(parseDiscoveredModels({ models: [{ id: 'k3' }] }).map(model => model.id)).toEqual(['k3']);
    expect(parseDiscoveredModels([{ id: 'k3' }]).map(model => model.id)).toEqual(['k3']);
    expect(parseDiscoveredModels([], { presetId: 'k3', url: 5, checkedAt: 'today' })).toEqual([]);
  });

  test('discovery sources are only kept when they are plain https urls', () => {
    const withSource = (url) => parseDiscoveredModels({ data: [{ id: 'k3', source: url }] },
      { url })[0].source;
    expect(withSource('https://api.deepseek.com/models')).toEqual(
      { url: 'https://api.deepseek.com/models', checkedAt: new Date().toISOString().slice(0, 10) });
    expect(withSource('http://api.deepseek.com/models')).toEqual(
      { checkedAt: new Date().toISOString().slice(0, 10) });
    expect(withSource('https://' + 'user:pw' + '@api.deepseek.com/models')).toEqual(
      { checkedAt: new Date().toISOString().slice(0, 10) });
    expect(withSource('javascript:alert(1)')).toEqual({ checkedAt: new Date().toISOString().slice(0, 10) });
    expect(withSource('not a url')).toEqual({ checkedAt: new Date().toISOString().slice(0, 10) });
  });

  test('discovered models feed the same search without changing their ids', () => {
    const models = parseDiscoveredModels(deepseekPayload, { presetId: 'deepseek' });
    expect(ids(searchModels(models, 'DEEPSEEK FLASH'))).toEqual(['deepseek-flash']);
    expect(ids(searchModels(models, 'v4pro'))).toEqual(['deepseek-v4-pro']);
    expect(ids(searchModels(models, 'deepseek-flash'))).toEqual(['deepseek-flash']);
  });
});

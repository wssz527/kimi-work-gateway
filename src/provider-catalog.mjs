// Official provider presets and pure model matching for Kimi++.
//
// Every preset says where its facts came from: source.url is the vendor page
// that was read and source.checkedAt is the day it was read. A value the
// vendor does not publish stays undefined instead of being filled in, and a
// plan is only labelled `coding` when the vendor documents that plan for the
// endpoint in question. Codes and subscriptions are separate products in every
// one of these catalogs, so a coding preset never inherits pay-as-you-go URLs
// and an API preset never inherits subscription URLs.
//
// Matching and discovery are pure: they rank or normalize the caller's own
// candidates, keep the upstream model id verbatim, and never store a choice.
// inputModalities only carries text/image, because that is what the gateway can
// forward truthfully; a documented video input is described in `description`
// rather than declared as a capability the pipeline cannot deliver.

const CHECKED = '2026-11-02';

const PROTOCOLS = ['chat', 'responses'];
const MODALITIES = ['text', 'image'];

const LIMITS = Object.freeze({
  models: 500,
  entries: 2000,
  candidates: 2000,
  name: 200,
  description: 1000,
  aliases: 8,
  alias: 200,
  efforts: 16,
  effort: 32,
  context: 100000000,
  output: 10000000,
  query: 200,
  limit: 50,
  defaultLimit: 20,
  fuzzyQuery: 64,
  fuzzyTarget: 256,
});

const CONTROL = /[\u0000-\u001f\u007f]/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,511}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isPlain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlain(value)) {
    const copy = {};
    for (const key of Object.keys(value)) copy[key] = clone(value[key]);
    return copy;
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const sourced = url => ({ url, checkedAt: CHECKED });
const firstDefined = (...values) => values.find(value => value !== undefined);

function label(value, limit) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= limit && !CONTROL.test(text) ? text : undefined;
}

function identifier(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  return IDENTIFIER.test(id) ? id : '';
}

function boundedInteger(value, limit) {
  return Number.isSafeInteger(value) && value > 0 && value <= limit ? value : undefined;
}

function flag(row, ...names) {
  for (const name of names) if (typeof row[name] === 'boolean') return row[name];
  return undefined;
}

const PAGES = {
  kimiModels: 'https://www.kimi.ai/zh-hans/help/kimi-code/models',
  kimiOverview: 'https://www.kimi.ai/zh-hans/help/kimi-code/membership-guide',
  deepseekModels: 'https://api-docs.deepseek.com/api/list-models',
  deepseekPricing: 'https://api-docs.deepseek.com/quick_start/pricing',
  glmCoding: 'https://docs.bigmodel.cn/cn/coding-plan/tool/others',
  glmSwitching: 'https://docs.bigmodel.cn/cn/coding-plan/latest-model',
  glmModels: 'https://docs.bigmodel.cn/cn/guide/start/model-overview',
  glmApi: 'https://docs.bigmodel.cn/cn/api/introduction',
  zaiCoding: 'https://docs.z.ai/devpack/tool/codex',
  qwenCoding: 'https://help.aliyun.com/en/model-studio/coding-plan',
  qwenCompatibility: 'https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope',
  qwenResponses: 'https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses',
  qwen38Max: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max',
  qwen37Plus: 'https://help.aliyun.com/zh/model-studio/qwen3-7-plus',
  qwen36Plus: 'https://help.aliyun.com/zh/model-studio/qwen3-6-plus',
  qwen35Plus: 'https://help.aliyun.com/zh/model-studio/qwen3-5-plus',
  openaiModels: 'https://developers.openai.com/api/docs/models',
};

const KIMI_CODE_MODELS = [
  {
    id: 'k3',
    name: 'K3',
    protocols: ['chat', 'responses'],
    contextWindow: 1048576,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    aliases: ['Kimi K3', '月之暗面 K3'],
    description: '旗舰编程模型，2.8T 参数。官方 1M 上下文只对高档位套餐开放，支持图片与视频输入。',
  },
  {
    id: 'k3-256k',
    name: 'K3 256K',
    protocols: ['chat', 'responses'],
    contextWindow: 262144,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    aliases: ['K3 256K'],
    description: 'K3 的 256K 上下文版本，上下文固定 262144，仅支持图片输入，消耗约为 k3 的一半。',
  },
  {
    id: 'kimi-for-coding',
    name: 'K2.8 Preview',
    protocols: ['chat', 'responses'],
    contextWindow: 1048576,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'high', 'max'],
    aliases: ['Kimi K2.8', 'K2.8 Preview'],
    description: 'K2.8 Preview，综合性能接近 K3，思考默认 max 档，支持图片与视频输入。',
  },
  {
    id: 'kimi-for-coding-highspeed',
    name: 'K2.7 Code HighSpeed',
    protocols: ['chat', 'responses'],
    contextWindow: 262144,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    aliases: ['Kimi K2.7 Code HighSpeed'],
    description: 'K2.7 Code 高速版，编码能力一致，输出速度约为普通版 5–6 倍、消耗约为 3 倍；思考固定开启，无分档。',
  },
];

const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    protocols: ['chat', 'responses'],
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    aliases: ['DeepSeek V4.1 Flash', 'deepseek-v4-flash'],
    description: '支持非思考与思考（默认）两种模式；旧 ID deepseek-v4-flash 已退役但仍被接受，请求会由当前 Flash 模型处理。',
    source: sourced(PAGES.deepseekPricing),
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    protocols: ['chat', 'responses'],
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    tools: true,
    reasoning: true,
    inputModalities: ['text'],
    aliases: ['DeepSeek V4 Pro'],
    description: '旗舰 MoE 模型，思考为默认模式；官方模型表未标注视觉输入，因此不声明图片能力。',
    source: sourced(PAGES.deepseekPricing),
  },
];

// The GLM Coding Plan publishes one base URL per protocol, so chat and
// responses live in separate presets instead of one preset with two URLs.
function glmModels(protocols) {
  const shared = { protocols: [...protocols], contextWindow: 1048576, maxOutputTokens: 131072,
    tools: true, reasoning: true, reasoningEfforts: ['low', 'high', 'max'], source: sourced(PAGES.glmModels) };
  return [
    {
      ...shared,
      id: 'glm-5.3',
      name: 'GLM-5.3',
      inputModalities: ['text'],
      aliases: ['智谱 GLM-5.3'],
      description: '旗舰文本编码模型，1M 上下文 / 128K 输出；思考默认 max 档，官方建议显式传 max。',
    },
    {
      ...shared,
      id: 'glm-5.3-flash',
      name: 'GLM-5.3-Flash',
      inputModalities: ['text', 'image'],
      aliases: ['智谱 GLM-5.3 Flash'],
      description: '原生多模态版本，支持图片输入；1M 上下文 / 128K 输出。',
    },
  ];
}

function zaiModels(protocols) {
  return [
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      protocols: [...protocols],
      contextWindow: 1048576,
      maxOutputTokens: 131072,
      tools: true,
      reasoning: true,
      inputModalities: ['text'],
      reasoningEfforts: ['low', 'high', 'max'],
      aliases: ['智谱 GLM-5.3'],
      description: '旗舰文本编码模型，1M 上下文 / 128K 输出；思考默认 max 档，官方建议显式传 max。',
      source: sourced(PAGES.glmModels),
    },
  ];
}

function qwenPlusModels(protocols) {
  const shared = { protocols: [...protocols], contextWindow: 1000000, tools: true, reasoning: true,
    inputModalities: ['text', 'image'] };
  return [
    {
      ...shared,
      id: 'qwen3.7-plus',
      name: 'Qwen3.7-Plus',
      maxOutputTokens: 131072,
      aliases: ['千问 3.7 Plus'],
      description: '旗舰均衡多模态模型，1M 上下文 / 128K 输出，支持图片与视频输入、函数调用与结构化输出。',
      source: sourced(PAGES.qwen37Plus),
    },
    {
      ...shared,
      id: 'qwen3.6-plus',
      name: 'Qwen3.6-Plus',
      maxOutputTokens: 65536,
      aliases: ['千问 3.6 Plus'],
      description: '上一代 Plus 多模态模型，1M 上下文 / 64K 输出，支持图片与视频输入。',
      source: sourced(PAGES.qwen36Plus),
    },
  ];
}

const QWEN_CODING_MODELS = [
  ...qwenPlusModels(['chat']),
  {
    id: 'qwen3.5-plus',
    name: 'Qwen3.5-Plus',
    protocols: ['chat'],
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    aliases: ['千问 3.5 Plus'],
    description: 'Coding Plan 仍列出的更早版本，1M 上下文 / 64K 输出，支持图片与视频输入。',
    source: sourced(PAGES.qwen35Plus),
  },
];

const QWEN_API_MODELS = [
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8-Max',
    protocols: ['chat', 'responses'],
    contextWindow: 1000000,
    maxOutputTokens: 131072,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['none', 'low', 'medium', 'xhigh'],
    aliases: ['千问 3.8 Max'],
    description: '旗舰 2.4T MoE 模型，1M 上下文 / 128K 输出；思考档位为 none/low/medium/xhigh，high 与 max 会映射到 xhigh。',
    source: sourced(PAGES.qwen38Max),
  },
  ...qwenPlusModels(['chat', 'responses']),
];

const OPENAI_MODELS = [
  {
    id: 'gpt-6-astra',
    name: 'GPT-6 Astra',
    protocols: ['chat', 'responses'],
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    aliases: ['Astra'],
    description: '旗舰推理与编码模型；输入超过 272K tokens 的请求按官方规则按 2 倍输入价格计费。',
  },
  {
    id: 'gpt-6.1-sol',
    name: 'GPT-6.1 Sol',
    protocols: ['chat', 'responses'],
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    aliases: ['Sol'],
    description: '接近 Astra 的复杂任务能力，价格更低。',
  },
  {
    id: 'gpt-6.1-terra',
    name: 'GPT-6.1 Terra',
    protocols: ['chat', 'responses'],
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    aliases: ['Terra'],
    description: '偏视觉推理、计算机操作与写作的高效模型。',
  },
  {
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    protocols: ['chat', 'responses'],
    contextWindow: 1050000,
    maxOutputTokens: 128000,
    tools: true,
    reasoning: true,
    inputModalities: ['text', 'image'],
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    aliases: ['Luna'],
    description: '高吞吐、低成本模型。',
  },
];

const PRESETS = freeze([
  {
    id: 'kimi-code-cn',
    name: 'Kimi Code（国内）',
    kind: 'coding',
    baseURL: 'https://api.kimi.com/coding/v1',
    protocols: ['chat', 'responses'],
    models: KIMI_CODE_MODELS,
    source: sourced(PAGES.kimiModels),
    notes: [
      'Kimi Code 的 key 只在 Kimi Code 控制台创建，与 Moonshot 开放平台按量 key、网页会员互不通用。',
      'k3 的 1M 上下文只对 Allegretto / Pro 及以上套餐开放；Moderato / Plus 调用 k3 实际上限 262144，超出会返回 401。',
      'k3-256k 上下文固定 262144；kimi-for-coding-highspeed 需要 Allegretto / Pro 及以上套餐。',
      '官方要求第三方工具保留真实客户端标识，伪造 User-Agent 或客户端身份可能导致订阅权益被暂停。',
      'K3 系列与 K2.8 Preview 关闭 thinking 后由 K2.8 Preview 的无思考版处理。',
    ],
  },
  {
    id: 'kimi-code-global',
    name: 'Kimi Code（海外）',
    kind: 'coding',
    baseURL: 'https://api.kimi.ai/coding/v1',
    protocols: ['chat', 'responses'],
    models: KIMI_CODE_MODELS,
    source: sourced(PAGES.kimiOverview),
    notes: [
      '海外域名与国内域名的 key 各自独立，不能互相调用。',
      'k3 的 1M 上下文只对 Allegretto / Pro 及以上套餐开放；Moderato / Plus 调用 k3 实际上限 262144，超出会返回 401。',
      'k3-256k 上下文固定 262144；kimi-for-coding-highspeed 需要 Allegretto / Pro 及以上套餐。',
      '官方要求第三方工具保留真实客户端标识，伪造 User-Agent 或客户端身份可能导致订阅权益被暂停。',
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'api',
    baseURL: 'https://api.deepseek.com',
    protocols: ['chat', 'responses'],
    models: DEEPSEEK_MODELS,
    source: sourced(PAGES.deepseekModels),
    notes: [
      '官方 /models 返回 context_window、max_output_tokens、input_modalities、effort 与 api_capabilities 结构化元数据，导入后以实际响应为准。',
      'Responses 与 Chat Completions 都由官方文档声明支持；未列出的请求参数可能被静默忽略，需要按真实支持列表校验。',
      '截至核查日期只查到按量计费的 API，未查到可预设的编码订阅方案；这不等于官方不存在任何订阅产品。',
    ],
  },
  {
    id: 'zhipu-coding-cn-chat',
    name: '智谱 GLM Coding Plan（国内 · Chat）',
    kind: 'coding',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
    protocols: ['chat'],
    models: glmModels(['chat']),
    source: sourced(PAGES.glmCoding),
    notes: [
      'Coding Plan 的 chat 端点（/api/coding/paas/v4）与 responses 端点（/api/v1）是不同 Base URL，不能混用；用错端点无法扣减套餐额度。',
      'Coding Plan 只允许在官方支持的指定工具与产品环境中使用，超出范围可能被暂停或吊销；本目录不伪造客户端标识。',
      'Coding Plan 的 key 与标准 API 的 key 分开管理、互不通用。',
      '在 Claude Code（Anthropic 兼容）入口启用 1M 需要模型名后缀 [1m]，本目录使用 OpenAI 兼容端点，无需该后缀。',
    ],
  },
  {
    id: 'zhipu-coding-cn-responses',
    name: '智谱 GLM Coding Plan（国内 · Responses）',
    kind: 'coding',
    baseURL: 'https://open.bigmodel.cn/api/v1',
    protocols: ['responses'],
    models: glmModels(['responses']),
    source: sourced(PAGES.glmSwitching),
    notes: [
      '该 Base URL 只承载 OpenAI Responses 协议；chat 请求必须改用 /api/coding/paas/v4，混用无法扣减套餐额度。',
      'Coding Plan 只允许在官方支持的指定工具与产品环境中使用，超出范围可能被暂停或吊销；本目录不伪造客户端标识。',
      'Coding Plan 的 key 与标准 API 的 key 分开管理、互不通用。',
    ],
  },
  {
    id: 'zhipu-api-cn',
    name: '智谱开放平台（国内 · 按量）',
    kind: 'api',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    protocols: ['chat'],
    models: glmModels(['chat']),
    source: sourced(PAGES.glmApi),
    notes: [
      '按量计费使用标准 API Base URL 与标准 API key，与 Coding Plan 的端点和 key 都不通用。',
      '模型能力与上限取自智谱模型概览；未在该页声明的能力不写入目录。',
    ],
  },
  {
    id: 'zai-coding-global-chat',
    name: 'Z.AI GLM Coding Plan（海外 · Chat）',
    kind: 'coding',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    protocols: ['chat'],
    models: zaiModels(['chat']),
    source: sourced(PAGES.zaiCoding),
    notes: [
      'Coding Plan 的 chat 端点与 responses 端点（https://api.z.ai/api/v1）是不同 Base URL，不能混用。',
      'Coding Plan 只允许在官方支持的指定工具与产品环境中使用，超出范围可能被暂停或吊销；本目录不伪造客户端标识。',
      'z.ai 的 devpack 文档只公布了 glm-5.3 的 1M 上下文；其它模型是否在该套餐内未证实，因此未列入预设。',
    ],
  },
  {
    id: 'zai-coding-global-responses',
    name: 'Z.AI GLM Coding Plan（海外 · Responses）',
    kind: 'coding',
    baseURL: 'https://api.z.ai/api/v1',
    protocols: ['responses'],
    models: zaiModels(['responses']),
    source: sourced(PAGES.zaiCoding),
    notes: [
      '该 Base URL 是 Coding Plan 的 Responses 专用入口；chat 请求必须改用 https://api.z.ai/api/coding/paas/v4。',
      'Coding Plan 只允许在官方支持的指定工具与产品环境中使用，超出范围可能被暂停或吊销；本目录不伪造客户端标识。',
      'z.ai 的 devpack 文档只公布了 glm-5.3 的 1M 上下文；其它模型是否在该套餐内未证实，因此未列入预设。',
    ],
  },
  {
    id: 'zai-api-global',
    name: 'Z.AI 开放平台（海外 · 按量）',
    kind: 'api',
    baseURL: 'https://api.z.ai/api/paas/v4',
    protocols: ['chat'],
    models: zaiModels(['chat']),
    source: sourced(PAGES.zaiCoding),
    notes: [
      '按量计费使用标准 API Base URL 与标准 API key，与 Coding Plan 的端点和 key 都不通用。',
      '模型能力与上限取自智谱模型概览，端点取自 z.ai 开发文档。',
    ],
  },
  {
    id: 'qwen-coding',
    name: '千问 Coding Plan（百炼）',
    kind: 'coding',
    baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    protocols: ['chat'],
    models: QWEN_CODING_MODELS,
    source: sourced(PAGES.qwenCoding),
    notes: [
      'Coding Plan 必须使用 sk-sp- 开头的套餐专用 key 与该专用 Base URL；和按量 key（sk-）或按量 Base URL 混用会按量额外计费。',
      '官方条款只允许在受支持的交互式编程工具中使用，禁止自动化脚本、应用后端等非交互场景，也禁止账号共享。',
      '仅预置官方列出的确切模型版本；Anthropic 兼容入口 https://coding.dashscope.aliyuncs.com/apps/anthropic 不在本目录的 chat/responses 范围内。',
    ],
  },
  {
    id: 'qwen-api',
    name: '千问百炼（按量）',
    kind: 'api',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocols: ['chat', 'responses'],
    models: QWEN_API_MODELS,
    source: sourced(PAGES.qwenResponses),
    notes: [
      '按量计费使用 sk- key；API key 与地域绑定，跨地域调用会返回 401。',
      '官方推荐改用业务空间专属域名 https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1；此处保留仍可用的旧域名 dashscope.aliyuncs.com。',
      'Responses 与 Chat Completions 都支持流式；各模型 reasoning 档位不同，未列出的档位不能假定可用。',
      '官方兼容性文档同时说明：未列入 Responses 支持列表的模型只保证基础兼容，Agent 能力有限。',
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'api',
    baseURL: 'https://api.openai.com/v1',
    protocols: ['chat', 'responses'],
    models: OPENAI_MODELS,
    source: sourced(PAGES.openaiModels),
    notes: [
      '按量计费：按官方模型页公布的每百万 tokens 单价结算。',
      '模型 ID 与上限取自官方模型页当前展示的 GPT-6 系列；未在该页声明的能力不写入目录。',
      '输入超过 272K tokens 的请求按官方价格规则加收费用（2 倍输入、1.5 倍输出）。',
    ],
  },
]);

const PRESET_BY_ID = new Map(PRESETS.map(entry => [entry.id, entry]));

export function providerPresets() {
  return clone(PRESETS);
}
// Matching normalizes case, separators and missing spaces, then ranks whole
// candidates in four tiers. It returns the caller's own model objects, so an
// autocomplete cannot silently rewrite the upstream id the user chose.
const normalizeKey = value => typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  : '';

function searchableLabels(model) {
  const labels = [];
  const name = normalizeKey(typeof model.name === 'string' ? model.name : '');
  if (name) labels.push(name);
  if (Array.isArray(model.aliases)) {
    for (const alias of model.aliases.slice(0, LIMITS.aliases * 2)) {
      const key = normalizeKey(alias);
      if (key && !labels.includes(key)) labels.push(key);
    }
  }
  return labels;
}

function boundedDistance(left, right, limit) {
  if (left.length === right.length && left.every((value, index) => value === right[index])) return 0;
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = new Array(right.length + 1);
  for (let row = 1; row <= left.length; row++) {
    current[0] = row;
    let best = row;
    for (let column = 1; column <= right.length; column++) {
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1));
      if (current[column] < best) best = current[column];
    }
    if (best > limit) return limit + 1;
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function fuzzyScore(key, labels) {
  const points = [...key];
  if (points.length < 3) return Infinity;
  const query = points.slice(0, LIMITS.fuzzyQuery);
  const limit = Math.max(1, Math.min(4, Math.ceil(query.length / 3)));
  let best = Infinity;
  for (const target of labels) {
    if (!target) continue;
    if (target.includes(key)) {
      const gap = Math.max(0, [...target].length - query.length);
      best = Math.min(best, 0.5 + Math.min(1, gap / 1000));
      continue;
    }
    const candidate = [...target].slice(0, LIMITS.fuzzyTarget);
    const distance = boundedDistance(query, candidate, limit);
    if (distance > limit) continue;
    best = Math.min(best, 1 + distance + Math.abs(candidate.length - query.length) / 1000);
  }
  return best;
}

function matchModel(model, key) {
  if (!isPlain(model)) return null;
  const idKey = normalizeKey(typeof model.id === 'string' ? model.id : '');
  if (!idKey) return null;
  if (idKey === key) return { tier: 0, score: 0 };
  const labels = searchableLabels(model);
  if (labels.some(value => value === key)) return { tier: 1, score: 0 };
  if (key.length >= 2 && (idKey.startsWith(key) || labels.some(value => value.startsWith(key)))) {
    return { tier: 2, score: 0 };
  }
  const score = fuzzyScore(key, [idKey, ...labels]);
  return score === Infinity ? null : { tier: 3, score };
}

function boundedLimit(value) {
  if (!Number.isSafeInteger(value)) return LIMITS.defaultLimit;
  if (value < 0) return LIMITS.defaultLimit;
  return Math.min(value, LIMITS.limit);
}

export function searchModels(models, query, options = {}) {
  const settings = isPlain(options) ? options : {};
  if (!Array.isArray(models) || typeof query !== 'string') return [];
  const text = query.trim();
  if (!text || text.length > LIMITS.query) return [];
  const key = normalizeKey(text);
  if (!key) return [];
  const ranked = [];
  models.slice(0, LIMITS.candidates).forEach((model, index) => {
    const match = matchModel(model, key);
    if (match) ranked.push({ model, index, tier: match.tier, score: match.score });
  });
  ranked.sort((left, right) => left.tier - right.tier || left.score - right.score || left.index - right.index);
  return ranked.slice(0, boundedLimit(settings.limit)).map(entry => entry.model);
}

// Discovery accepts the OpenAI-style `{ data: [...] }` envelope, a `{ models:
// [...] }` envelope or a bare array. Anything else yields an empty catalog
// instead of throwing, and every field is validated before it is kept: an
// unreadable capability stays undefined rather than becoming `false`.

// A vendor section is a positive statement only when it says so. DeepSeek
// documents `api_capabilities` as one object per supported protocol with no
// negative form, so a section object without a negation counts as support
// (`yes`); `true` counts as support too. `false`, `null` and `supported: false`
// are explicit refusals (`no`). Every other type — a bare string, a number, an
// array, `supported: null` — is mentioned but unreadable (`unreadable`): it is
// not support, and it must not be quietly replaced by the preset either.
function capabilityVerdict(value) {
  if (value === true) return 'yes';
  if (value === false || value === null) return 'no';
  if (!isPlain(value)) return 'unreadable';
  if (value.supported === false || value.supported === null) return 'no';
  if (value.supported !== undefined && typeof value.supported !== 'boolean') return 'unreadable';
  return 'yes';
}

const protocolName = name => name === 'responses' ? 'responses'
  : name === 'chat' || name === 'chat_completions' || name === 'completions' ? 'chat' : '';

// `declared` counts protocol-level statements the vendor actually made: an
// affirmation, a refusal, or a section that was mentioned but unreadable. An
// empty `protocols: []` array, an empty `api_capabilities: {}` object, or one
// holding only unrelated keys makes no such statement at all, which is an
// explicit declaration of an empty set and is different from the field being
// missing entirely: only the missing field may fall back to the preset.
function discoveryProtocols(row) {
  const status = { chat: 'absent', responses: 'absent' };
  const affirm = protocol => { if (status[protocol] !== 'no') status[protocol] = 'yes'; };
  const deny = protocol => { status[protocol] = 'no'; };
  let declared = 0;
  let stated = false;
  if (Array.isArray(row.protocols)) {
    stated = true;
    for (const value of row.protocols.slice(0, 8)) {
      if (!PROTOCOLS.includes(value)) continue;
      declared++;
      affirm(value);
    }
  }
  if (isPlain(row.api_capabilities)) {
    stated = true;
    for (const name of Object.keys(row.api_capabilities).slice(0, 32)) {
      const protocol = protocolName(name);
      if (!protocol) continue;
      declared++;
      const verdict = capabilityVerdict(row.api_capabilities[name]);
      if (verdict === 'yes') affirm(protocol);
      else if (verdict === 'no') deny(protocol);
      else if (status[protocol] === 'absent') status[protocol] = 'unreadable';
    }
  }
  return { status, declared, stated };
}

// Protocols are only ever narrowed. A vendor affirmation is authoritative and a
// preset may cut it down, but never back up: if the two share nothing, the
// vendor is saying this endpoint does not serve the preset's protocols, so the
// answer is an empty list rather than the preset's list. A protocol the vendor
// mentioned but did not confirm stays unknown and is not filled in from the
// preset. Only a protocol the vendor never mentioned at all can fall back to
// the preset's static list, and only when the vendor declared nothing anywhere:
// a field that is present but states no protocol is an explicit empty set, not
// an invitation to reuse the preset. With neither, nothing is known and nothing
// is claimed: an empty list keeps the id and leaves the choice to the user
// instead of assuming chat.
function protocolsFor(row, preset) {
  const presetProtocols = preset?.protocols ?? [];
  const { status, declared, stated } = discoveryProtocols(row);
  if (stated && !declared) return [];
  const affirmative = PROTOCOLS.filter(protocol => status[protocol] === 'yes');
  if (affirmative.length) {
    const allowed = presetProtocols.length
      ? presetProtocols.filter(protocol => affirmative.includes(protocol))
      : affirmative;
    return PROTOCOLS.filter(protocol => allowed.includes(protocol));
  }
  if (!presetProtocols.length) return [];
  return PROTOCOLS.filter(protocol => presetProtocols.includes(protocol) && status[protocol] === 'absent');
}

function modalitiesOf(row) {
  const values = Array.isArray(row.input_modalities) ? row.input_modalities
    : Array.isArray(row.inputModalities) ? row.inputModalities
      : Array.isArray(row.modalities?.input) ? row.modalities.input : [];
  const result = [];
  for (const value of values.slice(0, 8)) {
    if (typeof value === 'string' && MODALITIES.includes(value) && !result.includes(value)) result.push(value);
  }
  return result;
}

function effortsOf(row) {
  const values = Array.isArray(row.effort?.supported_levels) ? row.effort.supported_levels
    : Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts
      : Array.isArray(row.reasoningEfforts) ? row.reasoningEfforts : [];
  const result = [];
  for (const value of values.slice(0, LIMITS.efforts * 2)) {
    if (typeof value === 'string' && EFFORT.test(value) && !result.includes(value)) result.push(value);
    if (result.length >= LIMITS.efforts) break;
  }
  return result;
}

function aliasesOf(row, id) {
  if (!Array.isArray(row.aliases)) return [];
  const result = [];
  for (const value of row.aliases.slice(0, LIMITS.aliases * 2)) {
    const alias = label(value, LIMITS.alias);
    if (alias && alias !== id && !result.includes(alias)) result.push(alias);
    if (result.length >= LIMITS.aliases) break;
  }
  return result;
}

function sourceURL(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    const authority = url.href.slice(url.protocol.length + 2).split(/[/?#]/, 1)[0];
    return url.protocol === 'https:' && !authority.includes('@') ? url.href : undefined;
  } catch { return undefined; }
}

function provenance(date, url) {
  const checkedAt = typeof date === 'string' && DATE.test(date) ? date : new Date().toISOString().slice(0, 10);
  return url ? { url, checkedAt } : { checkedAt };
}

function readModel(row, preset, source) {
  if (!isPlain(row)) return null;
  const id = identifier(row.id);
  if (!id) return null;
  const model = { id, protocols: protocolsFor(row, preset) };
  const name = label(row.name, LIMITS.name) ?? label(row.display_name, LIMITS.name);
  if (name && name !== id) model.name = name;
  const contextWindow = boundedInteger(firstDefined(row.context_window, row.contextWindow, row.context_length),
    LIMITS.context);
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  const maxOutputTokens = boundedInteger(firstDefined(row.max_output_tokens, row.maxOutputTokens), LIMITS.output);
  if (maxOutputTokens !== undefined && (contextWindow === undefined || maxOutputTokens <= contextWindow)) {
    model.maxOutputTokens = maxOutputTokens;
  }
  const tools = flag(row, 'tools', 'supports_tools');
  if (tools !== undefined) model.tools = tools;
  const reasoning = flag(row, 'reasoning', 'supports_reasoning');
  if (reasoning !== undefined) model.reasoning = reasoning;
  const modalities = modalitiesOf(row);
  if (modalities.length) model.inputModalities = modalities;
  const efforts = effortsOf(row);
  if (efforts.length) model.reasoningEfforts = efforts;
  const aliases = aliasesOf(row, id);
  if (aliases.length) model.aliases = aliases;
  const description = label(row.description, LIMITS.description);
  if (description) model.description = description;
  model.source = source;
  return model;
}

function entriesOf(payload) {
  if (Array.isArray(payload)) return payload.slice(0, LIMITS.entries);
  if (!isPlain(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data.slice(0, LIMITS.entries);
  if (Array.isArray(payload.models)) return payload.models.slice(0, LIMITS.entries);
  return [];
}

export function parseDiscoveredModels(payload, options = {}) {
  const settings = isPlain(options) ? options : {};
  const preset = typeof settings.presetId === 'string' ? PRESET_BY_ID.get(settings.presetId) : undefined;
  const source = provenance(settings.checkedAt, sourceURL(settings.url));
  const models = [];
  const seen = new Set();
  for (const row of entriesOf(payload)) {
    if (models.length >= LIMITS.models) break;
    const model = readModel(row, preset, source);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

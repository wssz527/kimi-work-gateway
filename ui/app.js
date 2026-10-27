/* ============================================================
   Kimi Work 网关控制面板 — 交互
   契约：GET /api/state, POST /api/subagents, POST /api/actions
   密钥只存在于 sessionStorage 与请求头，绝不进入 DOM。
   ============================================================ */

const API = {
  state: '/api/state',
  subagents: '/api/subagents',
  actions: '/api/actions',
};

const POLL_MS = 2000;
const KEY_STORE = 'kwg.panel.key';
const THEME_STORE = 'kwg.panel.theme';

const WAVE_CLASSES = ['wave-0', 'wave-1', 'wave-2', 'wave-3', 'wave-4', 'wave-5', 'wave-6'];

const ACTION_LABEL = {
  'prepare-runtime': '准备副本',
  'launch-kimi': '启动 Kimi',
  'prepare-native': '准备原生设置',
  'remove-dns': '撤销 DNS 映射',
  'copy-token': '复制 Token',
};

const ACTION_STATE = {
  running: '进行中',
  prepared: '已准备',
  starting: '启动请求已发出',
  'waiting-kimi-exit': '等待 Kimi 退出',
  done: '已完成',
  copied: '已复制',
  unavailable: '不可用',
  failed: '失败',
  interrupted: '已中断',
};

const CONFIG_STATE = {
  ready: { form: 'solid', word: '就绪' },
  changed: { form: 'doubled', word: '已变更' },
  unavailable: { form: 'struck', word: '不可用' },
};

const RUNTIME_STATE = {
  'not-prepared': { form: 'dashed', word: '待准备', note: '还没有本机运行时副本。' },
  'waiting-launch': { form: 'dashed', word: '待启动', note: '副本已准备，等待 Kimi 用该副本启动。' },
  'pending-policy': { form: 'half', word: '待采用', note: '运行时尚未加载到当前策略。' },
  loaded: { form: 'capped', word: '已加载', note: '运行时已加载策略。' },
  'heartbeat-stale': { form: 'half', word: '心跳过期', note: '运行时曾加载策略，但心跳已过期或未及时更新。' },
  'policy-unavailable': { form: 'struck', word: '策略不可用', note: '运行时无法读取策略，子代理请求会被拒绝。' },
  unavailable: { form: 'struck', word: '不可用', note: '运行时当前不可用。' },
  outdated: { form: 'half', word: '版本过旧', note: '运行时版本与当前内核不一致。' },
  conflict: { form: 'conflict', word: '冲突', note: '运行时与配置存在冲突，未被覆盖。' },
};

const $ = (id) => document.getElementById(id);

const dom = {
  shell: $('shell'),
  gate: $('gate'),
  gateTitle: $('gate-title'),
  gateLede: $('gate-lede'),
  gateNote: $('gate-note'),
  gateActions: $('gate-actions'),
  gateRetry: $('gate-retry'),

  conn: $('conn'),
  connText: $('conn-text'),
  connRetry: $('conn-retry'),

  rev: $('rev'),
  sync: $('sync'),

  savedValue: $('saved-value'),
  savedSub: $('saved-sub'),
  adoptedValue: $('adopted-value'),
  adoptedSub: $('adopted-sub'),
  verdict: $('verdict'),
  verdictWord: $('verdict-word'),
  verdictNote: $('verdict-note'),

  bandSvg: $('band-svg'),
  bandAxis: $('band-axis'),
  bandReadouts: $('band-readouts'),

  modes: $('modes'),
  effort: $('effort'),
  effortOptions: $('effort-options'),
  effortHint: $('effort-hint'),

  q: $('q'),
  qClear: $('q-clear'),
  onlyTools: $('only-tools'),
  count: $('count'),
  modelList: $('model-list'),
  modelsEmpty: $('models-empty'),
  emptyTitle: $('empty-title'),
  emptyNote: $('empty-note'),
  emptyReset: $('empty-reset'),

  draftState: $('draft-state'),
  draftDetail: $('draft-detail'),
  btnApply: $('btn-apply'),
  btnApplyLabel: $('btn-apply-label'),
  btnInherit: $('btn-inherit'),
  btnReset: $('btn-reset'),

  rtState: $('rt-state'),
  rtVersion: $('rt-version'),
  rtMode: $('rt-mode'),
  rtAlias: $('rt-alias'),
  rtSpawn: $('rt-spawn'),
  rtReason: $('rt-reason'),

  op: $('op'),
  opName: $('op-name'),
  opNote: $('op-note'),

  native: $('native'),
  nativeBadge: $('native-badge'),
  nativePassed: $('native-passed'),
  nativeAddress: $('native-address'),
  nativeError: $('native-error'),

  railGwLine: $('r-gw-line'),
  railGwState: $('r-gw-state'),
  railGwUrl: $('r-gw-url'),
  railGwModels: $('r-gw-models'),
  railGwActive: $('r-gw-active'),
  railCfgLine: $('r-cfg-line'),
  railCfgState: $('r-cfg-state'),
  railCfgFile: $('r-cfg-file'),
  railCfgNote: $('r-cfg-note'),
  railRtLine: $('r-rt-line'),
  railRtState: $('r-rt-state'),
  railRtVersion: $('r-rt-version'),
  railRtMode: $('r-rt-mode'),
  railSync: $('r-sync'),
  theme: $('theme'),

  toast: $('toast'),
};

const state = {
  key: null,
  data: null,
  draft: null,
  dirty: false,
  query: '',
  onlyTools: false,
  reachable: null,
  submitting: false,
  pendingAction: null,
  lastSync: null,
  timer: null,
  toastTimer: null,
  started: false,
  locked: false,
};

/* ---------- key handling ---------- */

function readKey() {
  let key = null;
  const raw = window.location.hash || '';
  if (raw.length > 1) {
    const params = new URLSearchParams(raw.slice(1));
    key = params.get('key');
  }
  if (key) {
    try {
      sessionStorage.setItem(KEY_STORE, key);
    } catch {
      /* 无存储时仍然允许本次会话使用内存密钥 */
    }
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return key;
  }
  try {
    return sessionStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

function clearKey() {
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    /* 忽略 */
  }
  state.key = null;
}

/* ---------- api ---------- */

const ERROR_HINT = {
  configuration_conflict: '配置在别处被修改，已刷新状态，请确认后重新应用。',
  configuration_changed: '模型或连接配置已在外部修改，请重启面板后操作。',
  configuration_unavailable: '无法读取配置文件，请检查文件后重启面板。',
  subagent_policy_owner_conflict: '另一实例已接管子代理策略，请停止重复运行的服务。',
  subagent_policy_apply_failed: '选择已保存，但当前策略未能应用。请查看运行时状态。',
  subagent_policy_unavailable: '无法读取当前子代理策略，请检查状态目录后重启面板。',
  subagent_model_unavailable: '所选模型已不在当前目录中，请重新选择。',
  subagent_model_tools_required: '此模型不支持工具调用，无法用作子代理。',
  invalid_subagent_effort: '此模型不支持所选推理档位，请重新选择。',
  invalid_subagent_policy: '提交的目标格式不被接受，请重新选择。',
  panel_action_busy: '上一次操作仍在执行，请等待结果。',
  panel_action_conflict: '操作标识已被使用，请重试。',
  panel_action_limit: '短时间内操作过多，请稍后再试。',
  panel_receipt_conflict: '操作记录有冲突，请检查状态目录。',
  panel_stopping: '面板正在停止。',
  origin_refused: '请求来源不匹配，请从本机面板链接操作。',
  json_required: '请求格式不被接受。',
};

class ApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  if (!state.key) throw new ApiError('缺少面板会话密钥', 'NO_KEY', 0);

  const headers = { Authorization: 'Bearer ' + state.key };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
  } catch {
    throw new ApiError('无法连接本机面板服务', 'NETWORK', 0);
  }

  if (res.status === 401) {
    throw new ApiError('面板会话密钥无效或已过期', 'unauthorized', 401);
  }

  let payload = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const code = payload && payload.error && payload.error.code;
    const message = payload && payload.error && payload.error.message;
    throw new ApiError(
      ERROR_HINT[code] || message || '请求失败（HTTP ' + res.status + '）',
      code || 'http_' + res.status,
      res.status
    );
  }

  return payload;
}

/* ---------- theme ---------- */

function applyTheme(value) {
  const mode = value === 'light' || value === 'dark' ? value : 'auto';
  document.documentElement.dataset.theme = mode;
  dom.theme.value = mode;
  try {
    localStorage.setItem(THEME_STORE, mode);
  } catch {
    /* 忽略 */
  }
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORE);
  } catch {
    stored = null;
  }
  applyTheme(stored || 'auto');
}

/* ---------- formatting ---------- */

function fmtCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

function fmtContext(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000) return (n / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 'K';
  return String(n);
}

function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000) return (n / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + 'K';
  return String(n);
}

function fmtTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (v) => String(v).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function shortRev(rev) {
  if (typeof rev !== 'string' || !rev) return '未提供';
  return rev.slice(0, 8);
}

function truncate(value, max) {
  if (typeof value !== 'string') return '—';
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function modelLabel(model, alias) {
  if (!model) return typeof alias === 'string' && alias ? alias : '—';
  if (model.name && model.name !== model.id) return model.name;
  return model.id;
}

/* ---------- model index ---------- */

function modelIndex() {
  const map = new Map();
  const list = state.data && Array.isArray(state.data.models) ? state.data.models : [];
  list.forEach((m, i) => {
    if (m && typeof m.id === 'string') map.set(m.id, { model: m, index: i });
  });
  return map;
}

function findModel(id) {
  if (typeof id !== 'string' || !id) return null;
  const entry = modelIndex().get(id);
  return entry ? entry.model : null;
}

/* 运行时策略里的 modelAlias 是服务端生成的 <prefix><modelId>，
   prefix 只有两种已知值，modelId 本身可能含 '/'（如 group/glm-5-3-flash）。
   只剥离已知完整前缀，然后按完整 id 精确查目录；不做末段模糊匹配。 */
const MODEL_ALIAS_PREFIXES = ['byok-kth-kimi/', 'byok-kth-resp/'];

function modelIdFromAlias(alias) {
  if (typeof alias !== 'string' || !alias) return null;
  const index = modelIndex();
  if (index.has(alias)) return alias;
  for (const prefix of MODEL_ALIAS_PREFIXES) {
    if (alias.startsWith(prefix)) {
      const rest = alias.slice(prefix.length);
      if (index.has(rest)) return rest;
    }
  }
  return null;
}

function waveClassFor(id) {
  const entry = modelIndex().get(id);
  if (!entry) return '';
  const total = (state.data.models || []).length || 1;
  const bucket = Math.min(6, Math.floor((entry.index / total) * 7));
  return WAVE_CLASSES[bucket];
}

function isSubagentCapable(model) {
  return Boolean(model && model.tools === true);
}

/* ---------- draft ---------- */

function savedTarget(data) {
  const configured = data && data.subagents && data.subagents.configured;
  const mode = configured && configured.mode === 'force' ? 'force' : 'inherit';
  return {
    mode,
    model:
      mode === 'force'
        ? typeof configured.model === 'string' && configured.model
          ? configured.model
          : typeof configured.modelAlias === 'string' && configured.modelAlias
            ? configured.modelAlias
            : null
        : null,
    effort: mode === 'force' && typeof configured.effort === 'string' ? configured.effort : null,
  };
}

function draftFromSaved(data) {
  const saved = savedTarget(data);
  return { mode: saved.mode, model: saved.model, effort: saved.effort };
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  if (a.mode === 'inherit') return true;
  return (a.model || null) === (b.model || null) && (a.effort || null) === (b.effort || null);
}

function recomputeDirty() {
  const saved = state.data ? savedTarget(state.data) : null;
  state.dirty = Boolean(state.data) && !sameTarget(state.draft, saved);
}

/* ---------- verdict ---------- */

function evaluateBinding(data) {
  if (!data) {
    return { form: 'half', word: '读取中', note: '' };
  }
  const saved = savedTarget(data);
  const runtime = (data.subagents && data.subagents.runtime) || {};
  const policy = (data.subagents && data.subagents.policy) || {};
  const config = data.configuration || {};

  if (config.state !== 'ready') {
    const label = CONFIG_STATE[config.state] ? CONFIG_STATE[config.state].word : '异常';
    return {
      form: 'struck',
      word: '配置' + label,
      note: '配置文件当前不可用，保存已禁用。',
    };
  }

  const rState = typeof runtime.state === 'string' ? runtime.state : 'unavailable';
  const info = RUNTIME_STATE[rState] || { form: 'half', word: rState, note: '' };

  if (rState === 'conflict') {
    return { form: 'conflict', word: '策略冲突', note: runtime.reason || '运行时策略与保存目标不一致。' };
  }

  if (saved.mode === 'inherit') {
    const runtimeInherit = runtime.mode === 'inherit';
    if (rState === 'loaded' && policy.mode === 'inherit' && runtimeInherit) {
      return { form: 'solid', word: '继承已生效', note: '运行时以继承模式加载，跟随主模型。' };
    }
    if (rState === 'loaded' && (policy.mode === 'force' || runtime.mode === 'force')) {
      return {
        form: 'conflict',
        word: '未恢复继承',
        note: '运行时仍在使用固定模型，重新应用后由新的子代理会话采用。',
      };
    }
    if (policy.mode === 'blocked') {
      return { form: 'struck', word: '子代理被阻止', note: policy.reason || '运行时策略禁止子代理。' };
    }
    return { form: info.form, word: info.word, note: info.note };
  }

  if (policy.mode === 'blocked') {
    return { form: 'struck', word: '子代理被阻止', note: policy.reason || '运行时策略禁止子代理。' };
  }

  if (rState === 'loaded') {
    const adoptedId = modelIdFromAlias(runtime.modelAlias);
    const policyId =
      typeof policy.model === 'string' && policy.model ? policy.model : modelIdFromAlias(policy.modelAlias);

    /* 「已生效」要求三处同时成立：运行时加载、运行时模式与策略模式都是 force、
       观测到的完整模型 id 同时等于策略模型与已保存目标、且推理档位一致。 */
    const effortOf = (v) => (typeof v === 'string' && v ? v : null);
    const modeAgrees = runtime.mode === 'force' && policy.mode === 'force';
    const modelAgrees = adoptedId !== null && adoptedId === policyId && policyId === saved.model;
    const effortAgrees = effortOf(policy.effort) === effortOf(saved.effort);

    if (modeAgrees && modelAgrees && effortAgrees) {
      return { form: 'capped', word: '已生效', note: '运行时已加载固定模型与档位，与保存目标一致。' };
    }
    if (modelAgrees && !effortAgrees) {
      return {
        form: 'conflict',
        word: '档位不一致',
        note: '运行时的推理档位与保存目标不同，重新应用后由新的子代理会话采用。',
      };
    }
    return {
      form: 'half',
      word: '待采用',
      note: '运行时加载的模型或模式与保存目标不同，重新应用后由新的子代理会话采用。',
    };
  }

  return { form: info.form, word: info.word, note: info.note };
}

/* ---------- rendering: rail ---------- */

function setForm(el, form) {
  if (!el) return;
  el.dataset.form = form;
  const use = el.querySelector('.statemark use');
  if (use) use.setAttribute('href', '#m-' + form);
}

function renderRail(data) {
  const gw = (data && data.gateway) || {};
  const config = (data && data.configuration) || {};
  const runtime = (data && data.subagents && data.subagents.runtime) || {};

  const gwUp = gw.state === 'running';
  setForm(dom.railGwLine, gwUp ? 'solid' : 'struck');
  dom.railGwState.textContent = gwUp ? '运行中' : '已停止';
  dom.railGwUrl.textContent = typeof gw.url === 'string' && gw.url ? gw.url : '—';
  dom.railGwModels.textContent = typeof gw.modelCount === 'number' ? fmtCount(gw.modelCount) : '—';
  dom.railGwActive.textContent = typeof gw.activeRequests === 'number' ? fmtCount(gw.activeRequests) : '—';

  const cfgInfo = CONFIG_STATE[config.state] || { form: 'half', word: '未知' };
  setForm(dom.railCfgLine, cfgInfo.form);
  dom.railCfgState.textContent = cfgInfo.word;
  dom.railCfgFile.textContent = typeof config.file === 'string' && config.file ? config.file : '—';
  if (config.state === 'ready') {
    dom.railCfgNote.hidden = true;
    dom.railCfgNote.textContent = '';
  } else {
    dom.railCfgNote.hidden = false;
    dom.railCfgNote.dataset.tone = 'warn';
    dom.railCfgNote.textContent =
      config.state === 'changed'
        ? '配置文件已变化，保存已禁用。重启面板以载入新配置。'
        : '配置文件不可读，保存已禁用。修正后重启面板。';
  }

  const rInfo = RUNTIME_STATE[runtime.state] || { form: 'half', word: '未知' };
  setForm(dom.railRtLine, rInfo.form);
  dom.railRtState.textContent = rInfo.word;
  dom.railRtVersion.textContent = typeof runtime.version === 'string' && runtime.version ? runtime.version : '—';
  dom.railRtMode.textContent = typeof runtime.mode === 'string' && runtime.mode ? runtime.mode : '—';

  dom.rev.textContent = shortRev(data && data.revision);
  dom.railSync.textContent = state.lastSync
    ? '最近同步 ' + fmtTime(state.lastSync) + ' · 每 ' + POLL_MS / 1000 + ' 秒'
    : '尚未同步';
}

/* ---------- rendering: binding ---------- */

function renderBinding(data) {
  const saved = savedTarget(data);
  const runtime = (data.subagents && data.subagents.runtime) || {};
  const policy = (data.subagents && data.subagents.policy) || {};

  /* 已保存：配置文件里写下的目标 */
  const savedModel = saved.mode === 'force' ? findModel(saved.model) : null;
  dom.savedValue.textContent =
    saved.mode === 'inherit' ? '继承主模型' : saved.model ? modelLabel(savedModel, saved.model) : '未选择';

  const savedParts = [];
  if (saved.mode === 'force') {
    if (saved.model) savedParts.push(saved.model);
    savedParts.push(saved.effort ? '档位 ' + saved.effort : '档位自动');
  } else {
    savedParts.push('不固定模型');
  }
  dom.savedSub.textContent = savedParts.join(' · ');

  /* 实际采用：只陈述运行时此刻观测到的策略；未加载时如实说未加载，
     并把已写入的策略作为「待采用」附在后面。 */
  const loaded = runtime.state === 'loaded';
  const observedAlias = loaded && typeof runtime.modelAlias === 'string' ? runtime.modelAlias : null;
  const observedId = modelIdFromAlias(observedAlias);
  const observedModel = observedId ? findModel(observedId) : null;
  const observedMode = loaded && typeof runtime.mode === 'string' ? runtime.mode : null;

  const pendingAlias = modelIdFromAlias(policy.modelAlias);
  const pendingLabel =
    policy.mode === 'blocked'
      ? '已阻止'
      : policy.mode === 'inherit'
        ? '继承主模型'
        : pendingAlias
          ? modelLabel(findModel(pendingAlias), pendingAlias)
          : typeof policy.modelAlias === 'string' && policy.modelAlias
            ? '未匹配模型'
            : '未写入模型';

  let adoptedLabel;
  if (policy.mode === 'blocked') {
    adoptedLabel = '已阻止';
  } else if (loaded) {
    adoptedLabel = observedMode === 'inherit' ? '继承主模型' : observedId ? modelLabel(observedModel, observedId) : '未固定模型';
  } else {
    adoptedLabel = '尚未加载';
  }
  dom.adoptedValue.textContent = adoptedLabel;
  dom.adoptedValue.dataset.live = loaded && observedMode === 'force' && observedId ? 'true' : 'false';

  const adoptedParts = [];
  if (loaded) {
    if (observedMode) adoptedParts.push('模式 ' + observedMode);
    if (observedAlias) adoptedParts.push(observedAlias);
    if (typeof runtime.version === 'string' && runtime.version) adoptedParts.push('v' + runtime.version);
  } else {
    adoptedParts.push('策略已写入：' + pendingLabel);
    if (typeof policy.effort === 'string' && policy.effort) adoptedParts.push('档位 ' + policy.effort);
    if (typeof policy.reason === 'string' && policy.reason) adoptedParts.push(policy.reason);
  }
  dom.adoptedSub.textContent = adoptedParts.join(' · ');

  const verdict = evaluateBinding(data);
  dom.verdict.dataset.form = verdict.form;
  dom.verdictWord.textContent = verdict.word;
  dom.verdictNote.textContent = verdict.note;
}

/* ---------- rendering: calibration band ---------- */

const NS = 'http://www.w3.org/2000/svg';
const BAND = { h: 78, top: 30, bottom: 26 };
function bandX(contextWindow, max) {
  if (!max || max <= 0) return null;
  const ratio = Math.max(0, Math.min(1, contextWindow / max));
  return BAND.left + ratio * (BAND.right - BAND.left);
}

function svgEl(name, attrs) {
  const el = document.createElementNS(NS, name);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  }
  return el;
}

function renderBand(data) {
  if (!data) return;
  const models = Array.isArray(data.models) ? data.models : [];
  const svg = dom.bandSvg;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const maxCtx = models.reduce((acc, m) => {
    return typeof m.contextWindow === 'number' && m.contextWindow > acc ? m.contextWindow : acc;
  }, 0);

  if (!maxCtx) {
    dom.bandAxis.replaceChildren();
    renderReadouts(null, null, null, null);
    return;
  }

  const W = 1000;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + BAND.h);
  svg.setAttribute('preserveAspectRatio', 'none');

  const xOf = (ctx) => (Math.max(0, Math.min(1, ctx / maxCtx)) * W);

  svg.appendChild(
    svgEl('line', {
      x1: 0, y1: BAND.top, x2: W, y2: BAND.top,
      class: 'bw-edge',
    })
  );
  svg.appendChild(
    svgEl('line', {
      x1: 0, y1: BAND.h - BAND.bottom, x2: W, y2: BAND.h - BAND.bottom,
      class: 'bw-edge',
    })
  );

  const saved = savedTarget(data);
  const runtime = (data.subagents && data.subagents.runtime) || {};
  const draftModelId = state.draft && state.draft.mode === 'force' ? state.draft.model : null;
  const adoptedId = runtime.state === 'loaded' ? modelIdFromAlias(runtime.modelAlias) : null;

  const marks = new Map();

  models.forEach((m) => {
    if (!m || typeof m.id !== 'string') return;
    const ctx = typeof m.contextWindow === 'number' ? m.contextWindow : 0;
    if (!ctx) return;
    const x = xOf(ctx);
    const capable = m.tools === true;
    const tick = svgEl('line', {
      x1: x, y1: BAND.top + 4, x2: x, y2: BAND.h - BAND.bottom - 4,
      class: 'bw-tick',
    });
    const entry = modelIndex().get(m.id);
    const bucket = Math.min(6, Math.floor(((entry ? entry.index : 0) / (models.length || 1)) * 7));
    tick.classList.add(WAVE_CLASSES[bucket]);
    if (!capable) tick.setAttribute('opacity', '0.28');
    svg.appendChild(tick);
    marks.set(m.id, x);
  });

  const marker = (x, cls, kind) => {
    if (x === null || x === undefined) return;
    const g = svgEl('g', { class: cls });
    if (kind === 'saved') {
      g.appendChild(svgEl('line', { x1: x, y1: 10, x2: x, y2: BAND.h - 8, class: 'bw-saved-1' }));
      g.appendChild(svgEl('line', { x1: x + 3, y1: 10, x2: x + 3, y2: BAND.h - 8, class: 'bw-saved-2' }));
      g.appendChild(svgEl('line', { x1: x - 5, y1: 8, x2: x + 8, y2: 8, class: 'bw-saved-cap' }));
    } else if (kind === 'draft') {
      g.appendChild(
        svgEl('line', {
          x1: x, y1: 10, x2: x, y2: BAND.h - 8,
          class: 'bw-draft',
          'stroke-dasharray': '4 4',
        })
      );
    } else {
      g.appendChild(svgEl('line', { x1: x, y1: 14, x2: x, y2: BAND.h - 14, class: 'bw-adopted' }));
      g.appendChild(svgEl('line', { x1: x - 5, y1: 12, x2: x + 5, y2: 12, class: 'bw-adopted' }));
    }
    svg.appendChild(g);
  };

  if (saved.mode === 'force' && marks.has(saved.model)) {
    marker(marks.get(saved.model), 'bw-mark', 'saved');
  }
  if (draftModelId && draftModelId !== saved.model && marks.has(draftModelId)) {
    marker(marks.get(draftModelId), 'bw-mark', 'draft');
  }
  if (adoptedId && marks.has(adoptedId) && adoptedId !== saved.model) {
    marker(marks.get(adoptedId), 'bw-mark', 'adopted');
  }

  const axisLeft = document.createElement('span');
  axisLeft.textContent = '0';
  const axisRight = document.createElement('span');
  axisRight.textContent = fmtContext(maxCtx) + ' tokens';
  dom.bandAxis.replaceChildren(axisLeft, axisRight);

  renderReadouts(saved, draftModelId, runtime);
}

function renderReadouts(saved, draftId, runtime) {
  const rows = [];

  const savedModel = saved && saved.mode === 'force' ? findModel(saved.model) : null;
  rows.push({
    kind: 'saved',
    label: '已保存目标',
    value:
      !saved || saved.mode === 'inherit'
        ? '继承主模型'
        : savedModel
          ? fmtContext(savedModel.contextWindow) + ' tokens'
          : saved.model || '—',
    sub:
      saved && saved.mode === 'force'
        ? truncate(saved.model, 34) + (saved.effort ? ' · ' + saved.effort : '')
        : '不固定上下文窗口',
  });

  const draftModel = draftId ? findModel(draftId) : null;
  const draftUnchanged = state.data ? sameTarget(state.draft, savedTarget(state.data)) : false;
  rows.push({
    kind: 'draft',
    label: '草稿',
    value: draftUnchanged
      ? saved && saved.mode === 'inherit'
        ? '继承主模型'
        : draftModel
          ? fmtContext(draftModel.contextWindow) + ' tokens'
          : '—'
      : draftModel
        ? fmtContext(draftModel.contextWindow) + ' tokens'
        : '—',
    sub: draftUnchanged
      ? (draftId ? '与已保存一致 · ' + truncate(draftId, 30) : '与已保存一致')
      : draftId
        ? truncate(draftId, 34)
        : '未选择固定模型',
    form: draftModel || (draftUnchanged && saved && saved.mode === 'inherit') ? null : 'half',
  });

  const loaded = Boolean(runtime && runtime.state === 'loaded');
  const observedId = loaded ? modelIdFromAlias(runtime.modelAlias) : null;
  const observedModel = observedId ? findModel(observedId) : null;
  rows.push({
    kind: 'adopted',
    label: '运行时采用',
    value: !loaded
      ? '—'
      : observedModel
        ? fmtContext(observedModel.contextWindow) + ' tokens'
        : runtime && runtime.mode === 'inherit'
          ? '继承主模型'
          : '未固定模型',
    sub: !loaded
      ? '运行时尚未加载'
      : observedId
        ? truncate(observedId, 34)
        : '运行时未固定模型',
    form: loaded ? null : 'half',
  });

  const nodes = rows.map((row) => {
    const wrap = document.createElement('div');
    wrap.className = 'readout';
    const label = document.createElement('p');
    label.className = 'readout__label';
    const swatch = document.createElement('span');
    swatch.className = 'readout__swatch';
    swatch.dataset.kind = row.kind;
    label.append(swatch, document.createTextNode(row.label));
    const value = document.createElement('p');
    value.className = 'readout__value';
    if (row.form) value.dataset.form = row.form;
    value.textContent = row.value;
    const sub = document.createElement('p');
    sub.className = 'readout__sub';
    sub.textContent = row.sub;
    wrap.append(label, value, sub);
    return wrap;
  });

  dom.bandReadouts.replaceChildren(...nodes);
}

/* ---------- rendering: modes ---------- */

function renderModes() {
  const locked = state.locked || Boolean(state.data && state.data.configuration && state.data.configuration.state !== 'ready');
  const draft = state.draft;
  dom.modes.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.checked = Boolean(draft) && input.value === draft.mode;
    input.disabled = locked;
  });
  dom.modes.dataset.locked = locked ? 'true' : 'false';
}

/* ---------- rendering: effort ---------- */

function currentEffortOptions(model) {
  if (!model || !model.reasoning) return null;
  const list = Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts.filter((e) => typeof e === 'string' && e) : [];
  if (!list.length) return null;
  return { list, def: typeof model.defaultEffort === 'string' ? model.defaultEffort : null };
}

function renderEffort() {
  const draft = state.draft;
  const locked = state.locked;
  dom.effortOptions.replaceChildren();

  if (!draft || draft.mode === 'inherit') {
    dom.effortHint.textContent = '继承模式下不设档位，由主模型决定。';
    const none = document.createElement('p');
    none.className = 'effort__none';
    none.textContent = '切换到「指定模型」后可选择推理档位。';
    dom.effortOptions.append(none);
    dom.effortOptions.dataset.locked = 'true';
    return;
  }

  const model = draft.model ? findModel(draft.model) : null;
  if (!model) {
    dom.effortHint.textContent = '先选择一个模型。';
    const none = document.createElement('p');
    none.className = 'effort__none';
    none.textContent = '未选择模型，无档位可选。';
    dom.effortOptions.append(none);
    dom.effortOptions.dataset.locked = 'true';
    return;
  }

  const options = currentEffortOptions(model);
  if (!options) {
    dom.effortHint.textContent = model.reasoning
      ? '该模型未声明可选档位，使用其默认推理行为。'
      : '该模型未声明推理能力。';
    const none = document.createElement('p');
    none.className = 'effort__none';
    none.textContent = model.reasoning ? '无档位可选，自动使用默认。' : '该模型不支持推理档位。';
    dom.effortOptions.append(none);
    dom.effortOptions.dataset.locked = 'true';
    return;
  }

  dom.effortHint.textContent = options.def
    ? '默认档位 ' + options.def + '，可覆盖。'
    : '未声明默认档位，使用自动。';
  dom.effortOptions.dataset.locked = locked ? 'true' : 'false';

  const build = (value, label, isAuto) => {
    const opt = document.createElement('label');
    opt.className = 'effort-opt' + (isAuto ? ' effort-opt--auto' : '');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'effort';
    input.value = value;
    input.checked = (draft.effort || '') === value;
    input.disabled = locked;
    const span = document.createElement('span');
    span.textContent = label;
    opt.append(input, span);
    return opt;
  };

  const auto = build('', options.def ? '自动 · 默认 ' + options.def : '自动', true);
  dom.effortOptions.append(auto);
  options.list.forEach((value) => {
    dom.effortOptions.append(build(value, value, false));
  });
}

/* ---------- rendering: models ---------- */

function matchesQuery(model, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const fields = [model.id, model.name, model.protocol].filter((v) => typeof v === 'string');
  return fields.some((v) => v.toLowerCase().includes(needle));
}

let modelSignature = '';

function renderModels() {
  const data = state.data;
  const list = data && Array.isArray(data.models) ? data.models : [];
  const q = state.query.trim();
  const filtered = list.filter((m) => {
    if (!m || typeof m.id !== 'string') return false;
    if (state.onlyTools && !isSubagentCapable(m)) return false;
    return matchesQuery(m, q);
  });

  /* 轮询每 2 秒回来一次，整表重建会丢掉键盘焦点与滚动位置。
     只有可见集合或选中项真的变了才重建。 */
  const signature = JSON.stringify([
    filtered.map((m) => [m.id, m.tools, m.reasoning, m.contextWindow, m.maxOutputTokens, m.protocol, m.name]),
    state.draft && state.draft.mode === 'force' ? state.draft.model : null,
    state.locked,
    data ? savedTarget(data) : null,
  ]);
  if (signature === modelSignature) {
    dom.modelList.setAttribute('aria-busy', 'false');
    return;
  }
  modelSignature = signature;

  const scrollTop = dom.modelList.scrollTop;
  dom.modelList.replaceChildren();
  dom.modelList.setAttribute('aria-busy', 'false');

  const saved = data ? savedTarget(data) : { mode: 'inherit', model: null };
  const draftModel = state.draft && state.draft.mode === 'force' ? state.draft.model : null;

  filtered.forEach((m) => {
    const capable = isSubagentCapable(m);
    const row = document.createElement('label');
    row.className = 'model ' + waveClassFor(m.id);
    row.dataset.disabled = capable ? 'false' : 'true';
    row.dataset.checked = draftModel === m.id ? 'true' : 'false';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'model';
    input.value = m.id;
    input.checked = draftModel === m.id;
    input.disabled = !capable || state.locked;

    const tick = document.createElement('span');
    tick.className = 'model__tick';
    tick.setAttribute('aria-hidden', 'true');

    const main = document.createElement('span');
    main.className = 'model__main';
    const id = document.createElement('span');
    id.className = 'model__id';
    id.textContent = m.id;
    main.append(id);
    const nameText = [
      typeof m.name === 'string' && m.name && m.name !== m.id ? m.name : '',
      m.maxOutputTokens ? 'out ' + fmtTokens(m.maxOutputTokens) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (nameText) {
      const name = document.createElement('span');
      name.className = 'model__name';
      name.textContent = nameText;
      main.append(name);
    }

    const ctx = document.createElement('span');
    ctx.className = 'model__cell';
    const ctxValue = document.createElement('span');
    ctxValue.className = 'mono';
    ctxValue.textContent = fmtContext(m.contextWindow);
    ctx.append(ctxValue, document.createTextNode(' ctx'));

    const proto = document.createElement('span');
    proto.className = 'model__cell mono';
    proto.textContent = m.protocol === 'responses' ? 'responses' : 'chat';

    const flags = document.createElement('span');
    flags.className = 'model__flags';
    const flag = (text, cls) => {
      const f = document.createElement('span');
      f.className = 'flag ' + cls;
      f.textContent = text;
      return f;
    };
    flags.append(
      flag(m.tools ? '工具' : '无工具', m.tools ? 'flag--on' : 'flag--off'),
      flag(
        m.reasoning ? (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length ? '推理' : '推理') : '无推理',
        m.reasoning ? 'flag--on' : 'flag--off'
      )
    );

    const meta = document.createElement('span');
    meta.className = 'model__meta';
    const metaCtx = document.createElement('span');
    metaCtx.textContent = 'ctx ' + fmtContext(m.contextWindow);
    const metaOut = document.createElement('span');
    metaOut.textContent = m.maxOutputTokens ? 'out ' + fmtTokens(m.maxOutputTokens) : 'out —';
    const metaProto = document.createElement('span');
    metaProto.textContent = m.protocol === 'responses' ? 'responses' : 'chat';
    meta.append(metaCtx, metaOut, metaProto);

    if (!capable) {
      const na = document.createElement('span');
      na.className = 'model__na';
      na.textContent = '不可用于子代理';
      flags.replaceChildren(flag('无工具', 'flag--off'), na);
    }

    row.append(input, tick, main, ctx, proto, flags, meta);

    if (saved.mode === 'force' && saved.model === m.id) {
      flags.prepend(flag('已保存', 'flag--saved'));
      row.dataset.saved = 'true';
    }

    dom.modelList.append(row);
  });

  dom.modelList.scrollTop = scrollTop;

  const total = list.filter((m) => m && typeof m.id === 'string').length;
  const capableCount = list.filter(isSubagentCapable).length;
  dom.count.textContent = filtered.length + ' / ' + total + ' · 可用 ' + capableCount;

  const isEmpty = filtered.length === 0;
  dom.modelsEmpty.hidden = !isEmpty;
  dom.modelList.hidden = isEmpty;

  if (isEmpty) {
    if (!total) {
      dom.emptyTitle.textContent = '目录为空';
      dom.emptyNote.textContent = '配置中的模型目录没有可用模型。检查配置文件后重启面板。';
      dom.emptyReset.hidden = true;
    } else if (state.onlyTools && !list.some(isSubagentCapable)) {
      dom.emptyTitle.textContent = '没有支持工具的模型';
      dom.emptyNote.textContent = '当前配置中没有任何模型声明支持工具调用，无法设置子代理目标。';
      dom.emptyReset.hidden = false;
    } else {
      dom.emptyTitle.textContent = '没有匹配的模型';
      dom.emptyNote.textContent = q ? '没有模型匹配「' + truncate(q, 24) + '」。' : '清除筛选以查看全部模型。';
      dom.emptyReset.hidden = false;
    }
  }
}

function renderSkeleton() {
  modelSignature = '';
  dom.modelList.replaceChildren();
  dom.modelList.setAttribute('aria-busy', 'true');
  dom.modelsEmpty.hidden = true;
  dom.modelList.hidden = false;
  for (let i = 0; i < 6; i += 1) {
    const row = document.createElement('div');
    row.className = 'skel';
    row.setAttribute('aria-hidden', 'true');
    const tick = document.createElement('span');
    tick.className = 'skel__tick';
    const bar = document.createElement('span');
    bar.className = 'skel__bar';
    const bar2 = document.createElement('span');
    bar2.className = 'skel__bar skel__bar--short';
    row.append(tick, bar, bar2);
    dom.modelList.append(row);
  }
}

/* ---------- rendering: apply bar ---------- */

function renderApply() {
  const data = state.data;
  const locked = state.locked;
  const draft = state.draft;
  const saved = data ? savedTarget(data) : null;

  const savedModel = saved && saved.mode === 'force' ? findModel(saved.model) : null;
  const draftModel = draft && draft.mode === 'force' ? findModel(draft.model) : null;

  const problems = [];
  if (locked) problems.push('有操作正在进行，暂不能保存。');
  if (data && data.configuration && data.configuration.state !== 'ready') {
    problems.push('配置不是就绪状态，保存已禁用。重启面板以载入当前配置。');
  }
  if (draft && draft.mode === 'force') {
    if (!draft.model) problems.push('尚未选择模型。');
    else if (!draftModel) problems.push('所选模型已不在目录中。');
    else if (!isSubagentCapable(draftModel)) problems.push('所选模型未声明支持工具调用。');
  }

  const blocked = problems.length > 0;
  const canApply = Boolean(data) && state.dirty && !blocked && !state.submitting;
  const canInherit = Boolean(data) && !locked && !state.submitting && !(data.configuration && data.configuration.state !== 'ready') && !(saved && saved.mode === 'inherit' && !state.dirty);

  dom.btnApply.disabled = !canApply;
  dom.btnInherit.disabled = !canInherit || (saved && saved.mode === 'inherit' && !state.dirty);
  dom.btnReset.disabled = !state.dirty || state.submitting;

  dom.btnApplyLabel.textContent = state.submitting ? '正在保存…' : '应用目标';
  dom.btnApply.classList.toggle('is-busy', state.submitting);

  dom.draftState.dataset.dirty = String(Boolean(state.dirty));
  dom.draftState.dataset.blocked = String(blocked && state.dirty);

  let headline;
  if (!data) {
    headline = '尚未读取状态';
  } else if (blocked) {
    headline = problems[0];
  } else if (!state.dirty) {
    headline = '草稿与已保存一致';
  } else {
    headline = '草稿尚未保存';
  }
  dom.draftState.textContent = headline;

  const details = [];
  if (state.dirty && !blocked) {
    details.push(
      draft.mode === 'inherit'
        ? '将保存为「继承主模型」，不固定模型与档位。'
        : '将保存为「指定模型」' + (draft.model ? ' · ' + draft.model : '') + (draft.effort ? ' · 档位 ' + draft.effort : ' · 档位自动') + '。'
    );
    details.push('保存后服务端立即写入并应用，实际采用状态需运行时重新加载。');
  } else if (blocked && data) {
    if (data.configuration && data.configuration.state !== 'ready') {
      details.push('保存不会丢失：草稿保留在本页，重启面板后重新应用。');
    }
  } else if (saved) {
    details.push(
      saved.mode === 'inherit'
        ? '已保存为继承主模型。'
        : '已保存 ' + (saved.model || '—') + (saved.effort ? ' · 档位 ' + saved.effort : ' · 档位自动') + '。'
    );
  }
  dom.draftDetail.textContent = details.join(' ') || '—';

}

/* ---------- rendering: runtime ---------- */

function renderRuntime(data) {
  const runtime = (data && data.subagents && data.subagents.runtime) || {};
  const info = RUNTIME_STATE[runtime.state] || { form: 'half', word: '未知' };

  dom.rtState.textContent = info.word;
  dom.rtState.dataset.form = info.form;
  dom.rtVersion.textContent = typeof runtime.version === 'string' && runtime.version ? runtime.version : '—';
  dom.rtMode.textContent = typeof runtime.mode === 'string' && runtime.mode ? runtime.mode : '—';
  dom.rtAlias.textContent = typeof runtime.modelAlias === 'string' && runtime.modelAlias ? runtime.modelAlias : '—';
  const spawn = runtime.lastSpawn;
  dom.rtSpawn.textContent = spawn
    ? fmtTime(typeof spawn === 'number' ? spawn : spawn.at) +
      (typeof spawn === 'object' && typeof spawn.modelAlias === 'string' && spawn.modelAlias
        ? ' · ' + spawn.modelAlias
        : '')
    : '—';

  const reason = typeof runtime.reason === 'string' && runtime.reason ? runtime.reason : '';
  dom.rtReason.hidden = !reason;
  dom.rtReason.textContent = reason;

  const setup = (data && data.setup) || {};
  const intranet = setup.intranet || {};
  dom.nativePassed.textContent = intranet.passed ? '通过' : '未通过';
  dom.nativePassed.dataset.form = intranet.passed ? 'solid' : 'struck';
  dom.nativeAddress.textContent = typeof intranet.address === 'string' && intranet.address ? intranet.address : '—';

  const err = typeof intranet.error === 'string' && intranet.error ? intranet.error : '';
  dom.nativeError.hidden = !err;
  dom.nativeError.textContent = err;

  if (setup.revealed) {
    dom.nativeBadge.textContent = '已展开';
    dom.nativeBadge.dataset.state = 'ok';
  } else {
    dom.nativeBadge.textContent = '首次设置';
    dom.nativeBadge.dataset.state = '';
  }

  renderOperation(data);
  renderActions(data);
}

function renderOperation(data) {
  const op = data && data.operation;
  if (!op) {
    dom.op.dataset.form = 'half';
    dom.opName.textContent = '无进行中的操作';
    dom.opNote.hidden = true;
    dom.opNote.textContent = '';
    return;
  }

  const label = ACTION_LABEL[op.action] || op.action || '操作';
  const word = ACTION_STATE[op.state] || op.state || '未知';
  dom.opName.textContent = label + ' · ' + word;

  const running = op.state === 'running';
  const failed = op.state === 'failed' || op.state === 'interrupted' || op.state === 'unavailable';
  dom.op.dataset.form = running ? 'dashed' : failed ? 'struck' : 'solid';

  const note = typeof op.reason === 'string' && op.reason ? op.reason : '';
  dom.opNote.hidden = !note;
  dom.opNote.textContent = note;

  if (op.state === 'waiting-kimi-exit') {
    dom.opNote.hidden = false;
    dom.opNote.textContent = (note ? note + ' ' : '') + 'Kimi 已在运行。请正常退出 Kimi，再点一次「启动 Kimi」；本面板不会强制结束它。';
  }
}

/* 在途状态：只有 running 表示服务端仍在推进，重复操作没有意义。
   starting 是 launch 完成后的终态（启动请求已发出），不会再变，不能永锁。
   waiting-kimi-exit 要求用户正常退出 Kimi 后再点一次，同样不算在途。 */
function isInFlight(op) {
  return Boolean(op && op.state === 'running');
}

function renderActions(data) {
  const op = data && data.operation;
  const running = isInFlight(op);
  const config = data && data.configuration;
  const configBad = !config || config.state !== 'ready';

  const buttons = document.querySelectorAll('[data-action]');
  buttons.forEach((btn) => {
    const action = btn.dataset.action;
    const busy = state.pendingAction === action;
    let disabled = false;

    if (running) disabled = true;
    if (state.submitting) disabled = true;

    if (action === 'prepare-runtime' || action === 'launch-kimi') {
      if (configBad) disabled = true;
    }

    btn.disabled = disabled;
    btn.classList.toggle('is-busy', busy);
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  });
}

/* ---------- render all ---------- */

function renderAll() {
  const data = state.data;
  if (!data) return;

  renderRail(data);
  renderBinding(data);
  renderBand(data);
  renderModes();
  renderEffort();
  renderModels();
  renderApply();
  renderRuntime(data);

  dom.sync.textContent = state.lastSync ? '同步于 ' + fmtTime(state.lastSync) : '尚未同步';
}

/* ---------- state acquisition ---------- */

function adoptState(next) {
  state.data = next;
  state.locked = isInFlight(next.operation);
  recomputeDirty();
}

function resetDraft() {
  state.draft = draftFromSaved(state.data);
  state.dirty = false;
}

async function loadState({ silent = false } = {}) {
  if (!state.key) {
    showGate('missing');
    return false;
  }

  if (!silent) {
    if (!state.started) renderSkeleton();
  }

  try {
    const next = await request(API.state);
    if (!next || next.schemaVersion !== 1) {
      throw new ApiError('面板返回了无法识别的状态格式', 'SCHEMA', 200);
    }

    const wasDirty = state.dirty;
    const priorData = state.data;

    adoptState(next);
    state.reachable = true;
    state.lastSync = Date.now();
    dom.conn.hidden = true;

    if (!priorData) {
      state.draft = draftFromSaved(next);
      state.dirty = false;
    } else if (!wasDirty) {
      state.draft = draftFromSaved(next);
      state.dirty = false;
    } else {
      /* 保留用户草稿；若草稿模型已从目录消失，渲染层会标出问题。 */
      recomputeDirty();
    }

    if (!state.started) {
      state.started = true;
      dom.shell.hidden = false;
      dom.gate.hidden = true;
    }

    renderAll();
    return true;
  } catch (error) {
    state.reachable = false;
    handleApiFailure(error);
    return false;
  }
}

function handleApiFailure(error) {
  if (error.code === 'NO_KEY' || error.code === 'unauthorized') {
    clearKey();
    stopPolling();
    showGate(error.code === 'NO_KEY' ? 'missing' : 'expired');
    return;
  }

  if (error.code === 'origin_refused') {
    stopPolling();
    showGate('refused');
    return;
  }

  /* 断连必须可见，哪怕只是轮询失败：面板一旦不可达，
     页面上的状态就不再是「此刻」，用户需要知道。 */
  dom.conn.hidden = false;
  dom.connText.textContent =
    error.code === 'NETWORK'
      ? '无法连接本机面板服务。服务可能已停止或端口已变化，页面上的状态停留在最后一次读取。'
      : error.message || '读取状态失败，页面上的状态停留在最后一次读取。';
  dom.sync.textContent = state.lastSync ? '最后同步 ' + fmtTime(state.lastSync) + ' · 连接中断' : '尚未同步';

  if (!state.data) {
    renderSkeleton();
    if (!state.started) dom.shell.hidden = false;
  }
}

/* ---------- gate ---------- */

const GATE_COPY = {
  checking: {
    title: '正在读取会话',
    lede: '正在确认面板会话密钥并读取网关状态。',
    note: '',
    retry: false,
  },
  missing: {
    title: '需要从终端启动链接打开',
    lede:
      '面板每次启动都会生成一次性的会话密钥，只通过终端打印的链接传入。地址栏里的 #key=… 会在读取后立即从历史记录中移除，不会显示在页面上。',
    note: '',
  },
  expired: {
    title: '会话密钥已失效',
    lede: '面板重启会生成新的会话密钥，旧链接随之失效。请从终端打印的最新链接重新打开。',
    note: '若面板仍在运行，也可能是在别处打开了面板地址；请使用带 #key= 的完整链接。',
  },
  refused: {
    title: '无法确认面板会话',
    lede: '服务拒绝了这次请求，可能是页面被其他来源打开，或服务已停止。',
    note: '请从终端打印的链接重新打开；若持续出现，重启面板。',
  },
};

function showGate(kind) {
  const copy = GATE_COPY[kind] || GATE_COPY.missing;
  dom.gate.hidden = false;
  dom.shell.hidden = true;
  dom.gateTitle.textContent = copy.title;
  dom.gateLede.textContent = copy.lede;
  dom.gateNote.hidden = !copy.note;
  dom.gateNote.textContent = copy.note;
  dom.gateActions.hidden = copy.retry === false;
  if (copy.retry !== false) dom.gateRetry.focus({ preventScroll: true });
}

/* ---------- polling ---------- */

function startPolling() {
  stopPolling();
  state.timer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.submitting) return;
    loadState({ silent: true });
  }, POLL_MS);
}

function stopPolling() {
  if (state.timer !== null) {
    window.clearInterval(state.timer);
    state.timer = null;
  }
}

/* ---------- toast ---------- */

function showToast(message, tone) {
  if (state.toastTimer !== null) {
    window.clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }

  dom.toast.replaceChildren();
  const icon = document.createElementNS(NS, 'svg');
  icon.setAttribute('class', 'icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', tone === 'error' ? '#i-alert' : '#i-check');
  icon.append(use);

  const text = document.createElement('span');
  text.textContent = message;

  dom.toast.dataset.tone = tone || 'ok';
  dom.toast.hidden = false;
  dom.toast.append(icon, text);
  requestAnimationFrame(() => {
    dom.toast.dataset.open = 'true';
  });

  state.toastTimer = window.setTimeout(() => {
    dom.toast.dataset.open = 'false';
    state.toastTimer = window.setTimeout(() => {
      dom.toast.hidden = true;
      state.toastTimer = null;
    }, 220);
  }, tone === 'error' ? 6000 : 3200);
}

/* ---------- actions ---------- */

async function submitTarget(target) {
  if (state.submitting) return;
  const data = state.data;
  if (!data) return;

  state.submitting = true;
  renderApply();
  renderActions(data);

  try {
    const payload = {
      revision: data.revision,
      mode: target.mode,
    };
    if (target.mode === 'force') {
      payload.model = target.model;
      if (target.effort) payload.effort = target.effort;
    }

    const res = await request(API.subagents, { method: 'POST', body: payload });

    if (res && res.state) {
      adoptState(res.state);
      state.lastSync = Date.now();
      state.draft = draftFromSaved(res.state);
      state.dirty = false;
      dom.conn.hidden = true;
      renderAll();
      showToast(
        target.mode === 'inherit'
          ? '已恢复继承主模型，对后续新建的子代理生效。'
          : '目标已保存并应用，对后续新建的子代理生效；运行时状态见右侧。',
        'ok'
      );
    } else {
      await loadState({ silent: true });
      showToast('目标已提交，状态已刷新。', 'ok');
    }
  } catch (error) {
    await handleSubmitError(error);
  } finally {
    state.submitting = false;
    renderApply();
    if (state.data) renderActions(state.data);
  }
}

async function handleSubmitError(error) {
  if (error.code === 'NO_KEY' || error.code === 'unauthorized') {
    clearKey();
    stopPolling();
    showGate('expired');
    return;
  }

  if (error.status === 409) {
    await loadState({ silent: true });
    showToast(error.message, 'error');
    return;
  }

  if (error.status === 0) {
    dom.conn.hidden = false;
    dom.connText.textContent = '无法连接本机面板服务。服务可能已停止或端口已变化。';
  }

  showToast(error.message || '保存失败，请重试。', 'error');
}

async function runAction(action) {
  const data = state.data;
  if (!data || state.pendingAction) return;

  const op = data.operation;
  if (isInFlight(op)) {
    showToast('已有操作正在进行，等待它结束后再试。', 'error');
    return;
  }

  state.pendingAction = action;
  renderActions(data);

  try {
    const payload = {
      id: crypto.randomUUID(),
      at: Date.now(),
      action,
    };

    const res = await request(API.actions, { method: 'POST', body: payload });
    const opId = res && res.operation && res.operation.id ? res.operation.id : null;

    if (res && res.operation) {
      const current = state.data;
      if (current) {
        adoptState({ ...current, operation: res.operation });
        renderRuntime(state.data);
        renderApply();
      }
    }

    /* 202 只代表请求已被接受，结果要靠轮询到的 operation 状态确认。
       copy-token 尤其不能在这里就说已写入剪贴板。 */
    if (action === 'launch-kimi') {
      showToast('启动请求已提交，等待运行时状态。', 'ok');
    } else {
      showToast('操作已提交，等待结果。', 'ok');
    }

    await loadState({ silent: true });
    await confirmActionResult(action, opId);
  } catch (error) {
    if (error.code === 'NO_KEY' || error.code === 'unauthorized') {
      clearKey();
      stopPolling();
      showGate('expired');
      return;
    }
    if (error.code === 'origin_refused') {
      stopPolling();
      showGate('refused');
      return;
    }
    if (error.status === 0) {
      /* 请求可能已经送达并执行，只是响应丢了；不能断言「未提交」，也不自动重试。 */
      dom.conn.hidden = false;
      dom.connText.textContent = '无法连接本机面板服务，操作结果尚未确认。请先刷新状态再决定是否重试。';
      showToast('操作结果尚未确认，请先刷新状态；本面板不会自动重试。', 'error');
      return;
    }
    showToast(error.message || '操作失败，请重试。', 'error');
    await loadState({ silent: true });
  } finally {
    state.pendingAction = null;
    if (state.data) renderActions(state.data);
  }
}

/* 只在本请求的 operation 上观察到终态才报告结果；未观察到就保持中性，不下结论。 */
async function confirmActionResult(action, opId) {
  if (!opId) return;
  const op = state.data && state.data.operation;
  if (!op || op.id !== opId) return;

  if (action === 'copy-token') {
    if (op.state === 'copied') {
      showToast('Token 已由服务端写入系统剪贴板。', 'ok');
    } else if (op.state === 'failed' || op.state === 'unavailable' || op.state === 'interrupted') {
      showToast(
        'Token 未复制：' + (ACTION_STATE[op.state] || op.state) + (op.reason ? '（' + op.reason + '）' : ''),
        'error'
      );
    }
    return;
  }

  if (op.state === 'failed' || op.state === 'unavailable' || op.state === 'interrupted') {
    showToast(
      (ACTION_LABEL[action] || action) + '未完成：' + (ACTION_STATE[op.state] || op.state) + (op.reason ? '（' + op.reason + '）' : ''),
      'error'
    );
  }
}

/* ---------- draft mutation ---------- */

function setMode(mode) {
  if (state.locked) return;
  if (!state.draft) return;
  if (mode === state.draft.mode) return;

  if (mode === 'inherit') {
    state.draft = { mode: 'inherit', model: null, effort: null };
  } else {
    const saved = state.data ? savedTarget(state.data) : null;
    const seed =
      (saved && saved.mode === 'force' && saved.model && isSubagentCapable(findModel(saved.model)) && saved.model) ||
      (state.draft.model && isSubagentCapable(findModel(state.draft.model)) && state.draft.model) ||
      firstCapableModelId();
    state.draft = {
      mode: 'force',
      model: seed || null,
      effort: null,
    };
    if (seed) {
      const model = findModel(seed);
      const options = currentEffortOptions(model);
      if (options && options.def) state.draft.effort = null;
    }
  }
  recomputeDirty();
  renderModes();
  renderEffort();
  renderModels();
  renderApply();
  renderBand(state.data);
}

function firstCapableModelId() {
  const list = state.data && Array.isArray(state.data.models) ? state.data.models : [];
  const found = list.find((m) => m && typeof m.id === 'string' && isSubagentCapable(m));
  return found ? found.id : null;
}

function pickModel(id) {
  if (state.locked) return;
  const model = findModel(id);
  if (!model || !isSubagentCapable(model)) return;
  if (!state.draft) state.draft = { mode: 'force', model: id, effort: null };

  state.draft = {
    mode: 'force',
    model: id,
    effort: state.draft.mode === 'force' && state.draft.model === id ? state.draft.effort : null,
  };

  recomputeDirty();
  renderModes();
  renderEffort();
  renderModels();
  renderApply();
  renderBand(state.data);
}

function setEffort(value) {
  if (state.locked) return;
  if (!state.draft || state.draft.mode !== 'force') return;
  state.draft = { ...state.draft, effort: value || null };
  recomputeDirty();
  renderApply();
  renderBand(state.data);
}

function discardDraft() {
  if (!state.data) return;
  state.draft = draftFromSaved(state.data);
  state.dirty = false;
  renderEffort();
  renderModels();
  renderApply();
  renderBand(state.data);
}

function restoreInherit() {
  if (!state.data) return;
  state.draft = { mode: 'inherit', model: null, effort: null };
  recomputeDirty();
  renderModes();
  renderEffort();
  renderModels();
  renderApply();
  renderBand(state.data);

  if (state.dirty) {
    submitTarget({ mode: 'inherit' });
  } else {
    showToast('已保存的目标就是继承主模型。', 'ok');
  }
}

/* ---------- events ---------- */

function bindEvents() {
  dom.modes.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== 'mode') return;
    setMode(target.value === 'force' ? 'force' : 'inherit');
  });

  dom.effortOptions.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== 'effort') return;
    setEffort(target.value);
  });

  dom.modelList.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== 'model') return;
    pickModel(target.value);
  });

  dom.q.addEventListener('input', () => {
    state.query = dom.q.value;
    dom.qClear.hidden = !state.query;
    renderModels();
  });

  dom.q.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.query) {
      event.stopPropagation();
      state.query = '';
      dom.q.value = '';
      dom.qClear.hidden = true;
      renderModels();
    }
  });

  dom.qClear.addEventListener('click', () => {
    state.query = '';
    dom.q.value = '';
    dom.qClear.hidden = true;
    renderModels();
    dom.q.focus();
  });

  dom.onlyTools.addEventListener('change', () => {
    state.onlyTools = dom.onlyTools.checked;
    renderModels();
  });

  dom.emptyReset.addEventListener('click', () => {
    state.query = '';
    state.onlyTools = false;
    dom.q.value = '';
    dom.qClear.hidden = true;
    dom.onlyTools.checked = false;
    renderModels();
    dom.q.focus();
  });

  dom.btnApply.addEventListener('click', () => {
    if (!state.draft || dom.btnApply.disabled) return;
    submitTarget({ ...state.draft });
  });

  dom.btnInherit.addEventListener('click', restoreInherit);
  dom.btnReset.addEventListener('click', discardDraft);

  document.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      runAction(btn.dataset.action);
    });
  });

  dom.connRetry.addEventListener('click', async () => {
    dom.connRetry.disabled = true;
    await loadState();
    dom.connRetry.disabled = false;
  });

  dom.gateRetry.addEventListener('click', async () => {
    dom.gateRetry.disabled = true;
    const key = readKey();
    if (key) {
      state.key = key;
      const ok = await loadState();
      if (ok) startPolling();
      else showGate(state.reachable === false ? 'missing' : 'expired');
    } else {
      showGate('missing');
    }
    dom.gateRetry.disabled = false;
  });

  dom.theme.addEventListener('change', () => {
    applyTheme(dom.theme.value);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.key && !state.submitting) {
      loadState({ silent: true });
    }
  });

  window.addEventListener('online', () => {
    if (state.key) loadState({ silent: true });
  });

  /* 分区导航：高亮当前可见分区 */
  const sections = Array.from(document.querySelectorAll('[data-nav]'))
    .map((a) => ({ link: a, el: document.getElementById(a.dataset.nav) }))
    .filter((entry) => entry.el);

  if (sections.length && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        sections.forEach(({ link, el }) => {
          const on = el === visible.target;
          link.setAttribute('aria-current', on ? 'true' : 'false');
        });
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: [0.05, 0.3, 0.6] }
    );
    sections.forEach(({ el }) => observer.observe(el));
  }

  /* Ctrl/Cmd+Enter 应用目标 */
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    if (dom.btnApply.disabled) return;
    event.preventDefault();
    submitTarget({ ...state.draft });
  });
}

/* ---------- key rotation ---------- */

function adoptLocationKey() {
  let key = null;
  const raw = window.location.hash || '';
  if (raw.length > 1) {
    try {
      key = new URLSearchParams(raw.slice(1)).get('key');
    } catch {
      key = null;
    }
  }
  if (!key || key === state.key) return false;

  try {
    sessionStorage.setItem(KEY_STORE, key);
  } catch {
    /* 无存储时仅本次内存使用 */
  }
  history.replaceState(null, '', window.location.pathname + window.location.search);

  state.key = key;
  state.data = null;
  state.draft = null;
  state.dirty = false;
  state.started = false;
  state.locked = false;
  state.submitting = false;
  state.pendingAction = null;
  state.lastSync = null;

  stopPolling();
  dom.conn.hidden = true;
  dom.toast.hidden = true;
  dom.shell.hidden = true;
  showGate('checking');
  loadState().then((ok) => {
    if (ok) startPolling();
  });
  return true;
}

/* ---------- boot ---------- */

function boot() {
  initTheme();
  bindEvents();

  /* 面板重启后的新 #key=… 链接粘贴到已打开的页面时只发生 hash 变化，
     浏览器不会重新执行脚本，因此在 hash 变化与页面重新可见时都重新取一次密钥。
     这两个监听器必须在无密钥早退之前注册，否则裸地址打开后就收不到新密钥。 */
  window.addEventListener('hashchange', adoptLocationKey);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) adoptLocationKey();
  });

  state.key = readKey();

  if (!state.key) {
    showGate('missing');
    return;
  }

  showGate('checking');
  loadState().then((ok) => {
    if (!ok) return;
    startPolling();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.key && !state.started) {
      loadState().then((ok) => {
        if (ok && !state.timer) startPolling();
      });
    }
  });
}

boot();

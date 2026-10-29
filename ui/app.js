const API = {
  state: '/api/state',
  models: '/api/models',
  connection: '/api/connection',
  subagents: '/api/subagents',
  translation: '/api/translation',
  actions: '/api/actions',
};

const POLL_MS = 2000;
const KEY_STORE = 'kwg.panel.key';
const THEME_STORE = 'kwg.panel.theme';
const VIEW_STORE = 'kwg.panel.view';
const MODEL_ALIAS_PREFIXES = ['byok-kth-kimi/', 'byok-kth-resp/'];
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost', '::1']);
const UPDATE_ACTIONS = new Set(['check-update', 'install-update', 'rollback-update']);
const UPDATE_RELEASE_PREFIX = 'https://github.com/wssz527/kimi-work-gateway/releases/tag/';
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const VIEW_COPY = {
  overview: { title: '概览', lede: '网关、配置与子代理目标此刻的真实状态。' },
  models: { title: '模型管理', lede: '目录决定可选模型与它们的真实能力；保存会提交整个目录。' },
  subagents: { title: '子代理', lede: '选择本机子代理实际使用的模型与思考档位。' },
  translation: { title: '思考翻译', lede: '把 Kimi 的思考过程翻译成所选语言；保存只写配置，注入成功以运行时为准。' },
  connection: { title: '连接与诊断', lede: '上游地址、端口与环境变量名；检查只诊断连通性，不代表推理成功。' },
};

const ACTION_LABEL = {
  'prepare-runtime': '准备副本',
  'launch-kimi': '启动 Kimi',
  'prepare-native': '准备原生设置',
  'remove-dns': '撤销 DNS 映射',
  'copy-token': '复制 Token',
  'check-upstream': '上游检查',
  'check-compat': '兼容性检查',
  'launch-translated-kimi': '从网关启动 Kimi',
  'check-translation': '检查翻译状态',
  'check-update': '检查更新',
  'install-update': '下载并更新',
  'rollback-update': '回退版本',
};

const ACTION_STATE = {
  running: '进行中',
  prepared: '已准备',
  starting: '启动请求已发出',
  'waiting-kimi-exit': '等待 Kimi 退出',
  done: '已完成',
  copied: '已复制',
  passed: '通过',
  verified: '兼容',
  incompatible: '不兼容',
  unavailable: '不可用',
  unverified: '未验证',
  failed: '失败',
  interrupted: '已中断',
  'not-checked': '尚未检查',
  checking: '正在检查',
  current: '已是最新',
  available: '有新版本',
  staged: '已下载，待重启',
};

const CONFIG_STATE = {
  ready: { tone: 'ok', word: '就绪', note: '' },
  changed: { tone: 'warn', word: '已变更，待重启', note: '配置文件已被修改，当前进程仍在使用启动时读取的连接。' },
  unavailable: { tone: 'bad', word: '不可读', note: '无法读取配置文件，保存已禁用。' },
};

const RUNTIME_STATE = {
  'not-prepared': { tone: 'neutral', word: '待准备', note: '还没有本机运行时副本。' },
  'waiting-launch': { tone: 'warn', word: '待启动', note: '副本已准备，等待 Kimi 用该副本启动。' },
  'pending-policy': { tone: 'warn', word: '待采用', note: '运行时尚未加载当前策略。' },
  loaded: { tone: 'ok', word: '已加载', note: '运行时已加载策略。' },
  'heartbeat-stale': { tone: 'warn', word: '心跳过期', note: '运行时曾加载策略，但心跳已过期。' },
  'policy-unavailable': { tone: 'bad', word: '策略不可用', note: '运行时无法读取策略，子代理请求会被拒绝。' },
  unavailable: { tone: 'bad', word: '不可用', note: '运行时当前不可用。' },
  unsupported: { tone: 'bad', word: '启动接口不支持', note: '当前应用无法确认适配副本的加载能力；主模型 BYOK 与普通翻译可独立使用。' },
  'scope-conflict': { tone: 'bad', word: '作用域不匹配', note: '实际运行时与策略所属的 Kimi 目录不一致。' },
  outdated: { tone: 'warn', word: '版本过旧', note: '运行时版本与当前内核不一致。' },
  conflict: { tone: 'bad', word: '冲突', note: '运行时与配置存在冲突，未被覆盖。' },
};

const DIAG_REASON = {
  upstream_http_error: '上游返回了错误状态。',
  upstream_connection_failed: '无法连接上游地址。',
  upstream_catalog_invalid: '上游 /models 返回的格式不被接受。',
  catalog_parser_missing: '本机目录解析器未找到。',
  bundle_unavailable: '本机 Kimi 目录不可读。',
  probe_failed: '兼容检查未能执行。',
};

const UPDATE_STATE = {
  'not-checked': { tone: 'neutral', word: '尚未检查', note: '还没有检查过更新。点击「检查更新」读取最新正式发布。' },
  checking: { tone: 'warn', word: '正在检查', note: '正在读取 GitHub 上的正式发布。' },
  current: { tone: 'ok', word: '已是最新', note: '当前运行的就是最新稳定版本。' },
  available: { tone: 'warn', word: '有新版本', note: '发现可用的稳定版本。下载后需要重启网关才会运行新版本。' },
  staged: { tone: 'warn', word: '已下载，待重启', note: '新版本已下载完成；重启网关后才会生效，当前运行版本不变。' },
  failed: { tone: 'bad', word: '失败', note: '上一次更新操作没有完成，请查看原因后重试。' },
};

const UPDATE_REASON = {
  update_network_error: '无法连接 GitHub，可能是离线、代理或防火墙拦截。',
  update_timeout: '连接 GitHub 超时，请稍后重试。',
  update_release_http_error: 'GitHub 返回了错误状态，稍后再试或手动查看发布页。',
  update_rate_limited: 'GitHub 限制了请求频率，请稍后重试。',
  update_redirect_rejected: '下载地址被重定向到了不受信任的站点，已中止。',
  update_release_invalid: 'GitHub 返回的发布信息格式不被接受，未采用其中的任何数据。',
  update_release_not_found: '没有找到可用的正式发布版本。',
  update_release_unstable: '最新发布是草稿或预发行版本，不会被安装。',
  update_release_version_invalid: '发布版本号不是规范的稳定版本号，不会被安装。',
  update_release_asset_missing: '发布中没有对应版本的安装包。',
  update_release_asset_invalid: '发布的安装包信息不被接受，未下载。',
  update_response_too_large: 'GitHub 返回的数据超出预期大小，已中止。',
  update_sums_invalid: '校验文件格式不被接受，未安装。',
  update_checksum_unavailable: '发布中没有可用的 SHA-256 校验值，未安装。',
  update_checksum_mismatch: '安装包的 SHA-256 与发布记录不符，已丢弃。',
  update_size_mismatch: '安装包大小与发布记录不符，已丢弃。',
  update_package_too_large: '安装包超出允许的大小上限，未安装。',
  update_package_archive_unsafe: '安装包内含不安全的路径或链接，未安装。',
  update_package_corrupt: '安装包内容损坏或结构异常，未安装。',
  update_package_invalid: '安装包内容与声明的版本不一致，未安装。',
  update_package_extract_failed: '安装包解压失败，未安装。',
  update_write_failed: '写入更新目录失败，当前版本保持不变。',
  update_lock_timeout: '另一个更新进程占用中，请稍后重试。',
  update_directory_invalid: '更新目录不可用，当前版本保持不变。',
  update_active_invalid: '本地更新记录损坏，请检查更新目录。',
  update_baseline_invalid: '原始安装目录已变化，无法记录回退版本。',
  update_version_invalid: '当前版本号异常，无法比较更新。',
  update_config_invalid: '更新配置无效。',
  update_clock_invalid: '系统时间异常，无法记录更新。',
  update_rollback_unavailable: '没有可回退的旧版本。',
  update_rollback_target_invalid: '回退目标已损坏或被改动，已中止回退。',
  update_git_unavailable: '本机 git 不可用，已改用 GitHub 接口查询。',
  update_state_invalid: '读取更新状态失败。',
  update_unsupported_platform: '当前系统或安装方式不支持从面板更新。',
  update_not_available: '没有可安装的新版本，请先检查更新。',
  update_busy: '另一个更新操作正在进行。',
  update_staged_mismatch: '待重启的版本与当前记录不一致，请重新检查更新。',
  update_no_rollback: '没有可回退的旧版本。',
  update_rollback_failed: '回退失败，当前版本保持不变。',
  update_unknown: '更新操作未能完成，请查看网关日志。',
};

function updateReasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  return UPDATE_REASON[code] || UPDATE_REASON['update_' + code] || code;
}

const TRANSLATION_STATE = {
  disabled: { tone: 'neutral', word: '已关闭', note: '翻译在设置中关闭；Kimi 的思考保持原文。' },
  'not-started': { tone: 'neutral', word: '未启动', note: '还没有通过网关启动带翻译的 Kimi。' },
  starting: { tone: 'warn', word: '正在启动', note: '宿主进程正在准备带翻译的 Kimi。' },
  attaching: { tone: 'warn', word: '正在接入', note: '宿主进程正在把翻译引擎接入 Kimi 窗口。' },
  active: { tone: 'ok', word: '已注入', note: 'Kimi 已确认翻译引擎在运行。' },
  inactive: { tone: 'warn', word: '未生效', note: '翻译已配置，但当前 Kimi 窗口没有运行翻译引擎。' },
  'waiting-kimi-exit': { tone: 'warn', word: '等待 Kimi 退出', note: 'Kimi 仍在运行。请正常退出 Kimi，再从网关启动；本面板不会强制结束它。' },
  incompatible: { tone: 'bad', word: '不兼容', note: '当前 Kimi 的渲染入口或页面结构不兼容，无法注入翻译。' },
  failed: { tone: 'bad', word: '失败', note: '翻译注入未能完成，请查看原因后重试。' },
  stale: { tone: 'warn', word: '状态过期', note: '上一次注入的确认已过期，需要重新检查或重新启动。' },
  'pending-settings': { tone: 'warn', word: '正在应用', note: '翻译设置已保存，等待现有会话确认；无需重启推理网关。' },
  'legacy-running': { tone: 'warn', word: '旧版占用', note: '检测到任务 3 的旧注入仍在运行，未重复挂载；请正常退出 Kimi 后从网关启动。' },
};

const ERROR_HINT = {
  configuration_conflict: '配置在别处被修改，已刷新状态；你的编辑仍然保留，请确认后重新保存。',
  configuration_changed: '配置已在外部修改，模型、子代理与翻译保存已禁用，请重启面板。',
  configuration_unavailable: '无法读取配置文件，请检查文件后重启面板。',
  configuration_apply_failed: '目录已保存，但运行策略未能更新，请检查状态后重启。',
  subagent_model_in_use: '当前子代理仍在使用此模型或档位。请先到「子代理」更改目标，再修改模型能力。',
  subagent_policy_owner_conflict: '另一实例已接管子代理策略，请停止重复运行的服务。',
  subagent_policy_apply_failed: '选择已保存，但当前策略未能应用，请查看运行时状态。',
  subagent_policy_unavailable: '无法读取当前子代理策略，请检查状态目录后重启面板。',
  subagent_launch_unsupported: '当前 Kimi 正式应用不支持已确认的副本启动接口；主模型接入与普通翻译可独立使用。',
  subagent_bundle_application_mismatch: '子代理副本与发现的 Kimi 安装不一致，请重新检查安装来源。',
  subagent_model_unavailable: '所选模型已不在目录中，请重新选择。',
  subagent_model_tools_required: '此模型未声明工具调用，不能作为子代理。',
  invalid_subagent_effort: '此模型未声明所选思考档位，请重新选择。',
  invalid_subagent_policy: '提交的目标格式不被接受，请重新选择。',
  invalid_models: '模型声明无效：请检查 ID、上下文窗口、能力与思考档位。',
  protocol_conflict: '模型 ID 末段以 kimi- 开头时必须使用 Chat，其他必须使用 Responses。',
  invalid_base_url: '上游地址需使用 HTTPS（本机回环可用 HTTP），且不能包含账号、查询参数或片段。',
  invalid_config: '配置无效，请检查端口和环境变量名称。',
  invalid_connection_config: '连接配置不完整或包含不支持的字段。凭证请保存在环境变量中。',
  panel_action_busy: '上一次操作仍在执行，请等待结果。',
  panel_action_conflict: '操作标识已被使用，请刷新后重试。',
  panel_action_limit: '短时间内操作过多，请稍后再试。',
  panel_receipt_conflict: '操作记录有冲突，请检查状态目录。',
  panel_stopping: '面板正在停止。',
  origin_refused: '请求来源不匹配，请从本机面板链接操作。',
  json_required: '请求格式不被接受。',
  request_too_large: '请求过大，请减少一次提交的模型数量。',
  invalid_panel_action: '操作请求格式不被接受，请刷新后重试。',
  translation_unavailable: '面板服务未提供翻译状态，无法保存翻译设置。',
  invalid_translation_config: '翻译设置无效：请检查服务、目标语言与自定义服务字段。',
  invalid_translation_endpoint: '自定义服务地址需使用 HTTPS（本机回环可用 HTTP），且不能包含账号、查询参数或片段。',
  invalid_translation_api_key_env: 'API Key 变量名只能使用大写字母、数字与下划线，且不能以数字开头。',
  translation_not_enabled: '请先保存启用翻译的设置，再从网关启动 Kimi。',
  translation_unsaved_draft: '翻译设置有未保存的修改，请先保存再启动。',
  translation_config_unavailable: '翻译配置当前不可用，无法启动。',
  translation_kimi_running: 'Kimi 已在运行。请正常退出 Kimi 后从网关启动；本面板不会强制结束它。',
  translation_runtime_unavailable: '翻译运行时不可用，请检查本机 Kimi 副本。',
  translation_incompatible: '未找到可注入的 Kimi 渲染入口，或页面结构与翻译引擎不匹配。',
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
  restartBanner: $('restart-banner'),
  restartBannerText: $('restart-banner-text'),
  restartBannerLink: $('restart-banner-link'),

  opbar: $('opbar'),
  opbarDot: $('opbar-dot'),
  opbarName: $('opbar-name'),
  opbarNote: $('opbar-note'),

  viewTitle: $('view-title'),
  viewLede: $('view-lede'),
  sync: $('sync'),
  refresh: $('refresh'),

  navOverview: $('nav-overview'),
  navModels: $('nav-models'),
  navSubagents: $('nav-subagents'),
  navTranslation: $('nav-translation'),
  navConnection: $('nav-connection'),
  navModelCount: $('nav-model-count'),

  railGatewayDot: $('rail-gateway-dot'),
  railGatewayText: $('rail-gateway-text'),
  railGatewayUrl: $('rail-gateway-url'),
  theme: $('theme'),

  factGatewayDot: $('fact-gateway-dot'),
  factGateway: $('fact-gateway'),
  factGatewayUrl: $('fact-gateway-url'),
  factModels: $('fact-models'),
  factModelsSub: $('fact-models-sub'),
  factRuntimeDot: $('fact-runtime-dot'),
  factRuntime: $('fact-runtime'),
  factRuntimeSub: $('fact-runtime-sub'),
  factConfigDot: $('fact-config-dot'),
  factConfig: $('fact-config'),
  factConfigFile: $('fact-config-file'),

  savedValue: $('saved-value'),
  savedSub: $('saved-sub'),
  adoptedValue: $('adopted-value'),
  adoptedSub: $('adopted-sub'),
  verdict: $('verdict'),
  verdictDot: $('verdict-dot'),
  verdictWord: $('verdict-word'),
  verdictNote: $('verdict-note'),
  goSubagents: $('go-subagents'),

  metricRequests: $('metric-requests'),
  metricFailures: $('metric-failures'),
  metricUptime: $('metric-uptime'),
  recentBody: $('recent-body'),
  recentEmpty: $('recent-empty'),

  modelQ: $('model-q'),
  modelQClear: $('model-q-clear'),
  filterAll: $('filter-all'),
  filterVision: $('filter-vision'),
  filterTools: $('filter-tools'),
  filterReasoning: $('filter-reasoning'),
  modelCount: $('model-count'),
  modelNew: $('model-new'),
  workbench: $('workbench'),
  modelBody: $('model-body'),
  modelTableWrap: $('model-table-wrap'),
  modelEmpty: $('model-empty'),
  modelEmptyTitle: $('model-empty-title'),
  modelEmptyNote: $('model-empty-note'),
  modelEmptyReset: $('model-empty-reset'),
  inspector: $('inspector'),
  inspectorTitle: $('inspector-title'),
  inspectorClose: $('inspector-close'),
  modelForm: $('model-form'),
  mId: $('m-id'),
  mIdHint: $('m-id-hint'),
  mName: $('m-name'),
  mProtocol: $('m-protocol'),
  mContext: $('m-context'),
  mOutput: $('m-output'),
  mTools: $('m-tools'),
  mReasoning: $('m-reasoning'),
  mVision: $('m-vision'),
  mEffortField: $('m-effort-field'),
  mEfforts: $('m-efforts'),
  mEffortChips: $('m-effort-chips'),
  mDefault: $('m-default'),
  modelErrors: $('model-errors'),
  modelCancel: $('model-cancel'),
  modelSave: $('model-save'),
  modelSaveNote: $('model-save-note'),

  saModes: $('sa-modes'),
  modeInherit: $('mode-inherit'),
  modeForce: $('mode-force'),
  saModel: $('sa-model'),
  saModelHint: $('sa-model-hint'),
  saEffort: $('sa-effort'),
  saEffortHint: $('sa-effort-hint'),
  saWarning: $('sa-warning'),
  saDraft: $('sa-draft'),
  saReset: $('sa-reset'),
  saSave: $('sa-save'),
  rtStateDot: $('rt-state-dot'),
  rtState: $('rt-state'),
  rtVersion: $('rt-version'),
  rtMode: $('rt-mode'),
  rtSpawn: $('rt-spawn'),
  saVerdict: $('sa-verdict'),
  saVerdictDot: $('sa-verdict-dot'),
  saVerdictWord: $('sa-verdict-word'),
  saVerdictNote: $('sa-verdict-note'),

  connForm: $('conn-form'),
  cBase: $('c-base'),
  cKeyEnv: $('c-keyenv'),
  cTokenEnv: $('c-tokenenv'),
  cPort: $('c-port'),
  cDnsPort: $('c-dnsport'),
  cDns: $('c-dns'),
  envKeyDot: $('env-key-dot'),
  envKey: $('env-key'),
  envTokenDot: $('env-token-dot'),
  envToken: $('env-token'),
  pendingDiff: $('pending-diff'),
  connErrors: $('conn-errors'),
  connDraft: $('conn-draft'),
  connFillActive: $('conn-fill-active'),
  connSave: $('conn-save'),
  restartState: $('restart-state'),
  restartFile: $('restart-file'),

  diagUpstreamDot: $('diag-upstream-dot'),
  diagUpstreamState: $('diag-upstream-state'),
  diagUpstreamMeta: $('diag-upstream-meta'),
  diagCompatDot: $('diag-compat-dot'),
  diagCompatState: $('diag-compat-state'),
  diagCompatMeta: $('diag-compat-meta'),

  updUnavailable: $('upd-unavailable'),
  updCurrent: $('upd-current'),
  updCurrentSub: $('upd-current-sub'),
  updLatest: $('upd-latest'),
  updLatestSub: $('upd-latest-sub'),
  updChecked: $('upd-checked'),
  updCheckedSub: $('upd-checked-sub'),
  updRelease: $('upd-release'),
  updPending: $('upd-pending'),
  updVerdictDot: $('upd-verdict-dot'),
  updVerdictWord: $('upd-verdict-word'),
  updVerdictNote: $('upd-verdict-note'),
  updCheck: $('upd-check'),
  updInstall: $('upd-install'),
  updRollback: $('upd-rollback'),
  updHint: $('upd-hint'),

  trUnavailable: $('tr-unavailable'),
  trForm: $('tr-form'),
  trEnabled: $('tr-enabled'),
  trProvider: $('tr-provider'),
  trProviderHint: $('tr-provider-hint'),
  trTarget: $('tr-target'),
  trView: $('tr-view'),
  trCustom: $('tr-custom'),
  trEndpoint: $('tr-endpoint'),
  trModel: $('tr-model'),
  trKeyEnv: $('tr-keyenv'),
  trKeyState: $('tr-key-state'),
  trEgress: $('tr-egress'),
  trErrors: $('tr-errors'),
  trDraft: $('tr-draft'),
  trReset: $('tr-reset'),
  trSave: $('tr-save'),
  trRuntimeDot: $('tr-runtime-dot'),
  trRuntime: $('tr-runtime'),
  trVersion: $('tr-version'),
  trPid: $('tr-pid'),
  trVerification: $('tr-verification'),
  trWarning: $('tr-warning'),
  trEnvDot: $('tr-env-dot'),
  trEnv: $('tr-env'),
  trVerdictDot: $('tr-verdict-dot'),
  trVerdictWord: $('tr-verdict-word'),
  trVerdictNote: $('tr-verdict-note'),
  trLaunch: $('tr-launch'),
  trCheck: $('tr-check'),

  toast: $('toast'),
};

const state = {
  key: null,
  data: null,
  view: 'overview',
  query: '',
  filter: 'all',
  draft: null,
  draftDirty: false,
  editor: null,
  deleteId: null,
  conn: { base: null, dirty: false },
  modelsSaving: false,
  subagentSaving: false,
  connSaving: false,
  translation: { base: null, dirty: false },
  translationSaving: false,
  reachable: null,
  pendingAction: null,
  pendingOpId: null,
  lastSync: null,
  timer: null,
  toastTimer: null,
  started: false,
};

let actionButtons = [];

/* ---------- key ---------- */

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
      /* 无存储时仅本次会话可用 */
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

  if (res.status === 401) throw new ApiError('面板会话密钥无效或已过期', 'unauthorized', 401);

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
    const error = new ApiError(ERROR_HINT[code] || message || '请求失败（HTTP ' + res.status + '）', code || 'http_' + res.status, res.status);
    error.saved = Boolean(payload && payload.error && payload.error.saved);
    error.reason = payload && payload.error && payload.error.reason;
    throw error;
  }

  return payload;
}

/* ---------- theme and view ---------- */

function applyTheme(value) {
  const mode = value === 'light' || value === 'dark' ? value : 'auto';
  document.documentElement.dataset.theme = mode;
  if (dom.theme) dom.theme.value = mode;
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
  applyTheme(stored || 'light');
}

function initView() {
  let stored = null;
  try {
    stored = sessionStorage.getItem(VIEW_STORE);
  } catch {
    stored = null;
  }
  setView(VIEW_COPY[stored] ? stored : 'overview', { persist: false });
}

function setView(view, { persist = true } = {}) {
  if (!VIEW_COPY[view]) view = 'overview';
  state.view = view;
  Object.keys(VIEW_COPY).forEach((name) => {
    const section = $('view-' + name);
    if (section) section.hidden = name !== view;
    const nav = $('nav-' + name);
    if (nav) nav.setAttribute('aria-current', name === view ? 'page' : 'false');
  });
  if (dom.viewTitle) dom.viewTitle.textContent = VIEW_COPY[view].title;
  if (dom.viewLede) dom.viewLede.textContent = VIEW_COPY[view].lede;
  if (persist) {
    try {
      sessionStorage.setItem(VIEW_STORE, view);
    } catch {
      /* 忽略 */
    }
  }
  if (view === 'models') renderModels();
  if (view === 'subagents') renderSubagents();
  if (view === 'translation') renderTranslation();
  if (view === 'connection') renderConnection();
}

/* ---------- format ---------- */

function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

function setDot(el, tone) {
  if (el) el.dataset.tone = tone || 'neutral';
}

function setHidden(el, hidden) {
  if (el) el.hidden = Boolean(hidden);
}

function fmtCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

function fmtK(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
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

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return hours + ' 小时 ' + String(minutes).padStart(2, '0') + ' 分';
  if (minutes) return minutes + ' 分 ' + String(total % 60).padStart(2, '0') + ' 秒';
  return total + ' 秒';
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

function reasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  return DIAG_REASON[code] || code;
}

/* ---------- catalogue helpers ---------- */

function modelIndex() {
  const map = new Map();
  const list = state.data && Array.isArray(state.data.models) ? state.data.models : [];
  list.forEach((m) => {
    if (m && typeof m.id === 'string') map.set(m.id, m);
  });
  return map;
}

function findModel(id) {
  if (typeof id !== 'string' || !id) return null;
  return modelIndex().get(id) || null;
}

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

function modelFamilyFor(id) {
  const text = String(id || '').trim();
  if (!text) return null;
  const last = text.slice(text.lastIndexOf('/') + 1).toLowerCase();
  return last.startsWith('kimi-') ? 'chat' : 'responses';
}

function isCapable(model) {
  return Boolean(model && model.tools === true);
}

function hasVision(model) {
  return Boolean(model && Array.isArray(model.inputModalities) && model.inputModalities.includes('image'));
}

function declaredEfforts(model) {
  if (!model || model.reasoning !== true || !Array.isArray(model.reasoningEfforts)) return [];
  return model.reasoningEfforts.filter((value) => typeof value === 'string' && value);
}

function canonicalModel(model) {
  if (!model) return '';
  return JSON.stringify([
    model.id || '',
    model.name || '',
    model.protocol || '',
    model.contextWindow || 0,
    model.maxOutputTokens || 0,
    model.tools === true,
    model.reasoning === true,
    (model.inputModalities || ['text']).join(','),
    (model.reasoningEfforts || []).join(','),
    model.defaultEffort || '',
  ]);
}

function parseEfforts(text) {
  const parts = String(text || '').split(',').map((part) => part.trim()).filter(Boolean);
  const list = [];
  const invalid = [];
  for (const part of parts) {
    const value = part.toLowerCase();
    if (!EFFORT_PATTERN.test(value)) invalid.push(part);
    else if (!list.includes(value)) list.push(value);
  }
  return { list, invalid };
}

function buildModel(input) {
  const errors = [];
  const id = String(input.id || '').trim();
  if (!id) errors.push('模型 ID 不能为空。');
  else if (/[\u0000-\u001f]/.test(id)) errors.push('模型 ID 不能包含控制字符。');
  else if (id.length > 2048) errors.push('模型 ID 过长。');

  const contextWindow = Number(input.context);
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) errors.push('上下文窗口必须是正整数。');

  const outputText = String(input.output || '').trim();
  let maxOutputTokens;
  if (outputText) {
    maxOutputTokens = Number(outputText);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) errors.push('最大输出必须是正整数，或留空。');
  }

  const parsed = parseEfforts(input.efforts);
  if (parsed.invalid.length) {
    errors.push('思考档位只能是小写标识符（例如 low、medium、high）：' + parsed.invalid.join('、') + '。');
  }

  const reasoning = input.reasoning === true;
  let defaultEffort;
  if (reasoning && parsed.list.length) {
    const wanted = String(input.defaultEffort || '').trim();
    if (wanted) {
      if (!parsed.list.includes(wanted)) errors.push('默认档位必须是已列出的档位之一。');
      else defaultEffort = wanted;
    }
  }

  const model = {
    id,
    ...(String(input.name || '').trim() ? { name: String(input.name).trim() } : {}),
    protocol: modelFamilyFor(id) || 'responses',
    contextWindow,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    tools: input.tools === true,
    reasoning,
    inputModalities: input.vision === true ? ['text', 'image'] : ['text'],
    ...(reasoning && parsed.list.length ? { reasoningEfforts: parsed.list } : {}),
    ...(defaultEffort ? { defaultEffort } : {}),
  };
  return { model, errors };
}

function catalogueWith(editor, models) {
  const built = buildModel(editor.draft).model;
  const list = models.map((model) => ({ ...model }));
  const index = editor.originalId ? list.findIndex((model) => model.id === editor.originalId) : -1;
  if (index >= 0) list[index] = built;
  else list.push(built);
  return list;
}

/* ---------- connection helpers ---------- */

function connectionSource(data) {
  const connection = (data && data.connection) || {};
  return connection.saved || connection.active || null;
}

function normalizeBaseURL(value) {
  const text = String(value || '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: '上游地址不是合法的 URL。' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: '上游地址必须使用 HTTPS（本机回环可用 HTTP）。' };
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url.href)) return { error: '上游地址不能包含账号或密码。' };
  if (url.search || url.hash) return { error: '上游地址不能包含查询参数或片段。' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return { error: '非本机地址必须使用 HTTPS。' };
  return { value: url.href.replace(/\/$/, '') };
}

function buildConnection(input) {
  const errors = [];
  const base = normalizeBaseURL(input.baseURL);
  if (base.error) errors.push(base.error);

  const apiKeyEnv = String(input.apiKeyEnv || '').trim();
  if (!ENV_PATTERN.test(apiKeyEnv)) errors.push('API Key 变量名只能使用大写字母、数字与下划线，且不能以数字开头。');

  const tokenEnv = String(input.tokenEnv || '').trim();
  if (!ENV_PATTERN.test(tokenEnv)) errors.push('网关 Token 变量名只能使用大写字母、数字与下划线，且不能以数字开头。');

  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('网关端口必须是 0–65535 的整数。');

  const dnsPort = Number(input.dnsPort);
  if (!Number.isInteger(dnsPort) || dnsPort < 1024 || dnsPort > 65535) errors.push('DNS 端口必须是 1024–65535 的整数。');

  return {
    errors,
    value: {
      upstream: { baseURL: base.value || String(input.baseURL || '').trim(), apiKeyEnv },
      tokenEnv,
      port,
      dns: { enabled: input.dns === true, port: dnsPort },
    },
  };
}

function connectionFormValues() {
  return {
    baseURL: dom.cBase ? dom.cBase.value : '',
    apiKeyEnv: dom.cKeyEnv ? dom.cKeyEnv.value : '',
    tokenEnv: dom.cTokenEnv ? dom.cTokenEnv.value : '',
    port: dom.cPort ? dom.cPort.value : '',
    dnsPort: dom.cDnsPort ? dom.cDnsPort.value : '',
    dns: Boolean(dom.cDns && dom.cDns.checked),
  };
}

function connectionKey(value) {
  if (!value) return '';
  return JSON.stringify([value.baseURL, value.apiKeyEnv, value.tokenEnv, String(value.port), String(value.dnsPort), Boolean(value.dns)]);
}

function sourceFormValues(source) {
  if (!source) return { baseURL: '', apiKeyEnv: '', tokenEnv: '', port: '', dnsPort: '', dns: false };
  return {
    baseURL: source.upstream && source.upstream.baseURL ? source.upstream.baseURL : '',
    apiKeyEnv: source.upstream && source.upstream.apiKeyEnv ? source.upstream.apiKeyEnv : '',
    tokenEnv: source.tokenEnv || '',
    port: source.port === undefined ? '' : String(source.port),
    dnsPort: source.dns && source.dns.port !== undefined ? String(source.dns.port) : '',
    dns: Boolean(source.dns && source.dns.enabled),
  };
}

function fillConnectionForm() {
  const source = connectionSource(state.data);
  const values = sourceFormValues(source);
  if (source) {
    if (dom.cBase) dom.cBase.value = values.baseURL;
    if (dom.cKeyEnv) dom.cKeyEnv.value = values.apiKeyEnv;
    if (dom.cTokenEnv) dom.cTokenEnv.value = values.tokenEnv;
    if (dom.cPort) dom.cPort.value = values.port;
    if (dom.cDnsPort) dom.cDnsPort.value = values.dnsPort;
    if (dom.cDns) dom.cDns.checked = values.dns;
  }
  state.conn.base = connectionKey(values);
  state.conn.dirty = false;
}

/* ---------- translation helpers ---------- */

const TRANSLATION_DEFAULTS = {
  enabled: false,
  provider: 'bing',
  targetLanguage: 'zh',
  view: 'translated',
  customEndpoint: '',
  customModel: '',
  apiKeyEnv: 'KIMI_WORK_TRANSLATION_API_KEY',
};
const TRANSLATION_PROVIDERS = ['bing', 'google', 'custom'];
const TRANSLATION_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'ru'];
const TRANSLATION_VIEWS = ['translated', 'original'];

function translationPayload(data) {
  return (data && data.translation) || null;
}

function translationAvailable(data) {
  return Boolean(translationPayload(data));
}

function savedTranslation(data) {
  const payload = translationPayload(data);
  const configured = (payload && payload.configured) || {};
  return {
    enabled: configured.enabled === true,
    provider: TRANSLATION_PROVIDERS.includes(configured.provider) ? configured.provider : TRANSLATION_DEFAULTS.provider,
    targetLanguage: TRANSLATION_LANGUAGES.includes(configured.targetLanguage)
      ? configured.targetLanguage
      : TRANSLATION_DEFAULTS.targetLanguage,
    view: TRANSLATION_VIEWS.includes(configured.view) ? configured.view : TRANSLATION_DEFAULTS.view,
    customEndpoint: typeof configured.customEndpoint === 'string' ? configured.customEndpoint : '',
    customModel: typeof configured.customModel === 'string' ? configured.customModel : '',
    apiKeyEnv: typeof configured.apiKeyEnv === 'string' && configured.apiKeyEnv
      ? configured.apiKeyEnv
      : TRANSLATION_DEFAULTS.apiKeyEnv,
  };
}

function translationFormValues() {
  return {
    enabled: Boolean(dom.trEnabled && dom.trEnabled.checked),
    provider: dom.trProvider ? dom.trProvider.value : TRANSLATION_DEFAULTS.provider,
    targetLanguage: dom.trTarget ? dom.trTarget.value : TRANSLATION_DEFAULTS.targetLanguage,
    view: dom.trView ? dom.trView.value : TRANSLATION_DEFAULTS.view,
    customEndpoint: dom.trEndpoint ? dom.trEndpoint.value : '',
    customModel: dom.trModel ? dom.trModel.value : '',
    apiKeyEnv: dom.trKeyEnv ? dom.trKeyEnv.value : '',
  };
}

function translationKey(value) {
  if (!value) return '';
  return JSON.stringify([
    Boolean(value.enabled),
    value.provider,
    value.targetLanguage,
    value.view,
    String(value.customEndpoint || '').trim(),
    String(value.customModel || '').trim(),
    String(value.apiKeyEnv || '').trim(),
  ]);
}

function normalizeTranslationEndpoint(value) {
  const text = String(value || '').trim();
  if (!text) return { error: '自定义服务需要填写完整的 Chat Completions 地址。' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { error: '自定义服务地址不是合法的 URL。' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: '自定义服务地址必须使用 HTTPS（本机回环可用 HTTP）。' };
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(url.href)) return { error: '自定义服务地址不能包含账号或密码。' };
  if (url.search || url.hash) return { error: '自定义服务地址不能包含查询参数或片段。' };
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) return { error: '非本机地址必须使用 HTTPS。' };
  return { value: url.href };
}

/* 与保存按钮共用同一套规则，避免界面说可用而服务端拒绝。 */
function buildTranslation(input) {
  const errors = [];
  const provider = TRANSLATION_PROVIDERS.includes(input.provider) ? input.provider : TRANSLATION_DEFAULTS.provider;
  const targetLanguage = TRANSLATION_LANGUAGES.includes(input.targetLanguage)
    ? input.targetLanguage
    : TRANSLATION_DEFAULTS.targetLanguage;
  const view = TRANSLATION_VIEWS.includes(input.view) ? input.view : TRANSLATION_DEFAULTS.view;

  let customEndpoint = '';
  const customModel = String(input.customModel || '').trim();
  let apiKeyEnv = String(input.apiKeyEnv || '').trim();
  if (customModel.length > 2048 || /[\x00-\x1f\x7f]/.test(customModel)) errors.push('模型名称过长或包含控制字符。');

  if (provider === 'custom') {
    const endpoint = normalizeTranslationEndpoint(input.customEndpoint);
    if (endpoint.error) errors.push(endpoint.error);
    else customEndpoint = endpoint.value;
    if (apiKeyEnv && (!ENV_PATTERN.test(apiKeyEnv) || apiKeyEnv.length > 128)) {
      errors.push('API Key 变量名只能使用大写字母、数字与下划线，最长 128 字符，且不能以数字开头。');
    }
  } else {
    const endpoint = normalizeTranslationEndpoint(input.customEndpoint);
    if (!endpoint.error) customEndpoint = endpoint.value;
    if (apiKeyEnv && (!ENV_PATTERN.test(apiKeyEnv) || apiKeyEnv.length > 128)) apiKeyEnv = '';
  }
  if (!apiKeyEnv) apiKeyEnv = TRANSLATION_DEFAULTS.apiKeyEnv;

  return {
    errors,
    value: {
      enabled: input.enabled === true,
      provider,
      targetLanguage,
      view,
      customEndpoint,
      customModel,
      apiKeyEnv,
    },
  };
}

function fillTranslationForm() {
  const values = savedTranslation(state.data);
  if (dom.trEnabled) dom.trEnabled.checked = values.enabled;
  if (dom.trProvider) dom.trProvider.value = values.provider;
  if (dom.trTarget) dom.trTarget.value = values.targetLanguage;
  if (dom.trView) dom.trView.value = values.view;
  if (dom.trEndpoint) dom.trEndpoint.value = values.customEndpoint;
  if (dom.trModel) dom.trModel.value = values.customModel;
  if (dom.trKeyEnv) dom.trKeyEnv.value = values.apiKeyEnv;
  state.translation.base = translationKey(values);
  state.translation.dirty = false;
}

function translationDirty() {
  if (!translationAvailable(state.data)) return false;
  return translationKey(translationFormValues()) !== state.translation.base;
}

/* ---------- target draft ---------- */

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
            ? modelIdFromAlias(configured.modelAlias) || configured.modelAlias
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

function recomputeDraftDirty() {
  const saved = state.data ? savedTarget(state.data) : null;
  state.draftDirty = Boolean(state.data && state.draft) && !sameTarget(state.draft, saved);
}

function configInfo(data) {
  const config = (data && data.configuration) || {};
  return CONFIG_STATE[config.state] || { tone: 'neutral', word: '未知', note: '' };
}

function configReady(data) {
  return Boolean(data && data.configuration && data.configuration.state === 'ready');
}

/* ---------- verdict ---------- */

function evaluateBinding(data) {
  if (!data) return { tone: 'neutral', word: '读取中', note: '' };

  const saved = savedTarget(data);
  const runtime = (data.subagents && data.subagents.runtime) || {};
  const policy = (data.subagents && data.subagents.policy) || {};
  const config = data.configuration || {};

  if (config.state !== 'ready') {
    const info = configInfo(data);
    return { tone: 'bad', word: '配置' + info.word, note: '配置文件当前不可用，保存已禁用。重启面板后重新载入。' };
  }

  const runtimeState = typeof runtime.state === 'string' ? runtime.state : 'unavailable';
  const info = RUNTIME_STATE[runtimeState] || { tone: 'neutral', word: runtimeState, note: '' };

  if (runtimeState === 'conflict') {
    return { tone: 'bad', word: '策略冲突', note: runtime.reason || '运行时策略与保存目标不一致。' };
  }

  if (saved.mode === 'inherit') {
    if (runtimeState === 'loaded' && policy.mode === 'inherit' && runtime.mode === 'inherit') {
      return { tone: 'ok', word: '继承已生效', note: '运行时以继承模式加载，跟随主模型。' };
    }
    if (runtimeState === 'loaded' && (policy.mode === 'force' || runtime.mode === 'force')) {
      return { tone: 'warn', word: '未恢复继承', note: '运行时仍在使用固定模型，重新应用后由新的子代理会话采用。' };
    }
    if (policy.mode === 'blocked') {
      return { tone: 'bad', word: '子代理被阻止', note: policy.reason || '运行时策略禁止子代理。' };
    }
    return { tone: info.tone, word: info.word, note: info.note };
  }

  if (policy.mode === 'blocked') {
    return { tone: 'bad', word: '子代理被阻止', note: policy.reason || '运行时策略禁止子代理。' };
  }

  if (runtimeState === 'loaded') {
    const adoptedId = modelIdFromAlias(runtime.modelAlias);
    const policyId = typeof policy.model === 'string' && policy.model ? policy.model : modelIdFromAlias(policy.modelAlias);
    const effortOf = (value) => (typeof value === 'string' && value ? value : null);
    const modeAgrees = runtime.mode === 'force' && policy.mode === 'force';
    const modelAgrees = adoptedId !== null && adoptedId === policyId && policyId === saved.model;
    const effortAgrees = effortOf(policy.effort) === effortOf(saved.effort);

    if (modeAgrees && modelAgrees && effortAgrees) {
      return { tone: 'ok', word: '已生效', note: '运行时已加载固定模型与档位，与保存目标一致。' };
    }
    if (modelAgrees && !effortAgrees) {
      return { tone: 'warn', word: '档位不一致', note: '运行时的思考档位与保存目标不同，重新应用后由新的子代理会话采用。' };
    }
    return { tone: 'warn', word: '待采用', note: '运行时加载的模型或模式与保存目标不同，重新应用后由新的子代理会话采用。' };
  }

  return { tone: info.tone, word: info.word, note: info.note };
}

/* ---------- render: shell ---------- */

function renderShell(data) {
  const gw = (data && data.gateway) || {};
  const running = gw.state === 'running';
  setDot(dom.railGatewayDot, running ? 'ok' : 'bad');
  setText(dom.railGatewayText, running ? '运行中' : '已停止');
  setText(dom.railGatewayUrl, typeof gw.url === 'string' && gw.url ? gw.url : '—');
  setText(dom.sync, state.lastSync ? '同步于 ' + fmtTime(state.lastSync) : '尚未同步');

  const config = (data && data.configuration) || {};
  setHidden(dom.restartBanner, config.state !== 'changed');
  if (config.state === 'changed') {
    setText(dom.restartBannerText, '连接配置已修改，当前进程仍在使用启动时的设置。模型、子代理与翻译保存已禁用，重启面板后生效。');
  }
  setText(dom.navModelCount, fmtCount((data.models || []).length));
}

function renderOverview(data) {
  const gw = (data && data.gateway) || {};
  const running = gw.state === 'running';
  setDot(dom.factGatewayDot, running ? 'ok' : 'bad');
  setText(dom.factGateway, running ? '运行中' : '已停止');
  setText(dom.factGatewayUrl, gw.url || '—');

  const models = Array.isArray(data.models) ? data.models : [];
  setText(dom.factModels, fmtCount(models.length) + ' 个模型');
  setText(dom.factModelsSub, '可用于子代理 ' + fmtCount(models.filter(isCapable).length) + ' 个');

  const runtime = (data.subagents && data.subagents.runtime) || {};
  const runtimeInfo = RUNTIME_STATE[runtime.state] || { tone: 'neutral', word: '未知', note: '' };
  setDot(dom.factRuntimeDot, runtimeInfo.tone);
  setText(dom.factRuntime, runtimeInfo.word);
  setText(dom.factRuntimeSub, runtimeInfo.note || '—');

  const info = configInfo(data);
  setDot(dom.factConfigDot, info.tone);
  setText(dom.factConfig, info.word);
  setText(dom.factConfigFile, (data.configuration && data.configuration.file) || '—');

  const saved = savedTarget(data);
  const savedModel = saved.mode === 'force' ? findModel(saved.model) : null;
  setText(dom.savedValue, saved.mode === 'inherit' ? '继承主模型' : saved.model ? modelLabel(savedModel, saved.model) : '未选择');
  const savedParts = saved.mode === 'force'
    ? [saved.model, saved.effort ? '档位 ' + saved.effort : '档位自动'].filter(Boolean)
    : ['不固定模型与档位'];
  setText(dom.savedSub, savedParts.join(' · '));

  const loaded = runtime.state === 'loaded';
  const observedAlias = loaded && typeof runtime.modelAlias === 'string' ? runtime.modelAlias : null;
  const observedId = modelIdFromAlias(observedAlias);
  const observedMode = loaded && typeof runtime.mode === 'string' ? runtime.mode : null;
  const adoptedLabel = !loaded
    ? '尚未加载'
    : observedMode === 'inherit'
      ? '继承主模型'
      : observedId
        ? modelLabel(findModel(observedId), observedId)
        : '未固定模型';
  setText(dom.adoptedValue, adoptedLabel);
  const adoptedParts = loaded
    ? [observedMode ? '模式 ' + observedMode : '', observedAlias || '', runtime.version ? 'v' + runtime.version : ''].filter(Boolean)
    : ['运行时尚未加载策略'];
  setText(dom.adoptedSub, adoptedParts.join(' · '));

  const verdict = evaluateBinding(data);
  setDot(dom.verdictDot, verdict.tone);
  setText(dom.verdictWord, verdict.word);
  setText(dom.verdictNote, verdict.note);

  const metrics = data.metrics || {};
  setText(dom.metricRequests, fmtCount(metrics.requests || 0));
  setText(dom.metricFailures, fmtCount(metrics.failures || 0));
  setText(dom.metricUptime, typeof metrics.startedAt === 'number' ? fmtDuration(Date.now() - metrics.startedAt) : '—');
  renderRecent(Array.isArray(metrics.recent) ? metrics.recent : []);
}

let recentSignature = '';

function renderRecent(recent) {
  setText(dom.recentEmpty, '尚无推理请求。Kimi 开始调用模型后，这里会出现最近的 20 条记录。');
  const signature = JSON.stringify(recent);
  if (signature === recentSignature) {
    setHidden(dom.recentEmpty, recent.length > 0);
    return;
  }
  recentSignature = signature;
  const rows = recent.map((row) => {
    const tr = document.createElement('tr');
    const time = document.createElement('td');
    time.className = 'mono';
    time.textContent = fmtTime(row && row.at);
    const model = document.createElement('td');
    model.className = 'mono cell-id';
    model.textContent = (row && row.model) || '—';
    const protocol = document.createElement('td');
    protocol.textContent = row && row.protocol === 'chat' ? 'chat' : 'responses';
    const status = document.createElement('td');
    status.className = 'num mono';
    status.textContent = row && typeof row.status === 'number' ? String(row.status) : '—';
    status.dataset.tone = row && row.status >= 400 ? 'bad' : 'neutral';
    const ms = document.createElement('td');
    ms.className = 'num mono';
    ms.textContent = row && typeof row.ms === 'number' ? String(row.ms) + ' ms' : '—';
    if (row && row.error) {
      const error = document.createElement('span');
      error.className = 'cell-error';
      error.textContent = row.error;
      status.append(error);
    }
    tr.append(time, model, protocol, status, ms);
    return tr;
  });
  if (dom.recentBody) dom.recentBody.replaceChildren(...rows);
  setHidden(dom.recentEmpty, rows.length > 0);
}

/* ---------- render: operation ---------- */

function isInFlight(op) {
  return Boolean(op && op.state === 'running');
}

function operationNote(op) {
  if (op && op.state === 'waiting-kimi-exit') {
    const launch = op.action === 'launch-translated-kimi' ? '「从网关启动 Kimi」' : '「启动 Kimi」';
    return 'Kimi 已在运行。请正常退出 Kimi，再点一次' + launch + '；本面板不会强制结束它。';
  }
  const code = op && typeof op.reason === 'string' && op.reason ? op.reason : '';
  if (!code) return '';
  /* 更新操作的原因是 update_* 代码，与诊断原因表不共享命名空间。 */
  if (UPDATE_ACTIONS.has(op.action) || code.startsWith('update_')) return updateReasonText(code);
  return reasonText(code);
}

function renderOperation(data) {
  const op = data && data.operation;
  if (!op) {
    setHidden(dom.opbar, true);
    return;
  }
  const label = ACTION_LABEL[op.action] || op.action || '操作';
  const word = ACTION_STATE[op.state] || op.state || '未知';
  const running = isInFlight(op);
  const bad = op.state === 'failed' || op.state === 'interrupted' || op.state === 'unavailable' || op.state === 'incompatible';
  setHidden(dom.opbar, false);
  setDot(dom.opbarDot, running ? 'warn' : bad ? 'bad' : 'ok');
  setText(dom.opbarName, label + ' · ' + word);
  setText(dom.opbarNote, operationNote(op) || '');
  dom.opbar.dataset.running = running ? 'true' : 'false';
}

function renderActions(data) {
  if (!actionButtons.length) return;
  const running = isInFlight(data && data.operation);
  const busy = running || state.modelsSaving || state.subagentSaving || state.connSaving || state.translationSaving;
  const ready = configReady(data);
  const translationDirty = translationAvailable(data) ? state.translation.dirty : false;
  const launch = translationLaunchState(data, { dirty: translationDirty });
  for (const button of actionButtons) {
    const action = button.dataset.action;
    /* 更新按钮的可安装判断依赖 updates 与待重启版本，交给 renderUpdateButtons 统一处理。 */
    if (UPDATE_ACTIONS.has(action)) continue;
    const needsReady = action === 'prepare-runtime' || action === 'launch-kimi';
    const isTranslation = action === 'launch-translated-kimi' || action === 'check-translation';
    const pending = state.pendingAction === action;
    const translationBlocked = action === 'launch-translated-kimi'
      ? !launch.ready
      : action === 'check-translation'
        ? !translationAvailable(data) || !ready
        : false;
    button.disabled = busy || (needsReady && !ready) || (isTranslation && translationBlocked);
    button.classList.toggle('is-busy', pending);
    button.setAttribute('aria-busy', pending ? 'true' : 'false');
  }
}

/* ---------- render: model catalogue ---------- */

function matchesQuery(model, needle) {
  if (!needle) return true;
  const fields = [model.id, model.name, model.protocol, ...(model.reasoningEfforts || [])]
    .filter((value) => typeof value === 'string');
  return fields.some((value) => value.toLowerCase().includes(needle));
}

function filterModels() {
  const data = state.data;
  const all = data && Array.isArray(data.models) ? data.models : [];
  const needle = state.query.trim().toLowerCase();
  return {
    all,
    filtered: all
      .filter((model) => model && typeof model.id === 'string')
      .filter((model) => (state.filter === 'vision' ? hasVision(model)
        : state.filter === 'tools' ? isCapable(model)
          : state.filter === 'reasoning' ? model.reasoning === true
            : true))
      .filter((model) => matchesQuery(model, needle)),
  };
}

let modelSignature = '';

function renderModels() {
  const data = state.data;
  const { all, filtered } = filterModels();
  const saved = data ? savedTarget(data) : { mode: 'inherit', model: null };
  const signature = JSON.stringify([
    filtered.map(canonicalModel),
    state.editor ? state.editor.originalId : null,
    state.deleteId,
    state.modelsSaving,
    saved,
    configReady(data),
  ]);

  const total = all.filter((model) => model && typeof model.id === 'string').length;
  setText(dom.modelCount, filtered.length + ' / ' + total + ' · 可用于子代理 ' + all.filter(isCapable).length);

  const empty = filtered.length === 0;
  setHidden(dom.modelEmpty, !empty);
  setHidden(dom.modelTableWrap, empty);
  if (empty) {
    if (!total) {
      setText(dom.modelEmptyTitle, '目录为空');
      setText(dom.modelEmptyNote, '配置中的模型目录没有模型。用「新增模型」添加，或检查配置文件后重启面板。');
      setHidden(dom.modelEmptyReset, true);
    } else if (state.filter !== 'all' && !all.some((model) => (state.filter === 'vision' ? hasVision(model)
      : state.filter === 'tools' ? isCapable(model) : model.reasoning === true))) {
      setText(dom.modelEmptyTitle, '没有符合此筛选的模型');
      setText(dom.modelEmptyNote, '当前目录中没有模型声明该能力。清除筛选可查看全部模型。');
      setHidden(dom.modelEmptyReset, false);
    } else {
      setText(dom.modelEmptyTitle, '没有匹配的模型');
      setText(dom.modelEmptyNote, state.query ? '没有模型匹配「' + truncate(state.query.trim(), 24) + '」。' : '清除筛选以查看全部模型。');
      setHidden(dom.modelEmptyReset, false);
    }
  }

  if (signature === modelSignature) return;
  modelSignature = signature;

  if (!data) {
    if (dom.modelBody) dom.modelBody.replaceChildren();
    return;
  }

  const scrollTop = dom.modelTableWrap ? dom.modelTableWrap.scrollTop : 0;
  const rows = filtered.map((model) => buildModelRow(model, saved));
  if (dom.modelBody) dom.modelBody.replaceChildren(...rows);
  if (dom.modelTableWrap) dom.modelTableWrap.scrollTop = scrollTop;
}

function buildModelRow(model, saved) {
  const tr = document.createElement('tr');
  tr.dataset.modelId = model.id;
  if (state.editor && state.editor.originalId === model.id) tr.dataset.editing = 'true';
  if (saved.mode === 'force' && saved.model === model.id) tr.dataset.saved = 'true';

  const idCell = document.createElement('td');
  const id = document.createElement('span');
  id.className = 'mono cell-id';
  id.textContent = model.id;
  id.setAttribute('title', model.id);
  idCell.append(id);
  if (model.name && model.name !== model.id) {
    const name = document.createElement('span');
    name.className = 'cell-name';
    name.textContent = model.name;
    idCell.append(name);
  }
  if (saved.mode === 'force' && saved.model === model.id) {
    const flag = document.createElement('span');
    flag.className = 'tag tag--saved';
    flag.textContent = '子代理';
    idCell.append(flag);
  }

  const proto = document.createElement('td');
  proto.className = 'col-proto';
  const protoTag = document.createElement('span');
  protoTag.className = 'tag mono';
  protoTag.textContent = model.protocol === 'chat' ? 'chat' : 'responses';
  proto.append(protoTag);

  const context = document.createElement('td');
  context.className = 'num mono';
  context.textContent = fmtK(model.contextWindow);

  const output = document.createElement('td');
  output.className = 'num mono col-out';
  output.textContent = model.maxOutputTokens ? fmtK(model.maxOutputTokens) : '—';

  const caps = document.createElement('td');
  caps.className = 'col-cap';
  const capTags = [];
  const addTag = (text) => {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = text;
    capTags.push(tag);
  };
  if (model.tools) addTag('工具');
  if (model.reasoning) addTag('推理');
  if (hasVision(model)) addTag('视觉');
  if (!capTags.length) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = '—';
    caps.append(none);
  } else {
    caps.append(...capTags);
  }

  const efforts = document.createElement('td');
  efforts.className = 'col-efforts mono cell-efforts';
  const list = declaredEfforts(model);
  efforts.textContent = list.length ? list.join(', ') : '—';
  if (list.length) efforts.setAttribute('title', list.join(', '));

  const actions = document.createElement('td');
  actions.className = 'col-actions';

  if (state.deleteId === model.id) {
    tr.dataset.confirm = 'true';
    const confirmText = document.createElement('span');
    confirmText.className = 'confirm__text';
    confirmText.textContent = '删除？';
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn btn--danger btn--sm';
    yes.dataset.rowDelete = 'confirm';
    yes.dataset.modelId = model.id;
    yes.textContent = '删除';
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn btn--quiet btn--sm';
    no.dataset.rowDelete = 'cancel';
    no.dataset.modelId = model.id;
    no.textContent = '取消';
    actions.append(confirmText, yes, no);
  } else {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'iconbtn';
    edit.dataset.rowEdit = model.id;
    edit.setAttribute('aria-label', '编辑 ' + model.id);
    edit.append(iconUse('i-edit'));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'iconbtn iconbtn--danger';
    remove.dataset.rowDelete = 'ask';
    remove.dataset.modelId = model.id;
    remove.setAttribute('aria-label', '删除 ' + model.id);
    remove.append(iconUse('i-trash'));
    actions.append(edit, remove);
  }

  tr.append(idCell, proto, context, output, caps, efforts, actions);
  return tr;
}

function iconUse(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}

/* ---------- render: editor ---------- */

function openEditor(model) {
  state.deleteId = null;
  state.editor = {
    originalId: model ? model.id : null,
    confirmClose: false,
    serverErrors: [],
    draft: model
      ? {
        id: model.id,
        name: model.name || '',
        context: String(model.contextWindow || ''),
        output: model.maxOutputTokens ? String(model.maxOutputTokens) : '',
        tools: model.tools === true,
        reasoning: model.reasoning === true,
        vision: hasVision(model),
        efforts: (model.reasoningEfforts || []).join(', '),
        defaultEffort: model.defaultEffort || '',
      }
      : { id: '', name: '', context: '', output: '', tools: true, reasoning: false, vision: false, efforts: '', defaultEffort: '' },
  };
  fillEditorFields();
  renderEditor();
  renderModels();
  const focusTarget = state.editor.originalId ? dom.mName : dom.mId;
  if (focusTarget && focusTarget.focus) focusTarget.focus();
}

function closeEditor(force) {
  if (!state.editor) return;
  if (!force && editorDirty() && !state.editor.confirmClose) {
    state.editor.confirmClose = true;
    renderEditor();
    return;
  }
  state.editor = null;
  renderEditor();
  renderModels();
}

function fillEditorFields() {
  const draft = state.editor && state.editor.draft;
  if (!draft) return;
  if (dom.mId) dom.mId.value = draft.id;
  if (dom.mName) dom.mName.value = draft.name;
  if (dom.mContext) dom.mContext.value = draft.context;
  if (dom.mOutput) dom.mOutput.value = draft.output;
  if (dom.mTools) dom.mTools.checked = draft.tools;
  if (dom.mReasoning) dom.mReasoning.checked = draft.reasoning;
  if (dom.mVision) dom.mVision.checked = draft.vision;
  if (dom.mEfforts) dom.mEfforts.value = draft.efforts;
}

function readEditorFields() {
  const draft = state.editor && state.editor.draft;
  if (!draft) return;
  draft.id = dom.mId ? dom.mId.value : draft.id;
  draft.name = dom.mName ? dom.mName.value : draft.name;
  draft.context = dom.mContext ? dom.mContext.value : draft.context;
  draft.output = dom.mOutput ? dom.mOutput.value : draft.output;
  draft.tools = Boolean(dom.mTools && dom.mTools.checked);
  draft.reasoning = Boolean(dom.mReasoning && dom.mReasoning.checked);
  draft.vision = Boolean(dom.mVision && dom.mVision.checked);
  draft.efforts = dom.mEfforts ? dom.mEfforts.value : draft.efforts;
  draft.defaultEffort = dom.mDefault ? dom.mDefault.value : draft.defaultEffort;
}

function editorDirty() {
  const editor = state.editor;
  if (!editor) return false;
  if (!editor.originalId) {
    const draft = editor.draft;
    return Boolean(draft.id || draft.name || draft.context || draft.output || draft.efforts || draft.reasoning || draft.vision);
  }
  const original = findModel(editor.originalId);
  return canonicalModel(buildModel(editor.draft).model) !== canonicalModel(original);
}

function validateEditor(editor) {
  const { model, errors } = buildModel(editor.draft);
  const models = (state.data && state.data.models) || [];
  const duplicate = models.some((row) => row.id === model.id && row.id !== editor.originalId);
  if (duplicate) errors.push('已存在相同 ID 的模型。');
  return { model, errors };
}

function renderEditor() {
  const editor = state.editor;
  if (!editor) {
    setHidden(dom.inspector, true);
    if (dom.workbench) dom.workbench.dataset.open = 'false';
    return;
  }
  setHidden(dom.inspector, false);
  if (dom.workbench) dom.workbench.dataset.open = 'true';
  setText(dom.inspectorTitle, editor.originalId ? '编辑模型' : '新增模型');

  const id = String(editor.draft.id || '').trim();
  setText(dom.mProtocol, modelFamilyFor(id) || '—');

  const parsed = parseEfforts(editor.draft.efforts);
  const chips = [];
  parsed.list.forEach((value) => {
    const chip = document.createElement('span');
    chip.className = 'chip mono';
    chip.textContent = value;
    chips.push(chip);
  });
  parsed.invalid.forEach((value) => {
    const chip = document.createElement('span');
    chip.className = 'chip chip--bad mono';
    chip.textContent = value;
    chips.push(chip);
  });
  if (dom.mEffortChips) dom.mEffortChips.replaceChildren(...chips);

  syncDefaultOptions(parsed.list, editor.draft.defaultEffort);

  const reasoning = editor.draft.reasoning === true;
  if (dom.mEfforts) dom.mEfforts.disabled = !reasoning;
  if (dom.mDefault) dom.mDefault.disabled = !reasoning || !parsed.list.length;
  setHidden(dom.mEffortField, false);

  const { errors } = validateEditor(editor);
  const ready = configReady(state.data);
  const dirty = editorDirty();

  if (dom.modelErrors) {
    const messages = (editor.serverErrors || []).concat(errors);
    if (!ready && state.data) messages.unshift('配置当前不是就绪状态，保存已禁用。请先重启面板。');
    if (editor.confirmClose) messages.unshift('关闭会丢弃未保存的修改。');
    setHidden(dom.modelErrors, messages.length === 0);
    const nodes = messages.map((message) => {
      const p = document.createElement('p');
      p.textContent = message;
      return p;
    });
    if (editor.confirmClose) {
      const discard = document.createElement('button');
      discard.type = 'button';
      discard.className = 'btn btn--danger btn--sm';
      discard.textContent = '放弃并关闭';
      discard.addEventListener('click', () => closeEditor(true));
      nodes.push(discard);
    }
    dom.modelErrors.replaceChildren(...nodes);
  }

  if (dom.modelSave) dom.modelSave.disabled = errors.length > 0 || !ready || !dirty || state.modelsSaving;
  if (dom.modelSave) setText(dom.modelSave, state.modelsSaving ? '正在保存…' : '保存目录');
  if (dom.modelCancel) setText(dom.modelCancel, editor.confirmClose ? '继续编辑' : '取消');
  setText(dom.modelSaveNote, dirty ? '保存会提交整个模型目录，服务端立即应用。' : '没有未保存的修改。');
}

function syncDefaultOptions(list, current) {
  if (!dom.mDefault) return;
  const options = [{ value: '', label: '自动' }].concat(list.map((value) => ({ value, label: value })));
  if (current && !list.includes(current)) options.push({ value: current, label: current + '（未声明）' });
  const signature = JSON.stringify(options) + '#' + current;
  if (dom.mDefault.dataset.signature === signature) {
    dom.mDefault.value = current || '';
    return;
  }
  dom.mDefault.dataset.signature = signature;
  dom.mDefault.replaceChildren(...options.map((option) => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  dom.mDefault.value = current || '';
}

/* ---------- render: subagents ---------- */

function capableModels() {
  const list = state.data && Array.isArray(state.data.models) ? state.data.models : [];
  return list.filter(isCapable);
}

/* 子代理草稿的可用性判断独立成纯函数：保存按钮、提示与测试共用同一套规则，
   避免界面显示“可用”而服务端拒绝。 */
function evaluateSubagentDraft(draft, data) {
  const problems = [];
  const notes = [];
  if (!data) return { problems, notes };
  if (!configReady(data)) problems.push('配置当前不是就绪状态，保存已禁用。重启面板后可再次保存。');
  if (!draft || draft.mode !== 'force') return { problems, notes };

  const list = Array.isArray(data.models) ? data.models : [];
  const model = draft.model ? list.find((row) => row && row.id === draft.model) || null : null;
  if (!draft.model) problems.push('尚未选择模型。');
  else if (!model) problems.push('所选模型已不在目录中，请重新选择。');
  else if (!isCapable(model)) problems.push('所选模型未声明工具调用，不能作为子代理。');
  else if (!model.reasoning) notes.push('所选模型未声明推理能力，保存时将使用自动档位。');

  if (draft.effort && model && !declaredEfforts(model).includes(draft.effort)) {
    problems.push('该模型未声明档位 ' + draft.effort + '。请到「模型管理」补充该档位，或改选其他档位。');
  }
  return { problems, notes };
}

let saModelSignature = '';
let saEffortSignature = '';

function renderSubagents() {
  const data = state.data;
  if (!data) return;
  const draft = state.draft || { mode: 'inherit', model: null, effort: null };
  const ready = configReady(data);
  const busy = isInFlight(data.operation);

  if (dom.modeInherit) dom.modeInherit.checked = draft.mode === 'inherit';
  if (dom.modeForce) dom.modeForce.checked = draft.mode === 'force';
  if (dom.modeInherit) dom.modeInherit.disabled = !ready || busy;
  if (dom.modeForce) dom.modeForce.disabled = !ready || busy;

  const capable = capableModels();
  const modelSignature = JSON.stringify([capable.map((model) => [model.id, model.name || '']), draft.model]);
  if (modelSignature !== saModelSignature) {
    saModelSignature = modelSignature;
    const options = [{ value: '', label: '选择模型' }].concat(capable.map((model) => ({
      value: model.id,
      label: modelLabel(model, model.id) + ' · ' + model.id,
    })));
    if (draft.model && !capable.some((model) => model.id === draft.model)) {
      options.push({ value: draft.model, label: '（不在目录）' + draft.model });
    }
    if (dom.saModel) {
      dom.saModel.replaceChildren(...options.map((option) => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        return node;
      }));
    }
  }
  if (dom.saModel) {
    dom.saModel.value = draft.model || '';
    dom.saModel.disabled = draft.mode !== 'force' || !ready || busy;
  }

  const model = draft.model ? findModel(draft.model) : null;
  const list = declaredEfforts(model);
  const extra = draft.effort && !list.includes(draft.effort) ? draft.effort : null;
  const effortSignature = JSON.stringify([list, model && model.defaultEffort, extra, draft.mode, draft.model]);
  if (effortSignature !== saEffortSignature) {
    saEffortSignature = effortSignature;
    const options = [{ value: '', label: model && model.defaultEffort ? '自动（默认 ' + model.defaultEffort + '）' : '自动' }];
    list.forEach((value) => {
      options.push({ value, label: value === (model && model.defaultEffort) ? value + '（默认）' : value });
    });
    if (extra) options.push({ value: extra, label: extra + '（未声明）' });
    if (dom.saEffort) {
      dom.saEffort.replaceChildren(...options.map((option) => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        return node;
      }));
    }
  }
  if (dom.saEffort) {
    dom.saEffort.value = draft.effort || '';
    dom.saEffort.disabled = draft.mode !== 'force' || !model || !ready || busy;
  }

  const { problems, notes } = evaluateSubagentDraft(draft, data);

  if (dom.saWarning) {
    setHidden(dom.saWarning, problems.length === 0);
    dom.saWarning.replaceChildren(...problems.map((message) => {
      const p = document.createElement('p');
      p.textContent = message;
      return p;
    }));
    if (problems.length) {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'btn btn--outline btn--sm';
      jump.textContent = draft.model ? '编辑该模型能力' : '前往模型管理';
      jump.addEventListener('click', () => {
        const target = draft.model ? findModel(draft.model) : null;
        setView('models');
        if (target) openEditor(target);
      });
      dom.saWarning.append(jump);
    }
  }

  if (dom.saModelHint) {
    setText(dom.saModelHint, '只列出声明支持工具调用的模型，共 ' + capable.length + ' 个。');
  }
  if (dom.saEffortHint) {
    setText(dom.saEffortHint, notes[0] || (model
      ? (list.length ? '来自该模型声明的 ' + list.length + ' 个档位。' : '该模型未声明档位，只能使用自动。')
      : '先选择模型。'));
  }

  const dirty = state.draftDirty;
  if (dom.saSave) dom.saSave.disabled = !dirty || problems.length > 0 || !ready || state.subagentSaving || busy;
  if (dom.saSave) setText(dom.saSave, state.subagentSaving ? '正在保存…' : '保存目标');
  if (dom.saReset) dom.saReset.disabled = !dirty || state.subagentSaving;

  if (dom.saDraft) {
    let text;
    if (!state.data) text = '尚未读取状态';
    else if (!ready) text = '配置不是就绪状态，保存已禁用';
    else if (problems.length) text = problems[0];
    else if (!dirty) text = '草稿与已保存一致';
    else text = '草稿尚未保存';
    setText(dom.saDraft, text);
    dom.saDraft.dataset.dirty = String(dirty);
    dom.saDraft.dataset.blocked = String(problems.length > 0);
  }

  const runtime = (data.subagents && data.subagents.runtime) || {};
  const runtimeInfo = RUNTIME_STATE[runtime.state] || { tone: 'neutral', word: '未知', note: '' };
  setDot(dom.rtStateDot, runtimeInfo.tone);
  setText(dom.rtState, runtimeInfo.word);
  setText(dom.rtVersion, typeof runtime.version === 'string' && runtime.version ? runtime.version : '—');
  setText(dom.rtMode, typeof runtime.mode === 'string' && runtime.mode ? runtime.mode : '—');
  const spawn = runtime.lastSpawn;
  setText(dom.rtSpawn, spawn && typeof spawn.at === 'number'
    ? fmtTime(spawn.at) + (spawn.modelAlias ? ' · ' + spawn.modelAlias : '')
    : '—');

  const verdict = evaluateBinding(data);
  setDot(dom.saVerdictDot, verdict.tone);
  setText(dom.saVerdictWord, verdict.word);
  setText(dom.saVerdictNote, verdict.note);
}

/* ---------- render: connection ---------- */

function renderConnection() {
  const data = state.data;
  if (!data) return;
  const connection = data.connection || {};
  const active = connection.active || null;
  const saved = connection.saved || null;
  const environment = connection.environment || {};

  setDot(dom.envKeyDot, environment.apiKeySet ? 'ok' : 'bad');
  setText(dom.envKey, environment.apiKeySet ? '环境变量已设置' : '环境变量未设置，上游请求会失败');
  setDot(dom.envTokenDot, environment.tokenSet ? 'ok' : 'bad');
  setText(dom.envToken, environment.tokenSet ? '环境变量已设置' : '环境变量未设置');

  if (!state.conn.dirty) {
    const values = connectionKey(sourceFormValues(connectionSource(data)));
    if (values !== state.conn.base || !dom.cBase || !dom.cBase.value) fillConnectionForm();
  }

  renderPendingDiff(active, saved);

  const config = data.configuration || {};
  if (dom.connSave) {
    dom.connSave.disabled = !state.conn.dirty || state.connSaving || config.state === 'unavailable';
    setText(dom.connSave, state.connSaving ? '正在保存…' : '保存连接');
  }
  if (dom.connFillActive) dom.connFillActive.disabled = !active || state.connSaving;
  if (dom.connDraft) {
    const text = config.state === 'unavailable'
      ? '配置文件不可读，无法保存连接'
      : state.conn.dirty
        ? '草稿尚未保存，保存后需重启面板生效'
        : '草稿与配置文件一致';
    setText(dom.connDraft, text);
    dom.connDraft.dataset.dirty = String(state.conn.dirty);
  }

  if (dom.restartState) {
    setText(dom.restartState, config.state === 'ready'
      ? '当前配置文件已生效，没有待重启的修改。'
      : config.state === 'changed'
        ? '配置文件已修改，当前进程仍在使用启动时读取的连接。重启面板后生效。'
        : '无法读取配置文件。修正后重启面板。');
  }
  setText(dom.restartFile, (config.file || '—') + ' · 修订 ' + shortRev(data.revision));

  renderUpdates(data);
  renderDiagnostics(data);
}

function renderPendingDiff(active, saved) {
  if (!dom.pendingDiff) return;
  const fields = [
    ['上游地址', active && active.upstream && active.upstream.baseURL, saved && saved.upstream && saved.upstream.baseURL],
    ['API Key 变量名', active && active.upstream && active.upstream.apiKeyEnv, saved && saved.upstream && saved.upstream.apiKeyEnv],
    ['网关 Token 变量名', active && active.tokenEnv, saved && saved.tokenEnv],
    ['网关端口', active ? String(active.port) : '', saved ? String(saved.port) : ''],
    ['DNS', active && active.dns ? (active.dns.enabled ? '启用 ' + active.dns.port : '停用') : '', saved && saved.dns ? (saved.dns.enabled ? '启用 ' + saved.dns.port : '停用') : ''],
  ];
  const changed = fields.filter(([, before, after]) => before !== after);
  if (!changed.length) {
    setHidden(dom.pendingDiff, true);
    return;
  }
  setHidden(dom.pendingDiff, false);
  const title = document.createElement('p');
  title.className = 'diff__title';
  title.textContent = '待重启生效的差异（当前生效 → 配置文件）';
  const list = document.createElement('dl');
  list.className = 'diff__list';
  changed.forEach(([label, before, after]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = (before || '—') + ' → ' + (after || '—');
    list.append(dt, dd);
  });
  dom.pendingDiff.replaceChildren(title, list);
}

/* ---------- render: updates ---------- */

function updatePayload(data) {
  const value = data && data.updates;
  return value && typeof value === 'object' ? value : null;
}

function updatesAvailable(data) {
  return updatePayload(data) !== null;
}

function versionText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  /* 仓库标签带 v 前缀，接口字段按契约是裸 semver；两种写法都归一后比较。 */
  const bare = /^[vV]/.test(text) ? text.slice(1) : text;
  return SEMVER_PATTERN.test(bare) ? bare : '';
}

function releaseURLFor(payload) {
  const candidate = payload && typeof payload.releaseURL === 'string' ? payload.releaseURL.trim() : '';
  if (!candidate.startsWith(UPDATE_RELEASE_PREFIX)) return null;
  const tail = candidate.slice(UPDATE_RELEASE_PREFIX.length);
  /* 只接受单段合法 semver（允许仓库惯例的 v 前缀），拒绝额外路径、查询参数与片段。 */
  const tag = /^[vV]/.test(tail) ? tail.slice(1) : tail;
  if (!tag || tail.includes('/') || !SEMVER_PATTERN.test(tag)) return null;
  return UPDATE_RELEASE_PREFIX + tail;
}

function updateStateWord(state) {
  return UPDATE_STATE[state] || { tone: 'neutral', word: state || '未知', note: '' };
}

function evaluateUpdate(data) {
  const payload = updatePayload(data);
  if (!payload) {
    return {
      tone: 'neutral',
      word: '版本未知',
      note: '当前面板服务没有提供更新状态，无法确认运行版本或安装新版本。',
      current: '',
      latest: '',
      pending: '',
      state: null,
    };
  }
  const state = typeof payload.state === 'string' ? payload.state : 'not-checked';
  const info = updateStateWord(state);
  const current = versionText(payload.currentVersion);
  const latest = versionText(payload.latestVersion);
  const pending = versionText(payload.pendingVersion);
  const reason = updateReasonText(payload.reason);
  let note = info.note;
  if (state === 'failed') note = reason || info.note;
  else if (state === 'staged' && pending) note = '版本 ' + pending + ' 已下载；重启网关后才会生效，当前运行版本不变。';
  else if (state === 'available' && latest) note = '版本 ' + latest + ' 可以下载；下载后需重启网关才会生效。';
  else if (reason && state !== 'current') note = reason;
  return { tone: info.tone, word: info.word, note, state, current, latest, pending };
}

function renderUpdates(data) {
  const payload = updatePayload(data);
  const available = payload !== null;
  setHidden(dom.updUnavailable, available);

  if (!available) {
    setText(dom.updCurrent, '当前版本未知');
    setText(dom.updCurrentSub, '面板服务没有提供更新状态。');
    setText(dom.updLatest, '—');
    setText(dom.updLatestSub, '无法读取发布信息。');
    setText(dom.updChecked, '—');
    setText(dom.updCheckedSub, '尚未检查。');
    setText(dom.updRelease, '仅使用 GitHub Releases 的正式发布。');
    setHidden(dom.updPending, true);
    setDot(dom.updVerdictDot, 'neutral');
    setText(dom.updVerdictWord, '版本未知');
    setText(dom.updVerdictNote, '无法确认运行版本；下载与回退不可用。');
    setText(dom.updHint, '升级到提供更新状态的面板服务后，这里会显示当前版本与可用版本。');
    renderUpdateButtons(data);
    return;
  }

  const verdict = evaluateUpdate(data);
  const current = verdict.current;
  const latest = verdict.latest;

  setText(dom.updCurrent, current || '未知');
  setText(dom.updCurrentSub, current
    ? '本机正在运行的网关版本'
    : '面板服务未报告当前版本。');
  setText(dom.updLatest, latest || '未获取');
  const latestRaw = typeof payload.latestVersion === 'string' ? payload.latestVersion.trim() : '';
  setText(dom.updLatestSub, latest
    ? (current && latest === current ? '与运行版本相同' : 'GitHub 上的最新正式发布')
    : (latestRaw
      ? '返回的版本号格式不被接受，已忽略'
      : (verdict.state === 'checking' ? '正在读取…' : '检查后显示')));

  const checkedAt = payload.checkedAt;
  setText(dom.updChecked, checkedAt === null || checkedAt === undefined ? '—' : fmtTime(checkedAt));
  setText(dom.updCheckedSub, checkedAt === null || checkedAt === undefined
    ? '本次进程还没有检查过'
    : '最近一次检查完成的时间');

  const link = releaseURLFor(payload);
  if (link && dom.updRelease) {
    const anchor = document.createElement('a');
    anchor.className = 'mono upd__link';
    anchor.href = link;
    anchor.textContent = '查看发布页';
    anchor.rel = 'noreferrer noopener';
    anchor.target = '_blank';
    dom.updRelease.replaceChildren(anchor);
  } else if (dom.updRelease) {
    const note = document.createElement('span');
    note.textContent = '仅使用 GitHub Releases 的正式发布。';
    dom.updRelease.replaceChildren(note);
  }

  const pending = verdict.pending;
  if (pending) {
    setHidden(dom.updPending, false);
    setText(dom.updPending, '版本 ' + pending + ' 已下载，等待重启网关。重启前仍运行版本 '
      + (current || '未知') + '，正在进行的会话不会被结束。');
  } else {
    setHidden(dom.updPending, true);
  }

  setDot(dom.updVerdictDot, verdict.tone);
  setText(dom.updVerdictWord, verdict.word);
  setText(dom.updVerdictNote, verdict.note);
  setText(dom.updHint, updateHint(data, verdict));
  renderUpdateButtons(data);
}

function updateHint(data, verdict) {
  if (!updatesAvailable(data)) return '升级到提供更新状态的面板服务后，这里会显示当前版本与可用版本。';
  if (verdict.state === 'staged') return '重启网关后新版本才会运行；本面板不会自动重启。';
  if (verdict.state === 'available') return '下载不会结束正在运行的会话；重启网关后才切换到新版本。';
  if (verdict.state === 'checking') return '检查只读取 GitHub 的正式发布信息，不下载安装包。';
  if (verdict.state === 'failed') return '失败不会改变正在运行的版本；可重试或到 GitHub 手动下载。';
  if (verdict.state === 'current') return '当前已是最新稳定版本；需要时可再次检查，或回退到更早的版本。';
  return '检查、下载与回退都需要点击；本面板不会静默升级。';
}

function renderUpdateButtons(data) {
  const payload = updatePayload(data);
  const running = payload ? payload.state === 'checking' : false;
  const opRunning = isInFlight(data && data.operation);
  const pending = state.pendingAction;
  const idle = Boolean(payload) && !running && !opRunning && !pending;
  const current = payload ? versionText(payload.currentVersion) : '';
  const latest = payload ? versionText(payload.latestVersion) : '';
  const pendingVersion = payload ? versionText(payload.pendingVersion) : '';
  const canRollback = Boolean(payload) && Boolean(versionText(payload.rollbackVersion));

  if (dom.updCheck) {
    dom.updCheck.disabled = !payload || running || opRunning;
  }
  if (dom.updInstall) {
    const upgradable = Boolean(payload) && !pendingVersion && Boolean(latest) && latest !== current;
    dom.updInstall.disabled = !idle || !upgradable;
  }
  if (dom.updRollback) {
    dom.updRollback.disabled = !idle || !canRollback;
  }

  [[dom.updCheck, 'check-update'], [dom.updInstall, 'install-update'], [dom.updRollback, 'rollback-update']]
    .forEach(([button, action]) => {
      if (!button) return;
      const busy = pending === action;
      button.classList.toggle('is-busy', busy);
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    });
}

function renderDiagnostics(data) {
  const diagnostics = data.diagnostics || {};
  const upstream = diagnostics.upstream;
  if (!upstream) {
    setDot(dom.diagUpstreamDot, 'neutral');
    setText(dom.diagUpstreamState, '未检查');
    setText(dom.diagUpstreamMeta, '只请求上游 GET /models，不产生推理费用。');
  } else {
    const passed = upstream.state === 'passed';
    setDot(dom.diagUpstreamDot, passed ? 'ok' : 'bad');
    setText(dom.diagUpstreamState, passed ? '通过' : '未通过');
    const parts = [];
    if (typeof upstream.httpStatus === 'number') parts.push('HTTP ' + upstream.httpStatus);
    if (typeof upstream.modelCount === 'number') parts.push(fmtCount(upstream.modelCount) + ' 个模型');
    if (typeof upstream.ms === 'number') parts.push(upstream.ms + ' ms');
    if (upstream.reason) parts.push(reasonText(upstream.reason));
    if (upstream.at) parts.push(fmtTime(upstream.at));
    setText(dom.diagUpstreamMeta, parts.join(' · ') || '已检查');
  }

  const compat = diagnostics.compat;
  if (!compat) {
    setDot(dom.diagCompatDot, 'neutral');
    setText(dom.diagCompatState, '未检查');
    setText(dom.diagCompatMeta, '用本机 Kimi 目录解析器试导入当前模型目录。');
  } else {
    const words = { verified: '兼容', incompatible: '不兼容', unavailable: '不可用', unverified: '未验证' };
    const tones = { verified: 'ok', incompatible: 'bad', unavailable: 'bad', unverified: 'warn' };
    setDot(dom.diagCompatDot, tones[compat.state] || 'neutral');
    setText(dom.diagCompatState, words[compat.state] || compat.state || '未知');
    const parts = [];
    if (compat.version) parts.push('Kimi ' + compat.version);
    if (typeof compat.modelCount === 'number') parts.push('目录 ' + fmtCount(compat.modelCount));
    if (typeof compat.acceptedCount === 'number') parts.push('接受 ' + fmtCount(compat.acceptedCount));
    if (typeof compat.skippedCount === 'number') parts.push('跳过 ' + fmtCount(compat.skippedCount));
    if (compat.reason) parts.push(reasonText(compat.reason));
    if (compat.at) parts.push(fmtTime(compat.at));
    setText(dom.diagCompatMeta, parts.join(' · ') || '已检查');
  }
}

/* ---------- render: translation ---------- */

const TRANSLATION_REASON = {
  'kimi-running': 'Kimi 已在运行，需要正常退出后再从网关启动。',
  'kimi-exited': 'Kimi 已退出，翻译引擎随之停止。',
  'renderer-missing': '没有找到可注入的 Kimi 渲染窗口。',
  'version-unsupported': '没有找到可注入的 Kimi 渲染入口，或页面结构与翻译引擎不匹配。',
  translation_runtime_incompatible: '没有找到可注入的 Kimi 渲染入口，或页面结构与翻译引擎不匹配。',
  translation_kimi_unavailable: '无法读取本机 Kimi 运行时，请检查安装或本机副本。',
  'engine-inactive': 'Kimi 窗口已连接，但翻译引擎没有运行。',
  'legacy-engine': '检测到旧版翻译注入，未重复挂载。',
  'settings-pending': '设置已保存，等待下次从网关启动时采用。',
  'launch-failed': '带翻译的 Kimi 启动失败。',
  'translation_legacy_running': '检测到任务 3 的旧注入仍在运行，网关未重复挂载。',
  'translation_waiting_work_view': '已连接 Kimi，正在等待打开 Work 思考页面。',
  'translation_renderer_unconfirmed': 'Kimi 渲染页面未确认翻译引擎，可能是不兼容的界面版本。',
  'translation_session_conflict': '翻译会话记录冲突，请检查状态目录或重启面板。',
  'translation_host_stale': '上一次翻译会话状态已过期，请重新启动。',
  'subagent_runtime_outdated': '子代理运行时落后于当前 Kimi 安装，本次翻译启动未携带；重新「准备运行时」后恢复。',
  'subagent_state_conflict': '子代理运行时状态异常，本次翻译启动未携带其运行时。',
  'subagent_runtime_not_ready': '子代理运行时尚未就绪，本次翻译启动未携带。',
  'subagent_runtime_unsupported': '当前应用未通过子代理副本启动检查，本次仅启动翻译。',
  'subagent_launch_unsupported': '当前应用不支持已确认的子代理副本启动接口。',
  'subagent_policy_unavailable': '子代理策略不可用，本次翻译启动未携带其运行时。',
  'subagent_bundle_application_mismatch': '子代理运行时指向另一个 Kimi 安装，本次翻译启动未携带。',
  'subagent_heartbeat_stale': '子代理运行时心跳过期，本次翻译启动未携带其运行时。',
  'subagent_policy_blocked': '子代理策略处于阻止状态，本次翻译启动未携带其运行时。',
};

function translationReason(code) {
  if (typeof code !== 'string' || !code) return '';
  return TRANSLATION_REASON[code] || code;
}

function translationRuntime(data) {
  return (data && data.translation && data.translation.runtime) || {};
}

function translationLaunchState(data, { dirty = false } = {}) {
  const problems = [];
  if (!data) return { problems: ['尚未读取状态。'], ready: false };
  if (!translationAvailable(data)) problems.push('面板服务未提供翻译状态，暂时不能启动。');
  if (!configReady(data)) problems.push('连接配置不是就绪状态，请先重启面板。');
  if (!savedTranslation(data).enabled) problems.push('翻译尚未启用并保存，不能启动带翻译的 Kimi。');
  if (dirty) problems.push('翻译设置有未保存的修改，请先保存。');
  return { problems, ready: problems.length === 0 };
}

function evaluateTranslation(data, { dirty = false } = {}) {
  if (!data) return { tone: 'neutral', word: '读取中', note: '' };
  if (!translationAvailable(data)) {
    return { tone: 'neutral', word: '不可用', note: '面板服务未提供翻译状态；其余功能不受影响。' };
  }

  const saved = savedTranslation(data);
  const runtime = translationRuntime(data);
  const info = TRANSLATION_STATE[runtime.state] || {
    tone: 'neutral',
    word: typeof runtime.state === 'string' && runtime.state ? runtime.state : '未知',
    note: '',
  };
  const reason = translationReason(runtime.reason);

  if (!saved.enabled) {
    if (['active', 'pending-settings', 'starting', 'attaching'].includes(runtime.state)) {
      return { tone: 'warn', word: '等待停用确认', note: '关闭设置已保存，等待现有会话恢复原文；请以运行时确认结果为准。' };
    }
    if (runtime.state === 'legacy-running') return { tone: info.tone, word: info.word, note: info.note };
    if (['failed', 'stale'].includes(runtime.state)) {
      return { tone: 'warn', word: '停用未确认', note: reason || '无法确认现有会话是否已停用，请检查状态。' };
    }
    return { tone: 'neutral', word: '已关闭', note: '启用后保存设置，再从网关启动 Kimi。' };
  }

  if (dirty) {
    return { tone: 'warn', word: '有未保存修改', note: '保存后由会话应用新设置；当前运行状态未改变。' };
  }

  if (runtime.state === 'active') {
    return { tone: 'ok', word: '已注入', note: 'Kimi 已确认翻译引擎在运行。' };
  }

  if (runtime.state === 'disabled') {
    return { tone: 'neutral', word: '待启动', note: '翻译已启用并保存；从网关启动 Kimi 后才会注入。' };
  }

  return { tone: info.tone, word: info.word, note: reason || info.note };
}

function setTranslationControlsDisabled(disabled) {
  const fields = [dom.trEnabled, dom.trProvider, dom.trTarget, dom.trView, dom.trEndpoint, dom.trModel, dom.trKeyEnv];
  fields.forEach((field) => {
    if (field) field.disabled = disabled;
  });
}

function renderTranslation() {
  const data = state.data;
  if (!data) return;

  const available = translationAvailable(data);
  setHidden(dom.trUnavailable, available);
  setTranslationControlsDisabled(!available || state.translationSaving);

  /* 表单只在首次填充；之后由输入事件维护草稿，轮询渲染绝不回写用户正在编辑的字段。 */
  if (available && state.translation.base === null) fillTranslationForm();
  const dirty = translationDirty();
  state.translation.dirty = dirty;

  const provider = dom.trProvider ? dom.trProvider.value : savedTranslation(data).provider;
  setHidden(dom.trCustom, provider !== 'custom');
  const serviceName = provider === 'custom' ? '你填写的 Chat 服务' : provider === 'google' ? 'Google 翻译' : 'Bing 翻译';
  if (dom.trProviderHint) {
    setText(dom.trProviderHint, provider === 'custom'
      ? '由你提供的 Chat Completions 服务翻译；只填写地址、模型和变量名。'
      : '公共翻译服务，无需填写凭证；译文质量由该服务决定。');
  }
  if (dom.trEgress) {
    setText(dom.trEgress, '启用后，被翻译的思考文本会发送到' + serviceName
      + '；代码块、行内代码与链接会保留原文。翻译与子代理目标可以同时启用，互不影响。');
  }

  const built = buildTranslation(translationFormValues());
  if (dom.trErrors) {
    setHidden(dom.trErrors, built.errors.length === 0);
    dom.trErrors.replaceChildren(...built.errors.map((message) => {
      const p = document.createElement('p');
      p.textContent = message;
      return p;
    }));
  }

  const payload = translationPayload(data) || {};
  const environment = payload.environment || {};
  const keyKnown = built.value.apiKeyEnv === savedTranslation(data).apiKeyEnv;
  const keySet = keyKnown && environment.keySet === true;
  const custom = provider === 'custom';
  setDot(dom.trEnvDot, custom && keySet ? 'ok' : 'neutral');
  setText(dom.trEnv, custom ? (keyKnown ? (keySet ? '环境变量已设置' : '未设置，可免鉴权') : '保存后检查变量') : '公共翻译服务，无需凭证');
  if (dom.trKeyState) {
    dom.trKeyState.dataset.tone = keySet ? 'ok' : 'neutral';
    setText(dom.trKeyState, !keyKnown ? '变量名有未保存的修改；保存后显示启动环境中的状态。' : keySet
      ? '已读取到该环境变量；页面不会显示它的值。'
      : '未读取到该环境变量，将不携带鉴权；服务需要 Key 时，请设置变量并重新启动翻译会话。');
  }

  const runtime = translationRuntime(data);
  const info = TRANSLATION_STATE[runtime.state] || {
    tone: 'neutral',
    word: typeof runtime.state === 'string' && runtime.state ? runtime.state : '未知',
    note: '',
  };
  setDot(dom.trRuntimeDot, info.tone);
  setText(dom.trRuntime, info.word);
  setText(dom.trVersion, typeof runtime.version === 'string' && runtime.version ? runtime.version : '—');
  setText(dom.trPid, typeof runtime.pid === 'number' ? String(runtime.pid) : '—');
  // The version display is informational only. A build this codebase was never
  // hand-verified against is labelled instead of refused: the renderer
  // handshake remains the real gate.
  if (dom.trVerification) {
    dom.trVerification.hidden = runtime.verification !== 'unverified-version';
    dom.trVerification.dataset.tone = runtime.verification === 'unverified-version' ? 'warn' : 'ok';
    setText(dom.trVerification.querySelector?.('dd') || dom.trVerification, runtime.verification === 'unverified-version'
      ? `未验证版本 ${runtime.version}；可启动，以渲染器确认为准`
      : '');
  }
  if (dom.trWarning) {
    dom.trWarning.hidden = !runtime.warning;
    setText(dom.trWarning.querySelector?.('dd') || dom.trWarning, runtime.warning ? translationReason(runtime.warning) : '');
  }

  const verdict = evaluateTranslation(data, { dirty });
  setDot(dom.trVerdictDot, verdict.tone);
  setText(dom.trVerdictWord, verdict.word);
  setText(dom.trVerdictNote, verdict.note);

  const launch = translationLaunchState(data, { dirty });
  if (dom.trLaunch) dom.trLaunch.disabled = !launch.ready || state.translationSaving || isInFlight(data.operation);
  /* 待重启的连接意味着运行时仍按启动时的配置工作，此时检查结果不可信，一并禁用。 */
  if (dom.trCheck) {
    dom.trCheck.disabled = !available || !configReady(data) || state.translationSaving || isInFlight(data.operation);
  }

  if (dom.trSave) {
    dom.trSave.disabled = !available || !dirty || built.errors.length > 0
      || !configReady(data) || state.translationSaving || isInFlight(data.operation);
    setText(dom.trSave, state.translationSaving ? '正在保存…' : '保存翻译设置');
  }
  if (dom.trReset) dom.trReset.disabled = !dirty || state.translationSaving;

  if (dom.trDraft) {
    let text;
    if (!available) text = '面板服务未提供翻译状态，设置不可用';
    else if (!configReady(data)) text = '连接配置不是就绪状态，保存已禁用';
    else if (built.errors.length) text = built.errors[0];
    else if (!dirty) text = '草稿与已保存一致';
    else text = '草稿尚未保存';
    setText(dom.trDraft, text);
    dom.trDraft.dataset.dirty = String(dirty);
    dom.trDraft.dataset.blocked = String(built.errors.length > 0 || !available);
  }
}

/* ---------- state ---------- */

function adoptState(next, { initial = false } = {}) {
  state.data = next;

  if (!state.draft || !state.draftDirty) {
    state.draft = draftFromSaved(next);
    state.draftDirty = false;
  } else {
    recomputeDraftDirty();
  }

  if (initial || !state.conn.dirty) {
    fillConnectionForm();
  } else {
    /* 草稿还在，只更新比较基线；若服务器保存值恰好变成草稿值，脏标记随之消失。 */
    state.conn.base = connectionKey(sourceFormValues(connectionSource(next)));
    state.conn.dirty = connectionKey(connectionFormValues()) !== state.conn.base;
  }

  /* 翻译同理：轮询不得覆盖用户正在编辑的字段，只更新比较基线。 */
  if (!translationAvailable(next)) {
    state.translation.base = null;
    state.translation.dirty = false;
  } else if (initial || !state.translation.dirty) {
    fillTranslationForm();
  } else {
    state.translation.base = translationKey(savedTranslation(next));
    state.translation.dirty = translationKey(translationFormValues()) !== state.translation.base;
  }

  settlePending(next);
}

function settlePending(next) {
  const op = next && next.operation;
  if (!state.pendingOpId || !op || op.id !== state.pendingOpId || isInFlight(op)) return;
  const action = state.pendingAction || op.action;
  state.pendingOpId = null;
  state.pendingAction = null;
  void confirmActionResult(action, op.id);
}
function renderAll() {
  if (!state.data) return;
  renderShell(state.data);
  renderOverview(state.data);
  renderOperation(state.data);
  renderModels();
  renderSubagents();
  renderTranslation();
  renderConnection();
  renderActions(state.data);
}

async function loadState({ silent = false } = {}) {
  if (!state.key) {
    showGate('missing');
    return false;
  }
  if (!silent && !state.started) renderLoading();

  try {
    const next = await request(API.state);
    if (!next || next.schemaVersion !== 1) throw new ApiError('面板返回了无法识别的状态格式', 'SCHEMA', 200);
    adoptState(next, { initial: !state.data });
    state.reachable = true;
    state.lastSync = Date.now();
    setHidden(dom.conn, true);
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

function renderLoading() {
  if (dom.modelBody) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'muted';
    td.textContent = '正在读取模型目录…';
    tr.append(td);
    dom.modelBody.replaceChildren(tr);
  }
  setText(dom.recentEmpty, '正在读取运行状态…');
  setText(dom.factGateway, '读取中');
  setText(dom.factModels, '读取中');
  setText(dom.factRuntime, '读取中');
  setText(dom.factConfig, '读取中');
  setText(dom.savedValue, '读取中');
  setText(dom.adoptedValue, '读取中');
  setText(dom.verdictWord, '读取中');
  setText(dom.saVerdictWord, '读取中');
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
  setHidden(dom.conn, false);
  setText(dom.connText, error.code === 'NETWORK'
    ? '无法连接本机面板服务。服务可能已停止或端口已变化，页面上的状态停留在最后一次读取。'
    : error.message || '读取状态失败，页面上的状态停留在最后一次读取。');
  setText(dom.sync, state.lastSync ? '最后同步 ' + fmtTime(state.lastSync) + ' · 连接中断' : '尚未连接');
  if (!state.data) {
    renderLoading();
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
    lede: '面板每次启动都会生成一次性会话密钥，只通过终端打印的链接传入。地址栏里的 #key=… 会在读取后立即移除，不会显示在页面上。',
    note: '',
  },
  expired: {
    title: '会话密钥已失效',
    lede: '面板重启会生成新的会话密钥，旧链接随之失效。请从终端打印的最新链接重新打开。',
    note: '若面板仍在运行，也可能是从别处打开了面板地址；请使用带 #key= 的完整链接。',
  },
  refused: {
    title: '无法确认面板会话',
    lede: '服务拒绝了这次请求，可能是页面被其他来源打开，或服务已停止。',
    note: '请从终端打印的链接重新打开；若持续出现，重启面板。',
  },
};

function showGate(kind) {
  const copy = GATE_COPY[kind] || GATE_COPY.missing;
  setHidden(dom.gate, false);
  if (dom.shell) dom.shell.hidden = true;
  setText(dom.gateTitle, copy.title);
  setText(dom.gateLede, copy.lede);
  setHidden(dom.gateNote, !copy.note);
  setText(dom.gateNote, copy.note);
  setHidden(dom.gateActions, copy.retry === false);
  if (copy.retry !== false && dom.gateRetry) dom.gateRetry.focus({ preventScroll: true });
}

/* ---------- polling ---------- */

function startPolling() {
  stopPolling();
  state.timer = window.setInterval(() => {
    if (document.hidden) return;
    if (state.modelsSaving || state.subagentSaving || state.connSaving || state.translationSaving) return;
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
  const icon = iconUse(tone === 'error' ? 'i-alert' : 'i-check');
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

function actionUUID() {
  if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return hex() + '-' + hex() + '-' + hex() + '-' + hex();
}

async function runAction(action) {
  const data = state.data;
  if (!data || state.pendingAction) return;
  if (isInFlight(data.operation)) {
    showToast('已有操作正在进行，等待它结束后再试。', 'error');
    return;
  }
  if (action === 'launch-translated-kimi') {
    const launch = translationLaunchState(data, { dirty: state.translation.dirty });
    if (!launch.ready) {
      showToast(launch.problems[0], 'error');
      return;
    }
  }
  if (action === 'check-translation' && !translationAvailable(data)) {
    showToast('面板服务未提供翻译状态，无法检查。', 'error');
    return;
  }
  if (action === 'check-update' && !updatesAvailable(data)) {
    showToast('面板服务未提供更新状态，无法检查更新。', 'error');
    return;
  }
  if (action === 'install-update' || action === 'rollback-update') {
    const payload = updatePayload(data);
    if (!payload) {
      showToast('面板服务未提供更新状态，无法安装或回退。', 'error');
      return;
    }
    const latest = versionText(payload.latestVersion);
    const current = versionText(payload.currentVersion);
    const staged = versionText(payload.pendingVersion);
    if (action === 'install-update' && (!latest || staged || latest === current)) {
      showToast(staged
        ? '版本 ' + staged + ' 已下载，请重启网关；重复下载不会改变已暂存的版本。'
        : '没有可安装的新版本，请先点「检查更新」。', 'error');
      return;
    }
    if (action === 'rollback-update' && !versionText(payload.rollbackVersion)) {
      showToast('没有可回退的旧版本。', 'error');
      return;
    }
  }

  state.pendingAction = action;
  renderActions(data);
  renderUpdateButtons(data);

  try {
    const res = await request(API.actions, { method: 'POST', body: { id: actionUUID(), at: Date.now(), action } });
    const op = res && res.operation ? res.operation : null;
    const opId = op && op.id ? op.id : null;
    if (op) {
      state.pendingOpId = opId;
      adoptState({ ...state.data, operation: op });
      renderOperation(state.data);
      renderActions(state.data);
      renderUpdateButtons(state.data);
    }
    const submitted = action === 'launch-translated-kimi'
      ? '启动请求已被接受，注入结果以运行时状态为准。'
      : action === 'check-translation'
        ? '检查请求已提交，等待运行时返回结果。'
        : action === 'check-update'
          ? '检查更新已提交，正在读取 GitHub 上的正式发布。'
          : action === 'install-update'
            ? '下载请求已提交；下载完成后重启网关才会生效。'
            : action === 'rollback-update'
              ? '回退请求已提交；重启网关后运行回退前的版本。'
              : action === 'launch-kimi'
                ? '启动请求已提交，等待运行时状态。'
                : '操作已提交，等待结果。';
    showToast(submitted, 'ok');
    /* 终态由 settlePending 在轮询读取到匹配 operation 时确认，避免重复提示。 */
    await loadState({ silent: true });
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
      setHidden(dom.conn, false);
      setText(dom.connText, '无法连接本机面板服务，操作结果尚未确认。请先刷新状态再决定是否重试。');
      showToast('操作结果尚未确认，请先刷新状态；本面板不会自动重试。', 'error');
      return;
    }
    showToast(error.message || '操作失败，请重试。', 'error');
    await loadState({ silent: true });
  } finally {
    if (state.pendingAction === action) state.pendingAction = null;
    if (state.data) {
      renderActions(state.data);
      renderUpdateButtons(state.data);
    }
  }
}

async function confirmActionResult(action, opId) {
  if (!opId) return;
  const op = state.data && state.data.operation;
  if (!op || op.id !== opId) return;
  if (isInFlight(op)) return;

  const failed = op.state === 'failed' || op.state === 'unavailable' || op.state === 'interrupted';

  if (action === 'copy-token') {
    if (op.state === 'copied') showToast('Token 已由服务端写入系统剪贴板。', 'ok');
    else if (failed) showToast('Token 未复制：' + (ACTION_STATE[op.state] || op.state) + (op.reason ? '（' + reasonText(op.reason) + '）' : ''), 'error');
    return;
  }

  if (action === 'check-upstream') {
    if (op.state === 'passed') {
      const diag = (state.data.diagnostics && state.data.diagnostics.upstream) || {};
      showToast('上游检查通过' + (typeof diag.httpStatus === 'number' ? '：HTTP ' + diag.httpStatus : '')
        + (typeof diag.modelCount === 'number' ? '，' + diag.modelCount + ' 个模型' : '') + '。', 'ok');
    } else if (op.state === 'failed') {
      showToast('上游检查未通过：' + (reasonText(op.reason) || '无法连接上游') + '。', 'error');
    }
    return;
  }

  if (action === 'check-compat') {
    if (op.state === 'verified') showToast('兼容检查通过：当前目录可被本机 Kimi 解析。', 'ok');
    else if (op.state === 'incompatible') showToast('兼容检查未通过：当前目录不被本机 Kimi 接受。', 'error');
    else if (op.state === 'unverified' || op.state === 'unavailable') showToast('兼容检查未能完成：' + (reasonText(op.reason) || '本机目录不可读') + '。', 'error');
    return;
  }

  if (action === 'check-translation' || action === 'launch-translated-kimi') {
    const runtime = translationRuntime(state.data);
    const info = TRANSLATION_STATE[runtime.state] || { word: runtime.state || '未知' };
    if (runtime.state === 'active') {
      showToast('翻译已注入：Kimi 已确认翻译引擎在运行。', 'ok');
      return;
    }
    if (action === 'launch-translated-kimi' && op.state === 'waiting-kimi-exit') {
      showToast('Kimi 仍在运行。请正常退出 Kimi 后再点「从网关启动 Kimi」；本面板不会强制结束它。', 'error');
      return;
    }
    if (failed || runtime.state === 'failed' || runtime.state === 'incompatible') {
      const detail = translationReason(runtime.reason) || info.word || '注入未完成';
      showToast('翻译未注入：' + detail.replace(/。$/, '') + '。', 'error');
      return;
    }
    if (op.state === 'starting' || op.state === 'attaching') {
      showToast('启动请求已接受，等待运行时确认注入结果。', 'ok');
      return;
    }
    showToast('翻译状态：' + (info.word || '未知') + '（注入尚未确认）。', 'error');
    return;
  }

  if (action === 'check-update' || action === 'install-update' || action === 'rollback-update') {
    const payload = updatePayload(state.data) || {};
    const reason = updateReasonText(op.reason).replace(/[。；]+$/, '');
    if (failed) {
      showToast((ACTION_LABEL[action] || action) + '未完成：' + (reason || '更新服务未返回原因') + '。', 'error');
      return;
    }
    if (action === 'check-update') {
      const latest = versionText(payload.latestVersion);
      const current = versionText(payload.currentVersion);
      if (latest && current && latest !== current) showToast('发现新版本 ' + latest + '（当前 ' + current + '）。', 'ok');
      else if (latest) showToast('已是最新版本 ' + latest + '。', 'ok');
      else showToast('检查已完成，未读到可比较的稳定版本。', 'ok');
      return;
    }
    const pending = versionText(payload.pendingVersion);
    if (pending) {
      showToast('版本 ' + pending + ' 已准备好，重启网关后生效；当前会话不受影响。', 'ok');
      return;
    }
    if (action === 'rollback-update') {
      showToast('回退已完成；重启网关后运行回退前的版本。', 'ok');
      return;
    }
    showToast('更新已提交，但状态里还没有待重启的版本；请刷新后再确认。', 'error');
    return;
  }

  if (failed) {
    showToast((ACTION_LABEL[action] || action) + '未完成：' + (ACTION_STATE[op.state] || op.state) + (op.reason ? '（' + reasonText(op.reason) + '）' : ''), 'error');
    return;
  }

  if (op.state === 'waiting-kimi-exit') {
    showToast('Kimi 已在运行。请正常退出 Kimi，再点一次「启动 Kimi」；本面板不会强制结束它。', 'error');
  }
}

/* ---------- saving ---------- */

async function saveCatalogue(models, { close = true, message = '模型目录已保存并应用。' } = {}) {
  const data = state.data;
  if (!data || state.modelsSaving) return false;
  if (!configReady(data)) {
    showToast('配置当前不是就绪状态，无法保存模型目录。请先重启面板。', 'error');
    return false;
  }

  state.modelsSaving = true;
  renderEditor();
  renderModels();
  renderActions(data);

  try {
    const res = await request(API.models, { method: 'POST', body: { revision: data.revision, models } });
    if (res && res.state) {
      state.modelsSaving = false;
      adoptState(res.state);
      state.lastSync = Date.now();
      if (close) state.editor = null;
      state.deleteId = null;
      renderAll();
      renderEditor();
      showToast(message, 'ok');
      return true;
    }
    state.modelsSaving = false;
    await loadState({ silent: true });
    showToast('模型目录已提交，状态已刷新。', 'ok');
    return true;
  } catch (error) {
    state.modelsSaving = false;
    await handleSaveFailure(error, 'models');
    return false;
  } finally {
    state.modelsSaving = false;
    renderEditor();
    renderModels();
    if (state.data) renderActions(state.data);
  }
}

async function saveConnection() {
  const data = state.data;
  if (!data || state.connSaving) return;

  const values = connectionFormValues();
  const built = buildConnection(values);
  if (dom.connErrors) {
    setHidden(dom.connErrors, built.errors.length === 0);
    dom.connErrors.replaceChildren(...built.errors.map((message) => {
      const p = document.createElement('p');
      p.textContent = message;
      return p;
    }));
  }
  if (built.errors.length) return;

  state.connSaving = true;
  renderConnection();
  renderActions(data);

  try {
    const res = await request(API.connection, { method: 'POST', body: { revision: data.revision, ...built.value } });
    if (res && res.state) {
      state.connSaving = false;
      adoptState(res.state);
      state.lastSync = Date.now();
      state.conn.dirty = false;
      fillConnectionForm();
      renderAll();
      showToast('连接配置已保存。重启面板后生效。', 'ok');
    } else {
      state.connSaving = false;
      await loadState({ silent: true });
      showToast('连接配置已提交，状态已刷新。', 'ok');
    }
  } catch (error) {
    state.connSaving = false;
    await handleSaveFailure(error, 'connection');
  } finally {
    state.connSaving = false;
    if (state.data) {
      renderConnection();
      renderActions(state.data);
    }
  }
}

async function saveSubagentTarget() {
  const data = state.data;
  if (!data || state.subagentSaving || !state.draft) return;
  if (!configReady(data)) {
    showToast('配置当前不是就绪状态，无法保存子代理目标。请先重启面板。', 'error');
    return;
  }

  state.subagentSaving = true;
  renderSubagents();
  renderActions(data);

  try {
    const payload = { revision: data.revision, mode: state.draft.mode };
    if (state.draft.mode === 'force') {
      payload.model = state.draft.model;
      if (state.draft.effort) payload.effort = state.draft.effort;
    }
    const res = await request(API.subagents, { method: 'POST', body: payload });
    if (res && res.state) {
      state.subagentSaving = false;
      adoptState(res.state);
      state.lastSync = Date.now();
      state.draft = draftFromSaved(res.state);
      state.draftDirty = false;
      renderAll();
      showToast(state.draft.mode === 'inherit'
        ? '已保存为继承主模型，对后续新建的子代理生效。'
        : '目标已保存并应用，对后续新建的子代理生效。', 'ok');
    } else {
      state.subagentSaving = false;
      await loadState({ silent: true });
      showToast('目标已提交，状态已刷新。', 'ok');
    }
  } catch (error) {
    state.subagentSaving = false;
    await handleSaveFailure(error, 'subagents');
  } finally {
    state.subagentSaving = false;
    if (state.data) {
      renderSubagents();
      renderActions(state.data);
    }
  }
}

async function saveTranslation() {
  const data = state.data;
  if (!data || state.translationSaving) return false;
  if (!translationAvailable(data)) {
    showToast('面板服务未提供翻译状态，无法保存翻译设置。', 'error');
    return false;
  }
  if (!configReady(data)) {
    showToast('配置当前不是就绪状态，无法保存翻译设置。请先重启面板。', 'error');
    return false;
  }

  const built = buildTranslation(translationFormValues());
  if (dom.trErrors) {
    setHidden(dom.trErrors, built.errors.length === 0);
    dom.trErrors.replaceChildren(...built.errors.map((message) => {
      const p = document.createElement('p');
      p.textContent = message;
      return p;
    }));
  }
  if (built.errors.length) return false;

  state.translationSaving = true;
  renderTranslation();
  renderActions(data);

  try {
    const res = await request(API.translation, { method: 'POST', body: { revision: data.revision, ...built.value } });
    if (res && res.state) {
      state.translationSaving = false;
      adoptState(res.state);
      state.lastSync = Date.now();
      fillTranslationForm();
      renderAll();
      showToast(built.value.enabled
        ? '翻译设置已保存。注入成功与否以运行时状态为准；需要从网关启动 Kimi 才会生效。'
        : '翻译设置已保存为关闭。', 'ok');
      return true;
    }
    state.translationSaving = false;
    await loadState({ silent: true });
    showToast('翻译设置已提交，状态已刷新。', 'ok');
    return true;
  } catch (error) {
    state.translationSaving = false;
    await handleSaveFailure(error, 'translation');
    return false;
  } finally {
    state.translationSaving = false;
    if (state.data) {
      renderTranslation();
      renderActions(state.data);
    }
  }
}

async function handleSaveFailure(error, context) {
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
    setHidden(dom.conn, false);
    setText(dom.connText, '无法连接本机面板服务，修改结果尚未确认。请先刷新状态再决定是否重试。');
    showToast('修改结果尚未确认，请先刷新状态；本面板不会自动重试。', 'error');
    return;
  }

  if (error.status === 409 && (error.code === 'configuration_conflict' || error.code === 'configuration_changed' || error.code === 'configuration_unavailable')) {
    await loadState({ silent: true });
    if (error.code === 'configuration_conflict') {
      showToast('配置在别处被修改，已刷新状态；你的编辑仍然保留，请确认后重新保存。', 'error');
      return;
    }
    showToast(error.message, 'error');
    return;
  }

  if (error.code === 'subagent_model_in_use') {
    state.deleteId = null;
    renderModels();
    showToast(error.message, 'error');
    setView('subagents');
    return;
  }

  if (error.status === 400) {
    if (context === 'models' && state.editor) {
      state.editor.serverErrors = [error.message];
      renderEditor();
      return;
    }
    if (context === 'connection' && dom.connErrors) {
      setHidden(dom.connErrors, false);
      dom.connErrors.replaceChildren(...[error.message].map((message) => {
        const p = document.createElement('p');
        p.textContent = message;
        return p;
      }));
      return;
    }
    if (context === 'translation' && dom.trErrors) {
      setHidden(dom.trErrors, false);
      dom.trErrors.replaceChildren(...[error.message].map((message) => {
        const p = document.createElement('p');
        p.textContent = message;
        return p;
      }));
      return;
    }
    showToast(error.message, 'error');
    return;
  }

  if (error.saved) {
    await loadState({ silent: true });
    showToast(error.message + '（修改已保存）', 'error');
    return;
  }

  showToast(error.message || '保存失败，请重试。', 'error');
  await loadState({ silent: true });
}

/* ---------- draft mutation ---------- */

function setMode(mode) {
  if (!state.draft || !configReady(state.data)) return;
  if (mode === state.draft.mode) return;
  if (mode === 'inherit') {
    state.draft = { mode: 'inherit', model: null, effort: null };
  } else {
    const saved = state.data ? savedTarget(state.data) : null;
    const seed = (saved && saved.mode === 'force' && saved.model && isCapable(findModel(saved.model)) && saved.model)
      || (state.draft.model && isCapable(findModel(state.draft.model)) && state.draft.model)
      || (capableModels()[0] ? capableModels()[0].id : null);
    state.draft = { mode: 'force', model: seed || null, effort: null };
  }
  recomputeDraftDirty();
  renderSubagents();
  renderModels();
}

function pickModel(id) {
  if (!state.draft) return;
  const model = findModel(id);
  if (!model || !isCapable(model)) return;
  state.draft = { mode: 'force', model: id, effort: state.draft.model === id ? state.draft.effort : null };
  recomputeDraftDirty();
  renderSubagents();
  renderModels();
}

function pickEffort(value) {
  if (!state.draft || state.draft.mode !== 'force') return;
  state.draft = { ...state.draft, effort: value || null };
  recomputeDraftDirty();
  renderSubagents();
}

function discardDraft() {
  if (!state.data) return;
  state.draft = draftFromSaved(state.data);
  state.draftDirty = false;
  renderSubagents();
  renderModels();
}

/* ---------- events ---------- */

function onModelFilter(filter) {
  state.filter = filter;
  [['all', dom.filterAll], ['vision', dom.filterVision], ['tools', dom.filterTools], ['reasoning', dom.filterReasoning]]
    .forEach(([name, button]) => {
      if (button) button.setAttribute('aria-pressed', name === filter ? 'true' : 'false');
    });
  renderModels();
}

function bindEvents() {
  [['overview', dom.navOverview], ['models', dom.navModels], ['subagents', dom.navSubagents],
    ['translation', dom.navTranslation], ['connection', dom.navConnection]]
    .forEach(([view, button]) => {
      if (button) button.addEventListener('click', () => setView(view));
    });

  if (dom.goSubagents) dom.goSubagents.addEventListener('click', () => setView('subagents'));
  if (dom.restartBannerLink) dom.restartBannerLink.addEventListener('click', () => setView('connection'));

  if (dom.refresh) dom.refresh.addEventListener('click', async () => {
    dom.refresh.disabled = true;
    await loadState();
    dom.refresh.disabled = false;
  });

  if (dom.connRetry) dom.connRetry.addEventListener('click', async () => {
    dom.connRetry.disabled = true;
    await loadState();
    dom.connRetry.disabled = false;
  });

  if (dom.gateRetry) dom.gateRetry.addEventListener('click', async () => {
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

  if (dom.theme) dom.theme.addEventListener('change', () => applyTheme(dom.theme.value));

  /* 子代理 */
  if (dom.saModes) dom.saModes.addEventListener('change', (event) => {
    const target = event.target;
    if (!target || target.name !== 'mode') return;
    setMode(target.value === 'force' ? 'force' : 'inherit');
  });
  if (dom.saModel) dom.saModel.addEventListener('change', () => pickModel(dom.saModel.value));
  if (dom.saEffort) dom.saEffort.addEventListener('change', () => pickEffort(dom.saEffort.value));
  if (dom.saReset) dom.saReset.addEventListener('click', discardDraft);
  if (dom.saSave) dom.saSave.addEventListener('click', saveSubagentTarget);

  /* 模型目录 */
  if (dom.modelQ) dom.modelQ.addEventListener('input', () => {
    state.query = dom.modelQ.value;
    setHidden(dom.modelQClear, !state.query);
    renderModels();
  });
  if (dom.modelQ) dom.modelQ.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.query) {
      event.stopPropagation();
      clearModelQuery();
    }
  });
  if (dom.modelQClear) dom.modelQClear.addEventListener('click', clearModelQuery);
  if (dom.filterAll) dom.filterAll.addEventListener('click', () => onModelFilter('all'));
  if (dom.filterVision) dom.filterVision.addEventListener('click', () => onModelFilter('vision'));
  if (dom.filterTools) dom.filterTools.addEventListener('click', () => onModelFilter('tools'));
  if (dom.filterReasoning) dom.filterReasoning.addEventListener('click', () => onModelFilter('reasoning'));
  if (dom.modelEmptyReset) dom.modelEmptyReset.addEventListener('click', () => {
    state.query = '';
    if (dom.modelQ) dom.modelQ.value = '';
    setHidden(dom.modelQClear, true);
    onModelFilter('all');
    if (dom.modelQ && dom.modelQ.focus) dom.modelQ.focus();
  });
  if (dom.modelNew) dom.modelNew.addEventListener('click', () => openEditor(null));

  if (dom.modelBody) dom.modelBody.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!node) return;
    if (node.dataset.rowEdit) {
      const model = findModel(node.dataset.rowEdit);
      if (model) openEditor(model);
      return;
    }
    if (node.dataset.rowDelete === 'ask') {
      state.deleteId = node.dataset.modelId;
      renderModels();
      return;
    }
    if (node.dataset.rowDelete === 'cancel') {
      state.deleteId = null;
      renderModels();
      return;
    }
    if (node.dataset.rowDelete === 'confirm') {
      const id = node.dataset.modelId;
      const models = ((state.data && state.data.models) || []).filter((model) => model.id !== id);
      saveCatalogue(models, { close: false, message: '模型 ' + id + ' 已从目录删除并应用。' });
    }
  });

  if (dom.inspectorClose) dom.inspectorClose.addEventListener('click', () => closeEditor(false));
  if (dom.modelCancel) dom.modelCancel.addEventListener('click', () => {
    if (state.editor && state.editor.confirmClose) {
      state.editor.confirmClose = false;
      renderEditor();
      return;
    }
    closeEditor(false);
  });
  if (dom.modelForm) {
    dom.modelForm.addEventListener('input', () => {
      if (!state.editor) return;
      state.editor.serverErrors = [];
      readEditorFields();
      renderEditor();
    });
    dom.modelForm.addEventListener('change', () => {
      if (!state.editor) return;
      state.editor.serverErrors = [];
      readEditorFields();
      renderEditor();
    });
    dom.modelForm.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.editor) {
        event.preventDefault();
        closeEditor(false);
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && dom.modelSave && !dom.modelSave.disabled) {
        event.preventDefault();
        const models = catalogueWith(state.editor, state.data.models);
        saveCatalogue(models);
      }
    });
  }
  if (dom.modelSave) dom.modelSave.addEventListener('click', () => {
    if (!state.editor || dom.modelSave.disabled) return;
    const { errors } = validateEditor(state.editor);
    if (errors.length) {
      renderEditor();
      return;
    }
    saveCatalogue(catalogueWith(state.editor, state.data.models));
  });

  /* 连接 */
  if (dom.connForm) {
    dom.connForm.addEventListener('input', () => {
      state.conn.dirty = connectionKey(connectionFormValues()) !== state.conn.base;
      if (dom.connErrors) setHidden(dom.connErrors, true);
      renderConnection();
    });
    dom.connForm.addEventListener('change', () => {
      state.conn.dirty = connectionKey(connectionFormValues()) !== state.conn.base;
      renderConnection();
    });
  }
  if (dom.connFillActive) dom.connFillActive.addEventListener('click', () => {
    if (!state.data || !state.data.connection || !state.data.connection.active) return;
    const values = sourceFormValues(state.data.connection.active);
    if (dom.cBase) dom.cBase.value = values.baseURL;
    if (dom.cKeyEnv) dom.cKeyEnv.value = values.apiKeyEnv;
    if (dom.cTokenEnv) dom.cTokenEnv.value = values.tokenEnv;
    if (dom.cPort) dom.cPort.value = values.port;
    if (dom.cDnsPort) dom.cDnsPort.value = values.dnsPort;
    if (dom.cDns) dom.cDns.checked = values.dns;
    state.conn.dirty = connectionKey(values) !== state.conn.base;
    renderConnection();
  });
  if (dom.connSave) dom.connSave.addEventListener('click', saveConnection);

  /* 思考翻译 */
  if (dom.trForm) {
    const onEdit = () => {
      if (!translationAvailable(state.data)) return;
      state.translation.dirty = translationKey(translationFormValues()) !== state.translation.base;
      if (dom.trErrors) setHidden(dom.trErrors, true);
      renderTranslation();
    };
    dom.trForm.addEventListener('input', onEdit);
    dom.trForm.addEventListener('change', onEdit);
  }
  if (dom.trReset) dom.trReset.addEventListener('click', () => {
    if (!translationAvailable(state.data)) return;
    fillTranslationForm();
    renderTranslation();
    renderActions(state.data);
  });
  if (dom.trSave) dom.trSave.addEventListener('click', saveTranslation);

  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => runAction(button.dataset.action));
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.key && !state.modelsSaving && !state.subagentSaving && !state.connSaving && !state.translationSaving) {
      loadState({ silent: true });
    }
  });
  window.addEventListener('online', () => {
    if (state.key) loadState({ silent: true });
  });
}

function clearModelQuery() {
  state.query = '';
  if (dom.modelQ) dom.modelQ.value = '';
  setHidden(dom.modelQClear, true);
  renderModels();
  if (dom.modelQ && dom.modelQ.focus) dom.modelQ.focus();
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
  state.draftDirty = false;
  state.editor = null;
  state.deleteId = null;
  state.started = false;
  state.pendingAction = null;
  state.pendingOpId = null;
  state.lastSync = null;
  state.conn.dirty = false;
  state.translation.base = null;
  state.translation.dirty = false;
  modelSignature = '';
  recentSignature = '';
  saModelSignature = '';
  saEffortSignature = '';

  stopPolling();
  setHidden(dom.conn, true);
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
  initView();
  bindEvents();
  actionButtons = Array.from(document.querySelectorAll('[data-action]'));

  /* 面板重启后粘贴新链接只改变 hash，浏览器不会重新执行脚本，
     因此在 hash 变化与页面重新可见时都重新取一次密钥。 */
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

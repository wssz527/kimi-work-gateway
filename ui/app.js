const API = {
  state: '/api/state',
  models: '/api/models',
  connection: '/api/connection',
  connections: '/api/connections',
  subagents: '/api/subagents',
  translation: '/api/translation',
  actions: '/api/actions',
  providers: '/api/providers',
  modelSearch: '/api/model-search',
  discovery: '/api/discovery',
  context: '/api/context',
  tools: '/api/tools',
};

const POLL_MS = 2000;
const KEY_STORE = 'kwg.panel.key';
const THEME_STORE = 'kwg.panel.theme';
const VIEW_STORE = 'kwg.panel.view';
const MODEL_ALIAS_PREFIXES = ['byok-kth-kimi/', 'byok-kth-resp/'];
const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost', '::1']);
const UPDATE_ACTIONS = new Set(['check-update', 'install-update', 'rollback-update']);
const UPDATE_RELEASE_PREFIX = 'https://github.com/wssz527/kimi-work-gateway/releases/tag/';
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/* 上下文预算预设：256K/350K/600K 是固定 token 数，"完整"取已知真实上限。
   任何预设都不得把套餐上限抬高，因此上限未知时只作手填起点并明确标注。 */
const BUDGET_PRESETS = [
  { id: '256k', label: '256K', tokens: 262144 },
  { id: '350k', label: '350K', tokens: 350000 },
  { id: '600k', label: '600K', tokens: 600000 },
  { id: 'full', label: '完整', tokens: null },
];

const CTX_STATUS = {
  inherit: { tone: 'neutral', word: '原生默认', note: '没有写入整理阈值，Kimi 按自己的默认策略整理上下文。' },
  applied: { tone: 'ok', word: '已写入原生配置', note: '配置已写入；正在运行的会话不会中途改变，需新会话读取后生效。' },
  'waiting-config': { tone: 'warn', word: '待写入', note: '策略已保存，但原生配置文件尚未确认写入。' },
  conflict: { tone: 'bad', word: '冲突', note: '原生配置中已有其他来源的设置，未覆盖；请检查后重试。' },
};

const MCP_REASON = {
  native_mcp_kernel_unavailable: '没有找到官方 Kimi 内核，无法读取原生 MCP。',
  native_mcp_kimi_dir_unavailable: 'Kimi 用户目录不可读。',
  native_mcp_kernel_incompatible: '当前 Kimi 内核版本不提供 MCP 管理接口。',
  native_mcp_timeout: '读取原生 MCP 超时。',
  native_mcp_operation_failed: '原生 MCP 操作未完成。',
  native_mcp_manager_closed: 'MCP 管理器已关闭，请重新加载面板。',
  native_mcp_test_failed: '服务器没有按 MCP 协议正常回应。',
  native_mcp_test_timeout: '测试超时，结果未知。',
  native_mcp_test_in_progress: '上一次测试尚未结束。',
  native_mcp_server_not_found: 'Kimi 原生配置中没有这个服务器。',
  native_mcp_invalid_input: '提交的服务器设置不被接受。',
  native_mcp_server_exists: '同名服务器已存在。',
};

const DISCOVERY_REASON = {
  discovery_unavailable: '无法连接该上游，请检查地址与网络。',
  discovery_timeout: '读取上游目录超时。',
  discovery_http_error: '上游 /models 返回了错误状态。',
  discovery_too_large: '上游目录超出允许大小，已中止。',
  discovery_invalid_catalog: '上游返回的目录格式不被接受。',
  connection_unavailable: '该连接已不在配置中。',
  discovery_busy: '上一次读取仍在进行，请稍候。',
};

/* check-upstream 失败原因与 discovery 共用同一族错误码；这里补齐它自己的
   连接级拒绝，避免把「连接不在当前配置」显示成原始代码。 */
const UPSTREAM_REASON = {
  ...DISCOVERY_REASON,
  connection_unavailable: '该连接不在当前已配置的连接中；检查按行进行，不会隐式挑选。',
};

const VIEW_COPY = {
  overview: { title: '概览', lede: '路由、连接、上下文与实测流量的真实状态。' },
  models: { title: '模型管理', lede: '每个模型对应一条本机路由与一个真实上游 ID；保存会提交整个目录。' },
  subagents: { title: '子代理', lede: '选择本机子代理实际使用的模型与思考档位。' },
  translation: { title: '思考翻译', lede: '把 Kimi 的思考过程翻译成所选语言；保存只写配置，注入成功以运行时为准。' },
  connection: { title: '连接与工具', lede: '上游连接、原生上下文阈值与 MCP 工具管理。' },
};

const ACTION_LABEL = {
  'prepare-runtime': '准备副本',
  'launch-kimi': '启动 Kimi',
  'prepare-native': '准备原生设置',
  'connect-kimi': '重新接入 Kimi',
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
  'waiting-idle': '等待 Kimi 空闲',
  'waiting-quit': '等待 Kimi 正常退出',
  active: '已连接',
  inactive: '等待 Kimi 启动',
  cancelled: '已取消',
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
  'file-applied': { tone: 'ok', word: '配置已写入', note: 'secondaryModel 配置文件已更新，等待 Kimi 内核热加载；是否采用以内核为准。' },
  'waiting-config': { tone: 'warn', word: '配置待写入', note: 'native-config 通道尚未把当前策略写入本机配置文件。' },
  restored: { tone: 'neutral', word: '已恢复原状', note: '本面板管理的配置已撤销，Kimi 恢复自身配置。' },
  inherit: { tone: 'neutral', word: '未接管', note: 'native-config 通道未接管子代理模型，Kimi 使用自己的配置。' },
  blocked: { tone: 'bad', word: '已阻止', note: '子代理策略处于阻止状态，子代理请求会被拒绝。' },
  unverified: { tone: 'warn', word: '未验证', note: '无法确认当前内核支持模型池配置；尚未写入任何配置。' },
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
  invalid_subagent_transport: '子代理通道只能是本机配置文件（native-config）。',
  invalid_subagent_pool: '模型池需要 1–32 个不重复的候选模型。',
  invalid_subagent_description: '用途说明必须是单行文本，最长 1000 字符。',
  subagent_pool_default_required: '默认模型必须在候选列表中。',
  subagent_native_config_pending: 'native-config 通道尚未把策略写入本机配置文件。',
  subagent_native_config_failed: '写入本机配置文件失败，请检查文件权限。',
  subagent_native_contract_unverified: '当前 Kimi 内核未通过模型池配置契约检查，未写入任何配置。',
  subagent_native_contract_unavailable: '无法读取本机 Kimi 内核文件，无法确认模型池契约。',
  subagent_native_bundle_unavailable: '没有可检查的本机 Kimi 内核文件。',
  subagent_native_reload_pending: 'Kimi 尚未把模型池重新加载进工具定义，稍后自动重试。',
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

  factConnections: $('fact-connections'),
  factConnectionsSub: $('fact-connections-sub'),
  factRoute: $('fact-route'),
  factRouteSub: $('fact-route-sub'),
  factContextDot: $('fact-context-dot'),
  factContext: $('fact-context'),
  factContextSub: $('fact-context-sub'),
  factToolsDot: $('fact-tools-dot'),
  factTools: $('fact-tools'),
  factToolsSub: $('fact-tools-sub'),

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
  mUpstream: $('m-upstream'),
  mUpstreamHint: $('m-upstream-hint'),
  mConnection: $('m-connection'),
  mConnectionHint: $('m-connection-hint'),
  mCandidates: $('m-candidates'),
  mSourceField: $('m-source-field'),
  mProtocolHint: $('m-protocol-hint'),
  mContextHint: $('m-context-hint'),
  mBudgetGroup: $('m-budget-group'),
  mName: $('m-name'),
  mProtocol: $('m-protocol'),
  mProtocolGroup: $('m-protocol-group'),
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
  modePool: $('mode-pool'),
  saForceFields: $('sa-force-fields'),
  saPoolFields: $('sa-pool-fields'),
  saPoolDefault: $('sa-pool-default'),
  saPoolDefaultHint: $('sa-pool-default-hint'),
  saPoolAdd: $('sa-pool-add'),
  saPoolDesc: $('sa-pool-desc'),
  saPoolDescHint: $('sa-pool-desc-hint'),
  saPoolAppend: $('sa-pool-append'),
  saPoolErrors: $('sa-pool-errors'),
  saPoolList: $('sa-pool-list'),
  saNativeRow: $('sa-native-row'),
  saNative: $('sa-native'),
  saNativeHint: $('sa-native-hint'),
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
  rtNativeFacts: $('rt-native-facts'),
  rtObservedFact: $('rt-observed-fact'),
  rtObserved: $('rt-observed'),
  rtCompat: $('rt-compat'),
  rtCompatSub: $('rt-compat-sub'),
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
  restartHead: $('restart-head'),
  restartService: $('restart-service'),
  restartForeground: $('restart-foreground'),
  restartServiceRestart: $('restart-service-restart'),
  restartServiceStatus: $('restart-service-status'),
  restartServiceConfig: $('restart-service-config'),

  connsUnavailable: $('conns-unavailable'),
  connsList: $('conns-list'),
  connsEmpty: $('conns-empty'),
  connsDiff: $('conns-diff'),
  connsErrors: $('conns-errors'),
  connsDraft: $('conns-draft'),
  connsAdd: $('conns-add'),
  connsReset: $('conns-reset'),
  connsSave: $('conns-save'),
  connEditor: $('conn-editor'),
  connEditorTitle: $('conn-editor-title'),
  connEditorClose: $('conn-editor-close'),
  connEditorCancel: $('conn-editor-cancel'),
  connEditorApply: $('conn-editor-apply'),
  connEditorTest: $('conn-editor-test'),
  ceName: $('ce-name'),
  ceId: $('ce-id'),
  cePreset: $('ce-preset'),
  cePresetHint: $('ce-preset-hint'),
  ceBase: $('ce-base'),
  ceKey: $('ce-key'),
  ceKeyHint: $('ce-key-hint'),
  ceKeyEnv: $('ce-keyenv'),
  ceChat: $('ce-chat'),
  ceResponses: $('ce-responses'),
  legacyPanel: $('legacy-panel'),

  ctxUnavailable: $('ctx-unavailable'),
  ctxModes: $('ctx-modes'),
  ctxModeInherit: $('ctx-mode-inherit'),
  ctxModeCustom: $('ctx-mode-custom'),
  ctxFields: $('ctx-fields'),
  ctxRatio: $('ctx-ratio'),
  ctxRatioHint: $('ctx-ratio-hint'),
  ctxReserved: $('ctx-reserved'),
  ctxReservedHint: $('ctx-reserved-hint'),
  ctxSaved: $('ctx-saved'),
  ctxSavedSub: $('ctx-saved-sub'),
  ctxObserved: $('ctx-observed'),
  ctxObservedSub: $('ctx-observed-sub'),
  ctxVerdict: $('ctx-verdict'),
  ctxVerdictDot: $('ctx-verdict-dot'),
  ctxVerdictWord: $('ctx-verdict-word'),
  ctxVerdictNote: $('ctx-verdict-note'),
  ctxErrors: $('ctx-errors'),
  ctxDraft: $('ctx-draft'),
  ctxReset: $('ctx-reset'),
  ctxSave: $('ctx-save'),
  ctxNote: $('ctx-note'),

  picker: $('picker'),
  pickerTitle: $('picker-title'),
  pickerLede: $('picker-lede'),
  pickerClose: $('picker-close'),
  pickerQ: $('picker-q'),
  pickerScan: $('picker-scan'),
  pickerState: $('picker-state'),
  pickerNote: $('picker-note'),
  pickerList: $('picker-list'),
  pickerEmpty: $('picker-empty'),
  pickerEmptyTitle: $('picker-empty-title'),
  pickerEmptyNote: $('picker-empty-note'),

  toolsUnavailable: $('tools-unavailable'),
  toolsList: $('tools-list'),
  toolsEmpty: $('tools-empty'),
  toolsEditor: $('tools-editor'),
  toolsEditorTitle: $('tools-editor-title'),
  toolsEditorClose: $('tools-editor-close'),
  toolsAdd: $('tools-add'),
  toolsRefresh: $('tools-refresh'),
  toolsErrors: $('tools-errors'),
  toolsResult: $('tools-result'),
  teName: $('te-name'),
  teNameHint: $('te-name-hint'),
  teTransport: $('te-transport'),
  teStdio: $('te-stdio'),
  teRemote: $('te-remote'),
  teCommand: $('te-command'),
  teArgs: $('te-args'),
  teEnv: $('te-env'),
  teUrl: $('te-url'),
  teHeaders: $('te-headers'),
  teEnabled: $('te-enabled'),
  teErrors: $('te-errors'),
  teSave: $('te-save'),
  teCancel: $('te-cancel'),

  diagCompatDot: $('diag-compat-dot'),
  diagCompatState: $('diag-compat-state'),
  diagCompatMeta: $('diag-compat-meta'),

  nativeRemote: $('native-remote'),
  nativeRemoteDot: $('native-remote-dot'),
  nativeRemoteWord: $('native-remote-word'),
  nativeRemoteNote: $('native-remote-note'),

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
  conns: { base: null, dirty: false, editing: null, draft: null, errors: [] },
  connChecks: {},
  context: { base: null, dirty: false },
  tools: { servers: null, available: false, reason: null, editing: false, result: null, busy: false },
  picker: { open: false, models: null, query: '', state: null, checkedAt: null, source: null, reason: null,
    busy: false, seq: 0, hint: null, scope: null },
  providers: null,
  modelsSaving: false,
  subagentSaving: false,
  connSaving: false,
  connsSaving: false,
  contextSaving: false,
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

/* 错误列表是界面里唯一展示后端拒绝原因的位置；空列表即隐藏，
   避免留下上一次的过期错误被误读成当前状态。 */
function renderErrorList(el, messages) {
  if (!el) return;
  const list = (messages || []).filter((message) => typeof message === 'string' && message);
  setHidden(el, list.length === 0);
  el.replaceChildren(...list.map((message) => {
    const p = document.createElement('p');
    p.textContent = message;
    return p;
  }));
}

/* 连接区的提示必须活过轮询重渲染：把它存进会话状态再画，
   只画不存会导致下一次 state 刷新把用户的错误提示悄悄抹掉。 */
function setConnErrors(messages) {
  state.conns.errors = (messages || []).filter((message) => typeof message === 'string' && message);
  renderErrorList(dom.connsErrors, state.conns.errors);
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

/* token 预算按真实数值展示；不四舍五入到「看起来像整 K」的数，
   避免把一个手填的 262000 显示成 262K 而掩盖实际值。 */
function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '未知';
  return n.toLocaleString('zh-CN') + ' tokens';
}

function fmtMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' s';
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

  /* contextLimit 是已知的真实上游上限，只作校验用；预算超过它时明确拒绝，
     而不是把套餐限制悄悄抬高。上限未知时不做任何推断。 */
  const limitText = String(input.contextLimit === undefined || input.contextLimit === null ? '' : input.contextLimit).trim();
  let contextLimit;
  if (limitText) {
    contextLimit = Number(limitText);
    if (!Number.isSafeInteger(contextLimit) || contextLimit <= 0) errors.push('已知上下文上限必须是正整数，或留空表示未知。');
    else if (Number.isSafeInteger(contextWindow) && contextWindow > contextLimit) {
      errors.push('上下文预算 ' + fmtTokens(contextWindow) + ' 超过已知上限 ' + fmtTokens(contextLimit) + '，不能保存。');
    }
  }

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

  const connectionId = String(input.connectionId || '').trim();
  if (connectionId && !CONNECTION_ID_PATTERN.test(connectionId)) errors.push('连接标识格式无效，请重新选择连接。');
  const upstreamModelId = String(input.upstreamModelId || '').trim();
  if (upstreamModelId && /[\u0000-\u001f]/.test(upstreamModelId)) errors.push('上游模型 ID 不能包含控制字符。');
  if (upstreamModelId.length > 2048) errors.push('上游模型 ID 过长。');

  const metadata = metadataSourceOf(input.metadataSource);

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
    ...(connectionId ? { connectionId } : {}),
    ...(upstreamModelId ? { upstreamModelId } : {}),
    ...(contextLimit ? { contextLimit } : {}),
    ...(metadata ? { metadataSource: metadata } : {}),
  };
  return { model, errors };
}

/* 元数据来源只保留契约里的三种，且只在带 url/checkedAt 时才带这些字段：
   来源不可考时宁可不写，也不伪造一个 checkedAt。 */
function metadataSourceOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['preset', 'discovery', 'manual'].includes(value.kind)) return null;
  const source = { kind: value.kind };
  if (typeof value.url === 'string' && /^https?:\/\//.test(value.url)) source.url = value.url;
  if (typeof value.checkedAt === 'string' && value.checkedAt) source.checkedAt = value.checkedAt;
  return source;
}

/* `metadataSource` 只描述 contextWindow 这一个字段的真实出处：保存预算时原样
   沿用，所以既不能默认写 discovery，也不能拿别的字段的来源顶替。判定顺序：
   后端合并后的 metadataSource（专指上下文来源）→ 合并前的 sources（只有一方
   贡献过才能归因）→ 候选自己的 parser 来源 → manual。 */
function candidateMetadataSource(model) {
  if (!model || typeof model !== 'object') return { kind: 'manual' };
  const stated = metadataSourceOf(model.metadataSource);
  if (stated) return stated;
  const sources = model.sources && typeof model.sources === 'object' ? model.sources : null;
  if (sources) {
    const sides = ['discovery', 'preset'].map((key) => metadataSourceOf(sources[key])).filter(Boolean);
    /* 两方都贡献过字段时无法判断预算出自哪边：宁可标 manual，也不猜一个。 */
    if (sides.length === 1) return sides[0];
    if (sides.length > 1) return { kind: 'manual' };
  }
  /* parser 的 per-model `source` 只有 url/checkedAt，没有 kind：它来自上游目录
     读取，且只有这条候选确实读到了 contextWindow 才谈得上预算来源。 */
  if (model.source && typeof model.source === 'object' && Number(model.contextWindow) > 0) {
    const own = metadataSourceOf({ ...model.source, kind: 'discovery' });
    if (own) return own;
  }
  return { kind: 'manual' };
}

function catalogueWith(editor, models) {
  const built = buildModel(editor.draft).model;
  const list = models.map((model) => ({ ...model }));
  const index = editor.originalId ? list.findIndex((model) => model.id === editor.originalId) : -1;
  if (index >= 0) list[index] = built;
  else list.push(built);
  return list;
}

/* ---------- routing helpers ---------- */

/* 建议的本机路由 ID：连接 + 协议前缀 + 上游 ID 的百分号编码。
   末段决定协议，因此前缀同时是这份契约的自解释形式；用户仍可手改。 */
function routeIdFor(connectionId, upstreamModelId, protocol) {
  const connection = String(connectionId || '').trim();
  const upstream = String(upstreamModelId || '').trim();
  if (!connection || !upstream) return '';
  const family = protocol || modelFamilyFor(upstream) || 'responses';
  const prefix = family === 'chat' ? 'kimi-' : 'resp-';
  return connection + '/' + prefix + encodeURIComponent(upstream);
}

function connectionRowsOf(data) {
  const connections = data && data.connections;
  if (!connections) return null;
  const rows = Array.isArray(connections.saved) ? connections.saved : Array.isArray(connections.active) ? connections.active : [];
  return rows.filter((row) => row && typeof row === 'object');
}

function connectionsAvailable(data) {
  return Array.isArray(connectionRowsOf(data));
}

function findConnection(data, id) {
  const rows = connectionRowsOf(data) || [];
  return rows.find((row) => row && row.id === id) || null;
}

function connectionLabel(row) {
  if (!row) return '—';
  if (row.legacy) return '旧版单上游';
  return row.name || row.id || '—';
}

function connectionsChanged(data) {
  return Boolean(data && data.connections && data.connections.restartRequired);
}

/* 路由与上游 ID 都按原样展示：任何大小写或分隔符改写都会让请求打到不存在的模型。 */
function routingOf(model) {
  if (!model) return { connection: null, connectionId: null, upstream: null, legacy: true };
  const connectionId = typeof model.connectionId === 'string' && model.connectionId ? model.connectionId : null;
  return {
    connectionId,
    connection: connectionId,
    upstream: typeof model.upstreamModelId === 'string' && model.upstreamModelId ? model.upstreamModelId : model.id,
    legacy: !connectionId,
  };
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

/* ---------- named connections ---------- */

/* 草稿只保存可回传的字段。apiKey 只在用户本次输入时存在，且不会回填到任何
   输入框；签名比较同样排除它，避免把「刚输入但未保存的 key」当成未变更。 */
function connectionDraftRow(row) {
  return {
    id: typeof row.id === 'string' ? row.id : '',
    name: typeof row.name === 'string' ? row.name : '',
    providerPresetId: typeof row.providerPresetId === 'string' ? row.providerPresetId : '',
    baseURL: typeof row.baseURL === 'string' ? row.baseURL : '',
    apiKeyEnv: typeof row.apiKeyEnv === 'string' ? row.apiKeyEnv : '',
    protocols: Array.isArray(row.protocols) ? row.protocols.filter((value) => value === 'chat' || value === 'responses') : null,
    legacy: row.legacy === true,
    modelCount: Number.isInteger(row.modelCount) ? row.modelCount : null,
    apiKeySet: row.apiKeySet === true,
    apiKey: '',
    secretSet: false,
  };
}

function connectionDraftFrom(data) {
  const rows = connectionRowsOf(data);
  if (!rows) return null;
  return rows.map(connectionDraftRow);
}

function connectionsSignature(rows) {
  if (!Array.isArray(rows)) return '';
  return JSON.stringify(rows.map((row) => [row.legacy ? 'legacy' : 'named', row.id, row.name,
    row.providerPresetId || '', row.baseURL, row.apiKeyEnv || '',
    (row.protocols || []).slice().sort().join(','), row.apiKey ? 'with-key' : '']));
}

function savedConnectionsSignature(data) {
  return connectionsSignature(connectionDraftFrom(data));
}

function connectionsDirty() {
  return connectionsSignature(state.conns.draft || []) !== state.conns.base;
}

/* 提交体只包含契约允许的字段；apiKey 仅在本次输入过时带上，
   省略即表示保留已保存的旧值。 */
function connectionPayload(rows) {
  return (rows || []).filter((row) => !row.legacy).map((row) => ({
    id: row.id,
    name: row.name,
    ...(row.providerPresetId ? { providerPresetId: row.providerPresetId } : {}),
    baseURL: row.baseURL,
    ...(row.apiKeyEnv ? { apiKeyEnv: row.apiKeyEnv } : {}),
    ...(Array.isArray(row.protocols) && row.protocols.length ? { protocols: row.protocols } : {}),
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
  }));
}

const CONNECTION_ID_HINT = '标识只能使用字母、数字、点、下划线与连字符，且以字母或数字开头。';

/* 编辑抽屉的本地校验与服务端白名单保持一致，并额外拦下三种会静默丢配置的情况：
   重复标识、重复环境变量名、以及新连接缺 Key。 */
function validateConnectionDraft(draft, rows, { originalId = null } = {}) {
  const errors = [];
  const id = String(draft.id || '').trim();
  const name = String(draft.name || '').trim();
  if (!name) errors.push('请填写显示名称。');
  else if (name.length > 128) errors.push('显示名称最长 128 字符。');
  if (!id) errors.push('请填写连接标识。');
  else if (!CONNECTION_ID_PATTERN.test(id)) errors.push(CONNECTION_ID_HINT);
  else if ((rows || []).some((row) => !row.legacy && row.id === id && row.id !== originalId)) errors.push('已有同名标识的连接。');

  const base = normalizeBaseURL(draft.baseURL);
  if (base.error) errors.push(base.error);

  const keyEnv = String(draft.apiKeyEnv || '').trim();
  if (keyEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(keyEnv)) errors.push('Key 变量名只能使用大写字母、数字与下划线，且不能以数字开头。');
  if (keyEnv && (rows || []).some((row) => !row.legacy && row.id !== originalId && row.apiKeyEnv === keyEnv)) {
    errors.push('另一条连接已使用同一个 Key 变量名。');
  }

  const apiKey = String(draft.apiKey || '');
  if (!apiKey.trim() && !draft.secretSet && !(originalId && (rows || []).some((row) => row.id === originalId && row.apiKeySet))) {
    errors.push('请填写 API Key。留空只用于保持已保存的 Key。');
  }
  if (apiKey && /[\u0000-\u001f]/.test(apiKey)) errors.push('API Key 不能包含换行或控制字符。');

  const protocols = Array.isArray(draft.protocols) ? draft.protocols.filter((value) => value === 'chat' || value === 'responses') : [];
  return {
    errors,
    value: {
      id,
      name,
      ...(draft.providerPresetId ? { providerPresetId: draft.providerPresetId } : {}),
      baseURL: base.value || String(draft.baseURL || '').trim(),
      apiKeyEnv: keyEnv,
      ...(protocols.length ? { protocols } : {}),
      apiKey: apiKey.trim(),
      legacy: false,
    },
  };
}

/* 每次打开抽屉都从草稿副本开始，取消不会留下半个编辑。 */
function openConnectionEditor(row) {
  const rows = state.conns.draft || [];
  state.conns.editing = {
    originalId: row && !row.legacy ? row.id : null,
    draft: row ? { ...connectionDraftRow(row), apiKey: '', secretSet: row.apiKeySet === true }
      : { id: '', name: '', providerPresetId: '', baseURL: '', apiKeyEnv: '', protocols: null,
        legacy: false, modelCount: null, apiKeySet: false, apiKey: '', secretSet: false },
    errors: [],
  };
  renderConnections();
  if (dom.ceName && dom.ceName.focus) dom.ceName.focus();
}

function closeConnectionEditor() {
  state.conns.editing = null;
  renderConnections();
}

function readConnectionEditor() {
  const editing = state.conns.editing;
  if (!editing) return;
  editing.draft.name = dom.ceName ? dom.ceName.value : editing.draft.name;
  if (editing.originalId === null && dom.ceId) editing.draft.id = dom.ceId.value;
  editing.draft.providerPresetId = dom.cePreset ? dom.cePreset.value : editing.draft.providerPresetId;
  editing.draft.baseURL = dom.ceBase ? dom.ceBase.value : editing.draft.baseURL;
  editing.draft.apiKey = dom.ceKey ? dom.ceKey.value : editing.draft.apiKey;
  editing.draft.apiKeyEnv = dom.ceKeyEnv ? dom.ceKeyEnv.value : editing.draft.apiKeyEnv;
  const protocols = [];
  if (dom.ceChat && dom.ceChat.checked) protocols.push('chat');
  if (dom.ceResponses && dom.ceResponses.checked) protocols.push('responses');
  editing.draft.protocols = protocols.length ? protocols : null;
  if (editing.draft.apiKey) editing.draft.secretSet = true;
}

function applyConnectionEditor() {
  const editing = state.conns.editing;
  if (!editing) return;
  readConnectionEditor();
  const rows = state.conns.draft || [];
  const { errors, value } = validateConnectionDraft(editing.draft, rows, { originalId: editing.originalId });
  editing.errors = errors;
  if (errors.length) {
    renderConnections();
    return;
  }
  const next = rows.slice();
  const index = editing.originalId ? next.findIndex((row) => !row.legacy && row.id === editing.originalId) : -1;
  const stored = {
    ...value,
    modelCount: index >= 0 ? next[index].modelCount : 0,
    apiKeySet: index >= 0 ? next[index].apiKeySet : false,
    secretSet: Boolean(value.apiKey) || (index >= 0 && next[index].secretSet),
  };
  if (index >= 0) next[index] = stored;
  else next.push(stored);
  state.conns.draft = next;
  state.conns.editing = null;
  renderConnections();
  renderConnectionsDiff();
}

/* 供应商预设只用来填地址与协议；字段可继续手改，不把预设当成不可推翻的事实。 */
function applyProviderPreset(presetId) {
  const editing = state.conns.editing;
  if (!editing || !presetId) return;
  const preset = providerPreset(presetId);
  if (!preset) return;
  editing.draft.providerPresetId = preset.id;
  editing.draft.baseURL = typeof preset.baseURL === 'string' ? preset.baseURL : editing.draft.baseURL;
  if (Array.isArray(preset.protocols) && preset.protocols.length) {
    editing.draft.protocols = preset.protocols.filter((value) => value === 'chat' || value === 'responses');
  }
  if (!editing.draft.name) editing.draft.name = preset.name || '';
  if (!editing.draft.id) editing.draft.id = presetsSuggestedId(preset);
  if (dom.ceBase) dom.ceBase.value = editing.draft.baseURL;
  if (dom.ceChat) dom.ceChat.checked = (editing.draft.protocols || []).includes('chat');
  if (dom.ceResponses) dom.ceResponses.checked = (editing.draft.protocols || []).includes('responses');
  if (dom.ceId && editing.originalId === null) dom.ceId.value = editing.draft.id;
  if (dom.ceName) dom.ceName.value = editing.draft.name;
  renderConnections();
}

function presetsSuggestedId(preset) {
  const base = String(preset.id || 'conn').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  let id = base || 'conn';
  if (!/^[A-Za-z0-9]/.test(id)) id = 'c-' + id;
  return id.slice(0, 64);
}

function providerPresets() {
  return state.providers && Array.isArray(state.providers.presets) ? state.providers.presets : [];
}

function providerPreset(id) {
  if (!id) return null;
  return providerPresets().find((preset) => preset && preset.id === id) || null;
}

/* ---------- native context policy ---------- */

const CTX_RATIO_MIN = 0.5;
const CTX_RATIO_MAX = 0.99;

function contextPolicyOf(data) {
  const context = data && data.context;
  return context && typeof context === 'object' && context.policy ? context : null;
}

function contextAvailable(data) {
  return contextPolicyOf(data) !== null;
}

/* 契约只接受 0.50–0.99 的小数。越界或缺失时返回 null，由界面显示「待确认」，
   绝不把 >1 的百分数静默换算成小数而掩盖后端契约问题。 */
function normalizedRatio(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  if (number < CTX_RATIO_MIN || number > CTX_RATIO_MAX) return null;
  return number;
}

function ratioToPercent(value) {
  const ratio = normalizedRatio(value);
  return ratio === null ? null : Math.round(ratio * 1000) / 10;
}

function percentToRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const ratio = Math.round(number * 10) / 1000;
  return ratio < CTX_RATIO_MIN || ratio > CTX_RATIO_MAX ? null : ratio;
}

function contextDraftFrom(data) {
  const context = contextPolicyOf(data);
  if (!context) return null;
  const policy = context.policy || {};
  const custom = policy.mode === 'custom';
  return {
    mode: custom ? 'custom' : 'inherit',
    ratio: custom && normalizedRatio(policy.triggerRatio) !== null ? String(ratioToPercent(policy.triggerRatio)) : '',
    reserved: custom && Number.isSafeInteger(policy.reservedTokens) && policy.reservedTokens >= 0 ? String(policy.reservedTokens) : '0',
  };
}

function contextSignature(draft) {
  return draft ? JSON.stringify([draft.mode, draft.ratio, draft.reserved]) : '';
}

function contextDirty() {
  return contextSignature(state.context.draft) !== state.context.base;
}

function validateContextDraft(draft) {
  const errors = [];
  if (!draft) return { errors, value: null };
  if (draft.mode === 'inherit') return { errors, value: { mode: 'inherit' } };
  const ratio = percentToRatio(draft.ratio);
  if (ratio === null) errors.push('触发阈值必须是 50–99 之间的百分比。');
  const reservedText = String(draft.reserved === '' ? '0' : draft.reserved === undefined ? '0' : draft.reserved).trim();
  const reserved = Number(reservedText);
  if (!Number.isSafeInteger(reserved) || reserved < 0) errors.push('预留预算必须是不小于 0 的整数 tokens。');
  return { errors, value: errors.length ? null : { mode: 'custom', triggerRatio: ratio, reservedTokens: reserved } };
}

function evaluateContext(data) {
  const context = contextPolicyOf(data);
  if (!context) {
    return { tone: 'neutral', word: '不可用', note: '面板服务没有提供上下文策略状态；模型与连接不受影响。', status: null };
  }
  const status = typeof context.status === 'string' ? context.status : 'inherit';
  const info = CTX_STATUS[status] || { tone: 'neutral', word: status, note: '' };
  const reason = typeof context.reason === 'string' && context.reason ? context.reason : '';
  return { ...info, note: reason || info.note, status };
}

/* ---------- native MCP managers ---------- */

function toolsState(data) {
  const value = data && data.tools;
  return value && typeof value === 'object' && Array.isArray(value.servers) ? value : null;
}

function toolsAvailable(data) {
  const value = toolsState(data);
  return Boolean(value && value.available === true);
}

function mcpReasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  return MCP_REASON[code] || code;
}

/* 已知原因有中文说明；未知错误码也给一句可读的话，不把内部标识直接甩给用户。 */
function discoveryReasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  if (DISCOVERY_REASON[code]) return DISCOVERY_REASON[code];
  if (code === 'model_search_failed' || code === 'panel_operation_failed') {
    return '候选搜索未完成，请稍后重试；已载入的供应商目录仍可点选。';
  }
  return '操作未完成（' + code + '）；请重试或查看诊断。';
}

/* update 的 patch 只能包含用户真正改过的字段：省略的秘密字段由后端保留，
   因此未填写的 env/headers 绝不能被序列化成空对象而把已存值清空。 */
function mcpServerPayload(draft) {
  const errors = [];
  const name = String(draft.name || '');
  if (!MCP_NAME_PATTERN.test(name)) errors.push('名称需以字母或数字开头，可用点、下划线与连字符，最长 64 字符。');
  const transport = ['stdio', 'http', 'sse'].includes(draft.transport) ? draft.transport : null;
  if (!transport) errors.push('请选择传输方式。');
  const server = { name, transport, enabled: draft.enabled !== false };
  if (transport === 'stdio') {
    const command = String(draft.command || '').trim();
    if (!command) errors.push('stdio 服务器需要填写命令。');
    if (command.length > 1024) errors.push('命令最长 1024 字符。');
    server.command = command;
    const args = (draft.args || []).filter((value) => typeof value === 'string');
    if (args.length > 64) errors.push('参数最多 64 个。');
    if (args.length) server.args = args;
    if (draft.env && Object.keys(draft.env).length) server.env = { ...draft.env };
  } else if (transport) {
    const url = String(draft.url || '').trim();
    let parsed;
    try { parsed = new URL(url); } catch { errors.push('服务地址不是合法的 URL。'); }
    if (parsed && !['http:', 'https:'].includes(parsed.protocol)) errors.push('服务地址只接受 http 或 https。');
    if (parsed && (parsed.username || parsed.password)) errors.push('服务地址不能包含账号或密码。');
    if (!url) errors.push('远程服务器需要填写服务地址。');
    server.url = url;
    if (draft.headers && Object.keys(draft.headers).length) server.headers = { ...draft.headers };
  }
  return { errors, server };
}

function parseLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function parseEnvLines(text) {
  const env = {};
  const invalid = [];
  for (const line of parseLines(text)) {
    const index = line.indexOf('=');
    if (index <= 0) { invalid.push(line); continue; }
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { invalid.push(line); continue; }
    env[key] = line.slice(index + 1);
  }
  return { env, invalid };
}

function parseHeaderLines(text) {
  const headers = {};
  const invalid = [];
  for (const line of parseLines(text)) {
    const index = line.indexOf(':');
    if (index <= 0) { invalid.push(line); continue; }
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z0-9-]+$/.test(key)) { invalid.push(line); continue; }
    headers[key] = line.slice(index + 1).trim();
  }
  return { headers, invalid };
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
  const mode = configured && ['force', 'pool'].includes(configured.mode) ? configured.mode : 'inherit';
  const transport = mode !== 'inherit' && configured && configured.transport === 'native-config' ? 'native-config' : null;
  return {
    mode,
    transport,
    model:
      mode !== 'inherit'
        ? typeof configured.model === 'string' && configured.model
          ? configured.model
          : typeof configured.modelAlias === 'string' && configured.modelAlias
            ? modelIdFromAlias(configured.modelAlias) || configured.modelAlias
            : null
        : null,
    effort: mode === 'force' && typeof configured.effort === 'string' ? configured.effort : null,
    models: mode === 'pool' && Array.isArray(configured.models)
      ? configured.models
        .filter((row) => row && typeof row.id === 'string' && typeof row.description === 'string')
        .map((row) => ({ id: row.id, description: row.description }))
      : [],
  };
}

function draftFromSaved(data) {
  const saved = savedTarget(data);
  return {
    mode: saved.mode,
    transport: saved.transport,
    model: saved.model,
    effort: saved.effort,
    models: saved.models.map((row) => ({ ...row })),
  };
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.mode !== b.mode) return false;
  if (a.mode === 'inherit') return true;
  if ((a.transport || null) !== (b.transport || null)) return false;
  if ((a.model || null) !== (b.model || null)) return false;
  if (a.mode === 'pool') {
    const left = Array.isArray(a.models) ? a.models : [];
    const right = Array.isArray(b.models) ? b.models : [];
    return left.length === right.length
      && left.every((row, index) => row && right[index] && row.id === right[index].id && row.description === right[index].description);
  }
  return (a.effort || null) === (b.effort || null);
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
    if (runtimeState === 'file-applied' && policy.mode === 'inherit' && runtime.mode === 'inherit') {
      return { tone: 'ok', word: '继承已下发', note: '继承策略已写入本机配置文件；内核是否采用以它自己的重载为准。' };
    }
    return { tone: info.tone, word: info.word, note: info.note };
  }

  if (policy.mode === 'blocked') {
    return { tone: 'bad', word: '子代理被阻止', note: policy.reason || '运行时策略禁止子代理。' };
  }

  if (saved.transport === 'native-config') {
    if (runtime.transport !== 'native-config' && (runtimeState === 'loaded' || runtimeState === 'pending-policy' || runtimeState === 'waiting-launch')) {
      return { tone: 'warn', word: '通道未切换', note: '运行时仍按旧的副本通道工作；保存的 native-config 目标在内核重载配置后才会被采用。' };
    }
    if (runtimeState === 'file-applied' || runtimeState === 'unverified' || runtimeState === 'waiting-config') {
      const pool = saved.mode === 'pool' ? saved.models.length + ' 个候选模型' : saved.model;
      const observed = runtime.observed && runtime.observed.state === 'observed-schema';
      if (observed) {
        return {
          tone: saved.mode === 'pool' ? 'ok' : 'warn',
          word: saved.mode === 'pool' ? '池已可见' : '配置已写入',
          note: 'Kimi 发来的工具定义已包含' + (saved.mode === 'pool' ? '模型池' : '该模型')
            + '；这只证明工具定义已更新，内核实际选用哪个模型以运行时为准。',
        };
      }
      if (runtimeState !== 'file-applied') {
        return {
          tone: 'warn',
          word: info.word,
          note: '本次目标尚未落入本机配置：' + (info.note || '等待内核兼容检查与模型声明完成。')
            + (info.tone === 'bad' ? '' : '保存后无需重复操作，面板会继续核对。'),
        };
      }
      return {
        tone: 'warn',
        word: '已写入待内核采用',
        note: (saved.mode === 'pool' ? '模型池（' + pool + '）' : '固定模型')
          + '已写入本机配置文件；等 Kimi 内核重载后，工具定义与实际选用才反映新目标。',
      };
    }
    if (runtimeState === 'inherit' || runtimeState === 'restored') {
      return { tone: 'warn', word: '尚未接管', note: 'native-config 通道还没有写入本次目标；保存后等待配置文件更新。' };
    }
    if (runtimeState === 'loaded' && policy.transport === 'native-config') {
      return { tone: info.tone, word: info.word, note: '旧副本通道已停止；native-config 状态见上方运行时事实。' };
    }
    return { tone: info.tone, word: info.word, note: info.note };
  }

  if (runtimeState === 'loaded') {
    const adoptedId = modelIdFromAlias(runtime.modelAlias);
    const policyId = typeof policy.model === 'string' && policy.model ? policy.model : modelIdFromAlias(policy.modelAlias);
    const effortOf = (value) => (typeof value === 'string' && value ? value : null);
    const modeAgrees = runtime.mode === 'force' && policy.mode === 'force';
    const modelAgrees = adoptedId !== null && adoptedId === policyId && policyId === saved.model;
    const savedEffort = effortOf(saved.effort) || effortOf(findModel(saved.model)?.defaultEffort);
    const effortAgrees = effortOf(policy.effort) === savedEffort;

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

function desktopScopeInfo(data) {
  const info = (data && data.integration) || {};
  if (!info.desktop && info.imported !== true) return null;
  return { tone: 'neutral', word: '仅桌面', note: '只接入本机官方 Kimi 桌面 Work，不同步模型或登录态到 Kimi 手机端。' };
}

function nativeConnectionText(data) {
  const info = data.integration || {};
  const preparation = info.preparation || {};
  if (preparation.state === 'preparing') return '正在准备首次接入，请处理系统授权窗口。';
  if (preparation.state === 'cancelled') return '上次系统授权已取消。点击“重新接入 Kimi”可继续。';
  if (preparation.state === 'failed' || preparation.state === 'interrupted') return '接入准备未完成，请检查系统授权后重试。';
  if (info.imported) return '模型目录已接入 Kimi 原生选择器；保存目录后自动同步。';
  const reason = info.nativeImport?.reason || info.desktop?.reason || info.reason;
  const reasons = {
    native_bridge_unavailable: '正在等待 Kimi 接入通道，空闲后会自动恢复。',
    native_bridge_waiting_settings: '正在等待 Kimi 设置页完成原生导入。',
    native_bridge_waiting_launch: '等待 Kimi 启动并建立接入通道。',
    native_import_waiting_login: '请先在 Kimi Work 登录，然后重试接入。',
    native_import_disconnected: '检测到原生接入已断开。确认需要恢复后，点击“重新接入 Kimi”。',
    native_scope_unverified: '当前自定义 Kimi 目录无法确认归属，自动接管已暂停。',
    account_changed: '当前 Kimi 账户已变化，请核对账户后重试接入。',
    native_import_account_changed: '当前 Kimi 账户已变化，请核对账户后重试接入。',
    native_bridge_busy: 'Kimi 正在处理任务，空闲后会自动同步。',
    native_import_retry_pending: '正在等待上一次接入完成。',
  };
  if (reasons[reason]) return reasons[reason];
  if (info.state === 'pending') return '原生目录已接受，等待 Kimi 内核完成切换。';
  if (info.state === 'conflict') return '接入配置存在冲突，已保留当前内容；请检查配置后重试。';
  if (info.state === 'account-unverified') return '请登录 Kimi Work，等待确认当前账户。';
  if (info.desktop?.state === 'waiting-idle' || info.desktop?.state === 'waiting-quit') return '等待 Kimi 空闲后恢复接入。';
  return '正在检查模型接入；首次使用请先打开并登录 Kimi Work。';
}

function renderOverview(data) {
  setText($('native-state'), nativeConnectionText(data));
  const scope = desktopScopeInfo(data);
  setHidden(dom.nativeRemote, !scope);
  if (scope) {
    setDot(dom.nativeRemoteDot, scope.tone);
    setText(dom.nativeRemoteWord, scope.word);
    setText(dom.nativeRemoteNote, scope.note);
  }
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
  const savedModel = saved.mode !== 'inherit' ? findModel(saved.model) : null;
  let savedLabel;
  if (saved.mode === 'inherit') savedLabel = '继承主模型';
  else if (saved.mode === 'pool') savedLabel = '模型池 · ' + fmtCount(saved.models.length) + ' 个候选';
  else savedLabel = saved.model ? modelLabel(savedModel, saved.model) : '未选择';
  setText(dom.savedValue, savedLabel);
  const savedChannel = saved.transport === 'native-config' ? 'native-config' : '副本模式';
  const savedParts = saved.mode === 'inherit'
    ? ['不固定模型与档位']
    : saved.mode === 'pool'
      ? [saved.model, '默认模型 · ' + savedChannel].filter(Boolean)
      : [saved.model, saved.effort ? '档位 ' + saved.effort : '档位自动', savedChannel].filter(Boolean);
  setText(dom.savedSub, savedParts.join(' · '));

  const loaded = runtime.state === 'loaded' || runtime.state === 'file-applied';
  const nativeLoaded = loaded && runtime.transport === 'native-config';
  const observedAlias = loaded && typeof runtime.modelAlias === 'string' ? runtime.modelAlias : null;
  const observedId = modelIdFromAlias(observedAlias);
  const observedMode = loaded && typeof runtime.mode === 'string' ? runtime.mode : null;
  const adoptedLabel = !loaded
    ? '尚未加载'
    : observedMode === 'inherit'
      ? '继承主模型'
      : observedId
        ? modelLabel(findModel(observedId), observedId)
        : nativeLoaded && saved.mode === 'pool'
          ? '模型池 · ' + fmtCount(saved.models.length) + ' 个候选'
          : nativeLoaded && saved.model
            ? modelLabel(findModel(saved.model), saved.model)
            : '未固定模型';
  setText(dom.adoptedValue, adoptedLabel);
  const adoptedParts = loaded
    ? [observedMode ? '模式 ' + observedMode : '', observedAlias || (nativeLoaded ? '本机配置文件（内核未回报具体模型）' : ''),
      runtime.version ? 'v' + runtime.version : ''].filter(Boolean)
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
  renderRoutingFacts(data);
}

/* 概览只汇报可从状态中直接读到的路由事实：连接数、当前子代理路由与上游 ID、
   上下文策略状态、原生工具可用性。任何未知值都写「未知」而不是留空。 */
function renderRoutingFacts(data) {
  const rows = connectionRowsOf(data);
  const modelCount = Array.isArray(data.models) ? data.models.length : 0;
  if (!rows) {
    setText(dom.factConnections, '旧版单上游');
    setText(dom.factConnectionsSub, modelCount + ' 个模型路由到同一个上游');
  } else {
    const named = rows.filter((row) => !row.legacy);
    setText(dom.factConnections, named.length + ' 条连接' + (rows.some((row) => row.legacy) ? ' + 旧版' : ''));
    const unset = rows.filter((row) => !row.apiKeySet).length;
    setText(dom.factConnectionsSub, unset ? unset + ' 条连接的 Key 未在运行环境中' : '所有连接的 Key 已就绪');
  }

  const saved = savedTarget(data);
  const model = saved.mode !== 'inherit' && saved.model ? findModel(saved.model) : null;
  if (saved.mode === 'inherit') {
    setText(dom.factRoute, '跟随主模型');
    setText(dom.factRouteSub, '子代理不固定上游模型');
  } else if (saved.mode === 'pool') {
    setText(dom.factRoute, '模型池 · ' + fmtCount(saved.models.length) + ' 个候选');
    setText(dom.factRouteSub, '默认 ' + (saved.model || '未选择'));
  } else if (!saved.model) {
    setText(dom.factRoute, '未选择');
    setText(dom.factRouteSub, '尚未保存子代理目标');
  } else {
    const routing = routingOf(model);
    setText(dom.factRoute, routing.upstream || saved.model);
    setText(dom.factRouteSub, (routing.connectionId ? '连接 ' + routing.connectionId + ' · ' : '旧版单上游 · ')
      + (model ? protocolLabel(model.protocol) : '协议未知'));
  }

  const context = evaluateContext(data);
  setDot(dom.factContextDot, context.tone);
  setText(dom.factContext, context.word);
  const policy = contextPolicyOf(data);
  if (!policy) setText(dom.factContextSub, '面板未提供上下文策略状态');
  else {
    const ratio = ratioToPercent(policy.policy && policy.policy.triggerRatio);
    setText(dom.factContextSub, policy.policy && policy.policy.mode === 'custom'
      ? (ratio === null ? '触发阈值待确认' : ratio + '% 触发') : '跟随原生默认');
  }

  const tools = toolsState(data);
  if (!tools) {
    setDot(dom.factToolsDot, 'neutral');
    setText(dom.factTools, '未提供');
    setText(dom.factToolsSub, '面板服务没有 MCP 接口');
  } else if (tools.available === false) {
    setDot(dom.factToolsDot, 'warn');
    setText(dom.factTools, '不可用');
    setText(dom.factToolsSub, mcpReasonText(tools.reason) || '原生 MCP 不可用');
  } else {
    const count = Array.isArray(tools.servers) ? tools.servers.length : 0;
    setDot(dom.factToolsDot, 'ok');
    setText(dom.factTools, count + ' 个服务器');
    setText(dom.factToolsSub, '原生默认工具保持不变');
  }
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
    model.className = 'mono cell-id cell-model';
    model.textContent = (row && (row.upstreamModelId || row.model)) || '—';
    if (row && row.connectionId) {
      const connection = document.createElement('span');
      connection.className = 'cell-name';
      connection.textContent = row.connectionId;
      model.append(connection);
    }
    const protocol = document.createElement('td');
    protocol.className = 'col-proto';
    protocol.textContent = row && row.protocol === 'chat' ? 'chat' : 'responses';
    const status = document.createElement('td');
    status.className = 'num mono';
    status.textContent = row && typeof row.status === 'number' ? String(row.status) : '—';
    status.dataset.tone = row && row.status >= 400 ? 'bad' : 'neutral';
    /* 首字节不是首 token：流式首个事件才算 TTFT，这里只报告实际测到的耗时。 */
    const firstByte = document.createElement('td');
    firstByte.className = 'num mono col-firstbyte';
    firstByte.textContent = row && typeof row.firstByteMs === 'number' ? fmtMs(row.firstByteMs) : '未测';
    const total = document.createElement('td');
    total.className = 'num mono col-total';
    total.textContent = row && typeof row.ms === 'number' ? fmtMs(row.ms) : '—';
    const usage = document.createElement('td');
    usage.className = 'num mono col-usage';
    usage.textContent = usageText(row && row.usage);
    usage.setAttribute('title', usage.textContent);
    /* 平均输出速率是整段请求的平均值，含等待首字节的时间；不是 TPOT，也不是
       首 token 速度。没有可测的完成请求就没有速率，写「未提供」而不是 0。 */
    const rate = document.createElement('td');
    rate.className = 'num mono col-rate';
    rate.textContent = rateText(row && row.rate);
    rate.setAttribute('title', rateText(row && row.rate));
    /* 上下文占用是**上一次请求**的输入量，不是运行中会话的实时占用。 */
    const requestContext = document.createElement('td');
    requestContext.className = 'num mono col-reqctx';
    requestContext.textContent = requestContextText(row && row.context);
    requestContext.setAttribute('title', requestContextText(row && row.context));
    if (row && row.error) {
      const error = document.createElement('span');
      error.className = 'cell-error';
      error.textContent = row.error;
      status.append(error);
    }
    tr.append(time, model, protocol, status, firstByte, total, rate, usage, requestContext);
    return tr;
  });
  if (dom.recentBody) dom.recentBody.replaceChildren(...rows);
  setHidden(dom.recentEmpty, rows.length > 0);
}

/* 速率只认契约里的字段与口径；`basis` 不认识时不猜单位，直接说明未提供。 */
function rateText(rate) {
  if (!rate || typeof rate !== 'object') return '未提供';
  if (rate.basis !== 'total_request_time') return '未提供';
  const value = Number(rate.averageOutputTokensPerSecond);
  if (!Number.isFinite(value) || value <= 0) return '未提供';
  return (value >= 100 ? String(Math.round(value)) : value.toFixed(1)) + ' tok/s';
}

/* `context.limitTokens` 是这条模型**已设定的上下文预算**，不是上游硬上限
   `contextLimit`：所以这里只说「占预算多少」，不写成「距上限还剩多少」。
   比例优先用后端算好的值，缺失时才用两个实测数相除。 */
function requestContextText(context) {
  if (!context || typeof context !== 'object') return '未提供';
  const used = Number(context.usedTokens);
  const budget = Number(context.limitTokens);
  if (!Number.isFinite(used) || used < 0) return '未提供';
  const head = fmtCount(used) + ' tokens';
  if (!Number.isFinite(budget) || budget <= 0) return head + ' · 预算未知';
  const ratio = Number.isFinite(Number(context.ratio)) ? Number(context.ratio) : used / budget;
  return head + ' · 占预算 ' + Math.round(ratio * 100) + '%（' + fmtK(budget) + '）';
}

/* 用量只在收到上游真实 usage 时显示；缺失时写「未提供」，绝不当成 0。 */
function usageText(usage) {
  if (!usage || typeof usage !== 'object') return '未提供';
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens
    : Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null;
  const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens
    : Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
  if (input === null && output === null) return '未提供';
  return (input === null ? '?' : fmtCount(input)) + ' / ' + (output === null ? '?' : fmtCount(output));
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
  const saved = data ? savedTarget(data) : { mode: 'inherit', model: null, models: [] };
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
  if (saved.mode !== 'inherit' && saved.model === model.id) tr.dataset.saved = 'true';

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
  if (saved.mode !== 'inherit' && saved.model === model.id) {
    const flag = document.createElement('span');
    flag.className = 'tag tag--saved';
    flag.textContent = saved.mode === 'pool' ? '池默认' : '子代理';
    idCell.append(flag);
  }

  /* 路由列把「连接」和「真实上游 ID」放在同一个格里：这两个值一起才说明
     请求实际去了哪里，缺一个都会让用户以为本机路由 ID 就是上游 ID。 */
  const route = document.createElement('td');
  route.className = 'col-route';
  const routing = routingOf(model);
  const upstream = document.createElement('span');
  upstream.className = 'mono cell-id';
  upstream.textContent = routing.upstream || '—';
  upstream.setAttribute('title', routing.upstream || '');
  const connection = document.createElement('span');
  connection.className = 'cell-name';
  connection.textContent = routing.connectionId
    ? connectionLabel(findConnection(state.data, routing.connectionId)) + ' · ' + routing.connectionId
    : '旧版单上游';
  route.append(upstream, connection);

  const proto = document.createElement('td');
  proto.className = 'col-proto';
  const protoTag = document.createElement('span');
  protoTag.className = 'tag mono';
  protoTag.textContent = model.protocol === 'chat' ? 'chat' : 'responses';
  proto.append(protoTag);

  const context = document.createElement('td');
  context.className = 'num mono';
  context.textContent = fmtK(model.contextWindow);
  if (model.contextLimit) {
    const limit = document.createElement('span');
    limit.className = 'cell-name';
    limit.textContent = '上限 ' + fmtK(model.contextLimit);
    context.append(limit);
  } else {
    const limit = document.createElement('span');
    limit.className = 'cell-name';
    limit.textContent = '上限未知';
    context.append(limit);
  }

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

  tr.append(idCell, route, proto, context, output, caps, efforts, actions);
  return tr;
}

/* ---------- render: candidate picker ---------- */

/* 近似匹配只在本地做，且只用于排序，不改变候选本身：上游 ID 一律按原样展示和保存。 */
function normalizeNeedle(value) {
  return String(value || '').toLowerCase().replace(/[\s\-_./]+/g, '');
}

function subsequenceScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  let index = 0;
  let gaps = 0;
  for (const char of haystack) {
    if (char === needle[index]) index++;
    else if (index > 0) gaps++;
    if (index === needle.length) break;
  }
  if (index < needle.length) return 0;
  return Math.max(1, 100 - gaps);
}

function connectionScore(model, needle, rawNeedle) {
  if (!needle) return 1;
  const id = normalizeNeedle(model && model.id);
  const name = normalizeNeedle(model && model.name);
  /* 原文（保留分隔符）直接包含查询时加权：把 glm5.3 和 glm-5.3 归一化后是同一个
     串，但用户敲的是哪一种写法，说明他更可能指哪一个。 */
  const rawId = String(model && model.id || '').toLowerCase();
  const rawName = String(model && model.name || '').toLowerCase();
  let bonus = 0;
  if (rawNeedle) {
    if (rawId.includes(rawNeedle)) bonus += 60;
    if (rawName.includes(rawNeedle)) bonus += 40;
  }
  if (id === needle) return 1000 + bonus;
  if (id.startsWith(needle)) return 900 + bonus;
  if (id.includes(needle)) return 800 + bonus;
  if (name === needle) return 700 + bonus;
  if (name.startsWith(needle)) return 650 + bonus;
  if (name.includes(needle)) return 600 + bonus;
  const idScore = subsequenceScore(needle, id);
  const nameScore = subsequenceScore(needle, name);
  return Math.max(idScore, nameScore) * 5 + bonus;
}

function rankedCandidates(models, query) {
  const needle = normalizeNeedle(query);
  const rawNeedle = String(query || '').trim().toLowerCase();
  const list = (models || []).filter((model) => model && typeof model.id === 'string');
  if (!needle) return list.slice(0, 60);
  return list
    .map((model) => ({ model, score: connectionScore(model, needle, rawNeedle) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score
      || String(left.model.id).localeCompare(String(right.model.id)))
    .slice(0, 60)
    .map((entry) => entry.model);
}

function renderPicker() {
  const picker = state.picker;
  if (!picker.open || !state.editor) {
    setHidden(dom.picker, true);
    return;
  }
  setHidden(dom.picker, false);
  const draft = state.editor.draft;
  const connection = draft.connectionId ? findConnection(state.data, draft.connectionId) : null;
  setText(dom.pickerLede, connection
    ? '候选来自连接「' + connectionLabel(connection) + '」的供应商目录与最近一次上游读取；'
      + '输入关键词由服务端按别名与片段检索，点选后才会写入模型。'
    : '未选择命名连接：候选来自所选供应商预设的目录。选择一个连接可同时看到它上次读取到的模型。');

  if (dom.pickerQ) dom.pickerQ.value = picker.query;
  if (dom.pickerScan) {
    /* The explicit read only makes sense for a saved connection; the catalog
       itself never depends on it. */
    dom.pickerScan.disabled = picker.busy || !draft.connectionId;
    dom.pickerScan.hidden = !draft.connectionId;
    setText(dom.pickerScan, picker.busy ? '正在读取…' : '读取上游目录');
  }
  if (dom.pickerState) {
    if (picker.busy) setText(dom.pickerState, '正在搜索…');
    else if (picker.reason) setText(dom.pickerState, discoveryReasonText(picker.reason));
    else if (picker.state === 'searched') {
      const count = picker.models ? picker.models.length : 0;
      const parts = [count + ' 个候选'];
      if (picker.checkedAt) parts.push('上游读取于 ' + fmtTime(picker.checkedAt));
      setText(dom.pickerState, parts.join(' · '));
    } else setText(dom.pickerState, '尚未搜索');
  }
  if (dom.pickerNote) {
    /* Truthful about where the list came from: a preset-backed list is the
       vendor's documented catalog, not a live read of this endpoint. */
    const note = picker.state === 'searched' && picker.models && picker.models.length
      ? '列表来自供应商目录' + (picker.checkedAt ? '与最近一次上游读取' : '')
        + '；模型 ID 原样保留，能力与预算在你确认后才写入。'
      : '';
    setHidden(dom.pickerNote, !note);
    setText(dom.pickerNote, note);
  }

  /* The server already ranked matches; the local list is only a bounded view of
     what came back, so no second ranking algorithm can disagree with it. */
  const candidates = (picker.models || []).filter((model) => model && typeof model.id === 'string');
  const empty = candidates.length === 0;
  setHidden(dom.pickerEmpty, !empty);
  setHidden(dom.pickerList, empty);
  if (empty) {
    setText(dom.pickerEmptyTitle, picker.busy ? '正在搜索候选'
      : picker.state === 'searched' ? '没有匹配的候选' : '尚未载入候选');
    setText(dom.pickerEmptyNote, picker.busy
      ? '稍候；供应商目录会先返回，已保存连接的上次读取结果会一并合并。'
      : picker.state === 'searched'
        ? '换一个关键词，或清空搜索查看该连接的全部候选。'
        : '选择一条连接或供应商预设后，候选会自动载入。');
    return;
  }
  if (dom.pickerList) {
    const signature = JSON.stringify(candidates.map((model) => model.id));
    if (dom.pickerList.dataset.signature !== signature) {
      dom.pickerList.dataset.signature = signature;
      dom.pickerList.replaceChildren(...candidates.map(buildCandidateRow));
    }
  }
}

function buildCandidateRow(model) {
  const li = document.createElement('li');
  li.className = 'candidate';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'candidate__btn';
  button.dataset.candidateId = model.id;

  const head = document.createElement('span');
  head.className = 'candidate__head';
  const id = document.createElement('span');
  id.className = 'candidate__id mono';
  id.textContent = model.id;
  head.append(id);
  if (model.name && model.name !== model.id) {
    const name = document.createElement('span');
    name.className = 'candidate__name';
    name.textContent = model.name;
    head.append(name);
  }

  const facts = document.createElement('span');
  facts.className = 'candidate__facts';
  const parts = [];
  if (model.contextWindow) parts.push('上下文 ' + fmtK(model.contextWindow));
  if (model.maxOutputTokens) parts.push('输出 ' + fmtK(model.maxOutputTokens));
  if (model.tools === true) parts.push('工具');
  if (model.reasoning === true) parts.push('推理');
  if (Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) parts.push('视觉');
  if (Array.isArray(model.protocols) && model.protocols.length) parts.push(model.protocols.map(protocolLabel).join('/'));
  facts.textContent = parts.join(' · ') || '上游未提供能力信息';

  button.append(head, facts);
  li.append(button);
  return li;
}

/* 协议状态必须区分三种情况，M29 的 parser 已经把其中两种解析清楚了：
   1. 数组（一个或多个）：上游/preset 的真实声明，多值时默认偏好 Responses；
   2. 显式空数组：端点明确声明不支持任何协议（`supported:false` 或空列表），
      这是权威判定，UI 不得回退到 preset 再猜一次；
   3. 字段缺失：parser 已按 M29 合同继承已验证的 preset 协议，缺失只表示
      「这条公开行没带」，仍按未知处理并要求用户显式选择。
   把 1 与 2、3 混为一谈会推翻 M29 三轮修正。 */
function candidateProtocolState(model) {
  if (!model || !Array.isArray(model.protocols)) return { kind: 'absent', list: [] };
  const list = model.protocols.filter((value) => value === 'chat' || value === 'responses');
  return list.length ? { kind: 'declared', list } : { kind: 'explicit-empty', list: [] };
}

/* 保留旧名，返回声明过的协议（空/缺失都返回 null），调用方需区分时用上面的状态。 */
function candidateProtocols(model) {
  const state = candidateProtocolState(model);
  return state.kind === 'declared' ? state.list : null;
}

/* 多协议时默认 Responses：与网关默认族一致，用户仍可改选。 */
function preferredProtocol(protocols) {
  if (!protocols || !protocols.length) return null;
  return protocols.includes('responses') ? 'responses' : protocols[0];
}

function pickCandidate(upstreamId) {
  const editor = state.editor;
  if (!editor || !upstreamId) return;
  const model = (state.picker.models || []).find((row) => row && row.id === upstreamId) || null;
  const draft = editor.draft;
  const protocolState = candidateProtocolState(model);
  draft.upstreamModelId = upstreamId;
  draft.name = model && model.name ? model.name : draft.name;

  const preset = providerPreset(draft.providerPresetId) || providerPreset(
    (findConnection(state.data, draft.connectionId) || {}).providerPresetId);
  const presetProtocols = preset && Array.isArray(preset.protocols) && preset.protocols.length ? preset.protocols : null;
  /* 只有「字段缺失」才允许沿用 preset；显式空数组是权威的「不支持」，不 fallback。 */
  const chosen = protocolState.kind === 'declared'
    ? preferredProtocol(protocolState.list)
    : protocolState.kind === 'absent'
      ? preferredProtocol(presetProtocols)
      : null;
  draft.protocolExplicitEmpty = protocolState.kind === 'explicit-empty';

  if (chosen) {
    /* 声明过协议（一个或多个）就自动生成路由；多协议按偏好选一个，
       用户可通过协议按钮或直接改路由 ID 覆盖。 */
    const declared = protocolState.kind === 'declared';
    draft.id = routeIdFor(draft.connectionId, upstreamId, chosen);
    draft.protocolConfirmed = true;
    draft.protocolSource = declared ? 'discovery' : 'preset';
    draft.protocolOptions = declared ? protocolState.list : presetProtocols;
    draft.protocolHint = declared && protocolState.list.length > 1
      ? '上游声明 ' + protocolState.list.map(protocolLabel).join(' 与 ') + '，已按 ' + protocolLabel(chosen)
        + ' 生成路由；可切换协议。'
      : declared ? null
        : '上游目录没有声明协议，当前按预设「' + (preset ? preset.name || preset.id : '') + '」的 '
          + protocolLabel(chosen) + ' 填写；请确认后再保存。';
  } else {
    draft.id = '';
    draft.protocolConfirmed = false;
    draft.protocolSource = null;
    draft.protocolOptions = null;
    /* 显式空与缺失要用不同的话说清楚，否则用户会以为只是「目录没写」。 */
    draft.protocolHint = protocolState.kind === 'explicit-empty'
      ? '该端点明确声明不支持 Chat 或 Responses 协议，因此没有生成路由。'
        + '请确认上游能力后手动填写，或改用其他连接。'
      : '上游目录没有声明协议，因此没有自动生成路由 ID。'
        + '请选择协议或手动填写路由 ID；协议决定调用 Chat 还是 Responses 接口。';
  }
  if (model) {
    if (model.contextWindow) draft.context = String(model.contextWindow);
    draft.contextLimit = model.contextWindow ? String(model.contextWindow) : '';
    if (typeof model.tools === 'boolean') draft.tools = model.tools;
    if (typeof model.reasoning === 'boolean') draft.reasoning = model.reasoning;
    if (Array.isArray(model.inputModalities)) draft.vision = model.inputModalities.includes('image');
    if (model.maxOutputTokens) draft.output = String(model.maxOutputTokens);
    if (Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length) {
      draft.efforts = model.reasoningEfforts.join(', ');
    }
    /* 来源必须是这条候选自己的，不能一律写成 discovery：model-search 会把
       静态 preset 与最近一次成功 discovery 合并，两者的来源不同。优先用后端
       给出的 model.metadataSource / model.source，都没有时按「这次读取有没有
       真实目录」判断，仍无法确定就标 manual 而不是编造 discovery。 */
    draft.metadataSource = candidateMetadataSource(model);
  }
  editor.serverErrors = [];
  editor.budgetNote = null;
  fillEditorFields();
  state.picker.open = false;
  renderPicker();
  renderEditor();
  renderModels();
  if (dom.mId && dom.mId.focus) dom.mId.focus();
}

/* 显式切换协议：只重写路由 ID 的家族前缀，上游 ID 原样保留。
   手写路由 ID 仍是高级覆盖手段，不是多协议的必经步骤。 */
function chooseProtocol(protocol) {
  const editor = state.editor;
  if (!editor || !['chat', 'responses'].includes(protocol)) return;
  const draft = editor.draft;
  const upstream = String(draft.upstreamModelId || '').trim();
  draft.protocolSource = 'manual';
  draft.protocolConfirmed = true;
  if (upstream && draft.connectionId) {
    draft.id = routeIdFor(draft.connectionId, upstream, protocol);
    draft.protocolHint = '已按 ' + protocolLabel(protocol) + ' 生成路由；上游模型 ID 保持不变。';
    if (dom.mId) dom.mId.value = draft.id;
  } else {
    draft.protocolHint = upstream
      ? '请先选择所属连接，再由协议生成路由。'
      : '请先填写上游模型 ID，再由协议生成路由。';
  }
  renderEditor();
  renderModels();
}

/* ---------- render: MCP editor ---------- */

function renderToolsEditor() {
  const editing = state.tools.editing;
  if (!editing) {
    setHidden(dom.toolsEditor, true);
    return;
  }
  setHidden(dom.toolsEditor, false);
  const transport = dom.teTransport ? dom.teTransport.value : 'stdio';
  setHidden(dom.teStdio, transport !== 'stdio');
  setHidden(dom.teRemote, transport === 'stdio');
  if (dom.teSave) {
    dom.teSave.disabled = state.tools.busy;
    setText(dom.teSave, state.tools.busy ? '正在提交…' : '添加到 Kimi 原生配置');
  }
  if (dom.teNameHint) setText(dom.teNameHint, '名称以字母或数字开头，可用点、下划线与连字符，最长 64 字符。');
}

function openToolsEditor() {
  state.tools.editing = true;
  state.tools.errors = [];
  if (dom.teName) dom.teName.value = '';
  if (dom.teTransport) dom.teTransport.value = 'stdio';
  if (dom.teCommand) dom.teCommand.value = '';
  if (dom.teArgs) dom.teArgs.value = '';
  if (dom.teEnv) dom.teEnv.value = '';
  if (dom.teUrl) dom.teUrl.value = '';
  if (dom.teHeaders) dom.teHeaders.value = '';
  if (dom.teEnabled) dom.teEnabled.checked = true;
  renderErrorList(dom.teErrors, []);
  renderToolsEditor();
  if (dom.teName && dom.teName.focus) dom.teName.focus();
}

function closeToolsEditor() {
  state.tools.editing = false;
  renderErrorList(dom.teErrors, []);
  renderToolsEditor();
}

function readToolsEditor() {
  const transport = dom.teTransport ? dom.teTransport.value : 'stdio';
  if (transport === 'stdio') {
    const env = parseEnvLines(dom.teEnv ? dom.teEnv.value : '');
    return {
      draft: {
        name: dom.teName ? dom.teName.value : '',
        transport,
        enabled: Boolean(dom.teEnabled && dom.teEnabled.checked),
        command: dom.teCommand ? dom.teCommand.value : '',
        args: parseLines(dom.teArgs ? dom.teArgs.value : ''),
        env: env.env,
      },
      invalid: env.invalid.map((line) => '环境变量格式无效：' + truncate(line, 40)),
    };
  }
  const headers = parseHeaderLines(dom.teHeaders ? dom.teHeaders.value : '');
  return {
    draft: {
      name: dom.teName ? dom.teName.value : '',
      transport,
      enabled: Boolean(dom.teEnabled && dom.teEnabled.checked),
      url: dom.teUrl ? dom.teUrl.value : '',
      headers: headers.headers,
    },
    invalid: headers.invalid.map((line) => '请求头格式无效：' + truncate(line, 40)),
  };
}

function submitToolsEditor() {
  if (!state.tools.editing) return;
  const { draft, invalid } = readToolsEditor();
  const { errors, server } = mcpServerPayload(draft);
  const messages = invalid.concat(errors);
  renderErrorList(dom.teErrors, messages);
  if (messages.length) return;
  void submitTools({ action: 'add', server }, { successMessage: '已添加到 Kimi 原生 MCP 配置。' }).then((result) => {
    if (result && result.ok === true) closeToolsEditor();
  });
}

/* ---------- candidate search ---------- */

/* Picking a provider must not require a working `GET /models`. The unified
   search endpoint answers from the shipped preset for that connection and adds
   the last successful discovery, so an unsaved or offline upstream still shows
   its documented catalog. `runDiscovery` stays the explicit "read upstream now"
   action and never replaces what the search returns. */

const PICKER_DEBOUNCE_MS = 250;

function pickerScope() {
  const draft = state.editor && state.editor.draft;
  return draft ? String(draft.connectionId || '').trim() : '';
}

/* One in-flight request per picker: a fast connection or keyword change must not
   let an older answer land on newer state. */
async function searchCandidates(query, { connectionId = pickerScope(), keepReason = false } = {}) {
  const picker = state.picker;
  const seq = ++picker.seq;
  picker.busy = true;
  if (!keepReason) picker.reason = null;
  renderPicker();
  try {
    const body = { query: String(query || '') };
    if (connectionId) body.connectionId = connectionId;
    else if (state.editor && state.editor.draft.providerPresetId) {
      body.presetId = state.editor.draft.providerPresetId;
    }
    const res = await request(API.modelSearch, { method: 'POST', body });
    if (seq !== state.picker.seq) return null;
    const models = res && Array.isArray(res.models) ? res.models : [];
    picker.models = models;
    picker.state = 'searched';
    picker.hint = models.length ? null : 'no-match';
    picker.reason = null;
    return res;
  } catch (error) {
    if (seq !== state.picker.seq) return null;
    picker.reason = error.code || 'model_search_failed';
    picker.state = 'failed';
    return null;
  } finally {
    if (seq === state.picker.seq) {
      picker.busy = false;
      renderPicker();
    }
  }
}

let pickerTimer = null;
function scheduleSearch() {
  const picker = state.picker;
  if (pickerTimer) clearTimeout(pickerTimer);
  const query = picker.query;
  pickerTimer = setTimeout(() => {
    pickerTimer = null;
    if (!state.picker.open) return;
    void searchCandidates(query);
  }, PICKER_DEBOUNCE_MS);
}

/* 行内连接检查：按行携带该行的 connectionId，结果也按 connectionId 认领。
   后端绝不隐式挑选连接；这里同样只检查用户点的那一行。 */
async function runConnectionCheck(connectionId) {
  const data = state.data;
  if (!data || !connectionId) return null;
  if (state.pendingAction) {
    showToast('已有操作正在进行，等待它结束后再试。', 'error');
    return null;
  }
  state.connChecks = { ...state.connChecks, [connectionId]: { ...(state.connChecks[connectionId] || {}), busy: true } };
  renderConnections();
  const id = actionUUID();
  try {
    const res = await request(API.actions, {
      method: 'POST',
      body: { id, at: Date.now(), action: 'check-upstream', connectionId },
    });
    const op = res && res.operation ? res.operation : null;
    if (op && typeof op.connectionId === 'string' && op.connectionId !== connectionId) {
      showToast('检查结果与所在连接不符，已忽略。', 'error');
      return null;
    }
    const diag = (state.data && state.data.diagnostics && state.data.diagnostics.upstream) || {};
    const result = op && op.state ? op
      : diag && diag.connectionId === connectionId ? diag : null;
    const recorded = result ? { state: result.state,
      ...(Number.isInteger(result.httpStatus) ? { httpStatus: result.httpStatus } : {}),
      ...(Number.isInteger(result.modelCount) ? { modelCount: result.modelCount } : {}),
      ...(Number.isFinite(result.ms) ? { ms: result.ms } : {}),
      ...(result.reason ? { reason: result.reason } : {}), connectionId } : { state: 'interrupted', connectionId };
    state.connChecks = { ...state.connChecks, [connectionId]: recorded };
    if (result && result.state === 'passed') showToast('连接「' + connectionId + '」可用。', 'ok');
    else showToast('连接「' + connectionId + '」检查未通过：'
      + (upstreamReasonText(result && result.reason) || '请稍后再试') + '。', 'error');
    await loadState({ silent: true });
    return { ...state.connChecks[connectionId], busy: false };
  } catch (error) {
    state.connChecks = { ...state.connChecks, [connectionId]: { state: 'failed', reason: error.code || null, connectionId } };
    showToast(error.message || '连接检查未完成，请稍后再试。', 'error');
    return null;
  } finally {
    const current = state.connChecks[connectionId];
    if (current) {
      state.connChecks = { ...state.connChecks, [connectionId]: { ...current, busy: false } };
    }
    renderConnections();
  }
}

/* The explicit read is still available for a saved connection. A pass proves the
   endpoint answers; a failure keeps the preset-backed search usable. */
async function runDiscovery(connectionId) {
  if (!connectionId) {
    showToast('请选择一条已保存的连接。', 'error');
    return null;
  }
  const data = state.data;
  if (!data) return null;
  const seq = ++state.picker.seq;
  state.picker.busy = true;
  state.picker.reason = null;
  renderPicker();
  try {
    const res = await request(API.discovery, { method: 'POST', body: { revision: data.revision, connectionId } });
    const discovery = res && res.discovery;
    if (seq !== state.picker.seq) return null;
    if (!discovery || !Array.isArray(discovery.models)) {
      showToast('上游目录读取结果格式不被接受。', 'error');
      return null;
    }
    state.picker.checkedAt = discovery.checkedAt || null;
    state.picker.source = discovery.sourceURL || null;
    if (discovery.state !== 'passed') {
      /* A failed read is reported, not turned into an empty catalog: whatever the
         preset-backed search already showed stays on screen. */
      state.picker.reason = discovery.reason || null;
      showToast(discoveryReasonText(discovery.reason)
        + (Number.isInteger(discovery.httpStatus) ? '（HTTP ' + discovery.httpStatus + '）' : ''), 'error');
      return discovery;
    }
    showToast('读取到 ' + discovery.modelCount + ' 个候选模型。', 'ok');
    return discovery;
  } catch (error) {
    if (seq !== state.picker.seq) return null;
    state.picker.reason = error.code || null;
    showToast(discoveryReasonText(error.code) || error.message || '读取上游目录失败。', 'error');
    return null;
  } finally {
    if (seq === state.picker.seq) {
      state.picker.busy = false;
      renderPicker();
    }
    /* Either way the catalog now comes from the unified search, which merges the
       fresh discovery with the preset and keeps aliases and provenance. */
    if (state.picker.open) await searchCandidates(state.picker.query);
  }
}

function openPicker() {
  const editor = state.editor;
  if (!editor) return;
  state.picker.open = true;
  state.picker.query = '';
  state.picker.models = null;
  state.picker.state = null;
  state.picker.reason = null;
  state.picker.hint = null;
  state.picker.scope = pickerScope();
  renderPicker();
  if (dom.pickerQ && dom.pickerQ.focus) dom.pickerQ.focus();
  /* Opening the picker is the moment the catalog should be there: the preset
     answers immediately, and a saved connection's last discovery is merged in. */
  void searchCandidates('', { connectionId: state.picker.scope });
}

function closePicker() {
  state.picker.open = false;
  renderPicker();
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
        connectionId: model.connectionId || '',
        upstreamModelId: model.upstreamModelId || '',
        contextLimit: model.contextLimit ? String(model.contextLimit) : '',
        metadataSource: model.metadataSource || null,
      }
      : {
        id: '', name: '', context: '', output: '', tools: true, reasoning: false, vision: false,
        efforts: '', defaultEffort: '',
        /* 新模型默认落在唯一一条命名连接上：旧式无连接的路由只在确实没有命名连接时使用。 */
        connectionId: defaultConnectionId(),
        upstreamModelId: '', contextLimit: '', metadataSource: null,
      },
  };
  fillEditorFields();
  renderEditor();
  renderModels();
  const focusTarget = state.editor.originalId ? dom.mName : dom.mId;
  if (focusTarget && focusTarget.focus) focusTarget.focus();
}

function defaultConnectionId() {
  const rows = (connectionRowsOf(state.data) || []).filter((row) => !row.legacy);
  return rows.length ? rows[0].id : '';
}

function closeEditor(force) {
  if (!state.editor) return;
  if (!force && editorDirty() && !state.editor.confirmClose) {
    state.editor.confirmClose = true;
    renderEditor();
    return;
  }
  state.editor = null;
  state.picker = { open: false, models: null, query: '', state: null, checkedAt: null, source: null, reason: null,
    busy: false, seq: 0, hint: null, scope: null };
  renderEditor();
  renderPicker();
  renderModels();
}

function fillEditorFields() {
  const draft = state.editor && state.editor.draft;
  if (!draft) return;
  if (dom.mId) dom.mId.value = draft.id;
  if (dom.mName) dom.mName.value = draft.name;
  if (dom.mUpstream) dom.mUpstream.value = draft.upstreamModelId || '';
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
  /* 手写路由 ID 就是用户显式选择了协议：末段决定 Chat 还是 Responses。 */
  if (draft.protocolConfirmed === false && String(draft.id || '').trim()) draft.protocolConfirmed = true;
  draft.name = dom.mName ? dom.mName.value : draft.name;
  draft.upstreamModelId = dom.mUpstream ? dom.mUpstream.value : draft.upstreamModelId;
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
    return Boolean(draft.id || draft.name || draft.context || draft.output || draft.efforts || draft.reasoning
      || draft.vision || draft.upstreamModelId);
  }
  const original = findModel(editor.originalId);
  return canonicalModel(buildModel(editor.draft).model) !== canonicalModel(original);
}

function validateEditor(editor) {
  const { model, errors } = buildModel(editor.draft);
  const models = (state.data && state.data.models) || [];
  const duplicate = models.some((row) => row.id === model.id && row.id !== editor.originalId);
  if (duplicate) errors.push('已存在相同 ID 的模型。');
  /* 连接若限制了协议，这里提前说明：服务端同样会拒绝，避免用户以为只是保存慢。 */
  const connection = model.connectionId ? findConnection(state.data, model.connectionId) : null;
  if (model.connectionId && !connection) errors.push('所选连接不在已保存的连接列表中。');
  if (connection && Array.isArray(connection.protocols) && connection.protocols.length
    && !connection.protocols.includes(model.protocol)) {
    errors.push('连接「' + connectionLabel(connection) + '」只允许 ' + connection.protocols.map(protocolLabel).join('/')
      + '，当前模型路由 ID 会被解析为 ' + protocolLabel(model.protocol) + '。');
  }
  return { model, errors };
}

/* 上下文预算只做三种可信换算：固定预设、已知上限、手填。
   上限未知时「完整」不可用，避免把猜测当成上游真实能力。 */
function budgetStateFor(draft) {
  const contextLimit = Number(draft && draft.contextLimit) > 0 ? Number(draft.contextLimit) : null;
  const current = Number(draft && draft.context);
  return {
    contextLimit,
    current: Number.isSafeInteger(current) && current > 0 ? current : null,
    full: contextLimit,
  };
}

function applyBudgetPreset(presetId) {
  const editor = state.editor;
  if (!editor) return;
  readEditorFields();
  const budget = budgetStateFor(editor.draft);
  const preset = BUDGET_PRESETS.find((entry) => entry.id === presetId);
  if (!preset) return;
  if (preset.id === 'full') {
    if (!budget.full) {
      editor.budgetNote = '未知上游上限，无法选择「完整」。请先填写已知的上限或手动输入预算。';
      renderEditor();
      return;
    }
    editor.draft.context = String(budget.full);
    editor.budgetNote = null;
  } else {
    if (budget.contextLimit && preset.tokens > budget.contextLimit) {
      editor.budgetNote = preset.label + ' 超过该模型已知上限 ' + fmtTokens(budget.contextLimit) + '，不能选择。';
      renderEditor();
      return;
    }
    editor.draft.context = String(preset.tokens);
    editor.budgetNote = null;
  }
  if (dom.mContext) dom.mContext.value = editor.draft.context;
  renderEditor();
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
  const family = modelFamilyFor(id);
  const protoButtons = dom.mProtocolGroup ? Array.from(dom.mProtocolGroup.querySelectorAll('[data-protocol]')) : [];
  protoButtons.forEach((button) => {
    const active = button.dataset.protocol === family;
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    const allowed = !editor.draft.protocolOptions
      || editor.draft.protocolOptions.includes(button.dataset.protocol);
    button.disabled = state.modelsSaving || !allowed;
    button.setAttribute('title', allowed ? '按 ' + protocolLabel(button.dataset.protocol) + ' 生成路由'
      : '上游未声明此协议');
  });
  renderEditorRouting(editor);
  renderBudgetControls(editor);

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
  /* 协议未确认的候选不能被当作已确认能力保存：只有在用户填写了路由 ID
     （即显式选择了协议）之后才允许保存。 */
  const protocolPending = editor.draft.protocolConfirmed === false;

  if (dom.modelErrors) {
    const messages = (editor.serverErrors || []).concat(errors);
    if (protocolPending) {
      messages.unshift(editor.draft.protocolHint
        || '上游没有声明协议，请手动填写路由 ID 确认协议后再保存。');
    }
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

  if (dom.modelSave) dom.modelSave.disabled = errors.length > 0 || !ready || !dirty || state.modelsSaving || protocolPending;
  if (dom.modelSave) setText(dom.modelSave, state.modelsSaving ? '正在保存…' : '保存目录');
  if (dom.modelCancel) setText(dom.modelCancel, editor.confirmClose ? '继续编辑' : '取消');
  setText(dom.modelSaveNote, dirty ? '保存会提交整个模型目录，服务端立即应用。' : '没有未保存的修改。');
}

/* 路由区：连接下拉 + 上游 ID + 由两者推导的建议路由 ID。
   建议值只在用户还没手改 ID 时自动填入，避免覆盖手写值。 */
function renderEditorRouting(editor) {
  const draft = editor.draft;
  /* 协议推导的可见依据就是路由 ID 末段；这里是唯一推导点，提示与按钮共用。 */
  const family = modelFamilyFor(draft.id);
  const rows = (connectionRowsOf(state.data) || []).filter((row) => !row.legacy);
  const options = rows.length
    ? rows.map((row) => ({ value: row.id, label: row.name + ' · ' + row.id }))
    : [{ value: '', label: '旧版单上游（无命名连接）' }];
  if (draft.connectionId && !rows.some((row) => row.id === draft.connectionId)) {
    options.push({ value: draft.connectionId, label: draft.connectionId + '（未在已保存连接中）' });
  }
  syncSelectOptions(dom.mConnection, options, draft.connectionId || '');
  if (dom.mConnection) dom.mConnection.disabled = !rows.length || state.modelsSaving;

  const suggested = routeIdFor(draft.connectionId, draft.upstreamModelId);
  /* 只有用户明确给了上游 ID 且协议已被确认时，才把建议值自动写进路由 ID。
     协议待确认（picker 命中未声明协议的候选）时留空，交给用户手填。 */
  if (suggested && draft.protocolConfirmed !== false && !String(draft.id || '').trim()) {
    draft.id = suggested;
    if (dom.mId) dom.mId.value = suggested;
  }
  if (dom.mUpstreamHint) {
    const upstream = String(draft.upstreamModelId || '').trim();
    const id = String(draft.id || '').trim();
    setText(dom.mUpstreamHint, upstream
      ? '发给上游的 model 值按原样保存：' + upstream
      : id ? '留空表示与路由 ID 相同（' + id + '）。' : '实际发给上游的 model 值，按原样保留。');
  }
  if (dom.mProtocolHint) {
    const connection = draft.connectionId ? findConnection(state.data, draft.connectionId) : null;
    const restricted = connection && Array.isArray(connection.protocols) && connection.protocols.length
      ? connection.protocols : null;
    /* 说明改成「当前可见推导结论 + 原因」：读到什么（路由 ID 末段/上游声明/
       预设/连接限制）就说什么，不写无条件的规则句。连接限制与当前推导冲突时，
       在本行内给出该连接实际需要的协议。 */
    if (draft.protocolHint) setText(dom.mProtocolHint, draft.protocolHint);
    else if (family && restricted && !restricted.includes(family)) {
      setText(dom.mProtocolHint, '当前路由 ID 末段推导为 ' + protocolLabel(family)
        + '，但连接「' + connectionLabel(connection) + '」只允许 '
        + restricted.map(protocolLabel).join('/') + '；保存前请改用 '
        + restricted.map(protocolLabel).join(' 或 ') + '。');
    } else if (family) {
      setText(dom.mProtocolHint, '由当前路由 ID 末段推导为 ' + protocolLabel(family)
        + (restricted ? '；连接「' + connectionLabel(connection) + '」允许 ' + restricted.map(protocolLabel).join('/') + '。' : '。'));
    } else if (draft.protocolSource === 'preset') {
      setText(dom.mProtocolHint, '上游目录未声明协议；当前值来自供应商预设「'
        + (providerPreset(draft.providerPresetId) ? providerPreset(draft.providerPresetId).name || providerPreset(draft.providerPresetId).id : '')
        + '」，保存前请确认。');
    } else if (restricted) {
      setText(dom.mProtocolHint, '路由 ID 尚未推导出协议；连接「' + connectionLabel(connection) + '」只允许 '
        + restricted.map(protocolLabel).join('/') + '。');
    } else {
      setText(dom.mProtocolHint, '填写路由 ID 后按末段推导协议；当前连接未限制协议。');
    }
  }
  if (dom.mConnectionHint) {
    setText(dom.mConnectionHint, rows.length
      ? '连接决定请求发往哪个上游；上游模型 ID 决定上游看到的 model 值。'
      : '还没有命名连接。先在「连接与工具」添加连接，或使用旧版单上游设置。');
  }
}

/* 预算控件：只高亮真实匹配的预设；上限未知时「完整」禁用并说明，
   任何预设都不会被标成「推荐」，因为套餐限制只能由上游决定。 */
function renderBudgetControls(editor) {
  const draft = editor.draft;
  const budget = budgetStateFor(draft);
  const group = dom.mBudgetGroup;
  if (group) {
    const buttons = Array.from(group.querySelectorAll('[data-budget]'));
    buttons.forEach((button) => {
      const presetId = button.dataset.budget;
      const preset = BUDGET_PRESETS.find((entry) => entry.id === presetId);
      /* 一个认不出的按钮值不能让整块渲染中断：那会连带让保存按钮、提示与
         默认档位停在旧状态。认不出就如实禁用并说明，其余控件照常渲染。 */
      if (!preset) {
        button.setAttribute('aria-pressed', 'false');
        button.disabled = true;
        button.setAttribute('title', '未识别的预算预设：' + String(presetId));
        return;
      }
      const active = preset.id === 'full'
        ? Boolean(budget.full && budget.current === budget.full)
        : Boolean(budget.current === preset.tokens);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      const limited = preset.id !== 'full' && budget.contextLimit && preset.tokens > budget.contextLimit;
      const unknownFull = preset.id === 'full' && !budget.full;
      button.disabled = Boolean(limited || unknownFull) || state.modelsSaving;
      button.setAttribute('title', limited
        ? preset.label + ' 超过已知上限 ' + fmtTokens(budget.contextLimit)
        : unknownFull ? '上游上限未知，无法选择完整上下文' : '设为 ' + preset.label);
    });
  }
  if (dom.mContext) dom.mContext.disabled = state.modelsSaving;
  if (dom.mContextHint) {
    if (budget.contextLimit) {
      setText(dom.mContextHint, '已知上游上限 ' + fmtTokens(budget.contextLimit)
        + '；预算不得超过它，超出的预设已禁用。');
    } else {
      setText(dom.mContextHint, '上游上限未知：预设只是起点，保存后请按套餐实际能力确认。');
    }
  }
  if (editor.budgetNote && dom.modelErrors && dom.modelErrors.hidden) {
    /* 预设被拒的说明单独呈现，不与保存错误混在一起。 */
    setHidden(dom.modelErrors, false);
    const p = document.createElement('p');
    p.textContent = editor.budgetNote;
    dom.modelErrors.replaceChildren(p);
  }
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
  if (!draft || draft.mode === 'inherit') return { problems, notes };

  const list = Array.isArray(data.models) ? data.models : [];
  const model = draft.model ? list.find((row) => row && row.id === draft.model) || null : null;
  if (!draft.model) problems.push('尚未选择模型。');
  else if (!model) problems.push('所选模型已不在目录中，请重新选择。');
  else if (!isCapable(model)) problems.push('所选模型未声明工具调用，不能作为子代理。');

  if (draft.mode === 'pool') {
    const pool = Array.isArray(draft.models) ? draft.models : [];
    const ids = new Set(pool.map((row) => row && row.id));
    if (!pool.length) problems.push('候选列表为空，至少加入 1 个模型。');
    if (pool.length > 32) problems.push('候选模型最多 32 个。');
    if (pool.some((row) => !row || typeof row.description !== 'string' || !row.description.trim())) {
      problems.push('每个候选模型都需要用途说明。');
    }
    if (pool.some((row) => row && row.id && !list.some((entry) => entry && entry.id === row.id))) {
      problems.push('候选列表中有模型已不在目录中，请移除后重新选择。');
    } else if (pool.some((row) => row && row.id && !isCapable(list.find((entry) => entry && entry.id === row.id)))) {
      problems.push('候选列表中有模型未声明工具调用，不能作为子代理。');
    }
    if (draft.model && !ids.has(draft.model)) problems.push('默认模型必须在候选列表中。');
    return { problems, notes };
  }

  if (draft.effort && model && !declaredEfforts(model).includes(draft.effort)) {
    problems.push('该模型未声明档位 ' + draft.effort + '。请到「模型管理」补充该档位，或改选其他档位。');
  }
  if (!draft.effort && model && !model.reasoning) notes.push('所选模型未声明推理能力，保存时将使用自动档位。');
  return { problems, notes };
}

let saModelSignature = '';
let saEffortSignature = '';

/* 池条目在草稿里的规范形态：只保留 id 与单行用途说明。 */
function poolRow(id, description) {
  return { id, description: String(description || '').replace(/[\r\n\t ]+/g, ' ').trim() };
}

function poolDraftIds(draft) {
  const pool = draft && draft.mode === 'pool' && Array.isArray(draft.models) ? draft.models : [];
  return new Set(pool.map((row) => row.id));
}

function syncSelectOptions(select, options, current) {
  if (!select) return;
  const signature = JSON.stringify(options) + '#' + (current || '');
  if (select.dataset.signature === signature) {
    select.value = current || '';
    return;
  }
  select.dataset.signature = signature;
  select.replaceChildren(...options.map((option) => {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    return node;
  }));
  select.value = current || '';
}

function renderPoolList(draft, capable) {
  if (!dom.saPoolList) return;
  const pool = draft.mode === 'pool' && Array.isArray(draft.models) ? draft.models : [];
  const signature = JSON.stringify([pool, state.subagentSaving]);
  if (dom.saPoolList.dataset.signature === signature) return;
  dom.saPoolList.dataset.signature = signature;
  const rows = pool.map((row) => {
    const item = document.createElement('div');
    item.className = 'pool__row';
    const model = capable.find((entry) => entry.id === row.id) || null;
    const head = document.createElement('p');
    head.className = 'pool__head';
    const id = document.createElement('span');
    id.className = 'mono cell-id';
    id.textContent = row.id;
    id.setAttribute('title', row.id);
    head.append(id);
    if (row.id === draft.model) {
      const flag = document.createElement('span');
      flag.className = 'tag tag--saved';
      flag.textContent = '默认';
      head.append(flag);
    }
    if (model && model.name && model.name !== row.id) {
      const name = document.createElement('span');
      name.className = 'pool__name';
      name.textContent = model.name;
      head.append(name);
    }
    const note = document.createElement('p');
    note.className = 'pool__note';
    note.textContent = row.description || '—';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'iconbtn iconbtn--danger pool__remove';
    remove.dataset.poolRemove = row.id;
    remove.setAttribute('aria-label', '从池中移除 ' + row.id);
    remove.disabled = state.subagentSaving;
    remove.append(iconUse('i-trash'));
    item.append(head, note, remove);
    return item;
  });
  const empty = document.createElement('p');
  empty.className = 'pool__empty';
  empty.textContent = pool.length
    ? (pool.length >= 32 ? '候选已达上限 32 个。' : '')
    : '还没有候选模型。选择模型、填写用途后点「加入池」。';
  if (empty.textContent) rows.push(empty);
  dom.saPoolList.replaceChildren(...rows);
}

function renderSubagents() {
  const data = state.data;
  if (!data) return;
  const draft = state.draft || draftFromSaved(data);
  const ready = configReady(data);
  const busy = isInFlight(data.operation);

  if (dom.modeInherit) dom.modeInherit.checked = draft.mode === 'inherit';
  if (dom.modeForce) dom.modeForce.checked = draft.mode === 'force';
  if (dom.modePool) dom.modePool.checked = draft.mode === 'pool';
  for (const radio of [dom.modeInherit, dom.modeForce, dom.modePool]) {
    if (radio) radio.disabled = !ready || busy;
  }

  setHidden(dom.saForceFields, draft.mode !== 'force');
  setHidden(dom.saPoolFields, draft.mode !== 'pool');

  /* native-config 通道开关只在 force/pool 出现；pool 固定走 native-config。
     旧 force 配置首次载入草稿时不勾选，保存后才会启用新通道。 */
  const nativeApplies = draft.mode === 'force' || draft.mode === 'pool';
  setHidden(dom.saNativeRow, !nativeApplies);
  if (dom.saNative) {
    dom.saNative.checked = draft.transport === 'native-config';
    /* pool 固定走 native-config，开关只读；force 才是用户真正的选择。 */
    dom.saNative.disabled = !ready || busy || state.subagentSaving || draft.mode === 'pool';
  }
  if (dom.saNativeHint) {
    setText(dom.saNativeHint, draft.mode === 'pool'
      ? '模型池固定通过本机配置文件（native-config）下发；写入成功只代表文件已更新，是否被内核重载采用见运行时状态。'
      : '保存后写入 Kimi 的 secondaryModel 配置；写入成功只代表文件已更新，是否被内核重载采用见运行时状态。不勾选时保持副本模式，保存不改变现有通道。');
  }

  const capable = capableModels();
  const { problems, notes } = evaluateSubagentDraft(draft, data);

  if (draft.mode === 'pool') {
    const poolIds = poolDraftIds(draft);
    const remaining = capable.filter((model) => !poolIds.has(model.id));
    const pendingAdd = dom.saPoolAdd && remaining.some((model) => model.id === dom.saPoolAdd.value)
      ? dom.saPoolAdd.value : '';
    syncSelectOptions(dom.saPoolAdd, [{ value: '', label: '选择要加入的模型' }].concat(remaining.map((model) => ({
      value: model.id,
      label: modelLabel(model, model.id) + ' · ' + model.id,
    }))), pendingAdd);
    if (dom.saPoolAdd) dom.saPoolAdd.disabled = !ready || busy || state.subagentSaving || poolIds.size >= 32;
    if (dom.saPoolAppend) {
      dom.saPoolAppend.disabled = !ready || busy || state.subagentSaving
        || !dom.saPoolAdd || !dom.saPoolAdd.value;
    }

    const defaultOptions = poolIds.size
      ? Array.from(poolIds).map((id) => {
        const model = capable.find((entry) => entry.id === id) || null;
        return { value: id, label: modelLabel(model, id) + ' · ' + id };
      })
      : [{ value: '', label: '先加入候选模型' }];
    syncSelectOptions(dom.saPoolDefault, defaultOptions, draft.model || '');
    if (dom.saPoolDefault) dom.saPoolDefault.disabled = !ready || busy || state.subagentSaving || !poolIds.size;

    renderPoolList(draft, capable);

    if (dom.saPoolErrors) {
      const poolProblems = [];
      if (draft.model && !poolIds.has(draft.model)) poolProblems.push('默认模型必须在候选列表中。');
      if (poolIds.size > 32) poolProblems.push('候选模型最多 32 个。');
      if (Array.isArray(draft.models) && draft.models.some((row) => !row || !String(row.description || '').trim())) {
        poolProblems.push('每个候选模型都需要用途说明。');
      }
      setHidden(dom.saPoolErrors, poolProblems.length === 0);
      dom.saPoolErrors.replaceChildren(...poolProblems.map((message) => {
        const p = document.createElement('p');
        p.textContent = message;
        return p;
      }));
    }
    if (dom.saModelHint) setText(dom.saModelHint, '候选 ' + poolIds.size + ' / 32 · 只能加入声明支持工具调用的模型。');
    if (dom.saEffortHint) setText(dom.saEffortHint, '模型池不设统一思考档位，各模型使用自身默认档位。');
  } else {
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
    if (dom.saModelHint) setText(dom.saModelHint, '只列出声明支持工具调用的模型，共 ' + capable.length + ' 个。');
    if (dom.saEffortHint) {
      setText(dom.saEffortHint, notes[0] || (model
        ? (list.length ? '来自该模型声明的 ' + list.length + ' 个档位。' : '该模型未声明档位，只能使用自动。')
        : '先选择模型。'));
    }
  }

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

  /* native-config 专属事实：observed 只证明 Work 发来的工具定义已含模型池，
     compatibility 只说明内核源码结构与契约一致；两者都不是“内核已采用”。 */
  const native = runtime.transport === 'native-config'
    || ['file-applied', 'waiting-config', 'restored', 'unverified', 'inherit'].includes(runtime.state);
  setHidden(dom.rtNativeFacts, !native);
  setHidden(dom.rtObservedFact, !native);
  if (native) {
    const observedLive = runtime.observed && runtime.observed.state === 'observed-schema';
    setText(dom.rtObserved, observedLive
      ? '已出现在工具定义 · ' + fmtTime(runtime.observed.at)
      : '尚未观察到');
    const compat = runtime.compatibility;
    if (compat && compat.state === 'source-compatible') {
      setText(dom.rtCompat, '契约一致');
      setText(dom.rtCompatSub, 'Kimi ' + (compat.version || '—') + ' 的内核包含模型池配置段，可写入 secondaryModel 配置。');
    } else {
      setText(dom.rtCompat, '未验证');
      setText(dom.rtCompatSub, compat && compat.reason ? reasonText(compat.reason) : '尚未通过内核源码契约检查，写入会被拒绝。');
    }
  }

  const verdict = evaluateBinding(data);
  setDot(dom.saVerdictDot, verdict.tone);
  setText(dom.saVerdictWord, verdict.word);
  setText(dom.saVerdictNote, verdict.note);
}

/* ---------- render: connection ---------- */

/* 重启说明按本进程的真实运行方式分流：state.service 只在后台服务场景给出
   （service record 与本配置匹配时才认），此时教 service restart/status 找回；
   前台终端运行的 panel 保留 Ctrl+C 三步。页面自身永远不执行重启。 */
function renderRestartSteps(data) {
  const service = data && data.service;
  const running = service && service.mode === 'service';
  if (dom.restartHead) {
    setText(dom.restartHead, running
      ? '本面板由后台服务运行'
      : '本面板不提供自动重启，重启由你在终端完成。');
  }
  if (dom.restartService) setHidden(dom.restartService, !running);
  if (dom.restartForeground) setHidden(dom.restartForeground, running);
  if (!running) return;
  if (dom.restartServiceRestart) setText(dom.restartServiceRestart, 'kimi-work-gateway service restart');
  if (dom.restartServiceStatus) setText(dom.restartServiceStatus, 'kimi-work-gateway service status');
  if (dom.restartServiceConfig) setText(dom.restartServiceConfig, service.config || '—');
}

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
    const restartRequired = connectionsChanged(data);
    setText(dom.restartState, config.state === 'unavailable'
      ? '无法读取配置文件。修正后重启面板。'
      : restartRequired
        ? '连接或模型已有保存的修改，但当前进程仍在使用启动时读取的配置。模型与子代理保存已暂停；重启面板后生效。'
        : config.state === 'ready'
          ? '当前配置文件已生效，没有待重启的修改。'
          : '配置文件已修改，当前进程仍在使用启动时读取的连接。重启面板后生效。');
  }
  renderRestartSteps(data);
  setText(dom.restartFile, (config.file || '—') + ' · 修订 ' + shortRev(data.revision));

  renderConnections();
  renderContext();
  renderTools();
  renderUpdates(data);
  renderDiagnostics(data);
}

/* ---------- render: named connections ---------- */

function renderConnections() {
  const data = state.data;
  if (!data) return;
  const available = connectionsAvailable(data);
  setHidden(dom.connsUnavailable, available);
  setHidden(dom.legacyPanel, available);
  if (!available) {
    setHidden(dom.connsList, true);
    setHidden(dom.connsEmpty, true);
    setHidden(dom.connEditor, true);
    setHidden(dom.connsSave, true);
    setHidden(dom.connsAdd, true);
    setHidden(dom.connsReset, true);
    setHidden(dom.connsDiff, true);
    return;
  }

  const rows = state.conns.draft || [];
  const named = rows.filter((row) => !row.legacy);
  setHidden(dom.connsList, false);
  setHidden(dom.connsEmpty, named.length > 0);
  setHidden(dom.connsSave, false);
  setHidden(dom.connsAdd, false);
  setHidden(dom.connsReset, false);

  const config = data.configuration || {};
  const blocked = config.state === 'unavailable';
  const dirty = connectionsDirty();
  state.conns.dirty = dirty;

  if (dom.connsSave) {
    dom.connsSave.disabled = !dirty || state.connsSaving || blocked;
    setText(dom.connsSave, state.connsSaving ? '正在保存…' : '保存连接');
  }
  if (dom.connsAdd) dom.connsAdd.disabled = state.connsSaving || blocked;
  if (dom.connsReset) dom.connsReset.disabled = !dirty || state.connsSaving;
  if (dom.connsDraft) {
    setText(dom.connsDraft, blocked ? '配置文件不可读，无法保存连接'
      : dirty ? '草稿尚未保存；保存后需重启面板才会生效' : '草稿与配置文件一致');
    dom.connsDraft.dataset.dirty = String(dirty);
  }

  if (dom.connsErrors) {
    /* 抽屉里的行内校验与会话级错误分开保存：轮询触发的重渲染不能把
       「凭据文件不可用」这类提示抹掉，否则用户会反复重试同一个错误。 */
    renderErrorList(dom.connsErrors, state.conns.errors || []);
  }

  if (dom.connsList) {
    const signature = JSON.stringify([rows, state.connsSaving, config.state, state.connChecks]);
    if (dom.connsList.dataset.signature !== signature) {
      dom.connsList.dataset.signature = signature;
      dom.connsList.replaceChildren(...rows.map((row, index) => buildConnectionRow(row, index)));
    }
  }

  renderConnectionEditor();
  renderConnectionsDiff();
}

function buildConnectionRow(row, index) {
  const li = document.createElement('li');
  li.className = 'conn-row';
  li.dataset.connectionId = row.id || '';
  if (row.legacy) li.dataset.legacy = 'true';

  const main = document.createElement('div');
  main.className = 'conn-row__main';
  const title = document.createElement('p');
  title.className = 'conn-row__name';
  const name = document.createElement('span');
  name.textContent = row.legacy ? '旧版单上游' : row.name || row.id;
  title.append(name);
  if (row.legacy) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = '兼容';
    title.append(tag);
  }
  const url = document.createElement('p');
  url.className = 'conn-row__url mono';
  url.textContent = row.baseURL || '—';
  url.setAttribute('title', row.baseURL || '');
  main.append(title, url);

  const meta = document.createElement('div');
  meta.className = 'conn-row__meta';
  const keyState = document.createElement('p');
  keyState.className = 'conn-row__line';
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.dataset.tone = row.apiKeySet || row.apiKey ? 'ok' : 'warn';
  const keyText = document.createElement('span');
  keyText.textContent = row.apiKey ? '本次已输入新 Key（未保存）'
    : row.apiKeySet ? 'Key 已在运行环境中' : 'Key 未在运行环境中';
  keyState.append(dot, keyText);
  const models = document.createElement('p');
  models.className = 'conn-row__line muted';
  models.textContent = (row.modelCount === null ? '模型数未知' : row.modelCount + ' 个模型')
    + (row.protocols && row.protocols.length ? ' · ' + row.protocols.map(protocolLabel).join('/') : '');
  meta.append(keyState, models);

  /* 行内检查只探测本行连接；结果与按钮留在同一行，不新增任何导航或诊断页。 */
  const check = state.connChecks[row.id];
  const checkLine = document.createElement('p');
  checkLine.className = 'conn-row__line conn-row__check';
  const checkDot = document.createElement('span');
  checkDot.className = 'dot';
  const checkText = document.createElement('span');
  if (!check) {
    checkDot.dataset.tone = 'neutral';
    checkText.textContent = '尚未检查本行连接';
  } else if (check.busy) {
    checkDot.dataset.tone = 'warn';
    checkText.textContent = '正在检查本行连接…';
  } else if (check.state === 'passed') {
    checkDot.dataset.tone = 'ok';
    checkText.textContent = '连接可用' + (Number.isInteger(check.modelCount) ? '：' + check.modelCount + ' 个模型'
      : '') + (Number.isFinite(check.ms) ? ' · ' + fmtMs(check.ms) : '');
  } else {
    checkDot.dataset.tone = 'bad';
    checkText.textContent = '检查未通过' + (Number.isInteger(check.httpStatus) ? '（HTTP ' + check.httpStatus + '）' : '')
      + '：' + (upstreamReasonText(check.reason) || '无法连接本行上游');
  }
  checkLine.append(checkDot, checkText);
  meta.append(checkLine);

  const actions = document.createElement('div');
  actions.className = 'conn-row__actions';
  if (!row.legacy) {
    const checkButton = document.createElement('button');
    checkButton.type = 'button';
    checkButton.className = 'btn btn--quiet btn--sm';
    checkButton.dataset.connectionCheck = row.id;
    checkButton.disabled = Boolean(check && check.busy) || state.connsSaving;
    checkButton.textContent = check && check.busy ? '正在检查…' : '检查连接';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'btn btn--quiet btn--sm';
    edit.dataset.connectionEdit = row.id;
    edit.textContent = '编辑';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--quiet btn--sm';
    remove.dataset.connectionRemove = row.id;
    remove.textContent = '移除';
    actions.append(checkButton, edit, remove);
  } else {
    const note = document.createElement('span');
    note.className = 'hint hint--inline';
    note.textContent = '旧配置仍在使用';
    actions.append(note);
  }

  li.append(main, meta, actions);
  return li;
}

function protocolLabel(value) {
  return value === 'chat' ? 'Chat' : value === 'responses' ? 'Responses' : value;
}

/* 连接行内检查的失败说明：沿用 discovery 的错误码表，再补连接级拒绝。
   result 里带回了 connectionId，只有与所在行匹配的结果才被采纳。 */
function upstreamReasonText(code) {
  if (typeof code !== 'string' || !code) return '';
  return UPSTREAM_REASON[code] || DIAG_REASON[code] || code;
}

function renderConnectionEditor() {
  const editing = state.conns.editing;
  if (!editing) {
    setHidden(dom.connEditor, true);
    return;
  }
  setHidden(dom.connEditor, false);
  setText(dom.connEditorTitle, editing.originalId ? '编辑连接' : '添加连接');
  const draft = editing.draft;
  if (dom.ceName) dom.ceName.value = draft.name || '';
  if (dom.ceId) {
    dom.ceId.value = draft.id || '';
    dom.ceId.disabled = Boolean(editing.originalId);
  }
  if (dom.ceBase) dom.ceBase.value = draft.baseURL || '';
  if (dom.ceKeyEnv) dom.ceKeyEnv.value = draft.apiKeyEnv || '';
  if (dom.ceChat) dom.ceChat.checked = (draft.protocols || []).includes('chat');
  if (dom.ceResponses) dom.ceResponses.checked = (draft.protocols || []).includes('responses');
  if (dom.cePreset) {
    const options = [{ value: '', label: '自定义（不套用预设）' }]
      .concat(providerPresets().map((preset) => ({ value: preset.id, label: preset.name || preset.id })));
    syncSelectOptions(dom.cePreset, options, draft.providerPresetId || '');
  }
  if (dom.cePresetHint) {
    const preset = providerPreset(draft.providerPresetId);
    setText(dom.cePresetHint, preset
      ? '预设来源：' + (preset.source && preset.source.url ? preset.source.url : '未提供')
        + (preset.notes ? ' · ' + preset.notes : '')
      : '选择预设会填入官方地址与已知能力；仍可改为自定义地址。');
  }
  if (dom.ceKeyHint) {
    setText(dom.ceKeyHint, editing.originalId
      ? '已保存的 Key 不会显示。留空表示保持现有值。'
      : '新连接必须填写 API Key；只写入本机私有凭据文件，不回显。');
  }
  if (dom.ceKey) {
    dom.ceKey.value = '';
    dom.ceKey.placeholder = editing.originalId ? '留空保持现有 Key' : 'sk-…';
  }
  if (dom.connEditorTest) dom.connEditorTest.disabled = Boolean(!editing.originalId);
}

/* 差异用「已保存 → 草稿」的成对值展示，让「改了但没重启」无法被误读成已生效。 */
function renderConnectionsDiff() {
  if (!dom.connsDiff) return;
  const available = connectionsAvailable(state.data);
  if (!available) {
    setHidden(dom.connsDiff, true);
    return;
  }
  const saved = connectionDraftFrom(state.data) || [];
  const draft = state.conns.draft || [];
  const savedNamed = saved.filter((row) => !row.legacy);
  const draftNamed = draft.filter((row) => !row.legacy);
  const lines = [];
  const savedById = new Map(savedNamed.map((row) => [row.id, row]));
  for (const row of draftNamed) {
    const before = savedById.get(row.id);
    if (!before) {
      lines.push(['新增连接', '—', row.name + ' · ' + row.baseURL]);
      continue;
    }
    if (before.name !== row.name) lines.push(['连接名称', before.name, row.name]);
    if (before.baseURL !== row.baseURL) lines.push(['上游地址', before.baseURL, row.baseURL]);
    if ((before.protocols || []).join(',') !== (row.protocols || []).join(',')) {
      lines.push(['协议限制', (before.protocols || []).map(protocolLabel).join('/') || '不限',
        (row.protocols || []).map(protocolLabel).join('/') || '不限']);
    }
    if (row.apiKey) lines.push(['API Key', '已保存（不回显）', '本次将替换']);
  }
  const draftIds = new Set(draftNamed.map((row) => row.id));
  for (const row of savedNamed) {
    if (!draftIds.has(row.id)) lines.push(['移除连接', row.name + ' · ' + row.baseURL, '—']);
  }
  const removedLegacy = saved.some((row) => row.legacy) && !draft.some((row) => row.legacy);
  if (removedLegacy) lines.push(['旧版单上游', '仍保留', '已移除']);
  if (!lines.length) {
    setHidden(dom.connsDiff, true);
    return;
  }
  setHidden(dom.connsDiff, false);
  const title = document.createElement('p');
  title.className = 'diff__title';
  title.textContent = '待重启生效的差异（已保存 → 草稿）';
  const list = document.createElement('dl');
  list.className = 'diff__list';
  lines.forEach(([label, before, after]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.className = 'mono';
    dd.textContent = (before || '—') + ' → ' + (after || '—');
    list.append(dt, dd);
  });
  dom.connsDiff.replaceChildren(title, list);
}

/* ---------- render: native context policy ---------- */

function renderContext() {
  const data = state.data;
  if (!data) return;
  const available = contextAvailable(data);
  setHidden(dom.ctxUnavailable, available);

  const draft = state.context.draft;
  const savedDraft = contextDraftFrom(data);
  if (available && (!state.context.dirty || !draft)) {
    state.context.draft = savedDraft;
    state.context.base = contextSignature(savedDraft);
  }

  if (!available) {
    if (dom.ctxSave) dom.ctxSave.disabled = true;
    if (dom.ctxReset) dom.ctxReset.disabled = true;
    setText(dom.ctxSaved, '不可用');
    setText(dom.ctxSavedSub, '面板服务没有提供该接口。');
    setText(dom.ctxObserved, '—');
    setText(dom.ctxObservedSub, '无法读取原生配置观测。');
    setDot(dom.ctxVerdictDot, 'neutral');
    setText(dom.ctxVerdictWord, '不可用');
    setText(dom.ctxVerdictNote, '模型、连接与翻译不受影响。');
    if (dom.ctxModes) {
      dom.ctxModes.querySelectorAll('input').forEach((input) => { input.disabled = true; });
    }
    setContextFieldsDisabled(true);
    return;
  }

  /* 轮询不得覆盖正在编辑的字段：只有非脏状态才回填。 */
  if (!state.context.dirty) fillContextForm();

  const config = data.configuration || {};
  const blocked = config.state === 'unavailable';
  const dirty = contextDirty();
  state.context.dirty = dirty;

  if (dom.ctxModeInherit) dom.ctxModeInherit.checked = draft.mode === 'inherit';
  if (dom.ctxModeCustom) dom.ctxModeCustom.checked = draft.mode === 'custom';
  setContextFieldsDisabled(draft.mode !== 'custom' || state.contextSaving || blocked);

  const { errors } = validateContextDraft(draft);
  renderErrorList(dom.ctxErrors, errors.slice(0, 1));

  if (dom.ctxSave) {
    dom.ctxSave.disabled = !dirty || errors.length > 0 || state.contextSaving || blocked;
    setText(dom.ctxSave, state.contextSaving ? '正在保存…' : '保存整理策略');
  }
  if (dom.ctxReset) dom.ctxReset.disabled = !dirty || state.contextSaving;
  if (dom.ctxDraft) {
    setText(dom.ctxDraft, blocked ? '配置文件不可读，无法保存策略'
      : dirty ? '草稿尚未保存' : '草稿与已保存策略一致');
    dom.ctxDraft.dataset.dirty = String(dirty);
  }

  const policy = (contextPolicyOf(data).policy) || {};
  const savedText = policy.mode === 'custom'
    ? (ratioToPercent(policy.triggerRatio) === null ? '阈值待确认' : ratioToPercent(policy.triggerRatio) + '%')
    : '跟随原生默认';
  setText(dom.ctxSaved, savedText);
  setText(dom.ctxSavedSub, policy.mode === 'custom'
    ? (Number.isSafeInteger(policy.reservedTokens) ? '预留 ' + fmtTokens(policy.reservedTokens) : '预留未提供')
    : '未写入任何阈值。');

  const observed = contextPolicyOf(data).observed;
  if (!observed || typeof observed !== 'object') {
    setText(dom.ctxObserved, '未观测');
    setText(dom.ctxObservedSub, '没有从原生配置读到匹配的设置。');
  } else {
    const observedRatio = ratioToPercent(observed.triggerRatio);
    setText(dom.ctxObserved, observedRatio === null ? '未观测' : observedRatio + '%');
    setText(dom.ctxObservedSub, Number.isSafeInteger(observed.reservedTokens)
      ? '预留 ' + fmtTokens(observed.reservedTokens) : '未观测到预留值');
  }

  const verdict = evaluateContext(data);
  setDot(dom.ctxVerdictDot, verdict.tone);
  setText(dom.ctxVerdictWord, verdict.word);
  setText(dom.ctxVerdictNote, verdict.note);
  if (dom.ctxVerdict) dom.ctxVerdict.dataset.status = verdict.status || '';
}

function setContextFieldsDisabled(disabled) {
  [dom.ctxRatio, dom.ctxReserved].forEach((field) => {
    if (field) field.disabled = disabled;
  });
}

function fillContextForm() {
  const draft = state.context.draft;
  if (!draft) return;
  if (dom.ctxRatio) dom.ctxRatio.value = draft.ratio;
  if (dom.ctxReserved) dom.ctxReserved.value = draft.reserved;
}

function readContextForm() {
  const draft = state.context.draft;
  if (!draft) return;
  draft.ratio = dom.ctxRatio ? dom.ctxRatio.value : draft.ratio;
  draft.reserved = dom.ctxReserved ? dom.ctxReserved.value : draft.reserved;
  state.context.dirty = contextDirty();
}

/* ---------- render: native MCP ---------- */

function renderTools() {
  const data = state.data;
  if (!data) return;
  const value = toolsState(data);
  if (!value) {
    setHidden(dom.toolsUnavailable, false);
    setText(dom.toolsUnavailable, '当前面板服务没有提供 MCP 接口，此处只显示状态说明。');
    setHidden(dom.toolsList, true);
    setHidden(dom.toolsEmpty, true);
    setHidden(dom.toolsEditor, true);
    if (dom.toolsAdd) dom.toolsAdd.disabled = true;
    if (dom.toolsRefresh) dom.toolsRefresh.disabled = true;
    return;
  }
  setHidden(dom.toolsUnavailable, !(value.available === false));
  if (value.available === false) {
    setText(dom.toolsUnavailable, mcpReasonText(value.reason) || '原生 MCP 当前不可用。');
  }
  const servers = value.servers || [];
  setHidden(dom.toolsList, servers.length === 0);
  setHidden(dom.toolsEmpty, servers.length > 0);
  if (dom.toolsAdd) dom.toolsAdd.disabled = value.available === false || state.tools.busy;
  if (dom.toolsRefresh) dom.toolsRefresh.disabled = state.tools.busy;

  if (dom.toolsList) {
    const signature = JSON.stringify([servers, state.tools.busy, state.tools.result]);
    if (dom.toolsList.dataset.signature !== signature) {
      dom.toolsList.dataset.signature = signature;
      dom.toolsList.replaceChildren(...servers.map(buildToolRow));
    }
  }

  if (dom.toolsResult) {
    const result = state.tools.result;
    if (!result) setHidden(dom.toolsResult, true);
    else {
      setHidden(dom.toolsResult, false);
      dom.toolsResult.dataset.tone = result.tone || 'neutral';
      setText(dom.toolsResult, result.text || '');
    }
  }
  renderToolsEditor();
}

function buildToolRow(server) {
  const li = document.createElement('li');
  li.className = 'mcp-row';
  li.dataset.mcpName = server.name || '';
  const transport = ['stdio', 'http', 'sse'].includes(server.transport) ? server.transport : 'unknown';
  li.dataset.transport = transport;

  const main = document.createElement('div');
  main.className = 'mcp-row__main';
  const title = document.createElement('p');
  title.className = 'mcp-row__name';
  const name = document.createElement('span');
  name.className = 'mono';
  name.textContent = server.name || '—';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = transport === 'unknown' ? '传输未知' : transport;
  title.append(name, tag);
  if (server.enabled === false) {
    const off = document.createElement('span');
    off.className = 'tag';
    off.textContent = '已停用';
    title.append(off);
  }
  main.append(title);

  const detail = document.createElement('p');
  detail.className = 'mcp-row__detail mono';
  detail.textContent = toolEndpointText(server, transport);
  main.append(detail);

  const meta = document.createElement('div');
  meta.className = 'mcp-row__meta';
  const secrets = secretNamesText(server, transport);
  if (secrets) {
    const line = document.createElement('p');
    line.className = 'mcp-row__line muted';
    line.textContent = secrets;
    meta.append(line);
  }
  const tools = Array.isArray(server.enabledTools) && server.enabledTools.length
    ? '启用工具 ' + server.enabledTools.join(', ') : '';
  if (tools) {
    const line = document.createElement('p');
    line.className = 'mcp-row__line muted';
    line.textContent = tools;
    meta.append(line);
  }

  const actions = document.createElement('div');
  actions.className = 'mcp-row__actions';
  if (transport === 'unknown') {
    const note = document.createElement('span');
    note.className = 'hint hint--inline';
    note.textContent = '不可编辑';
    actions.append(note);
  } else {
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'btn btn--quiet btn--sm';
    test.dataset.mcpTest = server.name;
    test.textContent = '测试';
    test.disabled = state.tools.busy;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn--quiet btn--sm';
    remove.dataset.mcpRemove = server.name;
    remove.textContent = '移除';
    remove.disabled = state.tools.busy;
    actions.append(test, remove);
  }

  li.append(main, meta, actions);
  return li;
}

/* args 在原生列表里只给出数量，env/headers 只有名字：不把 [redacted] 当成真实值展示。 */
function toolEndpointText(server, transport) {
  if (transport === 'stdio') {
    const count = Number.isInteger(server.argsCount) ? server.argsCount
      : Array.isArray(server.args) ? server.args.length : 0;
    return (server.command || '—') + (count ? ' · ' + count + ' 个参数' : ' · 无参数');
  }
  if (transport === 'http' || transport === 'sse') return server.url || '—';
  return '原生未报告传输方式';
}

function secretNamesText(server, transport) {
  if (transport === 'stdio' && Array.isArray(server.envNames) && server.envNames.length) {
    return '环境变量：' + server.envNames.join(', ') + '（值不显示）';
  }
  if ((transport === 'http' || transport === 'sse') && Array.isArray(server.headerNames) && server.headerNames.length) {
    return '请求头：' + server.headerNames.join(', ') + '（值不显示）';
  }
  return '';
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

/* 只比较 X.Y.Z 数字段：比较只服务于「本地是否不低于远端」的展示措辞，
   下载与门槛判断仍完全由更新管理器决定。 */
function versionOrder(left, right) {
  const a = versionText(left);
  const b = versionText(right);
  if (!a || !b) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (pa[index] !== pb[index]) return pa[index] < pb[index] ? -1 : 1;
  }
  return 0;
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
  let word = info.word;
  /* 「current」只说明远端没有比本地更新的稳定版；本地版本更高时不能说
     「当前运行的就是最新稳定版本」，要如实说「无需更新」。 */
  const ahead = state === 'current' && current && latest && versionOrder(current, latest) > 0;
  if (state === 'failed') note = reason || info.note;
  else if (state === 'staged' && pending) note = '版本 ' + pending + ' 已下载；重启网关后才会生效，当前运行版本不变。';
  else if (state === 'available' && latest) note = '版本 ' + latest + ' 可以下载；下载后需重启网关才会生效。';
  else if (ahead) {
    word = '无需更新';
    note = '本地版本 ' + current + ' 高于最新稳定版 ' + latest + '；不需要更新。';
  }
  else if (reason && state !== 'current') note = reason;
  return { tone: info.tone, word, note, state, current, latest, pending, ahead: ahead === true };
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
    ? (current && latest === current ? '与运行版本相同'
      : verdict.ahead ? '低于本地运行版本' : 'GitHub 上的最新正式发布')
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
  if (verdict.state === 'current') {
    return verdict.ahead
      ? '本地版本不低于最新稳定版；无需更新，需要时可再次检查或回退。'
      : '当前已是最新稳定版本；需要时可再次检查，或回退到更早的版本。';
  }
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
  'translation_waiting_chat_view': '已连接 Kimi，正在等待打开 Chat 会话中的思考内容。',
  'translation_not_target': '当前页面不是受支持的思考页面，已拒绝翻译。',
  'translation_stale_generation': '页面已切换，旧页面的翻译请求已被丢弃。',
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
    return { tone: 'ok', word: '已注入', note: translationSurfaceNote(runtime) };
  }

  if (runtime.state === 'disabled') {
    return { tone: 'neutral', word: '待连接', note: '翻译已启用，等待接入宿主连接；可点击“从网关启动 Kimi”重试。' };
  }

  return { tone: info.tone, word: info.word, note: reason || info.note };
}

/* 每个面单独回报结构：空会话与选择器漂移以前都会显示成“已注入”，用户无法分辨
   是页面还没有思考内容，还是这一版界面已经换了结构。 */
const TRANSLATION_SURFACE_LABEL = { work: 'Work', chat: 'Chat' };
const TRANSLATION_STRUCTURE_NOTE = {
  none: '页面上还没有可以翻译的思考内容。',
  partial: '检测到思考块但结构与翻译引擎不匹配，可能是不兼容的界面版本。',
};

function translationSurfaceNote(runtime) {
  const surfaces = runtime && runtime.surfaces;
  if (!surfaces || typeof surfaces !== 'object') return 'Kimi 已确认翻译引擎在运行。';
  const notes = [];
  for (const name of ['work', 'chat']) {
    const entry = surfaces[name];
    if (!entry || entry.state !== 'active') continue;
    const label = TRANSLATION_SURFACE_LABEL[name] || name;
    const structure = TRANSLATION_STRUCTURE_NOTE[entry.structure];
    notes.push(structure ? `${label}：${structure}` : `${label}：翻译已就绪。`);
  }
  return notes.length ? notes.join(' ') : 'Kimi 已确认翻译引擎在运行。';
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

  /* 命名连接与上下文策略同样遵守「轮询不覆盖正在编辑的草稿」：脏草稿只更新
     比较基线，非脏时才回填。这样后台每两秒刷新不会吞掉用户刚输的 Key。 */
  const savedConns = savedConnectionsSignature(next);
  if (initial || !state.conns.dirty) {
    state.conns.base = savedConns;
    state.conns.draft = connectionDraftFrom(next);
    state.conns.dirty = false;
  } else {
    state.conns.base = savedConns;
    state.conns.dirty = connectionsDirty();
  }

  const savedContext = contextSignature(contextDraftFrom(next));
  if (initial || !state.context.dirty) {
    state.context.draft = contextDraftFrom(next);
    state.context.base = savedContext;
    state.context.dirty = false;
  } else {
    state.context.base = savedContext;
    state.context.dirty = contextDirty();
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
  renderPicker();
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
    /* 模型表共 8 列（ID、路由、协议、预算、输出、能力、档位、操作）。 */
    td.colSpan = 8;
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
      else if (latest && current && versionOrder(current, latest) > 0) showToast('本地版本 ' + current + ' 高于最新稳定版 ' + latest + '；无需更新。', 'ok');
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

/* 命名连接的整组替换：成功响应仍是完整 state，因此保存后立即拿到新的
   saved 行与 restartRequired，界面无需猜测是否已经生效。 */
async function saveConnections() {
  const data = state.data;
  if (!data || state.connsSaving) return;
  const config = data.configuration || {};
  if (config.state === 'unavailable') {
    showToast('配置文件不可读，无法保存连接。', 'error');
    return;
  }
  if (state.conns.editing) {
    showToast('还有一条连接没有加入草稿。先点「加入草稿」或取消。', 'error');
    return;
  }
  const payload = connectionPayload(state.conns.draft);
  if (!payload.length) {
    showToast('至少保留一条命名连接；如需退回旧配置，请先添加连接再移除旧上游。', 'error');
    return;
  }
  const missingKey = payload.filter((row) => !row.apiKey);
  if (missingKey.length) {
    const savedIds = new Set((connectionDraftFrom(data) || []).filter((row) => row.secretSet || row.apiKeySet).map((row) => row.id));
    const needsKey = missingKey.filter((row) => !savedIds.has(row.id));
    if (needsKey.length) {
      setConnErrors(['连接「' + needsKey.map((row) => row.name || row.id).join('、')
        + '」还没有 API Key。新连接必须填写，已保存的连接可以留空保留原值。']);
      return;
    }
  }

  state.connsSaving = true;
  renderConnections();
  renderActions(data);

  try {
    const tokenEnv = connectionSource(data) ? connectionSource(data).tokenEnv : undefined;
    const body = { revision: data.revision, connections: payload };
    if (typeof tokenEnv === 'string' && tokenEnv) body.tokenEnv = tokenEnv;
    const res = await request(API.connections, { method: 'POST', body });
    if (res && res.state) {
      state.connsSaving = false;
      adoptState(res.state);
      state.lastSync = Date.now();
      state.conns.base = savedConnectionsSignature(state.data);
      state.conns.draft = connectionDraftFrom(state.data);
      renderAll();
      showToast('连接已保存。需要重启面板后才会使用新的连接与密钥。', 'ok');
    } else {
      state.connsSaving = false;
      await loadState({ silent: true });
      showToast('连接已提交，状态已刷新。', 'ok');
    }
  } catch (error) {
    state.connsSaving = false;
    if (error.code === 'credentials_file_unavailable') {
      /* 只有写入私有凭据文件才需要它；这条错误不能当成「已保存」，
         也不能把用户输入的 Key 打到日志或提示里。 */
      setConnErrors(['当前启动方式没有可写的私有凭据文件，因此没有保存任何 API Key。'
        + '请用 setup 生成的凭据文件启动面板后重试；已填写的 Key 不会被记录。']);
      if (dom.ceKey) dom.ceKey.value = '';
      showToast('无法保存 API Key：当前没有可写的私有凭据文件。', 'error');
      renderConnections();
      return;
    }
    if (error.code === 'connection_in_use') {
      setConnErrors(['仍有模型引用被移除的连接：' + (Array.isArray(error.models) ? error.models.join('、') : '')
        + '。请先在模型管理改到其他连接，再移除该连接。']);
      showToast('连接仍被模型引用，未保存。', 'error');
      renderConnections();
      return;
    }
    await handleSaveFailure(error, 'connections');
  } finally {
    state.connsSaving = false;
    if (state.data) {
      renderConnections();
      renderActions(state.data);
    }
  }
}

async function saveContextPolicy() {
  const data = state.data;
  if (!data || state.contextSaving) return;
  if (!contextAvailable(data)) return;
  const draft = state.context.draft;
  const { errors, value } = validateContextDraft(draft);
  renderErrorList(dom.ctxErrors, errors);
  if (errors.length) return;

  state.contextSaving = true;
  renderContext();
  renderActions(data);

  try {
    const res = await request(API.context, { method: 'POST', body: { policy: value } });
    /* 契约固定为 {context}：只解析这一种形状，缺字段时如实报错而不是猜测。 */
    const context = res && res.context;
    if (context && typeof context === 'object' && context.policy) {
      if (state.data) state.data = { ...state.data, context };
      state.contextSaving = false;
      const next = contextDraftFrom(state.data);
      state.context.draft = next;
      state.context.base = contextSignature(next);
      state.context.dirty = false;
      renderContext();
      renderOverview(state.data);
      const status = evaluateContext(state.data);
      showToast(status.status === 'applied'
        ? '策略已写入 Kimi 原生配置；正在运行的会话不会中途改变，需新会话读取后生效。'
        : '策略已保存：' + status.word + '。', status.status === 'applied' ? 'ok' : 'error');
      return;
    }
    state.contextSaving = false;
    await loadState({ silent: true });
    showToast('策略已提交，状态已刷新。', 'ok');
  } catch (error) {
    state.contextSaving = false;
    if (error.status === 400) {
      renderErrorList(dom.ctxErrors, [error.message]);
      renderContext();
      return;
    }
    await handleSaveFailure(error, 'context');
  } finally {
    state.contextSaving = false;
    if (state.data) {
      renderContext();
      renderActions(state.data);
    }
  }
}

async function refreshTools({ silent = false } = {}) {
  const data = state.data;
  if (!data || state.tools.busy) return;
  state.tools.busy = true;
  renderTools();
  try {
    const res = await request(API.tools);
    if (res && Array.isArray(res.servers)) {
      state.data = { ...state.data, tools: res };
      state.tools.servers = res.servers;
      if (!silent) showToast('已重新读取原生 MCP 列表。', 'ok');
    }
  } catch (error) {
    if (!silent) showToast(error.message || '读取原生 MCP 失败。', 'error');
  } finally {
    state.tools.busy = false;
    if (state.data) {
      renderTools();
      renderOverview(state.data);
    }
  }
}

/* 固定 ops：add/update/remove/test。响应是 {tools, result}，state 只在 list 读，
   因此每次写操作后用返回的 tools 直接刷新，不额外发一次 list。 */
async function submitTools(body, { successMessage } = {}) {
  const data = state.data;
  if (!data || state.tools.busy) return null;
  state.tools.busy = true;
  state.tools.result = null;
  renderTools();
  renderToolsEditor();
  try {
    const res = await request(API.tools, { method: 'POST', body });
    if (res && res.tools && Array.isArray(res.tools.servers)) {
      state.data = { ...state.data, tools: res.tools };
      state.tools.servers = res.tools.servers;
    }
    const result = res && res.result;
    if (result) {
      /* timeout 与 busy 都不是失败：前者结果未知，后者表示上一次探测还没结束。
         两者都不自动重试，交由用户显式再点，后端 busy 兜底。 */
      const tone = result.ok === true ? 'ok'
        : ['absent', 'unchanged', 'busy', 'timeout'].includes(result.state) ? 'warn' : 'error';
      state.tools.result = { tone, text: toolsResultText(result) };
    }
    if (result && result.ok === true && successMessage) showToast(successMessage, 'ok');
    if (result && result.ok !== true && result.state !== 'busy') showToast(toolsResultText(result), 'error');
    return result || null;
  } catch (error) {
    showToast(error.message || '原生 MCP 操作未完成。', 'error');
    return null;
  } finally {
    state.tools.busy = false;
    if (state.data) {
      renderTools();
      renderOverview(state.data);
    }
  }
}

/* 结果文案只依据 state + reason + tools/summary。
   后端原始 detail 是内核输出，脱敏只是尽力而为，因此界面不展示它——
   这既符合「不需要诊断中心」，也避免把未净化的文本带进页面。 */
function toolsResultText(result) {
  if (!result || typeof result !== 'object') return '操作未完成。';
  const state = typeof result.state === 'string' ? result.state : '';
  const name = typeof result.name === 'string' ? result.name : '';
  const reason = typeof result.reason === 'string' ? result.reason : '';
  const toolCount = result.summary && Number.isInteger(result.summary.toolCount)
    ? result.summary.toolCount
    : Array.isArray(result.tools) ? result.tools.length : null;
  const declared = result.summary && Number.isInteger(result.summary.declaredToolCount)
    ? result.summary.declaredToolCount : null;

  if (state === 'connected') {
    if (toolCount === null) return '已连接 ' + name + '。';
    /* 声明数与解析数不一致说明内核输出被截断或异常，此时不能报「完整」。 */
    const truncated = declared !== null && declared !== toolCount;
    return '已连接 ' + name + '，解析到 ' + toolCount + ' 个工具'
      + (truncated ? '（内核声明 ' + declared + ' 个，输出可能被截断）。' : '。');
  }
  if (state === 'failed') {
    return mcpReasonText(reason) || '测试未通过：服务器没有按 MCP 协议正常回应。';
  }
  if (state === 'timeout') return '测试超时：结果未知，服务器可能稍后才就绪。可稍后再测试一次。';
  if (state === 'busy') return '上一次测试尚未结束；这不是失败，请稍后显式再试。';
  if (state === 'not_found') return '找不到服务器：' + name + '。';
  if (state === 'added') return '已添加 ' + name + '。';
  if (state === 'updated') return '已更新 ' + name + '。';
  if (state === 'unchanged') return name ? name + ' 没有变化。' : '没有变化。';
  if (state === 'removed') return '已移除 ' + name + '。';
  if (state === 'absent') return name + ' 不在原生配置中。';
  if (state === 'exists') return '同名服务器已存在：' + name + '。';
  if (state === 'invalid') {
    return '设置不被接受'
      + (typeof result.field === 'string' ? '（字段 ' + result.field + '）' : '') + '。';
  }
  if (state === 'unavailable') return mcpReasonText(reason) || '原生 MCP 当前不可用。';
  return mcpReasonText(reason) || '操作未完成。';
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
      if (state.draft.transport === 'native-config') payload.transport = 'native-config';
    } else if (state.draft.mode === 'pool') {
      payload.model = state.draft.model;
      payload.transport = 'native-config';
      payload.models = state.draft.models;
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
        : state.draft.mode === 'pool'
          ? '模型池设置已保存；配置写入与内核采用情况见运行时状态。'
          : state.draft.transport === 'native-config'
            ? '目标设置已保存；配置写入与内核采用情况见运行时状态。'
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
    /* 双锁：revision 是 gateway.json 整体修订（历史行为），translationRevision
       是翻译设置自己的修订，服务端会把它作为 CAS 令牌下传给运行时写入。 */
    const translation = state.data.translation || {};
    const payload = { revision: data.revision, ...built.value };
    if (typeof translation.revision === 'string') payload.translationRevision = translation.revision;
    const res = await request(API.translation, { method: 'POST', body: payload });
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
    if (error.status === 409 && error.code === 'translation_settings_conflict') {
      /* 陈旧的翻译修订：状态已刷新，保留用户的编辑，让用户确认后重存。 */
      await loadState({ silent: true });
      showToast('翻译设置已在别处被修改，已刷新状态；你的编辑仍然保留，请确认后重新保存。', 'error');
      return false;
    }
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
  if (!['inherit', 'force', 'pool'].includes(mode) || mode === state.draft.mode) return;
  const saved = state.data ? savedTarget(state.data) : null;
  if (mode === 'inherit') {
    state.draft = { mode: 'inherit', transport: null, model: null, effort: null, models: [] };
  } else if (mode === 'pool') {
    /* 池从旧目标热身：只保留已有用途说明的候选，其余由用户显式加入。 */
    const seen = new Set();
    const seed = [];
    const push = (id, description) => {
      if (typeof id !== 'string' || !id || seen.has(id)) return;
      const model = findModel(id);
      if (!model || !isCapable(model)) return;
      const row = poolRow(id, description);
      if (!row.description) return;
      seen.add(id);
      seed.push(row);
    };
    (Array.isArray(state.draft.models) ? state.draft.models : []).forEach((row) => push(row && row.id, row && row.description));
    if (saved && Array.isArray(saved.models)) saved.models.forEach((row) => push(row.id, row.description));
    state.draft = {
      mode: 'pool',
      transport: 'native-config',
      model: seed.some((row) => row.id === (saved && saved.model)) ? saved.model : seed.length ? seed[0].id : null,
      effort: null,
      models: seed,
    };
  } else {
    const seed = (saved && saved.mode !== 'inherit' && saved.model && isCapable(findModel(saved.model)) && saved.model)
      || (state.draft.model && isCapable(findModel(state.draft.model)) && state.draft.model)
      || (capableModels()[0] ? capableModels()[0].id : null);
    state.draft = { mode: 'force', transport: saved && saved.transport === 'native-config' ? 'native-config' : null, model: seed || null, effort: null, models: [] };
  }
  recomputeDraftDirty();
  renderSubagents();
  renderModels();
}

function pickModel(id) {
  if (!state.draft || state.draft.mode !== 'force') return;
  const model = findModel(id);
  if (!model || !isCapable(model)) return;
  state.draft = { ...state.draft, model: id, effort: state.draft.model === id ? state.draft.effort : null };
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

function pickPoolDefault(id) {
  if (!state.draft || state.draft.mode !== 'pool') return;
  if (!id || !poolDraftIds(state.draft).has(id)) return;
  state.draft = { ...state.draft, model: id };
  recomputeDraftDirty();
  renderSubagents();
  renderModels();
}

function appendPoolModel(id, description) {
  if (!state.draft || state.draft.mode !== 'pool') return;
  const model = findModel(id);
  if (!model || !isCapable(model)) return;
  const row = poolRow(id, description);
  if (!row.description) return;
  if (poolDraftIds(state.draft).has(id)) return;
  if (state.draft.models.length >= 32) return;
  state.draft = { ...state.draft, models: state.draft.models.concat([row]) };
  recomputeDraftDirty();
  renderSubagents();
}

function removePoolModel(id) {
  if (!state.draft || state.draft.mode !== 'pool') return;
  if (!poolDraftIds(state.draft).has(id)) return;
  const models = state.draft.models.filter((row) => row.id !== id);
  const model = state.draft.model === id ? null : state.draft.model;
  state.draft = { ...state.draft, model, models };
  recomputeDraftDirty();
  renderSubagents();
  renderModels();
}

function toggleTransport(enabled) {
  if (!state.draft || state.draft.mode === 'inherit') return;
  if (state.draft.mode === 'pool') return;
  state.draft = { ...state.draft, transport: enabled === true ? 'native-config' : null };
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
    setMode(['force', 'pool'].includes(target.value) ? target.value : 'inherit');
  });
  if (dom.saModel) dom.saModel.addEventListener('change', () => pickModel(dom.saModel.value));
  if (dom.saEffort) dom.saEffort.addEventListener('change', () => pickEffort(dom.saEffort.value));
  if (dom.saPoolDefault) dom.saPoolDefault.addEventListener('change', () => pickPoolDefault(dom.saPoolDefault.value));
  if (dom.saPoolAdd) dom.saPoolAdd.addEventListener('change', () => {
    const usable = Boolean(state.data && configReady(state.data)) && !isInFlight(state.data.operation);
    if (dom.saPoolAppend) dom.saPoolAppend.disabled = !usable || !dom.saPoolAdd.value || state.subagentSaving;
  });
  if (dom.saPoolAppend) dom.saPoolAppend.addEventListener('click', () => {
    const id = dom.saPoolAdd ? dom.saPoolAdd.value : '';
    const description = dom.saPoolDesc ? dom.saPoolDesc.value : '';
    if (!id) return;
    appendPoolModel(id, description);
    if (dom.saPoolDesc) dom.saPoolDesc.value = '';
    if (dom.saPoolDescHint) setHidden(dom.saPoolDescHint, false);
  });
  if (dom.saPoolList) dom.saPoolList.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('[data-pool-remove]') : null;
    if (!node) return;
    removePoolModel(node.dataset.poolRemove);
  });
  if (dom.saNative) dom.saNative.addEventListener('change', () => {
    toggleTransport(dom.saNative ? dom.saNative.checked : false);
  });
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

  /* 命名连接 */
  if (dom.connsAdd) dom.connsAdd.addEventListener('click', () => openConnectionEditor(null));
  if (dom.connsReset) dom.connsReset.addEventListener('click', () => {
    state.conns.draft = connectionDraftFrom(state.data);
    state.conns.base = savedConnectionsSignature(state.data);
    state.conns.editing = null;
    renderConnections();
  });
  if (dom.connsSave) dom.connsSave.addEventListener('click', saveConnections);
  if (dom.connsList) dom.connsList.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!node) return;
    if (node.dataset.connectionCheck) {
      void runConnectionCheck(node.dataset.connectionCheck);
      return;
    }
    if (node.dataset.connectionEdit) {
      const row = (state.conns.draft || []).find((entry) => entry.id === node.dataset.connectionEdit);
      if (row) openConnectionEditor(row);
      return;
    }
    if (node.dataset.connectionRemove) {
      const id = node.dataset.connectionRemove;
      const used = ((state.data && state.data.models) || []).filter((model) => model.connectionId === id);
      if (used.length) {
        setConnErrors(['仍有 ' + used.length + ' 个模型使用该连接（'
          + used.slice(0, 3).map((model) => model.id).join('、') + (used.length > 3 ? ' 等' : '')
          + '）。请先在模型管理改到其他连接，再移除。']);
        return;
      }
      state.conns.draft = (state.conns.draft || []).filter((entry) => entry.id !== id);
      if (state.conns.editing && state.conns.editing.originalId === id) state.conns.editing = null;
      setConnErrors([]);
      renderConnections();
    }
  });
  if (dom.connEditorClose) dom.connEditorClose.addEventListener('click', closeConnectionEditor);
  if (dom.connEditorCancel) dom.connEditorCancel.addEventListener('click', closeConnectionEditor);
  if (dom.connEditorApply) dom.connEditorApply.addEventListener('click', applyConnectionEditor);
  if (dom.connEditorTest) dom.connEditorTest.addEventListener('click', async () => {
    const editing = state.conns.editing;
    if (!editing || !editing.originalId) return;
    const discovery = await runDiscovery(editing.originalId);
    if (discovery && discovery.state === 'passed') {
      showToast('连接可达，读到 ' + discovery.modelCount + ' 个模型；已保存的凭据未改变。', 'ok');
    }
  });
  if (dom.cePreset) dom.cePreset.addEventListener('change', () => {
    if (!state.conns.editing) return;
    applyProviderPreset(dom.cePreset.value);
  });
  [dom.ceName, dom.ceId, dom.ceBase, dom.ceKey, dom.ceKeyEnv].forEach((field) => {
    if (!field) return;
    field.addEventListener('input', () => {
      if (!state.conns.editing) return;
      readConnectionEditor();
      if (state.conns.editing.errors && state.conns.editing.errors.length) {
        state.conns.editing.errors = [];
        setConnErrors([]);
      }
    });
  });
  [dom.ceChat, dom.ceResponses].forEach((field) => {
    if (!field) return;
    field.addEventListener('change', () => {
      if (!state.conns.editing) return;
      readConnectionEditor();
    });
  });

  /* 上下文策略 */
  [dom.ctxModeInherit, dom.ctxModeCustom].forEach((field) => {
    if (!field) return;
    field.addEventListener('change', () => {
      const draft = state.context.draft;
      if (!draft || !contextAvailable(state.data)) return;
      draft.mode = dom.ctxModeCustom && dom.ctxModeCustom.checked ? 'custom' : 'inherit';
      if (draft.mode === 'custom') {
        if (!draft.ratio) draft.ratio = '75';
        if (draft.reserved === '') draft.reserved = '0';
      }
      state.context.dirty = contextDirty();
      fillContextForm();
      renderContext();
    });
  });
  [dom.ctxRatio, dom.ctxReserved].forEach((field) => {
    if (!field) return;
    field.addEventListener('input', () => {
      readContextForm();
      renderErrorList(dom.ctxErrors, []);
      renderContext();
    });
  });
  if (dom.ctxReset) dom.ctxReset.addEventListener('click', () => {
    state.context.draft = contextDraftFrom(state.data);
    state.context.base = contextSignature(state.context.draft);
    state.context.dirty = false;
    fillContextForm();
    renderErrorList(dom.ctxErrors, []);
    renderContext();
  });
  if (dom.ctxSave) dom.ctxSave.addEventListener('click', saveContextPolicy);

  /* MCP 工具 */
  if (dom.toolsAdd) dom.toolsAdd.addEventListener('click', openToolsEditor);
  if (dom.toolsRefresh) dom.toolsRefresh.addEventListener('click', () => { void refreshTools(); });
  if (dom.toolsEditorClose) dom.toolsEditorClose.addEventListener('click', closeToolsEditor);
  if (dom.teCancel) dom.teCancel.addEventListener('click', closeToolsEditor);
  if (dom.teSave) dom.teSave.addEventListener('click', submitToolsEditor);
  if (dom.teTransport) dom.teTransport.addEventListener('change', renderToolsEditor);
  if (dom.toolsList) dom.toolsList.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('button') : null;
    if (!node) return;
    if (node.dataset.mcpTest) {
      /* 请求期间按钮由 renderTools 的 busy 状态禁用；结束后不做自动重试，
         timeout/busy 由用户显式再点。 */
      const name = node.dataset.mcpTest;
      showToast('正在测试 ' + name + '；这是唯一会启动服务器的操作。', 'ok');
      void submitTools({ action: 'test', name });
      return;
    }
    if (node.dataset.mcpRemove) {
      const name = node.dataset.mcpRemove;
      void submitTools({ action: 'remove', name }, { successMessage: '已从 Kimi 原生 MCP 配置移除。' });
    }
  });

  /* 候选选择器 */
  if (dom.mCandidates) dom.mCandidates.addEventListener('click', openPicker);
  if (dom.pickerClose) dom.pickerClose.addEventListener('click', closePicker);
  if (dom.pickerQ) dom.pickerQ.addEventListener('input', () => {
    state.picker.query = dom.pickerQ.value;
    renderPicker();
    scheduleSearch();
  });
  if (dom.pickerScan) dom.pickerScan.addEventListener('click', () => {
    const editor = state.editor;
    if (!editor) return;
    void runDiscovery(editor.draft.connectionId);
  });
  if (dom.pickerList) dom.pickerList.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('[data-candidate-id]') : null;
    if (!node) return;
    pickCandidate(node.dataset.candidateId);
  });
  if (dom.mConnection) dom.mConnection.addEventListener('change', () => {
    const editor = state.editor;
    if (!editor) return;
    editor.draft.connectionId = dom.mConnection.value;
    editor.draft.metadataSource = null;
    if (editor.draft.upstreamModelId) {
      editor.draft.id = routeIdFor(editor.draft.connectionId, editor.draft.upstreamModelId);
      if (dom.mId) dom.mId.value = editor.draft.id;
    }
    state.picker.models = null;
    state.picker.reason = null;
    state.picker.state = null;
    state.picker.checkedAt = null;
    state.picker.source = null;
    state.picker.scope = pickerScope();
    renderEditor();
    renderPicker();
    /* A saved connection already has a catalog, so changing the connection with
       the picker open reloads it instead of leaving an empty list. */
    if (state.picker.open) void searchCandidates(state.picker.query);
  });
  if (dom.mUpstream) dom.mUpstream.addEventListener('input', () => {
    const editor = state.editor;
    if (!editor) return;
    editor.draft.upstreamModelId = dom.mUpstream.value;
    editor.draft.metadataSource = null;
    const suggested = routeIdFor(editor.draft.connectionId, editor.draft.upstreamModelId);
    if (suggested) {
      editor.draft.id = suggested;
      if (dom.mId) dom.mId.value = suggested;
    }
    renderEditor();
  });
  if (dom.mBudgetGroup) dom.mBudgetGroup.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-budget]') : null;
    if (!button || button.disabled) return;
    applyBudgetPreset(button.dataset.budget);
  });
  if (dom.mProtocolGroup) dom.mProtocolGroup.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-protocol]') : null;
    if (!button || button.disabled) return;
    chooseProtocol(button.dataset.protocol);
  });

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
  /* 新会话属于另一份配置：旧草稿与已读候选必须丢弃，否则会把上一会话的
     连接、Key 或上下文设置带进这一份。 */
  state.conns = { base: null, dirty: false, editing: null, draft: null, errors: [] };
  state.context = { base: null, dirty: false };
  state.tools = { servers: null, available: false, reason: null, editing: false, result: null, busy: false };
  state.picker = { open: false, models: null, query: '', state: null, checkedAt: null, source: null, reason: null,
    busy: false, seq: 0, hint: null, scope: null };
  state.providers = null;
  modelSignature = '';
  recentSignature = '';
  saModelSignature = '';
  saEffortSignature = '';
  stopPolling();
  setHidden(dom.conn, true);
  dom.toast.hidden = true;
  dom.shell.hidden = true;
  showGate('checking');
  void loadProviders();
  loadState().then((ok) => {
    if (ok) startPolling();
  });
  return true;}

/* ---------- boot ---------- */

/* 供应商预设只读取一次，用于连接编辑器与首设页的引导。
   接口不可用时留空数组：表单退回纯手填，不阻塞其它功能。 */
async function loadProviders() {
  if (!state.key || state.providers) return;
  try {
    const res = await request(API.providers);
    if (res && Array.isArray(res.presets)) {
      state.providers = res;
      renderConnectionEditor();
    }
  } catch {
    state.providers = { presets: [] };
  }
}

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

  void loadProviders();
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

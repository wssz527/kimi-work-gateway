# Kimi Work Gateway

让普通 **Kimi 桌面应用的 Work** 使用第三方模型：一个可在本机运行的 OpenAI 兼容网关，以及一个可嵌入其他程序的库。它不是 Kimi Code CLI，也不是把 Kimi 会员额度转给别的 Agent 的 Provider。

它依赖 Kimi 自带的**第三方模型网关**设置，不修改 Kimi 安装包、`app.asar`、可执行文件或签名，不开调试端口，不注入模型菜单。

独立网关提供命令行与**本机 Web 控制面板**。面板可查看网关、模型目录和子代理运行状态，切换子代理模型与推理档位，并执行运行时准备、启动 Kimi、首次接入准备和复制 Token。主模型仍在 Kimi Work 菜单里选择。

**支持 macOS 与 Windows。** Linux 未适配。

## 它解决什么问题

Kimi 的原生接入有三个容易被忽略的前提，本工具把它们一次性做完并给出可核对的证据：

1. 隐藏入口需要显示（Kimi 用户数据里的 `byok-availability.json`）。
2. 它会对 `dev.msh.team` 做一次内网可用性检查；本工具用一个精确的单域名本地 DNS 回答它，不接管其他域名。
3. 它按模型 **ID 的命名**选择接口：最后一段以 `kimi-` 开头走 Chat Completions，其余走 Responses。名字和协议对不上时，模型会在导入阶段被静默丢弃。

## 安装与首次使用

需要先安装普通 Kimi 桌面应用，以及 **Node.js 20+（包含 npm）**。独立版不需要 Git、Magpie 或额外安装 Bun；使用已有 Bun 时要求 1.4.2+。兼容检查依据解析器、运行时结构和实际启动能力，不以版本号白名单决定。思考翻译需 Work 渲染器确认；严格子代理控制还需桌面应用允许加载适配副本。当前正式版 Kimi 3.2.21 会忽略该副本路径，因此报告 `unsupported / packaged_bundle_override_disabled`，不能宣称强制策略已生效。Kimi Code 不适用。

### 1. 一条命令安装

macOS 终端：

```sh
npm install --global --ignore-scripts "https://github.com/wssz527/kimi-work-gateway/releases/download/v0.6.4/kimi-work-gateway-0.6.4.tgz"
```

Windows PowerShell：

```powershell
npm.cmd install --global --ignore-scripts "https://github.com/wssz527/kimi-work-gateway/releases/download/v0.6.4/kimi-work-gateway-0.6.4.tgz"
```

这是从 GitHub Release 安装固定版本，安装后可执行 `kimi-work-gateway help`。Windows PowerShell 使用 `kimi-work-gateway.cmd`，无需更改脚本执行策略。命令需要联网下载安装包；发行附件同时提供 `SHA256SUMS`。本项目未发布到 npm Registry，请使用完整发行包地址。

已有 Magpie 且只需要模型接入与子代理控制时，优先安装 [Magpie 插件](https://github.com/wssz527/magpie-agent-kimi-work-byok#安装)，不必另装独立版。独立版的思考翻译入口不包含在插件内。

### 2. 配置上游与模型

在你自己保存配置的目录创建 `gateway.json`。下面的地址、模型 ID 和能力是示例，需要按实际服务修改；安装不附带 API Key、账号额度或可用的上游服务。凭证只从环境变量读取，不写进 JSON。

```json
{
  "upstream": { "baseURL": "https://your-upstream.example/v1", "apiKeyEnv": "KIMI_WORK_UPSTREAM_KEY" },
  "tokenEnv": "KIMI_WORK_GATEWAY_TOKEN",
  "port": 3426,
  "dns": { "enabled": true, "port": 53535 },
  "models": [
    { "id": "glm-5-3-flash", "name": "GLM 5.3 Flash", "protocol": "responses",
      "contextWindow": 131072, "maxOutputTokens": 32768, "tools": true },
    { "id": "deepseek-v4-1-flash", "protocol": "responses", "contextWindow": 131072, "tools": true },
    { "id": "kimi-k3.1-pro", "protocol": "chat", "contextWindow": 262144, "tools": true,
      "reasoning": true, "reasoningEfforts": ["low", "high"] }
  ]
}
```

**先确认上游协议。** Kimi 要求末段以 `kimi-` 开头的模型 ID 使用 Chat Completions，其余使用 Responses；网关按此转发，不做协议转换，也不把模型别名改写成另一个上游 ID。仅支持 Chat Completions 的服务不能直接承接上述 GLM/DeepSeek 的 Responses 示例。工具、图片输入、推理档位也必须由上游实际支持。

### 3. 设置环境变量并启动面板

在 `gateway.json` 所在目录运行。macOS：

```sh
export KIMI_WORK_UPSTREAM_KEY='替换为你的上游 API Key'
export KIMI_WORK_GATEWAY_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
kimi-work-gateway panel --config gateway.json
```

Windows PowerShell：

```powershell
$secret = Read-Host '上游 API Key' -AsSecureString
$env:KIMI_WORK_UPSTREAM_KEY = [System.Net.NetworkCredential]::new('', $secret).Password
Remove-Variable secret
$env:KIMI_WORK_GATEWAY_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
kimi-work-gateway.cmd panel --config gateway.json
```

打开终端打印的完整 `panel http://127.0.0.1:3427/#key=…` 链接。**上游 API Key、本地网关 Token、面板链接密钥是三个不同的值**；Kimi 中填写的是本地网关 Token，面板中可点击“复制 Token”。

环境变量只对当前终端及其子进程有效。重新打开终端后需要重新提供凭证；首次生成的网关 Token 应自行妥善保留并在后续启动时复用，重新生成后也要更新 Kimi 保存的 Token。上面的生成命令用于首次接入。

### 4. 首次准备并在 Kimi 导入

保持面板运行，在 **连接与诊断 → 准备原生设置** 中触发一次准备，并完成系统管理员授权（macOS 写 `/etc/resolver/dev.msh.team`，Windows 只改 hosts 的两行）。确认结果为完成，然后在空闲时正常退出并重新打开 Kimi，刷新入口与 DNS 缓存。

也可以在另一个终端执行 `kimi-work-gateway prepare`（PowerShell 使用 `kimi-work-gateway.cmd prepare`）；自定义 DNS 端口时需同时传入匹配的 `--dns-port`。

在 **Kimi 设置 → 其他 → 第三方模型网关** 里填：

- **Base URL**：`http://127.0.0.1:3426/v1`；改了网关端口则使用实际地址。
- **Token**：面板“复制 Token”写入剪贴板的值。

点“测试连接并导入模型”，回到 Work，点输入框旁的模型名即可切换。基础模型接入到此完成；强制子代理还需[准备并从适配副本启动](#子代理控制可选非官方适配)，翻译还需在[思考翻译](#思考翻译可选)页启用并从网关启动 Kimi。

### 日常运行、升级与移除

- 日常使用需保持 `panel` 或 `serve` 运行；关掉终端会停止模型网关。没有自动开机启动、系统托盘或后台服务，关闭浏览器标签不会停止网关。
- 不要同时启用独立网关和 Magpie 的 Kimi Work 插件占用同一组默认端口；它们的网关 Token 和状态目录也不同，切换来源后需在 Kimi 重新导入。
- 更新时先停止旧网关，用新 Release 的完整包地址重跑安装命令，再以原来的配置路径和凭证启动。配置与状态不在 npm 安装目录，包更新会保留它们；发行前后均应检查 Kimi 的版本兼容范围。
- 卸载前先按[断开](#断开)撤销系统解析，再执行 `npm uninstall --global kimi-work-gateway`（PowerShell 用 `npm.cmd`）。卸载包不会自动撤销解析或删除用户配置。若使用过内置更新或回退，相关副本仍保存在 `~/.config/kimi-work-gateway/program-updates/`；自定义 `KIMI_WORK_GATEWAY_UPDATE_DIR` 时则位于该目录。确认不再需要回退后手动删除对应更新目录，避免卸载后旧副本继续占用空间；适配副本的移除见[断开](#断开)。
- 不分享 API Key、Token、带 `#key=` 的面板链接、账号文件或真实状态目录；给别人的是仓库或 Release 链接，让对方使用自己的上游与凭证。

准备在你的机器上具体做了什么：

| 平台 | 写入 | 是否需要常驻进程 |
| --- | --- | --- |
| macOS | `/etc/resolver/dev.msh.team`，指向本机 DNS | 是，`serve` 同时监听 UDP 53535 |
| Windows | `%SystemRoot%\System32\drivers\etc\hosts` 的两行 | 否，只需 HTTP 网关 |

Windows 不需要 DNS 服务，因为 Kimi 用 `dns.promises.lookup` 解析该域名，Windows 上它读的就是 hosts 文件；Kimi 只检查结果是私网地址，不会真的去连接。

## Web 控制面板

使用同一份配置与环境变量，将 `serve` 换成 `panel`：

```sh
kimi-work-gateway panel --config gateway.json
# 如需改面板端口：追加 --ui-port 3437
```

终端会打印网关地址与 `panel http://127.0.0.1:3427/#key=…`。在本机浏览器打开完整面板链接；面板会把会话密钥留在当前标签页，并从地址栏移除它。刷新页面可继续使用，重启命令后需使用新链接。面板默认只监听 `127.0.0.1:3427`，网关仍使用配置中的端口；不要与已接入的 Magpie 插件同时占用默认网关端口。

- **模型管理**：增删改模型，填写 ID、名称、上下文和输出上限，并声明工具、推理、图片输入和可用思考档位。目录保存后立即在网关生效；到 Kimi 的第三方模型网关设置重新测试并导入，才能更新它的模型菜单。当前子代理仍依赖的模型或档位不能删除，请先更换子代理目标。
- **思考强度**：可选或填写模型已声明的档位，例如 `low`、`medium`、`high`、`xhigh`；上游有其他档位时，先在模型编辑器里填写其真实标识符，再用于子代理。不固定为低/高两档，选择自动时使用声明的默认值。
- **视觉能力**：开启图片输入会在 Kimi 原生目录中声明 `text,image`，网关保留并转发图片内容。这是能力声明，只有上游实际支持识图才有效；本工具不为纯文本模型添加识图功能。
- **子代理与运行时**：选择继承主模型或指定支持工具的模型。已保存目标、当前策略与运行时证据分别显示；匹配副本的进程、心跳、策略版本和目标一致后才显示采用。切换只影响后续新建子代理，主模型仍在 Kimi Work 菜单里选择。
- **连接设置**：编辑上游 Base URL、凭证的环境变量名称、监听端口与 DNS 配置。只保存变量名，密钥值继续放在启动环境。连接修改需停止并重新运行 `panel`；面板会分别显示当前运行值和已保存值，待重启期间禁止继续修改模型和子代理，防止误写。
- **诊断与请求**：检查上游只发送一次认证的 `GET /models`；兼容检查只读本机 Kimi 目录解析器。检查通过不代表实际推理成功。概览统计本进程收到的有效认证推理请求，显示次数、失败、最近 20 条模型/协议/HTTP 结果/耗时；重启清零，不记录对话、图片、响应正文，不估算 token 或费用。Magpie 模式的用量继续在 Magpie 查看。
- **准备、启动与 Token**：保留运行时副本准备、启动 Kimi、原生接入准备、撤销解析及服务端复制 Token。翻译关闭且子代理为继承模式时，“启动 Kimi”直接打开原版应用，不加载副本；强制子代理模式仍要求适配副本与启动契约可用，不会静默丢弃强制目标。管理员操作交给系统授权；已运行 Kimi 时提示先正常退出，不结束进程、不自动重试。Token 值不会发给页面。

`panel` 必须使用实际 JSON 文件，不接受 `--config -`。保存会保留原配置的未知字段；多个页面同时保存会提示版本冲突。手动在外部更改基础配置仍需重启。退出命令会关闭两个监听并按归属恢复继承。

控制 API 使用版本 1 状态，保留原接口并增加翻译设置：

| 接口 | 请求与响应 |
| --- | --- |
| `GET /api/state` | 状态、模型、子代理、连接、翻译设置与真实会话状态、请求统计及诊断摘要；不含密钥值 |
| `POST /api/models` | `{revision, models}`，完整模型目录；成功返回 `{ok:true,state}` 并立即应用 |
| `POST /api/connection` | `{revision, upstream:{baseURL,apiKeyEnv}, tokenEnv, port, dns:{enabled,port}}`；成功返回 `{ok:true,state}`，连接等重启后应用 |
| `POST /api/subagents` | `{revision,mode,model?,effort?}`；成功返回 `{ok:true,state}` |
| `POST /api/translation` | `{revision,...translation}`，完整翻译设置；成功返回 `{ok:true,state}`，已有宿主异步应用并回报状态 |
| `POST /api/actions` | `{id,at,action}`；202 返回 `{ok:true,operation}`，轮询状态确认结果；支持 `check-upstream`、`check-compat`、`check-translation`、`launch-translated-kimi` |

操作请求五分钟内有效，先持久记录再执行；同一次操作的重试须复用 `id` 和 `at`，重复请求返回原结果，中断后不重放。配置保存须带当前 `revision`，不能在网络结果未知时盲目重试。错误统一返回 `{error:{code,message}}`；已落盘但运行策略未更新时另带 `saved:true`。API 使用面板专用 Bearer 密钥、精确 Host/Origin 检查和 JSON 请求体，推理端点仍拒绝网页来源。

## 思考翻译（可选）

在面板的 **思考翻译** 页启用、选择服务和目标语言，保存后点击 **从网关启动 Kimi**。先正常退出已运行的 Kimi；网关不会结束现有进程。启用翻译后，面板原来的“启动 Kimi”也使用相同宿主，强制子代理选择继续使用已验证的运行时副本，需先准备该副本。

支持 Bing、Google 和自定义 Chat Completions，可选中文、英语、日语、韩语、西班牙语、法语、德语、俄语。Bing/Google 使用其公开翻译入口，可用性由服务方决定。思考文本会发送到所选翻译服务；代码块、行内代码和链接保持原文。长文本分段处理，超过边界或翻译失败会显示原因并保留原文，不用原文冒充成功。

自定义服务填写完整 Chat Completions URL，例如 `https://your-upstream.example/v1/chat/completions`，可选模型 ID。API Key 只从宿主的环境变量读取，默认变量名 `KIMI_WORK_TRANSLATION_API_KEY`；修改环境变量后需重新启动翻译会话，页面只显示变量是否存在，不接收密钥值。端点须使用 HTTPS，本机可用 HTTP，不允许嵌入凭证、查询参数或片段。

配置文件中的可选字段如下，也可直接通过面板填写：

```json
{
  "translation": {
    "enabled": true,
    "provider": "bing",
    "targetLanguage": "zh",
    "view": "translated",
    "customEndpoint": "",
    "customModel": "",
    "apiKeyEnv": "KIMI_WORK_TRANSLATION_API_KEY"
  }
}
```

翻译入口由 `panel` 提供；单独的 `serve` 或 `subagents-launch` 不会启动翻译宿主。设置保存与实际注入分别显示，只有 Work 渲染器确认后才显示生效。Kimi 思考区域提供 **译文 / 原文 / 重译**，折叠随原思考区域同步；停用设置后恢复原文。关闭面板标签不影响翻译；退出网关后已启动的会话宿主继续服务该 Kimi，重启同一状态目录的面板可继续管理。Kimi 退出后宿主自动结束。

翻译按普通 Kimi Work 页面的私有管道、渲染器协议和 DOM 结构确认能力；版本号仅展示，未知版本会标记待验证，不因版本号拒绝启动。不适用于 Kimi Code。它不暴露调试 TCP 端口、不提供任意脚本 HTTP 接口、不修改安装包或签名。流式正文稳定后才发起翻译，并提供匹配块计数用于识别界面结构变化。重复注入时，网关先释放有 `dispose()` 的 v4 旧引擎；无法安全释放的 v3 保持 `legacy-running`。旧启动器发现网关引擎后让位。原文和译文仅在页面有界内存中缓存，不写入 localStorage 或网关状态文件。翻译 Key、上游 Key 与本地 Token 不传给 Kimi 子进程；结构环境变量不能作为翻译 Key 名称。

## 跨版本与 GitHub 更新

**优先继续使用当前版本。** Kimi 的版本号或整份源码摘要变化不会单独触发“不支持”。子代理准备会按配置读取、创建、运行和模型档案接点检查结构，并记录摘要以验证副本完整性；启动时若安装来源已更新，会按新来源自动准备本地副本。只有接点真正缺失、歧义或正式应用启动契约不可用才拒绝该适配，普通模型网关可继续运行。翻译同样以实际协议和页面回执为准。结构保持兼容且应用允许加载副本时，无需跟着 Kimi 升级本工具；结构真正改变时再检查本项目更新。

从 v0.6.0 起，可在 **连接与诊断 → 程序更新** 中检查 GitHub 最新稳定版、下载更新或回退。命令行也可使用：

```sh
kimi-work-gateway check-update
kimi-work-gateway update
kimi-work-gateway rollback-update
```

Windows PowerShell 使用 `kimi-work-gateway.cmd`。这些命令不需要上游 API Key，也不修改模型配置或 Kimi 设置；旧版没有更新命令，需先按安装命令升级到 v0.6.0 一次。

更新来自 `wssz527/kimi-work-gateway` 的 GitHub 稳定 Release。发现最新稳定版本依次尝试三条路径：本机 `git ls-remote`、仓库的静态发行 feed（`releases.atom`）、最后才是 GitHub API。前两条都是匿名的静态文件读取，不需要账号，也不消耗任何人的 API 配额；只有本机有 Git 时才使用第一条，前两条都不可用时才调用 API，而那时使用的是**运行者本机 IP 自己的**匿名配额，与项目作者无关。拿到标签后仍按该标签读取 `SHA256SUMS`，确认安装包存在并取得摘要。下载、归档路径和 SHA-256 校验成功后才切换用户状态目录中的程序版本，保留上一版本供回退；网络错误、限流或校验失败会保留当前版本。更新与回退均在**下次启动网关**时生效，当前进程不会自动重启，也不会结束 Kimi。重启时继续使用原来的配置路径和环境变量。没有新版本时无需更新，不会强制降级。

更新状态通过 `GET /api/state` 的 `updates` 返回：`currentVersion` 是当前运行版本，`latestVersion` 是上次检查的稳定版，`pendingVersion` 是下次启动采用的版本，`rollbackVersion` 是可回退版本。`state` 为 `not-checked`、`checking`、`current`、`available`、`staged` 或 `failed`，另有可选 `checkedAt`、`releaseURL` 和 `reason`。面板操作仍经带 ID 去重的 `POST /api/actions`，新增 `check-update`、`install-update`、`rollback-update`。

更新位置默认属于用户状态目录，可用绝对路径环境变量 `KIMI_WORK_GATEWAY_UPDATE_DIR` 指定独立更新目录；使用自定义目录时，后续启动也须使用同一变量。

## 模型声明

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 上游真实模型 ID，1–2048 字符，不含控制字符；不必包含 `/` |
| `protocol` | 是 | `chat` 或 `responses`。必须与 ID 命名一致，冲突会直接拒绝启动 |
| `contextWindow` | 是 | 正整数 |
| `maxOutputTokens` | 否 | 正整数 |
| `tools` | 否 | 上游支持工具调用时写 `true` |
| `reasoning` | 否 | 上游支持推理时写 `true` |
| `inputModalities` | 否 | `["text"]`、`["text","image"]` |
| `reasoningEfforts` | 否 | 上游实际支持的档位，例如 `["low","medium","high","xhigh"]`；面板允许填写小写标识符（最长 32 字符） |
| `defaultEffort` | 否 | 必须包含在 `reasoningEfforts` 中 |

不声明 `tools` / `reasoning` 时按**不支持**处理，Kimi 不会给这些模型发工具请求。

## 命令

| 命令 | 作用 |
| --- | --- |
| `serve --config <file\|->` | 启动本地网关，直到 SIGINT / SIGTERM |
| `panel --config <file> [--ui-port <port>]` | 启动网关与本机 Web 控制面板，默认面板端口 3427 |
| `prepare` | 安装单域名解析（macOS resolver / Windows hosts），显示隐藏入口；需管理员授权 |
| `remove-dns` | 撤销上一项；只删除内容与本工具一致的文件或行 |
| `compat --config <file>` | 用已安装 Kimi 检查指定模型配置；省略配置只检查内置样例 |
| `status` | 打印网关状态文件、准备回执与子代理策略/运行时状态 |
| `copy-token` | 把本地网关 Token 复制到剪贴板 |
| `subagents-prepare` | 为子代理控制适配本地运行时副本（见下节）；不改安装目录 |
| `subagents-status` | 只读报告子代理策略与运行时状态 |
| `subagents-launch` | 用适配后的运行时副本启动 Kimi；需先退出 Kimi |

`serve` 不会申请管理员权限，也不会改 Kimi 自己的配置。状态文件包含进程与实例标识、URL、模型数量、DNS 模式与生效的子代理策略，不含 Key 或对话内容；退出时只清理仍归本实例所有的状态。

## 子代理控制（可选，非官方适配）

默认情况下 Work 里的子代理沿用主模型。如果希望子代理固定走另一个模型，本工具提供一条**内部、非官方**的适配路径：

- `subagents-launch` 为本次进程设置 `DAIMON_BUNDLE_DIR`，指向本地适配副本。准备前会执行正式应用的启动接口探针；应用忽略该变量时直接报告 `unsupported`。**当前正式版 Kimi 3.2.21 属于此情况，以下流程需启动能力检查通过后才可使用。** 不自动迁移为原生 TOML 配置，避免放松 fork/resume 的严格约束。
- 内核按配置读取、依赖注入、子代理创建与恢复结构定位，并用真实内核行为回归和生成代码语法检查验证守卫。未知版本可通过这些检查；无法确认结构和行为时拒绝准备。`serve` 负责策略和转发，不修改 Kimi 安装目录、`app.asar`、可执行文件或签名。
- 主模型仍由 Work 菜单选择；这里只影响子代理。

配置里加一段 `subagents`（模型必须已在本工具的 `models` 中声明且带 `tools`；要写 `effort` 时该模型还须声明 `reasoningEfforts`）：

```json
{
  "subagents": { "mode": "force", "model": "kimi-k3.1-pro", "effort": "high" }
}
```

对应 `models` 里至少要这样声明：

```json
{ "id": "kimi-k3.1-pro", "protocol": "chat", "contextWindow": 262144, "tools": true,
  "reasoning": true, "reasoningEfforts": ["low", "high"] }
```

省略 `subagents` 或写 `{ "mode": "inherit" }` 表示使用 Kimi 原来的子代理绑定。指向未声明、不支持工具或 `effort` 不在 `reasoningEfforts` 内的模型时，配置会直接被拒绝，`serve` 在监听前退出（退出码 2）。推理档位需使用小写标识符，最长 32 字符。使用面板可直接保存并应用子代理选择；手动更改配置时重启 `serve --config gateway.json` 或 `panel --config gateway.json`。保持网关运行，再进行下面的准备和启动。

```sh
# 1. 适配本地运行时副本（幂等，不改安装目录）
kimi-work-gateway subagents-prepare

# 2. 查看策略与运行时状态（只读，不写文件）
kimi-work-gateway subagents-status

# 3. 完全退出 Kimi 后，用适配副本启动
kimi-work-gateway subagents-launch
```

`subagents-launch` 要求 Kimi 已退出：若检测到 Kimi 仍在运行，会返回 `waiting-kimi-exit`（退出码 0），此时请先退出 Kimi 再重试。

`force` 生效时的行为：

| 情况 | 结果 |
| --- | --- |
| 新建普通子代理 | 使用 `force` 指定的模型（含 `effort`） |
| `fork` 现有子代理 | 拒绝：fork 继承父模型，与 `force` 冲突 |
| `resume` 之前用别的模型跑过的子代理 | 拒绝：需要新建子代理 |

**停止控制并恢复继承**：结束 `serve`（Ctrl+C）时，网关会把自己写入的策略恢复为 `inherit`；也可以在配置里删除 `subagents` 段并重启 `serve`。下次从 Kimi 的通常应用入口启动即可不使用适配副本。

注意事项：

- 这是**内部、非官方适配**。源码、hook、适配器版本共同标识副本；宿主升级或适配代码变化后旧副本标记 `outdated`，不自动删除可能仍在运行的目录。哈希用于完整性检查，不是兼容版本白名单。
- `unsupported` 表示正式应用的启动契约不可用；`scope-conflict` 表示实际作用域与策略不匹配。退出码：`0` 成功或“需先退出 Kimi”，`3` 失败或冲突，`9` 内核结构、注入行为或应用启动契约不受支持。
- `subagents-status` 只读，不会创建策略文件；`subagents-prepare`/`subagents-launch` 在策略文件缺失时会写入 `inherit`，已存在则保留并校验它属于当前 Kimi 作用域。跨作用域和坏策略会明确报告，不会覆盖。
- 独立 CLI 的 `subagents-launch` 不读取 `gateway.json`，只清理默认的 `KIMI_WORK_UPSTREAM_KEY`、`KIMI_WORK_GATEWAY_TOKEN` 和 `KIMI_WORK_TRANSLATION_API_KEY`。自定义上游、Token 或翻译凭证变量名时，请通过已加载该配置的 `panel` 启动，避免这些自定义变量被 Kimi 子进程继承。
- `loaded` 表示匹配运行时、存活进程、有效心跳和当前策略版本已确认；需同时检查 `mode`，它可以是 `force`、`inherit` 或 `blocked`。`prepared` 和 `waiting-launch` 不表示强制策略已生效，`starting` 只表示启动请求已发出。
- `pending-policy` 表示运行时在等待读取新策略；`policy-unavailable` 表示运行时仍在但策略无法读取，主会话保持可用、子代理被拒绝。`heartbeat-stale` 表示匹配进程仍在但心跳过期，不代表应再次启动。`unavailable`、`outdated`、`conflict` 分别说明来源不可用、来源已变化和副本/状态文件冲突。

## 跨版本与 `compat`

`compat` 按**结构**定位已安装 Kimi 的目录解析器，再把生成的目录交给它检查。使用 `--config` 检查你配置的全部模型，不需要读取上游 Key 或发起推理请求；省略该参数时只检查内置样例，输出会明确标注检查对象。

| 状态 | 含义 | 退出码 |
| --- | --- | --- |
| `verified` | 解析器接受本次检查的全部模型，0 丢弃 | 0 |
| `incompatible` | 本次检查有模型被丢弃，需要处理 | 9 |
| `unverified` | 无法识别或执行解析器，兼容性未知 | 0 |
| `unavailable` | 没找到安装包或平台不支持检查 | 0 |

`unverified` 与 `unavailable` 不阻止网关运行，但不能作为导入或调用成功的证明。最终以 Kimi 的导入提示与实际调用为准。Windows 会尝试用户安装目录和 Program Files；自定义安装位置可用 `--archive` 指定。

```sh
kimi-work-gateway compat --config gateway.json
kimi-work-gateway compat --archive /path/to/app.asar --config gateway.json

# 只检查 5 个内置样例：
kimi-work-gateway compat
# catalog: sample-models (5 models)
# parser: verified — 5 models accepted, 0 skipped
```

## 断开

1. 先在 Kimi 自己的“第三方模型网关”设置里断开连接。
2. 运行 `remove-dns` 并完成授权。
3. 停止 `serve`（若用过子代理控制，这一步同时把策略恢复为 `inherit`）。

只删除内容仍与本工具配置一致的 `/etc/resolver/dev.msh.team`（macOS），或只删除带本工具标记的那两行（Windows），不删除别人的解析文件或条目，不改全局 DNS、代理、证书或防火墙。停止 `serve` 后 HTTP 监听消失，不安装常驻服务。删除状态目录里的 `native-runtime/` 即可移除适配后的运行时副本；这不影响 Kimi 安装目录，也不影响 Work 的正常启动。

## 作为库使用

```js
import { KimiWorkGateway } from 'kimi-work-gateway';

const gateway = new KimiWorkGateway({ backend });   // backend 见下
await gateway.configure({ key: 'local-token', port: 3426 });
```

`backend` 需要两个方法：

- `listModels({ signal })` → 模型数组（结构同上面的配置项）。
- `request(protocol, payload, { signal, headers })` → `Promise<Response>`，`protocol` 为 `chat` 或 `responses`。

内置的 `OpenAIBackend` 对接任意 OpenAI 兼容上游。要接别的服务，实现这两个方法即可。

## 已知限制

- 只支持 Chat Completions 与 Responses 两种上游协议，不做跨协议转换。
- 独立 CLI 的模型清单来自配置文件。使用 `serve` 时，手动修改 `models` 后需重启；使用 `panel` 时，可在模型管理保存并立即应用。两种方式都需要在 Kimi 重新导入以更新模型菜单；仅重新导入不会改变网关配置。
- 请求的端点必须与模型声明的协议一致，错误请求返回 `409 model_protocol_mismatch`，不会转发到上游。
- 首次接入需要管理员授权（macOS resolver / Windows hosts）。准备只有在操作完成且验证成功后才记为 `done`；裁决缺失会记为失败。
- Windows prepare 可使用已存在的手工同值条目，撤销时保留该条目；只删除标记与内容完整匹配的归属条目对。BOM、原换行和无末尾换行的内容保留；不支持的编码拒绝改写。
- 单域名解析只回答 `dev.msh.team`，指向合成地址 `10.255.255.254`，不代表接入真实公司内网。
- 子代理控制是内部、非官方适配，按结构与实际启动能力检查；当前正式版 Kimi 3.2.21 不允许该副本加载路径。跨版本合成检查不保证所有未来版本可用。
- Windows 真机已验证 CLI、Node/HTTP 流程及临时 hosts 文件的实际 PowerShell 编辑，并在官方普通 Kimi 3.2.21 的隔离用户目录中验证私有 CDP 管道与 Work 渲染器挂载。**真实 UAC、真实 hosts 修改与登录后的完整 Work 桌面流程仍未联合验收**；分层结果以发行说明为准。
- 原生内核回归与翻译界面测试使用隔离目录、合成文本及本地模拟上游，覆盖模型绑定、恢复、坏策略和译文生命周期。它们不产生付费推理，也不能代替登录桌面后的整条调用链验证。

## 开发

以下命令用于源码仓库；普通安装用户不需要执行测试或安装 Bun。

```sh
git clone https://github.com/wssz527/kimi-work-gateway
cd kimi-work-gateway
bun test        # Bun 1.4.2 / 1.4.4；1.3.x 不在支持范围
bun run check   # 语法检查
bun scripts/verify-package.mjs  # 打包、解包并在包内重跑测试和检查
```

发布包包含 `test/`。测试使用合成凭证与临时文件，包含 Node CLI 的实际 HTTP 调用，以及无须安装 Kimi 的 20 组符号变化检查。安装了 Kimi 的 macOS 还会检查真实解析器；合成检查不保证未来版本兼容。CI 配置在 Ubuntu 上覆盖两个 Bun 版本，在 Windows 上执行专用脚本用例和包内自验；修改工作流后需要实际运行才能确认本次 Windows 结果。

子代理测试分开验证结构、守卫、运行时状态与应用启动契约。`test/subagent-native.test.mjs` 在安装 Kimi 且有 Node 24 的环境中，直接导入适配后的真实内核，经本地模拟上游完成 12 个模型绑定、协议、effort、配置重建和 fork/resume 场景。该夹具显式绕过桌面启动探针，只证明内核适配，不能证明正式 App 加载了副本；真实启动能力由独立探针检查。不产生付费推理，缺少环境时跳过也不等于通过。

## 来源与许可证

MIT。与 Kimi、Moonshot 官方无隶属关系。部分实现源自 [`@magpie-community/agent-kimi-desktop`](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，版权声明保留在 [LICENSE](LICENSE)。Magpie 用户可直接使用基于本核心的 [`magpie-agent-kimi-work-byok`](https://github.com/wssz527/magpie-agent-kimi-work-byok) 插件，无需单独运行本网关。

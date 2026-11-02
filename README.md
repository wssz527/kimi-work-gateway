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

需要先安装普通 Kimi 桌面应用，以及 **Node.js 20+（包含 npm）**。独立版不需要 Git、Magpie 或额外安装 Bun；使用已有 Bun 时要求 1.4.2+。兼容检查依据解析器、原生配置与运行时结构，不以版本号白名单决定。新的原生子代理池需显式启用配置同步；旧副本路径仍依赖桌面应用允许覆盖运行时，正式版 Kimi 3.2.21、3.2.22 对旧路径报告 `unsupported / packaged_bundle_override_disabled` 或明确的不兼容原因。思考翻译仍需渲染器回执：Work 页面或 Chat 页面确认引擎在运行后才显示生效。Kimi Code 不适用。

### 1. 一条命令安装

0.9.0 提供自动配置与后台恢复。下载后核对发行附件 `SHA256SUMS`，再按下面的固定版本地址安装；旧版安装结果不能作为此流程的验证。

macOS 终端：

```sh
npm install --global --ignore-scripts "https://github.com/wssz527/kimi-work-gateway/releases/download/v0.9.0/kimi-work-gateway-0.9.0.tgz"
```

Windows PowerShell：

```powershell
npm.cmd install --global --ignore-scripts "https://github.com/wssz527/kimi-work-gateway/releases/download/v0.9.0/kimi-work-gateway-0.9.0.tgz"
```

这是从 GitHub Release 安装固定版本，安装后可执行 `kimi-work-gateway help`。Windows PowerShell 使用 `kimi-work-gateway.cmd`，无需更改脚本执行策略。命令需要联网下载安装包；发行附件同时提供 `SHA256SUMS`。本项目未发布到 npm Registry，请使用完整发行包地址。

已有 Magpie 且只需要模型接入与子代理控制时，优先安装 [Magpie 插件](https://github.com/wssz527/magpie-agent-kimi-work-byok#安装)，不必另装独立版。独立版的思考翻译入口不包含在插件内。

### 2. 打开首次配置页

```sh
kimi-work-gateway setup
```

Windows PowerShell 使用 `kimi-work-gateway.cmd setup`。命令打开本机配置页，填写自己的上游地址、API Key 和模型目录，然后保存并启动。程序生成并保存稳定的本地网关 Token，安装当前用户的后台服务，交接到实际控制面板。以后不需要重复设置环境变量或保持终端窗口。

上游 Key 与本地 Token 保存到用户状态目录内的私有 `credentials.json`，不会放入普通模型配置、日志或页面状态 API。配置页只在本机监听，并使用独立会话鉴权。再次运行 `setup` 可以维护已有配置；留空 Key 表示保留原值。

**先确认上游协议。** Kimi 要求末段以 `kimi-` 开头的模型 ID 使用 Chat Completions，其余使用 Responses；网关按此转发，不做协议转换，也不把模型别名改成其他上游 ID。工具、图片和推理档位也必须由上游实际支持。安装不附带账号、Key 或额度。

### 3. 在 Kimi 选择模型

打开并登录普通 Kimi 桌面应用，完成首次系统管理员授权。后台自动准备单域名解析、显示原生 BYOK 入口，并调用 Kimi 自己的导入接口保存本地网关连接。等待面板显示“模型目录已接入 Kimi 原生选择器”后，即可在 Work 输入框旁选择主模型；子代理在面板配置固定模型或模型池。

不需要复制 Token 或手动填写 Kimi 网关设置。Kimi 正在处理任务时会等待空闲；首次授权取消或接入中断时，到 **连接与诊断 → 重新接入 Kimi** 重试。无法确认当前账户、已有设置属于其他来源或接口结构变化时，会保留配置并给出状态，避免错误覆盖。

### 日常运行、升级与移除

- 首次配置安装的后台服务在用户登录后运行。关闭浏览器或终端不停止网关；只有手动运行的 `panel` / `serve` 依赖对应进程。
- 在面板增删模型、修改能力后，目录自动同步到 Kimi；不依赖 Kimi 的每日刷新。已有任务结束后再进行需要内核切换的更新。
- 模型目录、凭据、子代理池、用途与翻译设置在用户目录内保存，不随 Kimi 或网关版本号变化。Kimi 重启、安装文件更新或接入通道结束后，后台重新检查结构与实时忙闲状态，恢复导入通道和已启用翻译。用户主动退出 Kimi 时不会立即把它重新打开。
- 网关程序更新后用 `kimi-work-gateway service restart` 应用新版本；后台先等待推理请求和 Kimi 任务结束，再正常重启。服务入口通过稳定 bootstrap 读取已激活的程序版本，不绑定某个 Release 副本。可用 `service status` 查看状态和控制面板链接，`service stop` / `service start` 暂停或恢复。
- 不要同时启用独立网关和 Magpie 插件占用同一组默认端口。切换来源时，先停用旧来源，再让新来源接入。
- 卸载前运行 `kimi-work-gateway service uninstall`，再按[断开](#断开)撤销系统解析，最后执行 `npm uninstall --global kimi-work-gateway`（PowerShell 使用 `.cmd` 命令）。卸载不删除用户模型和凭据；不再需要时自行移除状态目录及 `program-updates/` 中的回退副本。
- 分享仓库或发行包，让安装者使用自己的上游与凭据。不要分享 `credentials.json`、账号文件、真实状态目录或带 `#key=` 的面板链接。

准备在你的机器上具体做了什么：

| 平台 | 写入 | 是否需要常驻进程 |
| --- | --- | --- |
| macOS | `/etc/resolver/dev.msh.team`，指向本机 DNS | 是，`serve` 同时监听 UDP 53535 |
| Windows | `%SystemRoot%\System32\drivers\etc\hosts` 的两行 | 否，只需 HTTP 网关 |

Windows 不需要 DNS 服务，因为 Kimi 用 `dns.promises.lookup` 解析该域名，Windows 上它读的就是 hosts 文件；Kimi 只检查结果是私网地址，不会真的去连接。

## Web 控制面板

首次配置完成后使用页面提供的控制面板入口。之后运行 `kimi-work-gateway service status` 可找回当前入口。高级用户也可提供自己的配置和环境变量，在前台运行：

```sh
kimi-work-gateway panel --config gateway.json
# 如需改面板端口：追加 --ui-port 3437
```

面板默认只监听 `127.0.0.1:3427`，使用独立的 `#key=` 链接鉴权；页面从地址栏移除密钥并保存在当前标签页。服务重启后使用新的入口。不要与已接入的 Magpie 插件同时占用默认网关端口。

- **模型管理**：增删模型与能力声明，保存后立即更新网关，并自动请求 Kimi 原生导入。当前子代理仍依赖的模型或档位不能删除，请先更换目标。
- **思考强度**：使用上游真实声明的档位，支持 `low`、`medium`、`high`、`xhigh` 及其他合法标识符；自动档位使用该模型的默认值。
- **视觉能力**：声明 `text,image` 后转发图片；只有上游实际支持才有效。
- **子代理**：继承、固定或模型池。池内保存候选、用途与默认模型，切换只影响新建子代理。文件写入、工具定义可见与真实调用分别报告；主模型在 Work 原生菜单选择。
- **连接设置**：编辑地址、端口、DNS 和凭据变量名。普通配置不保存密钥；`setup` 保存的私有凭据由服务在启动时读取，其他凭据可从环境提供。连接修改后重启服务；当前运行值与已保存值分别显示。
- **诊断与请求**：上游检查仅请求 `GET /models`，兼容检查只读本机解析器。概览只记录模型、协议、HTTP结果和耗时等元数据，重启清零，不记录对话、图片或响应正文。
- **Kimi接入**：自动准备、同步与恢复；取消授权后可主动重试。固定模型和模型池使用原版 Kimi，本机私有管道宿主维护原生导入与翻译，不要求副本。复制 Token 和旧兼容副本保留为手动操作。

`panel` 必须使用实际 JSON 文件，不接受 `--config -`。保存会保留原配置的未知字段；多个页面同时保存会提示版本冲突。手动在外部更改基础配置仍需重启。退出命令会关闭两个监听并按归属恢复继承。高级用途可给 `serve` / `panel` 加 `--no-native`，仅运行网关，不自动准备或接管桌面应用。

## 桌面接入边界

当前正式接入路径只控制官方 Kimi 桌面应用，不默认启动远程 companion、凭据 helper，也不接管 `safeStorage`。官方安装包、可执行文件和签名保持不变，原登录态继续由官方应用自己管理。

这套本机第三方模型接入不会同步到 Kimi 手机端。模型目录进入桌面原生选择器、实际选模和真实上游调用是不同证据，不能由本机 `ready` 推定其他两项已成功。若旧版本留下了 companion，停用或迁移时只对运行收据、启动记录、构建产物和实际可执行路径均一致的进程发一次正常退出请求，不重试、不强杀，也不关闭用户自己的官方 Kimi。

控制 API 使用版本 1 状态，保留原接口并增加翻译设置：

| 接口 | 请求与响应 |
| --- | --- |
| `GET /api/state` | 状态、模型、子代理、连接、翻译设置与真实会话状态、请求统计及诊断摘要；不含密钥值 |
| `POST /api/models` | `{revision, models}`，完整模型目录；成功返回 `{ok:true,state}` 并立即应用 |
| `POST /api/connection` | `{revision, upstream:{baseURL,apiKeyEnv}, tokenEnv, port, dns:{enabled,port}}`；成功返回 `{ok:true,state}`，连接等重启后应用 |
| `POST /api/subagents` | `{revision,mode,model,effort?,transport?}` 或 `{revision,mode:'pool',model,transport:'native-config',models:[{id,description}]}`；成功返回 `{ok:true,state}`。`transport` 仅接受 `native-config`，`pool` 固定使用它 |
| `POST /api/translation` | `{revision,...translation}`，完整翻译设置；成功返回 `{ok:true,state}`，已有宿主异步应用并回报状态 |
| `POST /api/actions` | `{id,at,action}`；202 返回 `{ok:true,operation}`，轮询状态确认结果；支持 `connect-kimi`、`check-upstream`、`check-compat`、`check-translation`、`launch-translated-kimi` |

操作请求五分钟内有效，先持久记录再执行；同一次操作的重试须复用 `id` 和 `at`，重复请求返回原结果，中断后不重放。配置保存须带当前 `revision`，不能在网络结果未知时盲目重试。错误统一返回 `{error:{code,message}}`；已落盘但运行策略未更新时另带 `saved:true`。API 使用面板专用 Bearer 密钥、精确 Host/Origin 检查和 JSON 请求体，推理端点仍拒绝网页来源。

## 思考翻译（可选）

在面板的 **思考翻译** 页启用、选择服务和目标语言并保存。原生接入宿主会应用设置；尚未连接时可点击 **从网关启动 Kimi**。持续监督保存启用意图，Kimi 普通重启或更新后，在确认安装归属与实时空闲状态后正常重开接入通道，恢复翻译；不强杀进程。原生固定子模型和模型池不依赖副本。

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

翻译设置由面板提供，`panel`、后台服务及配置了翻译的 `serve` 都使用同一接入监督机制。只有渲染器确认后才显示生效。页面提供 **译文 / 原文 / 重译**，折叠随原思考区域同步，停用后恢复原文。关闭浏览器不影响翻译；网关退出不强杀现有 Kimi，恢复相同状态目录后继续监督。Kimi 主动退出后当前宿主结束，后台等待下一次打开；更新后的普通启动会重新检查并恢复。

同一套翻译引擎与设置覆盖两处可见思考：Work 页面的思考块，以及 Chat 页面（`https://www.kimi.com` 的对话、历史与根路由）中已展开的思考内容。默认仍然关闭，沿用同一个开关、服务与目标语言；不修改模型上下文、不修改消息存储，只翻译页面上已经显示出来的思考文本。

Chat 页面与 Work 的结构不同，引擎按页面实际契约工作：折叠状态由思考块根节点的 `is-expanded` 决定，折叠时正文虽然仍留在 DOM 中但不会发送；流式进行中（`.resize-container.enable-grow-animation`）不发送，只有稳定后才请求一次；展开后可切换原文与译文，折叠时两者都不显示。Chat 是单页应用，切换到设置、会员或插件等页面时会立即撤销注入、移除镜像并丢弃在途回复；跨域离开同样如此，旧文档的迟到回复不会被注入新页面。

翻译按页面的私有管道、渲染器协议和 DOM 结构确认能力；版本号仅展示，未知版本会标记待验证，不因版本号拒绝启动。不适用于 Kimi Code。只有 Work 页面与已确认的 Chat origin 与路由会收到注入：iframe、worker、外观相似的域名（如 `www.kimi.com.evil.test`）、同站的设置与会员页面一律拒绝。注入与绑定都限定在页面主 frame 的主 world：子 frame 与隔离世界的调用会被直接丢弃，目标查询失败时本次翻译请求直接拒绝而不是沿用上一次的位置快照，每次请求还会在被固定的那个 world 中复核实际位置与是否顶层页面；页面主 frame 导航后旧的在途请求与回复一并作废。保存设置或页面加载完成只会让翻译引擎重新确认，不会丢弃仍然有效的主 world，因此不会出现“设置保存后翻译静默失效”。渲染器在安装它的求值中就会扫描页面，所以首个请求可能早于本次注入的回执到达；宿主按本次注入的 generation 与主 world 固定并等待该回执，只有回执确认 surface 与顶层页面后才处理请求，注入失败、被取代、world 销毁或管道关闭时立即释放等待，既不调用翻译服务也不迟到回包。它不暴露调试 TCP 端口、不提供任意脚本 HTTP 接口、不修改安装包或签名。流式正文稳定后才发起翻译，并提供匹配块计数与结构状态（`none` 空会话 / `partial` 结构漂移 / `matched`），用于区分“页面还没打开思考”与“界面结构已变化”；面板会按 Work 与 Chat 分别显示这一状态。重复注入时，网关先释放有 `dispose()` 的 v4 旧引擎；无法安全释放的 v3 保持 `legacy-running`。旧启动器发现网关引擎后让位。原文和译文仅在页面有界内存中缓存，不写入 localStorage 或网关状态文件。翻译 Key、上游 Key 与本地 Token 不传给 Kimi 子进程；结构环境变量不能作为翻译 Key 名称。

## 跨版本与 GitHub 更新

**优先继续使用当前版本。** Kimi 的版本号或整份源码摘要变化不会单独触发“不支持”。普通固定子代理和模型池使用原生 TOML，不依赖旧运行时副本。网关运行时根据已确认的当前账户原生 profile 恢复被重建的 provider 和模型表，并重新应用持久保存的池、用途与默认项；状态位于用户目录，不随应用版本号迁移。首次与目录变化由网关调用 Kimi 原生导入接口完成；已确认账户且已有授权时可恢复丢失目录。明确断开、账户身份无法确认或用户手改冲突时暂停并报告，不猜账户、不还原旧凭据。入口或配置语义真正变化时，再检查本项目更新。旧副本路径和翻译分别按其实际结构、启动契约与页面回执检查能力。

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
| `setup [--state-dir <dir>] [--no-open]` | 打开首次配置页，保存凭据、安装后台服务并进入控制面板 |
| `service start\|stop\|restart\|status\|uninstall` | 管理当前用户后台服务；restart 等待任务安全结束 |
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

`serve` 与 `panel` 共用自动接入连接；首次准备可能请求系统管理员授权，取消后不会反复弹框。显式启用原生子代理同步后，只管理下文所述私有 TOML 区块。状态文件包含进程、URL、模型数量、DNS 与策略，不含 Key 或对话内容；退出时只清理仍归本实例所有的状态。

## 原生子代理模型池

在面板的 **子代理** 页显式启用原生配置同步，可选择继承主模型、固定一个子模型，或配置模型池。也可在 `gateway.json` 设置：

```json
{
  "subagents": {
    "mode": "pool",
    "transport": "native-config",
    "model": "deepseek-v4-1-flash",
    "models": [
      { "id": "deepseek-v4-1-flash", "description": "代码实现和排查" },
      { "id": "glm-5-3-flash", "description": "独立审查和交叉验证" }
    ]
  }
}
```

这些 ID 必须已在网关目录声明，并在 Kimi 导入。池内可选 1–32 个支持工具调用的模型，默认模型须在池中；用途说明为单行文本，最长 1000 字符。模型池使用各模型自己的默认思考档位。固定模型可设置 `mode: "force"`、`transport: "native-config"`、`model` 及可选 `effort`；继承模式使用 `mode: "inherit"` 和同一 transport。

这条路径不依赖 `DAIMON_BUNDLE_DIR`，不修改安装文件。网关在运行期间管理 Kimi 私有 `runtime/kimi-code/home/config.toml` 中带归属标记的 `secondary_model` 区块；桌面重新生成配置后会重新同步。已有未受管的子代理配置、用户改过的受管区块或文件归属冲突均不会被覆盖。关闭前切回继承并确认撤销状态，再停止或卸载网关。

| 状态 | 可以确认什么 |
| --- | --- |
| `source-compatible` | 安装内核的配置、监听和模型选择结构匹配；不代表实际请求已采用 |
| `file-applied` | 区块已写入私有配置；固定模型模式不据此声称已运行 |
| `observed.state: observed-schema` | Work 请求中的子代理工具已包含预期模型池和默认模型 |
| `waiting-config` | 模型尚未导入或私有配置尚未生成 |
| `conflict` / `unverified` | 无法安全同步或确认安装结构，需查看原因 |

模型池未出现在 Work 的工具定义中时，网关返回可重试的 `subagent_native_reload_pending`，不向上游转发旧定义。设置只作用于新建的普通子代理；`fork` 继承父会话，恢复旧子代理保留原有模型。`primary` 仅在 Kimi 原生为该工具提供此选择时继承主模型与档位；当前普通 Agent/AgentSwarm 只接受池内别名，TowerSpawn 保留 `primary`。需要在普通 Agent 中选主模型时，将主模型加入池并选择其别名。原生配置路径沿用 Kimi 自己的这些行为，与下文旧副本的严格守卫不同。plan、coder、explore 的类型决定工具权限，用途说明不构成按类型强制绑定。AgentSwarm、TowerSpawn 在 Work 实际启用这些功能时共用该池，本工具不解锁会员功能或开启隐藏功能。

`serve` 和面板会将已有的固定模型配置迁移为原生同步，包括未写 `transport` 的 `force` 配置。固定目标与模型池不再依赖随 Kimi 安装包变化的旧副本。兼容检查读取原生配置与选择能力；版本号变化只触发复核。新内核移除 `force` 键时使用其原生 `default_model` 语义；单成员池不暴露模型选择参数时按其真实行为处理，不误报为尚未加载。旧副本命令仍保留供兼容构建显式使用。Windows 真机仍需实测。

## Work 各功能的模型来源

| 功能 | 模型或服务来源 | 第三方接入边界 |
| --- | --- | --- |
| 主会话、规划、工具推理 | 当前会话模型 | 使用 Work 导入的第三方模型 |
| 压缩、上下文摘要 | 当前会话模型 | 随主模型切换，没有独立摘要模型选项 |
| 普通子代理、各 Agent 类型 | 原生 secondary_model 池或继承 | 可使用上述池；类型与模型选择分开 |
| Swarm / Tower 工作器 | 同一子代理模型池 | 只有宿主实际开放功能时可用 |
| 图片理解 | 当前模型的真实图片能力 | 目录需声明图片输入；不为文本模型增加视觉能力，未接入视频服务 |
| 定时任务 | 调度器本身无模型，触发后的任务使用会话模型 | 第三方会话模型可承接推理；仍受宿主调度和会话生命周期限制 |
| 会话标题 | Kimi 专用 chat_title 服务与账号鉴权 | 不通过本聊天模型网关；不提供第三方标题生成 |
| 长期记忆 | Kimi Memory Space 服务 | 仍由 Kimi 账号与工具设置管理 |
| 网页搜索、抓取 | 独立工具服务 | 聊天模型不能直接替代；兼容搜索服务可由原生 services 配置提供，但本工具未管理该配置 |
| 生图、宠物渲染 | 独立媒体服务 | 不随聊天模型选择切换，未提供第三方生图设置 |
| 语音听写 | 腾讯云 ASR，经 Kimi 获取凭证 | 不随聊天模型选择切换，未提供第三方 ASR 设置 |
| 思考翻译 | 本网关独立翻译设置 | 覆盖 Work 思考块与 Chat 页面已展开的思考；可使用自定义 Chat Completions，见上文 |

这份边界来自对本机 Work 3.2.21 与 3.2.22 调用路径的检查；服务端实现与未来应用版本可能变化。代码中存在某个供应商 SDK，不等于该功能已经开放给用户。

## 子代理控制（可选，非官方适配）

本节是保留的旧副本接入，仅适用于允许覆盖运行时路径的桌面构建。默认情况下 Work 里的子代理沿用主模型。如果希望使用旧版严格守卫，本工具保留该**内部、非官方**路径：

- `subagents-launch` 为本次进程设置 `DAIMON_BUNDLE_DIR`，指向本地适配副本。准备前会执行正式应用的启动接口探针；应用忽略该变量时直接报告 `unsupported`。**当前正式版 Kimi 3.2.21、3.2.22 属于此情况，以下流程需启动能力检查通过后才可使用。** 不自动迁移为原生 TOML 配置，避免放松 fork/resume 的严格约束。
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

定位只对**字符串表函数**使用括号匹配：它的函数体可达上百万字符，内部字面量含换行与 `}`，按行尾 `\n}` 截断会停在字面量中间。其余函数仍按 `\n}` 切分，因为给它们套用字符串感知扫描会被正则字面量与参数默认值干扰。字符串表以外的形状变化（例如数组声明不在函数开头）会让检查落到 `unverified`，不会误报 `verified`。

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
3. 停止 `serve`（没用过原生子代理池时，这一步同时把策略恢复为 `inherit`）。若用过模型池，面板或 `subagents-status` 显示 `restored` 才算撤销成功；显示 `conflict` 说明本机 `config.toml` 中的受管区块被手工改过或 receipt 丢失，工具不会覆盖它，需按提示人工处理后再断开。`close` 失败不会影响 Kimi 正常启动，但请勿把残留区块当作仍在生效的池。

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
- 子代理控制是内部、非官方适配，按结构与实际启动能力检查；当前正式版 Kimi 3.2.21、3.2.22 不允许该副本加载路径。跨版本合成检查不保证所有未来版本可用。
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

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

## 安装与运行

要求 Node 20+ 或 Bun 1.4.2+。

```sh
git clone https://github.com/wssz527/kimi-work-gateway
cd kimi-work-gateway
```

写一份配置（凭证只从环境变量读取，不要写进文件）：

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

```sh
export KIMI_WORK_UPSTREAM_KEY=...
export KIMI_WORK_GATEWAY_TOKEN=...
node bin/kimi-work-gateway.mjs serve --config gateway.json
```

第一次接入还要做一次准备，它会请求系统管理员授权（macOS 写 `/etc/resolver/dev.msh.team`，Windows 只改 hosts 的两行）：

```sh
node bin/kimi-work-gateway.mjs prepare
```

然后在 **Kimi 设置 → 其他 → 第三方模型网关** 里填：

- **Base URL**：`http://127.0.0.1:3426/v1`
- **Token**：`copy-token` 复制到剪贴板的那个值

点“测试连接并导入模型”，回到 Work，点输入框旁的模型名即可切换。

准备在你的机器上具体做了什么：

| 平台 | 写入 | 是否需要常驻进程 |
| --- | --- | --- |
| macOS | `/etc/resolver/dev.msh.team`，指向本机 DNS | 是，`serve` 同时监听 UDP 53535 |
| Windows | `%SystemRoot%\System32\drivers\etc\hosts` 的两行 | 否，只需 HTTP 网关 |

Windows 不需要 DNS 服务，因为 Kimi 用 `dns.promises.lookup` 解析该域名，Windows 上它读的就是 hosts 文件；Kimi 只检查结果是私网地址，不会真的去连接。

## Web 控制面板

使用同一份配置与环境变量，将 `serve` 换成 `panel`：

```sh
node bin/kimi-work-gateway.mjs panel --config gateway.json
# 如需改面板端口：追加 --ui-port 3437
```

终端会打印网关地址与 `panel http://127.0.0.1:3427/#key=…`。在本机浏览器打开完整面板链接；面板会把会话密钥留在当前标签页，并从地址栏移除它。刷新页面可继续使用，重启命令后需使用新链接。面板默认只监听 `127.0.0.1:3427`，网关仍使用配置中的端口；不要与已接入的 Magpie 插件同时占用默认网关端口。

- **模型管理**：增删改模型，填写 ID、名称、上下文和输出上限，并声明工具、推理、图片输入和可用思考档位。目录保存后立即在网关生效；到 Kimi 的第三方模型网关设置重新测试并导入，才能更新它的模型菜单。当前子代理仍依赖的模型或档位不能删除，请先更换子代理目标。
- **思考强度**：可选或填写模型已声明的档位，例如 `low`、`medium`、`high`、`xhigh`；上游有其他档位时，先在模型编辑器里填写其真实标识符，再用于子代理。不固定为低/高两档，选择自动时使用声明的默认值。
- **视觉能力**：开启图片输入会在 Kimi 原生目录中声明 `text,image`，网关保留并转发图片内容。这是能力声明，只有上游实际支持识图才有效；本工具不为纯文本模型添加识图功能。
- **子代理与运行时**：选择继承主模型或指定支持工具的模型。已保存目标、当前策略与运行时证据分别显示；匹配副本的进程、心跳、策略版本和目标一致后才显示采用。切换只影响后续新建子代理，主模型仍在 Kimi Work 菜单里选择。
- **连接设置**：编辑上游 Base URL、凭证的环境变量名称、监听端口与 DNS 配置。只保存变量名，密钥值继续放在启动环境。连接修改需停止并重新运行 `panel`；面板会分别显示当前运行值和已保存值，待重启期间禁止继续修改模型和子代理，防止误写。
- **诊断与请求**：检查上游只发送一次认证的 `GET /models`；兼容检查只读本机 Kimi 目录解析器。检查通过不代表实际推理成功。概览统计本进程收到的有效认证推理请求，显示次数、失败、最近 20 条模型/协议/HTTP 结果/耗时；重启清零，不记录对话、图片、响应正文，不估算 token 或费用。Magpie 模式的用量继续在 Magpie 查看。
- **准备、启动与 Token**：保留运行时副本准备、启动适配 Kimi、原生接入准备、撤销解析及服务端复制 Token。管理员操作交给系统授权；已运行 Kimi 时提示先正常退出，不结束进程、不自动重试。Token 值不会发给页面。

`panel` 必须使用实际 JSON 文件，不接受 `--config -`。保存会保留原配置的未知字段；多个页面同时保存会提示版本冲突。手动在外部更改基础配置仍需重启。退出命令会关闭两个监听并按归属恢复继承。

控制 API 使用版本 1 状态，保留原接口并增加模型与连接设置：

| 接口 | 请求与响应 |
| --- | --- |
| `GET /api/state` | 状态、模型、子代理、连接的运行/保存值、进程内请求统计与诊断摘要；不含密钥值 |
| `POST /api/models` | `{revision, models}`，完整模型目录；成功返回 `{ok:true,state}` 并立即应用 |
| `POST /api/connection` | `{revision, upstream:{baseURL,apiKeyEnv}, tokenEnv, port, dns:{enabled,port}}`；成功返回 `{ok:true,state}`，连接等重启后应用 |
| `POST /api/subagents` | `{revision,mode,model?,effort?}`；成功返回 `{ok:true,state}` |
| `POST /api/actions` | `{id,at,action}`；202 返回 `{ok:true,operation}`，轮询状态确认结果；新增 `check-upstream`、`check-compat` |

操作请求五分钟内有效，先持久记录再执行；同一次操作的重试须复用 `id` 和 `at`，重复请求返回原结果，中断后不重放。配置保存须带当前 `revision`，不能在网络结果未知时盲目重试。错误统一返回 `{error:{code,message}}`；已落盘但运行策略未更新时另带 `saved:true`。API 使用面板专用 Bearer 密钥、精确 Host/Origin 检查和 JSON 请求体，推理端点仍拒绝网页来源。

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

- Kimi 从**本地运行时副本**加载适配代码：`subagents-launch` 为本次 Kimi 进程设置 `DAIMON_BUNDLE_DIR`，指向状态目录里的副本。`serve` 负责保存策略和转发请求，**不修改 Kimi 安装目录、`app.asar`、可执行文件或签名**。
- 只支持 **Kimi 3.2.21** 且内核源码哈希精确匹配的那一份；版本或哈希不符时 `subagents-prepare` 直接拒绝（退出码 9），不会尝试猜测。
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
node bin/kimi-work-gateway.mjs subagents-prepare

# 2. 查看策略与运行时状态（只读，不写文件）
node bin/kimi-work-gateway.mjs subagents-status

# 3. 完全退出 Kimi 后，用适配副本启动
node bin/kimi-work-gateway.mjs subagents-launch
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

- 这是**内部、非官方适配**，依赖 Work 内核的具体实现；Kimi 新版本会被直接拒绝。当前允许的规范化内核 SHA-256 为 `ea0a2ec58a26bd0365401e14251b33b7a547dd31bfd423f61699ac362026d1af`。
- 退出码：`0` 成功或“需先退出 Kimi”，`3` 失败或冲突（含策略文件损坏、作用域冲突、目标被阻止、来源不可用或心跳过期），`9` Kimi 版本或源码不受支持。
- `subagents-status` 只读，不会创建策略文件；`subagents-prepare`/`subagents-launch` 在策略文件缺失时会写入 `inherit`，已存在则保留并校验它属于当前 Kimi 作用域。跨作用域和坏策略会明确报告，不会覆盖。
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
node bin/kimi-work-gateway.mjs compat --config gateway.json
node bin/kimi-work-gateway.mjs compat --archive /path/to/app.asar --config gateway.json

# 只检查 5 个内置样例：
node bin/kimi-work-gateway.mjs compat
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
- 子代理控制是内部、非官方适配，仅支持 Kimi 3.2.21 的指定源哈希，其他版本直接拒绝；不能保证跨版本可用。
- **尚未在真实 Windows + Kimi + UAC 上做端到端验收。** Windows 专用用例会在临时文件上实际执行 PowerShell；macOS 无 PowerShell 时跳过这些用例，不能将其记为已通过。Windows 上的子代理控制同样尚未在真机验收，暂按“未验证”对待。
- 本轮原生回归使用真实 Work 内核与隔离数据，覆盖模型绑定、恢复和坏策略；没有重启正在使用的 Kimi。经 `subagents-launch` 启动完整桌面后再操作 Work 的整条链路仍待单独验收，不能以直接加载内核替代这项证据。

## 开发

```sh
bun test        # Bun 1.4.2 / 1.4.4；1.3.x 不在支持范围
bun run check   # 语法检查
bun scripts/verify-package.mjs  # 打包、解包并在包内重跑测试和检查
```

发布包包含 `test/`。测试使用合成凭证与临时文件，包含 Node CLI 的实际 HTTP 调用，以及无须安装 Kimi 的 20 组符号变化检查。安装了 Kimi 的 macOS 还会检查真实解析器；合成检查不保证未来版本兼容。CI 配置在 Ubuntu 上覆盖两个 Bun 版本，在 Windows 上执行专用脚本用例和包内自验；修改工作流后需要实际运行才能确认本次 Windows 结果。

子代理相关测试分两层：`test/cli.test.mjs` 与 `test/subagents.test.mjs` 用注入的替身覆盖策略与运行时契约，不启动 Kimi；`test/subagent-native.test.mjs` 在装有受支持 Kimi 的 macOS 上运行原生用例——在本机真实 Work 内核加本地 mock 上游上完成“父 A → 子 B → 父 A”、Chat 与 Responses 两种协议、effort 传递、配置重建、关闭恢复继承、fork 与 resume 拒绝，全程不产生付费调用。该原生用例在缺少受支持 Kimi 或 Node 版本不足时跳过，跳过不等于通过。

## 来源与许可证

MIT。与 Kimi、Moonshot 官方无隶属关系。部分实现源自 [`@magpie-community/agent-kimi-desktop`](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，版权声明保留在 [LICENSE](LICENSE)。Magpie 用户可直接使用基于本核心的 [`magpie-agent-kimi-work-byok`](https://github.com/wssz527/magpie-agent-kimi-work-byok) 插件，无需单独运行本网关。

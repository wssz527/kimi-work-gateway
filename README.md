# Kimi Work Gateway

让普通 **Kimi 桌面应用的 Work** 使用第三方模型：一个可在本机运行的 OpenAI 兼容网关，以及一个可嵌入其他程序的库。它不是 Kimi Code CLI，也不是把 Kimi 会员额度转给别的 Agent 的 Provider。

它依赖 Kimi 自带的**第三方模型网关**设置，不修改 Kimi 安装包、`app.asar`、可执行文件或签名，不开调试端口，不注入模型菜单。

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
    { "id": "kimi-k3.1-pro", "protocol": "chat", "contextWindow": 262144, "tools": true, "reasoning": true }
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
| `reasoningEfforts` | 否 | 例如 `["low","high"]` |
| `defaultEffort` | 否 | 必须包含在 `reasoningEfforts` 中 |

不声明 `tools` / `reasoning` 时按**不支持**处理，Kimi 不会给这些模型发工具请求。

## 命令

| 命令 | 作用 |
| --- | --- |
| `serve --config <file\|->` | 启动本地网关，直到 SIGINT / SIGTERM |
| `prepare` | 安装单域名解析（macOS resolver / Windows hosts），显示隐藏入口；需管理员授权 |
| `remove-dns` | 撤销上一项；只删除内容与本工具一致的文件或行 |
| `compat --config <file>` | 用已安装 Kimi 检查指定模型配置；省略配置只检查内置样例 |
| `status` | 打印网关状态文件与准备回执 |
| `copy-token` | 把本地网关 Token 复制到剪贴板 |

`serve` 不会申请管理员权限，也不会改 Kimi 自己的配置。状态文件包含进程与实例标识、URL、模型数量和 DNS 模式，不含 Key 或对话内容；退出时只清理仍归本实例所有的状态。

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
3. 停止 `serve`。

只删除内容仍与本工具配置一致的 `/etc/resolver/dev.msh.team`（macOS），或只删除带本工具标记的那两行（Windows），不删除别人的解析文件或条目，不改全局 DNS、代理、证书或防火墙。停止 `serve` 后 HTTP 监听消失，不安装常驻服务。

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
- 独立 CLI 的模型清单来自配置文件。增删模型或修改能力声明后，先修改 `models` 并重启 `serve`，再在 Kimi 重新导入；仅重新导入不会改变网关配置。
- 请求的端点必须与模型声明的协议一致，错误请求返回 `409 model_protocol_mismatch`，不会转发到上游。
- 首次接入需要管理员授权（macOS resolver / Windows hosts）。准备只有在操作完成且验证成功后才记为 `done`；裁决缺失会记为失败。
- Windows prepare 可使用已存在的手工同值条目，撤销时保留该条目；只删除标记与内容完整匹配的归属条目对。BOM、原换行和无末尾换行的内容保留；不支持的编码拒绝改写。
- 单域名解析只回答 `dev.msh.team`，指向合成地址 `10.255.255.254`，不代表接入真实公司内网。
- **尚未在真实 Windows + Kimi + UAC 上做端到端验收。** Windows 专用用例会在临时文件上实际执行 PowerShell；macOS 无 PowerShell 时跳过这些用例，不能将其记为已通过。

## 开发

```sh
bun test        # Bun 1.4.2 / 1.4.4；1.3.x 不在支持范围
bun run check   # 语法检查
bun scripts/verify-package.mjs  # 打包、解包并在包内重跑测试和检查
```

发布包包含 `test/`。测试使用合成凭证与临时文件，包含 Node CLI 的实际 HTTP 调用，以及无须安装 Kimi 的 20 组符号变化检查。安装了 Kimi 的 macOS 还会检查真实解析器；合成检查不保证未来版本兼容。CI 配置在 Ubuntu 上覆盖两个 Bun 版本，在 Windows 上执行专用脚本用例和包内自验；修改工作流后需要实际运行才能确认本次 Windows 结果。

## 来源与许可证

MIT。与 Kimi、Moonshot 官方无隶属关系。部分实现源自 [`@magpie-community/agent-kimi-desktop`](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，版权声明保留在 [LICENSE](LICENSE)。Magpie 用户可直接使用基于本核心的 [`magpie-agent-kimi-work-byok`](https://github.com/wssz527/magpie-agent-kimi-work-byok) 插件，无需单独运行本网关。

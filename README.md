# Kimi Work Gateway

让普通 **Kimi 桌面应用的 Work** 使用第三方模型：一个可在本机运行的 OpenAI 兼容网关，以及一个可嵌入其他程序的库。它不是 Kimi Code CLI，也不是把 Kimi 会员额度转给别的 Agent 的 Provider。

它依赖 Kimi 自带的**第三方模型网关**设置，不修改 Kimi 安装包、`app.asar`、可执行文件或签名，不开调试端口，不注入模型菜单。

**首版只声明 macOS。** Windows / Linux 尚未适配。

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

第一次接入还要做一次准备，它会请求 macOS 管理员授权，只写入 `/etc/resolver/dev.msh.team`：

```sh
node bin/kimi-work-gateway.mjs prepare
```

然后在 **Kimi 设置 → 其他 → 第三方模型网关** 里填：

- **Base URL**：`http://127.0.0.1:3426/v1`
- **Token**：`copy-token` 复制到剪贴板的那个值

点“测试连接并导入模型”，回到 Work，点输入框旁的模型名即可切换。

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
| `prepare` | 安装单域名 resolver，显示隐藏入口；需管理员授权 |
| `remove-dns` | 撤销 resolver；只删除内容与本工具一致的解析文件 |
| `status` | 打印网关状态文件与准备回执 |
| `copy-token` | 把本地网关 Token 复制到剪贴板 |

`serve` 不会申请管理员权限，也不会改 Kimi 自己的配置。状态文件只有 pid、URL、模型数量，不含任何 key 或对话内容。

## 断开

1. 先在 Kimi 自己的“第三方模型网关”设置里断开连接。
2. 运行 `remove-dns` 并完成授权。
3. 停止 `serve`。

只删除内容仍与本工具配置一致的 `/etc/resolver/dev.msh.team`，不删除别人的解析文件，不改全局 DNS、hosts、代理、证书或防火墙。停止 `serve` 后 HTTP 和 DNS 监听一并消失，不安装常驻服务。

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
- 推理前的模型目录校验以 `listModels()` 的返回为准；上游增删模型后需要重启或重新导入。
- 首次接入需要一次管理员授权，这是 Kimi 自身的内网检查决定的，不是本工具的选择偏好。
- 单域名 DNS 只回答 `dev.msh.team`，为合成地址 `10.255.255.254`，不代表接入真实公司内网。

## 开发

```sh
bun test        # Bun 1.4.2 / 1.4.4；1.3.x 的 HTTP 取消语义不同，不在支持范围
bun run check   # 语法检查
```

## 来源与许可证

MIT。与 Kimi、Moonshot 官方无隶属关系。部分实现源自 [`@magpie-community/agent-kimi-desktop`](https://github.com/magpie-community/plugins/tree/main/packages/kimi-desktop)，版权声明保留在 [LICENSE](LICENSE)。Magpie 用户可直接使用基于本核心的 [`magpie-agent-kimi-work-byok`](https://github.com/wssz527/magpie-agent-kimi-work-byok) 插件，无需单独运行本网关。

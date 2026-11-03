import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PanelError } from './panel-controller.mjs';

const UI = new URL('../ui/', import.meta.url);
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const MESSAGES = {
  unauthorized: '面板会话已失效，请从终端输出的链接重新打开。',
  origin_refused: '请求来源不匹配，请从本机面板链接操作。',
  configuration_conflict: '配置已经变更，请刷新后重新应用。',
  configuration_changed: '模型或连接配置已在外部修改，请重启面板后操作。',
  configuration_unavailable: '无法读取配置文件，请检查文件后重启面板。',
  subagent_policy_owner_conflict: '另一实例已接管子代理策略，请停止重复运行的服务。',
  subagent_policy_apply_failed: '选择已保存，但当前策略未能应用，请检查运行状态。',
  subagent_model_unavailable: '所选模型已不在当前目录中，请重新选择。',
  subagent_model_tools_required: '此模型不支持工具调用，无法用作子代理。',
  invalid_subagent_effort: '此模型不支持所选推理档位，请重新选择。',
  panel_action_busy: '上一次操作仍在执行，请等待结果。',
  panel_action_conflict: '操作标识已被使用，请刷新后重试。',
  panel_receipt_conflict: '操作记录有冲突，请检查状态目录。',
  invalid_models: '模型声明无效，请检查 ID、上下文、能力及思考档位。',
  protocol_conflict: '模型 ID 最后一段以 kimi- 开头时必须使用 Chat，其余必须使用 Responses。',
  invalid_base_url: '上游地址需使用 HTTPS（本机可用 HTTP），且不能包含凭证、查询参数或片段。',
  invalid_config: '配置无效，请检查端口和环境变量名称。',
  invalid_connection_config: '连接配置不完整或包含不支持的字段。凭证请保存在环境变量中。',
  subagent_model_in_use: '当前子代理仍使用此模型或思考档位，请先更改子代理目标，再修改模型能力。',
  configuration_apply_failed: '模型目录已保存，但运行策略未能更新，请检查状态后重启。',
  invalid_translation_config: '翻译设置无效，请检查服务、语言、显示方式和环境变量名。',
  invalid_translation_endpoint: '翻译端点需使用 HTTPS（本机可用 HTTP），且不能包含凭证或查询参数。',
  translation_endpoint_required: '请填写自定义翻译服务的完整 Chat Completions 地址。',
  translation_not_enabled: '请先保存并启用思考翻译，再从网关启动 Kimi。',
  translation_apply_failed: '翻译设置已保存，但会话尚未应用，请检查状态目录后重试。',
  translation_settings_conflict: '翻译设置已在别处被修改，请刷新状态后确认再保存。',
  invalid_connections: '连接列表无效：请检查 ID、名称、地址、环境变量名与协议。',
  invalid_discovery: '模型发现请求无效，请检查连接后重试。',
  connection_in_use: '仍有模型使用该连接，请先把这些模型改到其他连接或删除。',
  connection_unavailable: '连接不可用：该连接可能尚未保存，或需要重启面板后生效。',
  credentials_file_unavailable: '未使用凭据文件启动，无法保存连接密钥；请从 setup 或带 --credentials 的启动方式保存。',
  discovery_busy: '已有模型发现请求在执行，请等待结果。',
  discovery_timeout: '连接上游超时，未能读取模型列表。',
  discovery_unavailable: '无法连接上游，未能读取模型列表。',
  discovery_http_error: '上游拒绝了模型列表请求，请检查地址与密钥。',
  discovery_invalid_catalog: '上游返回的模型列表格式不被接受。',
  discovery_too_large: '上游模型列表过大，已停止读取。',
  invalid_model_search: '模型搜索请求无效：请选择供应商或连接，并填写关键词。',
  invalid_context_policy: '上下文策略无效：触发阈值必须是 0.50 到 0.99 之间的小数，预留必须是不小于 0 的整数。',
  context_policy_unavailable: '上下文策略接口不可用，无法写入原生配置。',
  invalid_tool_action: '工具操作无效：只支持添加、更新、移除与显式测试。',
  native_mcp_unavailable: '原生 MCP 接口不可用，无法执行该操作。',
  context_window_exceeds_limit: '上下文预算超过该模型的已知上限，不能保存。',
};

function authorized(actual, key) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from('Bearer ' + key);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new PanelError('json_required', 415);
  if (Number(req.headers['content-length']) > 32768) throw new PanelError('request_too_large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new PanelError('request_too_large', 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new PanelError('invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PanelError('invalid_json');
  return value;
}

export class GatewayPanel {
  constructor({ controller, uiDir = fileURLToPath(UI) } = {}) {
    this.controller = controller;
    this.uiDir = uiDir;
    this.key = crypto.randomBytes(32).toString('hex');
  }

  async start({ port = 3427 } = {}) {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || this.server) throw Error('invalid_panel_port');
    this.assets = new Map(Object.entries(FILES).map(([route, [name, type]]) => [route,
      { content: fs.readFileSync(path.join(this.uiDir, name)), type: type + '; charset=utf-8' }]));
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    } catch { server.close(); throw Error('panel_port_unavailable'); }
    this.server = server;
    this.host = '127.0.0.1:' + server.address().port;
    this.url = 'http://' + this.host;
    this.entryURL = this.url + '/#key=' + this.key;
    return this.entryURL;
  }

  async handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== this.host) throw new PanelError('origin_refused', 403);
      if (req.headers.origin && req.headers.origin !== this.url
        || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
        throw new PanelError('origin_refused', 403);
      }
      const asset = this.assets.get(req.url);
      if (asset && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(req.method === 'HEAD' ? undefined : asset.content); return;
      }
      if (!['/api/state', '/api/subagents', '/api/actions', '/api/models', '/api/connection', '/api/connections',
        '/api/discovery', '/api/translation', '/api/providers', '/api/model-search', '/api/context',
        '/api/tools'].includes(req.url)) throw new PanelError('not_found', 404);
      if (!authorized(req.headers.authorization, this.key)) throw new PanelError('unauthorized', 401);
      if (req.method === 'GET' && req.url === '/api/state') { json(200, await this.controller.state()); return; }
      if (req.method === 'GET' && req.url === '/api/providers') { json(200, this.controller.providers()); return; }
      if (req.method === 'GET' && req.url === '/api/tools') {
        // A read launches nothing, but it is answered from a real listing so the
        // panel's card is truthful on first load.
        json(200, await this.controller.refreshTools());
        return;
      }
      if (req.method !== 'POST' || req.url === '/api/state') throw new PanelError('method_not_allowed', 405);
      if (req.headers.origin !== this.url) throw new PanelError('origin_refused', 403);
      const input = await readBody(req);
      if (req.url === '/api/subagents') json(200, { ok: true, state: await this.controller.apply(input) });
      else if (req.url === '/api/models') json(200, { ok: true, state: await this.controller.saveModels(input) });
      else if (req.url === '/api/connection') json(200, { ok: true, state: await this.controller.saveConnection(input) });
      else if (req.url === '/api/connections') json(200, { ok: true, state: await this.controller.saveConnections(input) });
      else if (req.url === '/api/discovery') json(200, { ok: true, discovery: await this.controller.discover(input) });
      else if (req.url === '/api/translation') json(200, { ok: true, state: await this.controller.saveTranslation(input) });
      else if (req.url === '/api/model-search') json(200, { ok: true, ...await this.controller.modelSearch(input) });
      else if (req.url === '/api/tools') json(200, { ok: true, ...await this.controller.tools(input) });
      else if (req.url === '/api/context') json(200, { ok: true, ...await this.controller.saveContext(input) });
      else json(202, { ok: true, operation: await this.controller.action(input) });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const code = /^[a-z][a-z0-9_-]{0,100}$/.test(error?.message) ? error.message : 'panel_request_failed';
      json(error.status || (code.startsWith('invalid_') || code.startsWith('subagent_model_')
        || code === 'protocol_conflict' || code === 'context_window_exceeds_limit' ? 400 : 503),
        { error: { code, message: MESSAGES[code] || '操作未完成，请检查当前状态后重试。', ...(error.details || {}) } });
    }
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

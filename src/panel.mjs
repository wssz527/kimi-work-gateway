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
      if (!['/api/state', '/api/subagents', '/api/actions', '/api/models', '/api/connection'].includes(req.url)) throw new PanelError('not_found', 404);
      if (!authorized(req.headers.authorization, this.key)) throw new PanelError('unauthorized', 401);
      if (req.method === 'GET' && req.url === '/api/state') { json(200, await this.controller.state()); return; }
      if (req.method !== 'POST' || req.url === '/api/state') throw new PanelError('method_not_allowed', 405);
      if (req.headers.origin !== this.url) throw new PanelError('origin_refused', 403);
      const input = await readBody(req);
      if (req.url === '/api/subagents') json(200, { ok: true, state: await this.controller.apply(input) });
      else if (req.url === '/api/models') json(200, { ok: true, state: await this.controller.saveModels(input) });
      else if (req.url === '/api/connection') json(200, { ok: true, state: await this.controller.saveConnection(input) });
      else json(202, { ok: true, operation: await this.controller.action(input) });
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const code = /^[a-z][a-z0-9_-]{0,100}$/.test(error?.message) ? error.message : 'panel_request_failed';
      json(error.status || (code.startsWith('invalid_') || code.startsWith('subagent_model_') || code === 'protocol_conflict' ? 400 : 503),
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

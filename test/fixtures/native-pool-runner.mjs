import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { findSubagentInstallation } from '../../src/subagent-runtime.mjs';
import { KimiWorkGateway } from '../../src/gateway.mjs';
import { NativeSubagentBridge } from '../../src/native-subagent-bridge.mjs';
import { normalizeSubagentPolicy } from '../../src/subagent-policy.mjs';

const root = process.argv[2];
const installation = findSubagentInstallation();
const dist = path.join(installation.bundleDir, 'app/daimon/dist');
const kernel = await import(pathToFileURL(path.join(dist, 'kimi-code-v2/kernel-bundle.mjs')));
const internal = path.join(dist, '_internal');
async function withExport(name) {
  const candidates = fs.readdirSync(internal).filter(name => name.endsWith('.js'));
  const marker = name === 'createDaimonKimiCodeV2KernelRuntimeForBundle' ? /DaimonKimiCodeV2KernelRuntime\s*=\s*class/
    : new RegExp('export\\s*\\{[^}]*\\b' + name + '\\b');
  const matches = candidates.filter(file => marker.test(fs.readFileSync(path.join(internal, file), 'utf8')));
  if (matches.length !== 1) throw Error('native_pool_export_ambiguous:' + name);
  return import(pathToFileURL(path.join(internal, matches[0])));
}
const configModule = await withExport('syncDaimonKimiCodePrivateConfig');
const adapter = await withExport('createDaimonKimiCodeV2KernelRuntimeForBundle');
const kimiDir = path.join(root, 'kimi');
const homeDir = path.join(kimiDir, 'runtime/kimi-code/home');
const configPath = path.join(homeDir, 'config.toml');
const models = ['parent', 'child', 'responses'].map(name => ({ id: 'lab/' + (name === 'responses' ? 'child-responses' : 'kimi-' + name), name, protocol: name === 'responses' ? 'responses' : 'chat', contextWindow: 64000, maxOutputTokens: 2048, tools: true }));
const aliases = models.map(row => (row.protocol === 'responses' ? 'byok-kth-resp/' : 'byok-kth-kimi/') + row.id);
const requests = [], events = [];
let phase = 'baseline', childChoice = aliases[1], runtime, client;
const bridge = new NativeSubagentBridge({ stateDir: path.join(root, 'state'), kimiDir });
const gateway = new KimiWorkGateway({ backend: { listModels: async () => models,
  request: async (protocol, body) => {
    const agent = body.tools?.find(tool => (tool.function || tool).name === 'Agent');
    const definition = agent?.function || agent;
    const rootIndex = body.messages?.findLastIndex(message => message.role === 'user' && message.content === 'ROOT_LAB') ?? -1;
    const rootRequest = rootIndex >= 0;
    requests.push({ phase, protocol, model: body.model, rootRequest, poolVisible: Boolean(definition?.parameters?.properties?.model) });
    const called = body.messages?.slice(rootIndex + 1).some(message => message.role === 'tool');
    const spawn = phase !== 'baseline' && rootRequest && !called;
    const headers = { 'Content-Type': 'text/event-stream' };
    if (protocol === 'responses') {
      const item = { type: 'message', id: 'msg_child', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CHILD_OK', annotations: [] }] };
      const response = { id: 'resp_child', object: 'response', created_at: 1, status: 'completed', model: body.model,
        output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
      const values = [
        { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'CHILD_OK' },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'CHILD_OK' },
        { type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] },
        { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response },
      ];
      return new Response(values.map(value => 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n').join(''), { headers });
    }
    const delta = spawn ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_pool_' + phase, type: 'function', function: {
      name: 'Agent', arguments: JSON.stringify({ subagent_type: 'coder', description: 'Check native pool', prompt: 'CHILD_LAB: Return CHILD_OK', ...(childChoice ? { model: childChoice } : {}), run_in_background: false }),
    } }] } : { role: 'assistant', content: rootRequest ? 'PARENT_OK' : 'CHILD_OK' };
    const chunk = { id: 'chat_pool', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: spawn ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
    return new Response('data: ' + JSON.stringify(chunk) + '\n\ndata: ' + JSON.stringify(end) + '\n\ndata: [DONE]\n\n', { headers });
  } } });
gateway.beforeRequest = (protocol, body) => bridge.beforeRequest(protocol, body);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('non_loopback_request_blocked');
  return originalFetch(input, init);
};
try {
  await gateway.configure({ key: 'synthetic-pool-key', port: 0 });
  const daimonConfig = { credentials: { kimiCode: {}, kimiClaw: {}, pixelLab: {} }, kimiCode: { kimiRequestHeaders: {} },
    model: { current: aliases[0], providers: { lab: { type: 'openai', baseUrl: gateway.url, apiKey: 'synthetic-pool-key' } },
      models: Object.fromEntries(models.map((row, index) => [aliases[index], { provider: row.protocol === 'responses' ? 'responses' : 'lab', model: row.id, maxContextSize: row.contextWindow, maxOutputSize: row.maxOutputTokens, capabilities: ['tool_use'] }])) } };
  daimonConfig.model.providers.responses = { type: 'openai_responses', baseUrl: gateway.url, apiKey: 'synthetic-pool-key' };
  const sync = () => configModule.syncDaimonKimiCodePrivateConfig({ daimonConfig, env: {}, skillsRoot: path.join(root, 'skills'), kimiCodeConfigPath: path.join(root, 'generated/config.toml'), kimiCodeHomeDir: homeDir });
  await sync(); fs.mkdirSync(path.join(root, 'workspace'));
  runtime = await adapter.createDaimonKimiCodeV2KernelRuntimeForBundle({ bundleModule: kernel, homeDir, configPath, shareDir: path.join(root, 'share'), identity: { productName: 'native-pool-test', version: installation.version, platform: 'kimi-work' } });
  client = runtime.requireClient();
  let finish, activeSession;
  client.onEvent(event => { events.push({ type: event.type, agentId: event.agentId, ...(event.type === 'turn.step.retrying' ? { detail: event } : {}) }); if (event.type === 'turn.ended' && event.agentId === 'main' && event.sessionId === activeSession) finish?.(event); });
  async function run() {
    const session = await client.createSession({ workDir: path.join(root, 'workspace'), model: aliases[0], thinking: 'off' });
    activeSession = session.id; let timer;
    const done = new Promise((resolve, reject) => { finish = resolve; timer = setTimeout(() => reject(Error('native_pool_timeout')), 25000); });
    try { await client.prompt({ sessionId: session.id, input: 'ROOT_LAB' }); assert.equal((await done).reason, 'completed'); }
    finally { clearTimeout(timer); finish = undefined; }
  }
  await run(); assert.equal(requests.at(-1).poolVisible, false);
  const policy = normalizeSubagentPolicy({ mode: 'pool', model: models[1].id, models: models.map(row => ({ id: row.id, description: 'Synthetic ' + row.name })) }, models);
  assert.equal(bridge.update(policy).state, 'file-applied');
  for (const [name, choice, expected] of [['pool', aliases[1], 1], ['responses', aliases[2], 2], ['default', undefined, 1], ['primary', 'primary', 0]]) {
    phase = name; childChoice = choice; await run();
    assert.ok(requests.some(row => row.phase === name && !row.rootRequest && row.model === models[expected].id), name + '_child_missing');
    if (name === 'responses') assert.ok(requests.some(row => row.phase === name && row.protocol === 'responses'));
  }
  assert.equal(bridge.inspect().observed.state, 'observed-schema');
  await sync(); phase = 'rebuilt'; childChoice = aliases[1]; await run(); assert.ok(requests.some(row => row.phase === 'rebuilt' && row.model === models[1].id));
  const restored = bridge.update({ mode: 'inherit', transport: 'native-config' });
  assert.ok(['restored', 'inherit'].includes(restored.state));
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('[secondary_model]'), false);
  console.log(JSON.stringify({ ok: true, unmodifiedKernel: true, unmodifiedWorkAdapter: true, requests, subagentsCompleted: events.filter(row => row.type === 'subagent.completed').length }));
} catch (error) {
  console.error(JSON.stringify({ phase, requests, events: events.slice(-20) }));
  throw error;
} finally {
  globalThis.fetch = originalFetch;
  await runtime?.shutdown?.(); await client?.dispose?.(); bridge.close(); await gateway.stop();
}

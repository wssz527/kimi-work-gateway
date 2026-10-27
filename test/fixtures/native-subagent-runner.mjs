import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { SubagentPolicy, SubagentRuntime, KimiWorkGateway, OpenAIBackend } from '../../src/index.mjs';

const root = path.resolve(process.argv[2]);
const models = [
  { id: 'lab/kimi-parent', protocol: 'chat', contextWindow: 128000, maxOutputTokens: 4096, tools: true },
  { id: 'lab/kimi-child', protocol: 'chat', contextWindow: 64000, maxOutputTokens: 2048, tools: true },
  { id: 'lab/child-responses', protocol: 'responses', contextWindow: 32000, maxOutputTokens: 1024,
    tools: true, reasoning: true, reasoningEfforts: ['low', 'high'], defaultEffort: 'low' },
];
const seen = [], events = [], blocked = [];
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    blocked.push(url.origin);
    throw Error('non_loopback_request_blocked');
  }
  return fetchOriginal(input, init);
};
let scenario = 'normal';
let savedAgent;
const upstream = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text);
  const lastRoot = body.messages?.findLastIndex(message => message.role === 'user' && message.content === 'ROOT_LAB') ?? -1;
  const rootRequest = lastRoot >= 0;
  const toolMessages = body.messages?.slice(lastRoot + 1).filter(message => message.role === 'tool').map(message => message.content) || [];
  const spawn = rootRequest && !toolMessages.length;
  seen.push({ url: req.url, model: body.model, rootRequest: Boolean(rootRequest), spawn: Boolean(spawn), toolMessages,
    reasoning: body.reasoning, maxTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
  if (req.url.endsWith('/responses')) {
    const item = { type: 'message', id: 'msg_child', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'CHILD_OK', annotations: [] }] };
    const response = { id: 'resp_child', object: 'response', created_at: 1, status: 'completed', model: body.model,
      output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } };
    const send = value => res.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
    send({ type: 'response.created', response: { ...response, output: [], status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    send({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'CHILD_OK' });
    send({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'CHILD_OK' });
    send({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response });
    res.end();
    return;
  }
  const args = scenario === 'resume' ? { resume: savedAgent, description: 'Resume lab child', prompt: 'CHILD_LAB', run_in_background: false }
    : { description: 'Native model test', prompt: 'CHILD_LAB: return CHILD_OK', subagent_type: 'coder', run_in_background: false,
      ...(scenario === 'fork' ? { fork: true, subagent_type: undefined } : {}) };
  const call = { id: 'call_lab_child', type: 'function', function: { name: 'Agent', arguments: JSON.stringify(args) } };
  const chunk = delta => ({ id: 'chat_lab', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta, finish_reason: null }] });
  res.write('data: ' + JSON.stringify(chunk(spawn ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] }
    : { role: 'assistant', content: rootRequest ? 'PARENT_OK' : 'CHILD_OK' })) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: spawn ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const gateway = new KimiWorkGateway({ backend: new OpenAIBackend({ baseURL: 'http://127.0.0.1:' + upstream.address().port + '/v1',
  apiKey: 'synthetic-upstream-key', models }) });
let client;
try {
  const url = await gateway.configure({ key: 'synthetic-work-token', port: 0 });
  const stateDir = path.join(root, 'state'), kimiDir = path.join(root, 'kimi');
  const policy = new SubagentPolicy({ stateDir, kimiDir });
  policy.configure(undefined, models);
  const runtimeManager = new SubagentRuntime({ stateDir, ...(process.env.KIMI_WORK_TEST_ARCHIVE ? { archive: process.env.KIMI_WORK_TEST_ARCHIVE } : {}) });
  const prepared = runtimeManager.prepare();
  assert.equal(prepared.state, 'prepared');
  const kernelPath = path.join(prepared.bundleDir, 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs');
  const internal = path.join(prepared.bundleDir, 'app/daimon/dist/_internal');
  const adapterFiles = fs.readdirSync(internal).filter(name => name.endsWith('.js')
    && /DaimonKimiCodeV2KernelRuntime\s*=\s*class/.test(fs.readFileSync(path.join(internal, name), 'utf8')));
  assert.equal(adapterFiles.length, 1);
  const kernel = await import(pathToFileURL(kernelPath));
  const { createDaimonKimiCodeV2KernelRuntimeForBundle } = await import(pathToFileURL(path.join(internal, adapterFiles[0])));
  const homeDir = policy.homeDir, workDir = path.join(root, 'workspace'), configPath = path.join(homeDir, 'config.toml');
  fs.mkdirSync(homeDir, { recursive: true }); fs.mkdirSync(workDir);
  const config = `default_model = "parent"
[providers.chat]
type = "openai"
base_url = "${url}"
api_key = "synthetic-work-token"
[providers.responses]
type = "openai_responses"
base_url = "${url}"
api_key = "synthetic-work-token"
[models.parent]
provider = "chat"
model = "lab/kimi-parent"
max_context_size = 128000
max_output_size = 4096
capabilities = ["tool_use"]
[models."byok-kth-kimi/lab/kimi-child"]
provider = "chat"
model = "lab/kimi-child"
max_context_size = 64000
max_output_size = 2048
capabilities = ["tool_use"]
[models."byok-kth-resp/lab/child-responses"]
provider = "responses"
model = "lab/child-responses"
max_context_size = 32000
max_output_size = 1024
capabilities = ["tool_use", "thinking"]
support_efforts = ["low", "high"]
default_effort = "low"
[thinking]
enabled = false
[experimental]
subagent_fork = true
[loop_control]
max_steps_per_turn = 8
`;
  fs.writeFileSync(configPath, config);
  const runtime = await createDaimonKimiCodeV2KernelRuntimeForBundle({ bundleModule: kernel, homeDir, configPath,
    shareDir: path.join(root, 'share'), identity: { productName: 'kimi-work-lab', version: '3.2.21', platform: 'kimi-work' } });
  client = runtime.requireClient();
  let finish, activeSession;
  client.onEvent(event => {
    events.push(event);
    if (event.type === 'subagent.spawned') savedAgent = event.subagentId;
    if (event.type === 'turn.ended' && event.agentId === 'main' && event.sessionId === activeSession) finish?.(event);
  });
  const results = [];
  async function run(name, desired, expected, reuse, beforeCreate) {
    if (beforeCreate) beforeCreate();
    else policy.configure(desired, models);
    fs.writeFileSync(configPath, config);
    const session = reuse || await client.createSession({ workDir, model: 'parent', thinking: 'off' });
    if (!reuse) await client.reloadSession({ sessionId: session.id });
    activeSession = session.id;
    const start = seen.length, eventStart = events.length;
    let timeout;
    const completed = new Promise((resolve, reject) => { finish = resolve; timeout = setTimeout(() => reject(Error('native_turn_timeout')), 20000); });
    try {
      await client.prompt({ sessionId: session.id, input: 'ROOT_LAB' });
      const terminal = await completed;
      const requests = seen.slice(start), turnEvents = events.slice(eventStart);
      assert.equal(terminal.reason, 'completed');
      assert.deepEqual(requests.map(row => row.model), expected);
      results.push({ name, requests, subagents: turnEvents.filter(event => event.type.startsWith('subagent.')).map(({ type, model }) => ({ type, model })) });
      return { session, turnEvents, requests };
    } finally { clearTimeout(timeout); finish = undefined; }
  }
  const forced = await run('forced-chat', { mode: 'force', model: models[1].id }, [models[0].id, models[1].id, models[0].id]);
  assert.ok(forced.turnEvents.some(event => event.type === 'subagent.completed'));
  scenario = 'resume';
  await run('resume-matching-model', { mode: 'force', model: models[1].id }, [models[0].id, models[1].id, models[0].id], forced.session);
  scenario = 'normal';
  await run('private-config-rebuilt', { mode: 'force', model: models[1].id }, [models[0].id, models[1].id, models[0].id]);
  const responses = await run('forced-responses', { mode: 'force', model: models[2].id }, [models[0].id, models[2].id, models[0].id]);
  assert.equal(responses.requests[1].url, '/v1/responses');
  assert.equal(responses.requests[1].reasoning.effort, 'low');
  assert.equal(responses.requests[1].maxTokens, 1024);
  await run('inherit', undefined, [models[0].id, models[0].id, models[0].id]);
  assert.equal(runtimeManager.inspect({ runnerPid: process.pid }).state, 'loaded');
  policy.configure({ mode: 'force', model: models[1].id }, models);
  assert.equal(runtimeManager.inspect({ runnerPid: process.pid }).state, 'pending-policy');
  scenario = 'fork';
  const fork = await run('fork-conflict', { mode: 'force', model: models[1].id }, [models[0].id, models[0].id]);
  assert.ok(JSON.stringify(fork.requests).includes('subagent_policy_fork_conflict'));
  scenario = 'normal';
  const inherited = await run('prepare-resume', undefined, [models[0].id, models[0].id, models[0].id]);
  scenario = 'resume';
  const resumed = await run('resume-conflict', { mode: 'force', model: models[1].id }, [models[0].id, models[0].id], inherited.session);
  assert.ok(JSON.stringify(resumed.requests).includes('subagent_policy_resume_conflict'));
  scenario = 'normal';
  const revoked = await run('blocked-at-session-creation', undefined, [models[0].id, models[0].id], undefined, () => {
    assert.throws(() => policy.configure({ mode: 'force', model: models[1].id }, [models[0]]), /subagent_model_unavailable/);
  });
  assert.ok(JSON.stringify(revoked.requests).includes('subagent_model_unavailable'));
  assert.deepEqual(revoked.turnEvents.filter(event => event.type.startsWith('subagent.')), []);
  assert.equal(runtimeManager.inspect({ runnerPid: process.pid }).mode, 'blocked');
  const missing = await run('missing-policy-at-session-creation', undefined, [models[0].id, models[0].id], undefined,
    () => fs.unlinkSync(policy.file));
  assert.ok(JSON.stringify(missing.requests).includes('subagent_policy_unavailable'));
  assert.equal(runtimeManager.inspect({ runnerPid: process.pid }).state, 'policy-unavailable');
  const malformed = await run('malformed-policy-at-session-creation', undefined, [models[0].id, models[0].id], undefined,
    () => fs.writeFileSync(policy.file, '{broken'));
  assert.ok(JSON.stringify(malformed.requests).includes('subagent_policy_unavailable'));
  fs.unlinkSync(policy.file);
  await run('after-policy-repair', undefined, [models[0].id, models[0].id, models[0].id]);
  policy.close();
  const receiptText = fs.readFileSync(runtimeManager.receiptPath, 'utf8');
  fs.writeFileSync(runtimeManager.receiptPath, JSON.stringify({ ...JSON.parse(receiptText), at: Date.now() - 60000 }));
  assert.equal(runtimeManager.inspect({ runnerPid: process.pid }).state, 'heartbeat-stale');
  fs.writeFileSync(runtimeManager.receiptPath, receiptText);
  const installation = runtimeManager.installation;
  runtimeManager.installation = () => { throw Error('subagent_kimi_unavailable'); };
  assert.deepEqual(runtimeManager.inspect(), { state: 'unavailable', reason: 'subagent_kimi_unavailable' });
  runtimeManager.installation = installation;
  assert.equal(kernel.createKernelClient instanceof Function, true);
  assert.equal(blocked.length, 0);
  console.log(JSON.stringify({ ok: true, prepared, results, blocked }));
} finally {
  await client?.close();
  await gateway.stop();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
}

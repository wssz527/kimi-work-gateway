import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectNativeSubagentContract, NativeSubagentBridge } from '../src/native-subagent-bridge.mjs';
import { NativeSubagentConfig, NATIVE_SUBAGENT_BEGIN, NATIVE_SUBAGENT_END,
  NATIVE_SUBAGENT_RECEIPT } from '../src/native-subagent-config.mjs';

// These kernels are synthetic: each is the smallest source that still has the
// structure the probe reads — a `"secondaryModel"` domain, a schema literal
// naming `defaultModel` and `models`, and a `registerConfigSection` call. The
// surrounding code is what the gateway already requires (a config watcher and
// the selection markers), so a kernel here only differs by the two behaviours
// the probe reports.
const KERNEL = 'app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';

function kernelSource({ forceKey = false, countGate = false, registerArgs = 3, poolEntry = true,
  reload = true, selection = true } = {}) {
  const schema = ['defaultModel: string().min(1).optional(),',
    'models: ' + (poolEntry ? 'record(string(), string())' : 'array(string())') + '.optional(),',
    ...(forceKey ? ['force: boolean().optional(),'] : []),
    'model: string().min(1).optional(),', 'defaultEffort: string().optional()'];
  const registration = 'registerConfigSection(SECONDARY_MODEL_SECTION, SecondaryModelConfigSchema'
    + (registerArgs >= 3 ? ', { collectDiagnostics: (section) => [] }' : '') + ');';
  return [
    'const SECONDARY_MODEL_SECTION = "secondaryModel";',
    'const SecondaryModelConfigSchema = object({', ...schema.map(line => '\t' + line), '});',
    registration,
    'function resolveSubagentModelPool(config) {',
    '\tconst section = config.get(SECONDARY_MODEL_SECTION);',
    '\tif (section?.models !== void 0) return { defaultModel: section.defaultModel, models: section.models };',
    '\tif (section?.defaultModel !== void 0) return { defaultModel: section.defaultModel, models: { [section.defaultModel]: "" } };',
    '}',
    'function exposesSubagentModelChoice(config) {',
    '\tconst pool = resolveSubagentModelPool(config);',
    countGate ? '\treturn pool !== void 0 && Object.keys(pool.models).length > 1;'
      : '\treturn pool !== void 0;',
    '}',
    reload ? 'watchCandidates(homeDir, [configFile]);' : '',
    reload ? 'this.watchDebounce.cancelAndSet(() => { this.reload(); }, 0);' : '',
    selection ? 'const hint = "Pool entries don\'t inherit your thinking level.";' : '',
    selection ? 'const sources = ["primary_override", "secondary_pool"];' : '',
  ].filter(Boolean).join('\n') + '\n';
}

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function installation(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-capability-'));
  roots.push(root);
  const bundleDir = path.join(root, 'bundle');
  const kernel = path.join(bundleDir, KERNEL);
  fs.mkdirSync(path.dirname(kernel), { recursive: true });
  fs.writeFileSync(kernel, source);
  const archive = path.join(root, 'app.asar');
  fs.writeFileSync(archive, 'fixture');
  return { archive, bundleDir, version: '9.9.9-synthetic' };
}

const inspect = options => inspectNativeSubagentContract(installation(kernelSource(options)));

describe('contract probe', () => {
  test('a three-argument registration is read by structure, not by its exact text', () => {
    const result = inspect({ registerArgs: 3, countGate: true });
    expect(result.state).toBe('source-compatible');
    expect(result.checks).toEqual({ section: true, pool: true, reload: true, selection: true });
    expect(result.capabilities).toEqual({ forceKeySupported: false, singlePoolModelChoice: false });
  });

  test('a two-argument registration on the older schema keeps the force key and the single-member choice', () => {
    const result = inspect({ registerArgs: 2, forceKey: true, countGate: false });
    expect(result.state).toBe('source-compatible');
    expect(result.capabilities).toEqual({ forceKeySupported: true, singlePoolModelChoice: true });
  });

  test('reformatting, whitespace and identifier renames do not change the verdict', () => {
    const renamed = kernelSource({ registerArgs: 3 })
      .replaceAll('SECONDARY_MODEL_SECTION', 'A_DIFFERENT_DOMAIN_CONSTANT')
      .replaceAll('SecondaryModelConfigSchema', 'AnotherSchemaName')
      .replaceAll('resolveSubagentModelPool', 'locatePool')
      .replace(/\n/g, '\r\n')
      .replace(/,\n/g, ',\n\n\t')
      .replace('registerConfigSection(', 'registerConfigSection (\n\t');
    expect(inspectSource(renamed)).toEqual(inspectSource(kernelSource({ registerArgs: 3 })));
  });

  test('a trailing comma in the schema does not change capabilities', () => {
    const source = kernelSource({ registerArgs: 3, countGate: true });
    expect(inspectSource(source.replace('defaultEffort: string().optional()', 'defaultEffort: string().optional(),')))
      .toEqual(inspectSource(source));
  });

  test('a version number in the source proves nothing either way', () => {
    const versioned = kernelSource({ registerArgs: 3, forceKey: true }) + 'const build = "3.2.21";\n';
    expect(inspectSource(versioned).capabilities).toEqual({ forceKeySupported: true, singlePoolModelChoice: true });
  });

  test('a missing pool entry or a missing reload marker stays unverified', () => {
    for (const options of [{ poolEntry: false }, { reload: false }, { selection: false }]) {
      const result = inspect({ registerArgs: 3, ...options });
      expect(result.state).toBe('unverified');
      expect(result.reason).toBe('subagent_native_contract_unverified');
      expect(result.capabilities).toBeDefined();
    }
  });

  test('a schema literal without the section shape is unverified and carries no capabilities', () => {
    const source = kernelSource({ registerArgs: 3 }).replace('defaultModel: string().min(1).optional(),', '');
    const result = inspectSource(source);
    expect(result.state).toBe('unverified');
    expect(result.checks.section).toBe(false);
    expect(result.capabilities).toBeUndefined();
  });

  test('a bundle that cannot be read is unavailable, not a capability claim', () => {
    const result = inspectNativeSubagentContract({ archive: '/nonexistent/app.asar' });
    expect(result.state).toBe('unverified');
    expect(result.capabilities).toBeUndefined();
  });
});

function inspectSource(source) {
  const { state, checks, capabilities, reason } = inspectNativeSubagentContract(installation(source));
  return { state, checks, capabilities, reason };
}

// --- config writes ---------------------------------------------------------

const CONFIG = `default_model = "parent"

[models."byok-kth-kimi/lab/kimi-child"]
provider = "chat"
model = "lab/kimi-child"
capabilities = ["tool_use"]

[models."byok-kth-resp/lab/child-responses"]
provider = "responses"
model = "lab/child-responses"
capabilities = ["tool_use", "thinking"]

[thinking]
enabled = false
`;
const CHILD = 'byok-kth-kimi/lab/kimi-child';
const RESPONSES = 'byok-kth-resp/lab/child-responses';
const pinned = (effort) => ({ mode: 'force', modelAlias: RESPONSES, ...(effort === undefined ? {} : { effort }) });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-capability-config-'));
  roots.push(root);
  const stateDir = path.join(root, 'state'), kimiDir = path.join(root, 'kimi');
  const homeDir = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const configPath = path.join(homeDir, 'config.toml');
  fs.writeFileSync(configPath, CONFIG);
  return { root, stateDir, kimiDir, configPath, instance: new NativeSubagentConfig({ stateDir, kimiDir }),
    read: () => fs.readFileSync(configPath, 'utf8') };
}

describe('capability-aware config', () => {
  test('without capabilities the pinned block keeps the historical force key', () => {
    const { instance, read } = setup();
    expect(instance.update(pinned('high'))).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
    expect(read()).toContain('[secondary_model]\nforce = true\ndefault_model = "' + RESPONSES + '"\ndefault_effort = "high"\n');
    expect(Bun.TOML.parse(read()).secondary_model).toEqual({ force: true, default_model: RESPONSES, default_effort: 'high' });
  });

  test('a kernel without the force key pins with a lone default model and keeps the effort', () => {
    const { instance, read } = setup();
    const capabilities = { forceKeySupported: false, singlePoolModelChoice: false };
    expect(instance.update(pinned('high'), capabilities).state).toBe('file-applied');
    expect(read()).toContain('[secondary_model]\ndefault_model = "' + RESPONSES + '"\ndefault_effort = "high"\n'
      + NATIVE_SUBAGENT_END);
    expect(read()).not.toContain('force');
    const parsed = Bun.TOML.parse(read()).secondary_model;
    expect(parsed).toEqual({ default_model: RESPONSES, default_effort: 'high' });
    // The kernel reads the same policy back from the block this instance wrote.
    expect(instance.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
  });

  test('a pinned block is rewritten when the kernel gains or loses the force key', () => {
    const { instance, read } = setup();
    const modern = { forceKeySupported: false, singlePoolModelChoice: false };
    const legacy = { forceKeySupported: true, singlePoolModelChoice: true };
    instance.update(pinned(), legacy);
    expect(read()).toContain('force = true');
    instance.update(pinned(), modern);
    expect(read()).not.toContain('force = true');
    expect(instance.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
    instance.update(pinned(), legacy);
    expect(read()).toContain('force = true');
    expect(instance.close().state).toBe('restored');
    expect(read()).toBe(CONFIG);
  });

  test('a pool block is identical under either capability set', () => {
    const rows = [{ modelAlias: CHILD, description: 'Implementation' },
      { modelAlias: RESPONSES, description: 'Review' }];
    const policy = { mode: 'pool', modelAlias: RESPONSES, models: rows };
    for (const capabilities of [undefined, { forceKeySupported: false, singlePoolModelChoice: false },
      { forceKeySupported: true, singlePoolModelChoice: true }]) {
      const { instance, read } = setup();
      expect(instance.update(policy, capabilities).state).toBe('file-applied');
      expect(read()).toContain('[secondary_model.models]');
      expect(read()).not.toContain('force = true');
    }
  });

  test('a pinned block written without force still restores exact bytes', () => {
    const { instance, read, stateDir } = setup();
    instance.update(pinned('low'), { forceKeySupported: false });
    expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(true);
    expect(instance.update({ mode: 'inherit' })).toEqual({ state: 'inherit', transport: 'native-config', mode: 'inherit' });
    expect(read()).toBe(CONFIG);
    expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(false);
  });

  test('a block a newer kernel wrote without force is adopted, not treated as edited', () => {
    const { instance, read, stateDir } = setup();
    instance.update(pinned(), { forceKeySupported: false });
    fs.rmSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT));
    const restarted = new NativeSubagentConfig({ stateDir: instance.stateDir, kimiDir: instance.kimiDir });
    expect(restarted.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
    expect(restarted.update(pinned(), { forceKeySupported: false }).state).toBe('file-applied');
    expect(read()).toContain(NATIVE_SUBAGENT_BEGIN);
    expect(restarted.close().state).toBe('restored');
    expect(read()).toBe(CONFIG);
  });
});

// --- bridge ----------------------------------------------------------------

const poolOf = aliases => ({ mode: 'pool', transport: 'native-config', modelAlias: aliases[0],
  models: aliases.map(alias => ({ modelAlias: alias, description: 'Description of ' + alias })) });

function bridgeFixture(compatibility) {
  const calls = [];
  const bridge = new NativeSubagentBridge({
    config: { update(value, capabilities) {
      calls.push({ value, capabilities });
      return { state: value.mode === 'pool' || value.mode === 'force' ? 'file-applied' : 'inherit', transport: 'native-config' };
    }, close() { return { state: 'restored' }; } },
    inspectContract: () => compatibility });
  return { bridge, calls };
}

const agentTool = (aliases) => ({ name: 'Agent', description: 'Available models (pass via model): '
  + aliases.map((alias, index) => '- ' + alias + (index === 0 ? ' [default]' : '') + ': Description of ' + alias).join('\n'),
  parameters: { properties: { model: { type: 'string' } } } });

test('the bridge passes the probed capabilities to the config and keeps them in the status', () => {
  const compatibility = { state: 'source-compatible', version: 'synthetic',
    capabilities: { forceKeySupported: false, singlePoolModelChoice: false } };
  const { bridge, calls } = bridgeFixture(compatibility);
  bridge.update({ mode: 'force', transport: 'native-config', modelAlias: RESPONSES, effort: 'high' });
  expect(calls[0].capabilities).toEqual(compatibility.capabilities);
  expect(bridge.inspect().compatibility.capabilities).toEqual(compatibility.capabilities);
});

test('a single-member pool is not rejected where the kernel pins it, and is never reported as a choice', () => {
  const compatibility = { state: 'source-compatible', version: 'synthetic',
    capabilities: { forceKeySupported: false, singlePoolModelChoice: false } };
  const { bridge } = bridgeFixture(compatibility);
  bridge.update(poolOf([CHILD]));
  // The agent tools lose the parameter; TowerSpawn keeps it because its gate
  // only asks whether a pool exists.
  const strippedAgent = { name: 'Agent', description: 'Launch a subagent', parameters: { properties: { prompt: {} } } };
  const tower = { name: 'TowerSpawn', description: '- ' + CHILD + ' [default]: Description of ' + CHILD,
    parameters: { properties: { model: { type: 'string' } } } };
  expect(bridge.beforeRequest('chat', { tools: [strippedAgent, tower] })).toBeUndefined();
  expect(bridge.inspect().observed).toBeUndefined();
  // A request that still shows the old pool means the reload has not happened.
  expect(bridge.beforeRequest('chat', { tools: [agentTool([CHILD]), tower] })).toEqual(
    { status: 503, code: 'subagent_native_reload_pending' });
  expect(bridge.inspect().observed).toBeUndefined();
});

test('a single-member pool on a kernel that still offers the choice keeps the strict schema check', () => {
  const compatibility = { state: 'source-compatible', version: 'synthetic',
    capabilities: { forceKeySupported: true, singlePoolModelChoice: true } };
  const { bridge } = bridgeFixture(compatibility);
  bridge.update(poolOf([CHILD]));
  expect(bridge.beforeRequest('chat', { tools: [{ name: 'Agent', description: 'Launch a subagent',
    parameters: { properties: { prompt: {} } } }] })).toEqual({ status: 503, code: 'subagent_native_reload_pending' });
  expect(bridge.beforeRequest('chat', { tools: [agentTool([CHILD])] })).toBeUndefined();
  expect(bridge.inspect().observed.state).toBe('observed-schema');
});

test('a multi-member pool still requires the parameter and every advertised description', () => {
  const compatibility = { state: 'source-compatible', version: 'synthetic',
    capabilities: { forceKeySupported: false, singlePoolModelChoice: false } };
  const { bridge } = bridgeFixture(compatibility);
  bridge.update(poolOf([CHILD, RESPONSES]));
  expect(bridge.beforeRequest('chat', { tools: [agentTool([CHILD])] })).toEqual(
    { status: 503, code: 'subagent_native_reload_pending' });
  expect(bridge.beforeRequest('chat', { tools: [agentTool([CHILD, RESPONSES])] })).toBeUndefined();
  expect(bridge.inspect().observed.state).toBe('observed-schema');
});

test('a compatibility report without capabilities keeps the historical strict behaviour', () => {
  const { bridge } = bridgeFixture({ state: 'source-compatible', version: 'synthetic' });
  bridge.update(poolOf([CHILD]));
  expect(bridge.beforeRequest('chat', { tools: [{ name: 'Agent', description: 'Launch a subagent',
    parameters: { properties: { prompt: {} } } }] })).toEqual({ status: 503, code: 'subagent_native_reload_pending' });
});

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NativeSubagentConfig, NATIVE_SUBAGENT_BEGIN, NATIVE_SUBAGENT_END,
  NATIVE_SUBAGENT_RECEIPT, NATIVE_CONFIG_MAX_BYTES } from '../src/native-subagent-config.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const SECRET = 'sk-live-secret-value-9f8e7d6c';
const BASE = `default_model = "parent"

[providers.chat]
type = "openai"
base_url = "https://lab.example/v1"
api_key = "${SECRET}"

[models.parent]
provider = "chat"
model = "lab/kimi-parent"
max_context_size = 128000
capabilities = ["tool_use"]

[models."byok-kth-kimi/lab/kimi-child"]
provider = "chat"
model = "lab/kimi-child"
max_context_size = 64000
capabilities = ["tool_use"]

[models."byok-kth-resp/lab/child-responses"]
provider = "responses"
model = "lab/child-responses"
capabilities = ["tool_use", "thinking"]
support_efforts = ["low", "high"]
default_effort = "low"

[thinking]
enabled = false
`;

const CHILD = 'byok-kth-kimi/lab/kimi-child';
const RESPONSES = 'byok-kth-resp/lab/child-responses';
const force = (modelAlias = RESPONSES, effort) => ({ mode: 'force', modelAlias,
  ...(effort === undefined ? {} : { effort }) });
const pool = (rows = [[CHILD, 'Implementation'], [RESPONSES, 'Independent review']], modelAlias = RESPONSES) => ({
  mode: 'pool', modelAlias, models: rows.map(([alias, description]) => ({ modelAlias: alias, description })),
});

function setup({ config = BASE, eol = '\n', writeConfig = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-config-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const kimiDir = path.join(root, 'kimi');
  const homeDir = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const configPath = path.join(homeDir, 'config.toml');
  const text = config.replace(/\n/g, eol);
  if (writeConfig) fs.writeFileSync(configPath, text);
  const instance = new NativeSubagentConfig({ stateDir, kimiDir });
  const read = () => fs.readFileSync(configPath, 'utf8');
  return { root, stateDir, kimiDir, homeDir, configPath, text, instance, read };
}

const fresh = (context, overrides = {}) => new NativeSubagentConfig({ stateDir: context.stateDir,
  kimiDir: context.kimiDir, ...overrides });
const receiptOf = stateDir => JSON.parse(fs.readFileSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT), 'utf8'));
const resultKeys = result => Object.keys(result).sort();

describe('force and pool blocks', () => {
  test('force appends one owned block and leaves every original byte untouched', () => {
    const context = setup();
    const { instance, text, read, configPath } = context;
    expect(instance.update(force(RESPONSES, 'high'))).toEqual({ state: 'file-applied',
      transport: 'native-config', mode: 'force' });
    const written = read();
    expect(written.startsWith(text)).toBe(true);
    expect(written).toContain(NATIVE_SUBAGENT_BEGIN + '\n# owner=' + instance.ownerID + ' body-sha256=');
    expect(written).toContain('\n[secondary_model]\nforce = true\ndefault_model = "' + RESPONSES
      + '"\ndefault_effort = "high"\n' + NATIVE_SUBAGENT_END);
    expect(written).not.toContain('secondary_model.models');
    const parsed = Bun.TOML.parse(written);
    expect(parsed.secondary_model).toEqual({ force: true, default_model: RESPONSES, default_effort: 'high' });
    expect(parsed.models[CHILD]).toBeDefined();
    expect(fs.readFileSync(configPath, 'utf8')).toContain(SECRET);
    // A `config.json` beside it is not this module's business.
    const configJson = path.join(context.homeDir, 'config.json');
    fs.writeFileSync(configJson, '{"untouched":true}\n');
    instance.update(pool());
    expect(fs.readFileSync(configJson, 'utf8')).toBe('{"untouched":true}\n');
  });

  test('force without an effort omits default_effort', () => {
    const { instance, read } = setup();
    expect(instance.update(force(CHILD)).state).toBe('file-applied');
    const block = read().slice(read().indexOf(NATIVE_SUBAGENT_BEGIN));
    expect(block).not.toContain('default_effort');
    expect(instance.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
  });

  test('pool writes [secondary_model] then a quoted JSON-keyed models map', () => {
    const { instance, read } = setup();
    expect(instance.update(pool([[CHILD, 'Implementation # not a comment'], [RESPONSES, 'Review']]))).toEqual({
      state: 'file-applied', transport: 'native-config', mode: 'pool' });
    const written = read();
    expect(written).toContain('[secondary_model]\ndefault_model = "' + RESPONSES + '"\n[secondary_model.models]\n'
      + '"' + CHILD + '" = "Implementation # not a comment"\n"' + RESPONSES + '" = "Review"\n');
    expect(written.indexOf('[secondary_model]\n')).toBeGreaterThan(written.indexOf('[thinking]'));
    expect(Bun.TOML.parse(written).secondary_model).toEqual({ default_model: RESPONSES,
      models: { [CHILD]: 'Implementation # not a comment', [RESPONSES]: 'Review' } });
    expect(instance.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'pool' });
  });

  test('pool escapes quotes and backslashes in keys and descriptions', () => {
    const alias = 'byok-kth-resp/lab/"quoted"\\slash';
    const header = '[models."byok-kth-resp/lab/\\"quoted\\"\\\\slash"]\nprovider = "responses"\n';
    const context = setup({ config: BASE.replace('[thinking]', header + '[thinking]') });
    const { instance, read } = context;
    const description = 'say "hi"\\ and stay on one line';
    expect(instance.update(pool([[alias, description], [RESPONSES, 'Review']], alias)).state).toBe('file-applied');
    const written = read();
    expect(written).toContain('"byok-kth-resp/lab/\\"quoted\\"\\\\slash" = "say \\"hi\\"\\\\ and stay on one line"');
    expect(Bun.TOML.parse(written).secondary_model.models[alias]).toBe(description);
    // The models header, the pool default and the pool key each quote the alias
    // once; nothing else in the file repeats it.
    const block = written.slice(written.indexOf(NATIVE_SUBAGENT_BEGIN));
    expect(block.split('\n').filter(line => line.includes('byok-kth-resp/lab/\\"quoted\\"\\\\slash')).length).toBe(2);
    // The written alias key is a JSON-quoted TOML key the kernel can read back.
    expect(Bun.TOML.parse(written).secondary_model.default_model).toBe(alias);
  });

  test('the same policy is idempotent and force replaces a pool block in place', () => {
    const { instance, read } = setup();
    const desired = pool();
    instance.update(desired);
    const once = read();
    expect(instance.update(desired)).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'pool' });
    expect(read()).toBe(once);
    expect(instance.update(force(RESPONSES, 'low')).state).toBe('file-applied');
    expect(read()).not.toContain('[secondary_model.models]');
    expect(read().startsWith(BASE)).toBe(true);
  });

  test('a policy that cannot be one safe TOML line is refused without touching anything', () => {
    const { instance, read, stateDir } = setup();
    const before = read();
    const refused = [
      force('a\nb'), force('a\u0000b'), force(''), force(RESPONSES, 'HIGH'), force(RESPONSES, 'a b'),
      pool([[CHILD, 'line\nbreak']]), pool([[CHILD, 'bell' + String.fromCharCode(7)]]),
      pool([[CHILD, 'x'], [CHILD, 'y']], CHILD), pool([[CHILD, 'Implementation']], RESPONSES),
      pool([[CHILD, NATIVE_SUBAGENT_END]]), pool([['x'.repeat(3000), 'too long']], 'x'.repeat(3000)),
      { mode: 'guess' }, { mode: 'force' },
    ];
    for (const policy of refused) {
      const result = instance.update(policy);
      expect(result.state).toBe('conflict');
      expect(result.reason).toBe('invalid_policy');
      expect(result.transport).toBe('native-config');
    }
    expect(read()).toBe(before);
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});

describe('restore', () => {
  test('inherit and blocked remove only the managed block and restore exact bytes', () => {
    for (const mode of ['inherit', 'blocked']) {
      const { instance, read, stateDir } = setup();
      instance.update(pool());
      expect(instance.update({ mode })).toEqual({ state: mode, transport: 'native-config', mode });
      expect(read()).toBe(BASE);
      expect(read()).not.toContain('secondary_model');
      expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(false);
    }
  });

  test('close restores the file, drops the receipt and releases ownership', () => {
    const { instance, read, stateDir } = setup();
    instance.update(pool());
    expect(instance.close()).toEqual({ state: 'restored', transport: 'native-config' });
    expect(read()).toBe(BASE);
    expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(false);
    // A second close is a no-op instead of an endless owner claim.
    expect(instance.close()).toEqual({ state: 'inherit', transport: 'native-config', reason: 'no_managed_block' });
    expect(instance.inspect()).toEqual({ state: 'inherit', transport: 'native-config' });
  });

  test('a file without a trailing newline and a CRLF file both restore byte for byte', () => {
    for (const variant of [{ config: BASE.trimEnd() }, { config: BASE, eol: '\r\n' }]) {
      const { instance, read, text } = setup(variant);
      expect(instance.update(force(RESPONSES)).state).toBe('file-applied');
      if (variant.eol === '\r\n') {
        expect(read()).toContain('\r\n[secondary_model]\r\nforce = true\r\n');
        expect(read()).not.toMatch(/[^\r]\n/);
      }
      expect(instance.update({ mode: 'inherit' }).state).toBe('inherit');
      expect(read()).toBe(text);
    }
  });

  test('inherit on an untouched file never writes a block or a receipt', () => {
    const { instance, read, stateDir } = setup();
    expect(instance.update({ mode: 'inherit' })).toEqual({ state: 'inherit', transport: 'native-config', mode: 'inherit' });
    expect(instance.update({ mode: 'blocked' })).toEqual({ state: 'blocked', transport: 'native-config', mode: 'blocked' });
    expect(read()).toBe(BASE);
    expect(fs.existsSync(stateDir) && fs.readdirSync(stateDir).length).toBe(false);
  });
});

describe('desktop rebuild and ownership', () => {
  test('a generator rebuild that drops the block is repaired on the next update', () => {
    const context = setup();
    const { instance, read, configPath } = context;
    expect(instance.update(pool()).state).toBe('file-applied');
    // The desktop generator rewrites config.toml from its own model.
    const rebuilt = BASE.replace('[thinking]', '[models."byok-kth-resp/lab/child-responses"]\nprovider = "responses"');
    fs.writeFileSync(configPath, rebuilt);
    expect(instance.inspect()).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'managed_block_missing' });
    expect(instance.update(pool()).state).toBe('file-applied');
    expect(read()).toBe(rebuilt + read().slice(rebuilt.length));
    expect(read()).toContain(NATIVE_SUBAGENT_BEGIN);
    expect(read()).toContain('[secondary_model.models]');
    // Disabling after the repair restores the rebuilt file, not the old one.
    expect(instance.update({ mode: 'inherit' }).state).toBe('inherit');
    expect(read()).toBe(rebuilt);
  });

  test('a newer instance adopts the block and the old close cannot undo it', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    expect(instance.update(force(RESPONSES)).state).toBe('file-applied');
    const newer = fresh(context);
    expect(newer.update(pool()).state).toBe('file-applied');
    expect(read()).toContain('[secondary_model.models]');
    expect(receiptOf(stateDir).ownerID).toBe(newer.ownerID);
    expect(instance.close()).toEqual({ state: 'inherit', transport: 'native-config', reason: 'ownership_superseded' });
    expect(read()).toContain('[secondary_model.models]');
    expect(instance.update({ mode: 'inherit' })).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'inherit', reason: 'ownership_superseded' });
    expect(instance.update(force(CHILD))).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
    expect(newer.close()).toEqual({ state: 'inherit', transport: 'native-config', reason: 'ownership_superseded' });
    expect(instance.close()).toEqual({ state: 'restored', transport: 'native-config' });
    expect(read()).toBe(BASE);
  });

  test('a restarted instance adopts a block it can verify, but a stale one cannot delete it', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    const restarted = fresh(context);
    expect(restarted.inspect().state).toBe('file-applied');
    expect(restarted.close()).toEqual({ state: 'inherit', transport: 'native-config', reason: 'ownership_superseded' });
    expect(read()).toContain('[secondary_model]');
    expect(restarted.update(force(RESPONSES)).state).toBe('file-applied');
    expect(receiptOf(stateDir).ownerID).toBe(restarted.ownerID);
    expect(restarted.close()).toEqual({ state: 'restored', transport: 'native-config' });
    expect(read()).toBe(BASE);
  });

  test('a receipt left by a crash before the TOML write is repaired, not trusted blindly', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    // Simulate a crash between the receipt write and the config write: the
    // receipt claims the block, the file does not have it.
    const receipt = receiptOf(stateDir);
    fs.writeFileSync(instance.configPath, BASE);
    expect(instance.inspect()).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'managed_block_missing' });
    expect(instance.update(force(RESPONSES)).state).toBe('file-applied');
    expect(receiptOf(stateDir).ownerID).toBe(instance.ownerID);
    expect(receiptOf(stateDir).blockHash).toBe(receipt.blockHash);
    expect(instance.close()).toEqual({ state: 'restored', transport: 'native-config' });
    expect(read()).toBe(BASE);
  });

  test('a receipt naming another Kimi home is an owner conflict', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    const before = read();
    const receiptPath = path.join(stateDir, NATIVE_SUBAGENT_RECEIPT);
    fs.writeFileSync(receiptPath, JSON.stringify({ ...receiptOf(stateDir), homeDir: '/somewhere/else' }) + '\n');
    for (const result of [instance.inspect(), instance.update(pool()), instance.close()]) {
      expect(result).toEqual({ ...(result.mode ? { mode: result.mode } : {}), state: 'conflict',
        transport: 'native-config', reason: 'owner_conflict' });
    }
    expect(read()).toBe(before);
  });

  test('a receipt and block that disagree about the owner are refused', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    const before = read();
    const receiptPath = path.join(stateDir, NATIVE_SUBAGENT_RECEIPT);
    const forged = { ...receiptOf(stateDir), ownerID: '00000000-0000-4000-8000-000000000000' };
    fs.writeFileSync(receiptPath, JSON.stringify(forged) + '\n');
    expect(instance.update(pool())).toEqual({ state: 'conflict', transport: 'native-config', mode: 'pool',
      reason: 'owner_conflict' });
    expect(read()).toBe(before);
  });

  test('an unreadable state directory is a receipt conflict, not a write', () => {
    const context = setup();
    const { instance, read, root } = context;
    fs.writeFileSync(path.join(root, 'state'), 'not a directory');
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'receipt_conflict' });
    expect(read()).toBe(BASE);
  });

  test('a symlink above the composed paths does not veto the feature', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-outer-'));
    roots.push(outer);
    const real = path.join(outer, 'real');
    fs.mkdirSync(path.join(real, 'kimi', 'runtime', 'kimi-code', 'home'), { recursive: true });
    fs.writeFileSync(path.join(real, 'kimi', 'runtime', 'kimi-code', 'home', 'config.toml'), BASE);
    // `outer/link` is a symlink, but it sits above the composed kimiDir, so it
    // is the user's own layout and not something this module must police.
    const link = path.join(outer, 'link');
    fs.symlinkSync(real, link);
    const instance = new NativeSubagentConfig({ stateDir: path.join(outer, 'state'), kimiDir: path.join(link, 'kimi') });
    expect(instance.update(force(RESPONSES)).state).toBe('file-applied');
    expect(fs.readFileSync(path.join(real, 'kimi', 'runtime', 'kimi-code', 'home', 'config.toml'), 'utf8'))
      .toContain('[secondary_model]');
  });
  test('a lost receipt leaves a verifiable block in place until a write takes it over', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    fs.rmSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT));
    const before = read();
    expect(instance.inspect()).toEqual({ state: 'file-applied', transport: 'native-config', mode: 'force' });
    // Without a receipt nobody can prove the block is not a live instance's,
    // so neither close nor a disable may delete it.
    expect(instance.close()).toEqual({ state: 'conflict', transport: 'native-config', reason: 'receipt_unverified' });
    expect(instance.update({ mode: 'inherit' })).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'inherit', reason: 'receipt_unverified' });
    expect(read()).toBe(before);
    expect(instance.update(force(RESPONSES)).state).toBe('file-applied');
    expect(receiptOf(stateDir).ownerID).toBe(instance.ownerID);
    expect(instance.close().state).toBe('restored');
    expect(read()).toBe(BASE);
  });

  test('a corrupt or symlinked receipt is never trusted', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(force(RESPONSES));
    const receiptPath = path.join(stateDir, NATIVE_SUBAGENT_RECEIPT);
    const before = read();
    for (const corrupt of ['{"schemaVersion":1,"ownerID":"not-a-uuid"}\n', 'not json\n',
      '{"schemaVersion":2,"ownerID":"' + instance.ownerID + '"}']) {
      fs.writeFileSync(receiptPath, corrupt);
      expect(instance.close().reason).toBe('receipt_unverified');
      expect(read()).toBe(before);
    }
    fs.rmSync(receiptPath);
    const target = path.join(context.root, 'elsewhere.json');
    fs.writeFileSync(target, '{}');
    fs.symlinkSync(target, receiptPath);
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'receipt_conflict' });
    expect(read()).toBe(before);
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  });
});

describe('conflicts', () => {
  test('a foreign [secondary_model] table or inline definition is refused, never overwritten', () => {
    const configs = [BASE + '[secondary_model]\nforce = true\ndefault_model = "parent"\n',
      BASE + 'secondary_model.default_model = "byok-kth-kimi/lab/kimi-child"\n',
      '[secondary_model]\ndefault_model = "parent"\n' + BASE,
      BASE + '[secondary_model.models]\n"parent" = "Parent"\n'];
    for (const config of configs) {
      const { instance, read } = setup({ config });
      expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
        mode: 'force', reason: 'foreign_secondary_model' });
      expect(read()).toBe(config);
      expect(instance.update({ mode: 'inherit' })).toEqual({ state: 'conflict', transport: 'native-config',
        mode: 'inherit', reason: 'foreign_secondary_model' });
      expect(instance.close()).toEqual({ state: 'conflict', transport: 'native-config',
        reason: 'foreign_secondary_model' });
      expect(read()).toBe(config);
    }
  });

  test('a hand-edited managed block is reported and left alone', () => {
    const { instance, read } = setup();
    instance.update(force(RESPONSES));
    const edited = read().replace('default_model = "' + RESPONSES + '"', 'default_model = "' + CHILD + '"');
    fs.writeFileSync(instance.configPath, edited);
    expect(instance.inspect()).toEqual({ state: 'conflict', transport: 'native-config', reason: 'block_modified' });
    expect(instance.update(pool())).toEqual({ state: 'conflict', transport: 'native-config', mode: 'pool',
      reason: 'block_modified' });
    expect(instance.close()).toEqual({ state: 'conflict', transport: 'native-config', reason: 'block_modified' });
    expect(read()).toBe(edited);
  });

  test('a duplicated, unterminated or near-miss marker is refused instead of scanned', () => {
    const configs = [BASE + NATIVE_SUBAGENT_BEGIN + '\n' + NATIVE_SUBAGENT_END + '\n',
      BASE + '# BEGIN KIMI WORK GATEWAY SUBAGENTS (hand made)\n',
      BASE + NATIVE_SUBAGENT_END + '\n',
      BASE + NATIVE_SUBAGENT_BEGIN + '\n'];
    for (const config of configs) {
      const { instance, read } = setup({ config });
      const result = instance.update(force(RESPONSES));
      expect(result.state).toBe('conflict');
      expect(result.transport).toBe('native-config');
      expect(read()).toBe(config);
    }
  });

  test('a managed block with a top-level key right after it is not rewritten', () => {
    const { instance, read } = setup();
    instance.update(force(RESPONSES));
    const extended = read() + '\ndefault_model = "shadowed"\n';
    fs.writeFileSync(instance.configPath, extended);
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'block_not_terminal' });
    expect(read()).toBe(extended);
  });

  test('TOML the generator cannot reproduce is reported, not guessed at', () => {
    for (const config of [BASE + 'note = """\nmulti line\n"""\n',
      BASE + 'note = "unterminated\n', BASE + 'models = { "byok-kth-kimi/lab/kimi-child" = {} }\n']) {
      const { instance, read } = setup({ config });
      expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
        mode: 'force', reason: 'unsupported_toml' });
      expect(read()).toBe(config);
    }
  });

  test('a file that changed between the snapshot and the apply is not overwritten', () => {
    const context = setup();
    const { instance, read, configPath, stateDir } = context;
    const originalWrite = instance.writeReceipt.bind(instance);
    instance.writeReceipt = value => {
      const failure = originalWrite(value);
      if (!failure) fs.writeFileSync(configPath, read() + '\n[extra]\nnote = "written by someone else"\n');
      return failure;
    };
    expect(instance.update(pool())).toEqual({ state: 'conflict', transport: 'native-config', mode: 'pool',
      reason: 'concurrent_modification' });
    // The foreign write survives and the receipt from the failed apply is gone.
    expect(read()).toBe(BASE + '\n[extra]\nnote = "written by someone else"\n');
    expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(false);
    instance.writeReceipt = originalWrite;
    expect(instance.update(pool()).state).toBe('file-applied');
    expect(read()).toContain('note = "written by someone else"');
    expect(instance.close().state).toBe('restored');
    expect(read()).toBe(BASE + '\n[extra]\nnote = "written by someone else"\n');
  });
});

describe('models declaration', () => {
  test('an undeclared alias waits for the config instead of writing an invalid section', () => {
    const withoutChild = BASE.replace(/\[models\."byok-kth-resp\/lab\/child-responses"\][\s\S]*?\n\n/, '');
    const { instance, read, stateDir } = setup({ config: withoutChild });
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'models_missing', mode: 'force' });
    expect(read()).toBe(withoutChild);
    expect(fs.existsSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT))).toBe(false);
  });

  test('a model that disappears drops a previously applied block', () => {
    const { instance, read, configPath } = setup();
    instance.update(force(RESPONSES));
    fs.writeFileSync(configPath, BASE.replace(/\[models\."byok-kth-resp\/lab\/child-responses"\][\s\S]*?\n\n/, ''));
    expect(instance.update(force(RESPONSES)).state).toBe('waiting-config');
    expect(read()).not.toContain('secondary_model');
    expect(instance.inspect()).toEqual({ state: 'inherit', transport: 'native-config' });
  });

  test('[models."alias"], [models.alias] and [models] sub-keys all declare a model', () => {
    const dotted = BASE.replace('[models."byok-kth-resp/lab/child-responses"]', '[models.child-responses]');
    const { instance } = setup({ config: dotted });
    expect(instance.update(force('child-responses')).state).toBe('file-applied');

    const subkeys = BASE.replace('[models."byok-kth-resp/lab/child-responses"]', '[models]\n"byok-kth-resp/lab/child-responses" = { provider = "responses" }');
    const second = setup({ config: subkeys });
    expect(second.instance.update(force(RESPONSES)).state).toBe('file-applied');

    const quoted = BASE.replace('[models."byok-kth-resp/lab/child-responses"]', '[models."lab.child"]');
    const third = setup({ config: quoted });
    expect(third.instance.update(force('lab.child')).state).toBe('file-applied');
  });

  test('comments and string values that mention an alias do not declare it', () => {
    const decoy = BASE.replace('[models."byok-kth-resp/lab/child-responses"]', '[models.other]')
      .replace('[thinking]', '[thinking]\n# [models."byok-kth-resp/lab/child-responses"]\n'
        + 'note = "[models.\\"byok-kth-resp/lab/child-responses\\"]"');
    const { instance, read } = setup({ config: decoy });
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'models_missing', mode: 'force' });
    expect(read()).toBe(decoy);
  });
});

describe('filesystem safety', () => {
  test('a symlinked config file or composed ancestor is refused', () => {
    const context = setup();
    const { root, configPath, read } = context;
    const moved = path.join(root, 'real-config.toml');
    fs.renameSync(configPath, moved);
    fs.symlinkSync(moved, configPath);
    const instance = fresh(context, { stateDir: path.join(root, 'state2') });
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'config_symlink' });
    expect(read()).toBe(BASE);

    const third = setup();
    const realHome = path.join(third.root, 'real-home');
    fs.renameSync(third.homeDir, realHome);
    fs.symlinkSync(realHome, third.homeDir);
    expect(third.instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'path_symlink' });
    expect(third.read()).toBe(BASE);
  });

  test('a missing config waits, and a directory in its place is a conflict', () => {
    const missing = setup({ writeConfig: false });
    expect(missing.instance.update(force(RESPONSES))).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'config_missing', mode: 'force' });
    expect(missing.instance.inspect()).toEqual({ state: 'waiting-config', transport: 'native-config',
      reason: 'config_missing' });
    expect(fs.existsSync(missing.configPath)).toBe(false);

    const directory = setup({ writeConfig: false });
    fs.mkdirSync(directory.configPath);
    expect(directory.instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'config_not_file' });
  });

  test('a config larger than the size limit is refused unread', () => {
    const { instance, configPath } = setup();
    fs.truncateSync(configPath, NATIVE_CONFIG_MAX_BYTES + 1);
    expect(instance.update(force(RESPONSES))).toEqual({ state: 'conflict', transport: 'native-config',
      mode: 'force', reason: 'config_too_large' });
    expect(fs.statSync(configPath).size).toBe(NATIVE_CONFIG_MAX_BYTES + 1);
  });

  test('the receipt stores ownership metadata and a hash, never the credentials', () => {
    const { instance, stateDir } = setup();
    expect(instance.update(pool()).state).toBe('file-applied');
    const receipt = receiptOf(stateDir);
    expect(Object.keys(receipt).sort()).toEqual(['blockHash', 'homeDir', 'managed', 'mode', 'ownerID', 'schemaVersion']);
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.ownerID).toBe(instance.ownerID);
    expect(receipt.blockHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.managed).toContain('[secondary_model]');
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(instance.stateDir);
    if (process.platform !== 'win32') {
      expect(fs.statSync(path.join(stateDir, NATIVE_SUBAGENT_RECEIPT)).mode & 0o777).toBe(0o600);
    }
  });

  test('results carry only a state, a transport and a short reason', () => {
    const context = setup();
    const { instance, root } = context;
    const results = [instance.update(pool()), instance.inspect(), instance.update({ mode: 'inherit' }), instance.close()];
    expect(results.map(resultKeys)).toEqual([['mode', 'state', 'transport'], ['mode', 'state', 'transport'],
      ['mode', 'state', 'transport'], ['reason', 'state', 'transport']]);
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
    const conflict = setup({ config: BASE + '[secondary_model]\ndefault_model = "parent"\n' });
    expect(resultKeys(conflict.instance.update(force(RESPONSES)))).toEqual(['mode', 'reason', 'state', 'transport']);
    expect(JSON.stringify(conflict.instance.update(force(RESPONSES)))).not.toContain(conflict.root);
  });

  test('inspect is read-only', () => {
    const { instance, read, stateDir } = setup();
    const before = fs.statSync(instance.configPath).mtimeMs;
    expect(instance.inspect()).toEqual({ state: 'inherit', transport: 'native-config' });
    expect(read()).toBe(BASE);
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.statSync(instance.configPath).mtimeMs).toBe(before);
  });

  test('the written file stays a regular file with the original mode and no temp files', () => {
    const { instance, configPath } = setup();
    fs.chmodSync(configPath, 0o644);
    instance.update(force(RESPONSES));
    const stat = fs.lstatSync(configPath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    // NTFS has no POSIX permission bits: chmod is a no-op there and the mask
    // only reflects read-only. The byte-preserving check makes sense only on
    // filesystems that actually store the mode.
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(path.dirname(configPath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});

test('an interrupted handoff journal recovers without treating a modified block as its own', () => {
  const context = setup(); context.instance.update(force(CHILD));
  const interrupted = fresh(context);
  interrupted.commit = () => { throw Error('simulated_process_exit_after_receipt'); };
  expect(() => interrupted.update(force(RESPONSES, 'high'))).toThrow('simulated_process_exit_after_receipt');
  const journal = receiptOf(context.stateDir);
  expect(journal.previous.ownerID).toBe(context.instance.ownerID);
  const restarted = fresh(context);
  expect(restarted.update(force(RESPONSES, 'high')).state).toBe('file-applied');
  expect(Bun.TOML.parse(context.read()).secondary_model.default_model).toBe(RESPONSES);
  context.instance.close();
  expect(Bun.TOML.parse(context.read()).secondary_model.default_model).toBe(RESPONSES);
  expect(restarted.close().state).toBe('restored'); expect(context.read()).toBe(BASE);
});

test('an unterminated multiline array is preserved rather than receiving a managed section', () => {
  const config = BASE + 'unfinished = ["first",\n';
  const context = setup({ config });
  expect(context.instance.update(force()).state).toBe('conflict'); expect(context.read()).toBe(config);
});

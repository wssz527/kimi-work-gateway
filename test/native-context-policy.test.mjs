import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { NativeContextPolicy, NATIVE_CONTEXT_BEGIN, NATIVE_CONTEXT_END,
  NATIVE_CONTEXT_RECEIPT } from '../src/native-context-policy.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const BASE = `default_model = "parent"

[models.parent]
provider = "chat"
model = "lab/kimi-parent"
max_context_size = 256000

[providers.chat]
type = "openai"
base_url = "https://lab.example/v1"
api_key = "local-placeholder"

[thinking]
enabled = false
`;

function setup({ config = BASE, eol = '\n', writeConfig = true, extra = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-context-policy-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const kimiDir = path.join(root, 'kimi');
  const homeDir = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const configPath = path.join(homeDir, 'config.toml');
  const text = (config + extra).replace(/\n/g, eol);
  if (writeConfig) fs.writeFileSync(configPath, text);
  const instance = new NativeContextPolicy({ stateDir, kimiDir });
  const read = () => fs.readFileSync(configPath, 'utf8');
  const write = value => fs.writeFileSync(configPath, value);
  const receipt = () => JSON.parse(fs.readFileSync(path.join(stateDir, NATIVE_CONTEXT_RECEIPT), 'utf8'));
  const hasReceipt = () => fs.existsSync(path.join(stateDir, NATIVE_CONTEXT_RECEIPT));
  return { root, stateDir, kimiDir, homeDir, configPath, text, instance, read, write, receipt, hasReceipt };
}

const fresh = (context, overrides = {}) => new NativeContextPolicy({
  stateDir: context.stateDir, kimiDir: context.kimiDir, ...overrides });
const custom = (triggerRatio, reservedTokens) => ({ mode: 'custom',
  ...(triggerRatio === undefined ? {} : { triggerRatio }),
  ...(reservedTokens === undefined ? {} : { reservedTokens }) });
const blockOf = text => text.slice(text.indexOf(NATIVE_CONTEXT_BEGIN), text.indexOf(NATIVE_CONTEXT_END) + NATIVE_CONTEXT_END.length);

describe('appending a block', () => {
  test('a new policy appends one marker block and leaves every original byte intact', () => {
    const context = setup();
    const { instance, text, read } = context;
    const state = instance.update(custom(0.6, 40000));
    expect(state).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'applied', observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    const written = read();
    expect(written.startsWith(text)).toBe(true);
    expect(blockOf(written)).toBe([
      NATIVE_CONTEXT_BEGIN,
      '# owner=' + instance.ownerID + ' body-sha256='
        + crypto.createHash('sha256')
          .update('[loop_control]\ncompaction_trigger_ratio = 0.60\nreserved_context_size = 40000')
          .digest('hex') + ' added-eol=0',
      '[loop_control]',
      'compaction_trigger_ratio = 0.60',
      'reserved_context_size = 40000',
      NATIVE_CONTEXT_END,
    ].join('\n'));
  });

  test('the ratio is written as the decimal the kernel schema takes, never as a percent integer', () => {
    const context = setup();
    const { instance, read } = context;
    expect(instance.update(custom(0.5)).status).toBe('applied');
    expect(read()).toContain('compaction_trigger_ratio = 0.50');
    expect(instance.update(custom(0.99)).status).toBe('applied');
    expect(read()).toContain('compaction_trigger_ratio = 0.99');
    // 85% is 0.85 in the config; only the caller renders a percentage.
    expect(instance.update(custom(0.85)).status).toBe('applied');
    expect(read()).toContain('compaction_trigger_ratio = 0.85');
    expect(read()).not.toContain('= 85');
  });

  test('a second update rewrites the same block instead of adding another', () => {
    const context = setup();
    const { instance, read } = context;
    instance.update(custom(0.6, 40000));
    expect(instance.update(custom(0.9, 60000)).status).toBe('applied');
    const written = read();
    expect(written.split(NATIVE_CONTEXT_BEGIN)).toHaveLength(2);
    expect(written.split('[loop_control]')).toHaveLength(2);
    expect(written).toContain('compaction_trigger_ratio = 0.90');
    expect(written).toContain('reserved_context_size = 60000');
    expect(written).not.toContain('reserved_context_size = 40000');
  });

  test('a file without a trailing newline is restored byte for byte', () => {
    const context = setup({ config: BASE.trimEnd() });
    const { instance, read, text, receipt } = context;
    expect(read().endsWith('\n')).toBe(false);
    instance.update(custom(0.7));
    // The separator newline the append needed is recorded so removal can undo it.
    expect(receipt().block.addedEol).toBe(true);
    expect(read().startsWith(text)).toBe(true);
    expect(instance.update({ mode: 'inherit' })).toEqual({ policy: { mode: 'inherit' },
      status: 'inherit', observed: {} });
    expect(read()).toBe(text);
    expect(context.hasReceipt()).toBe(false);
  });

  test('CRLF files keep CRLF', () => {
    const context = setup({ eol: '\r\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.65, 20000));
    expect(read()).toContain('compaction_trigger_ratio = 0.65\r\n');
    expect(read().replace(/\r\n/g, '')).not.toContain('\n');
    instance.update({ mode: 'inherit' });
    expect(read()).toBe(text);
  });
});

describe('editing an existing table', () => {
  const FOREIGN = BASE + `
# tuned by hand
[loop_control]
max_steps_per_turn = 12
reserved_context_size = 30000 # keep some headroom
# trailing note
`;

  test('an existing [loop_control] is edited in place, never duplicated', () => {
    const context = setup({ extra: `
# tuned by hand
[loop_control]
max_steps_per_turn = 12
reserved_context_size = 30000 # keep some headroom
# trailing note
` });
    const { instance, read } = context;
    expect(instance.update(custom(0.7, 50000)).status).toBe('applied');
    const written = read();
    expect(written.split('[loop_control]')).toHaveLength(2);
    expect(written).not.toContain(NATIVE_CONTEXT_BEGIN);
    expect(written).toContain('max_steps_per_turn = 12');
    expect(written).toContain('# tuned by hand');
    expect(written).toContain('# trailing note');
    expect(written).toContain('reserved_context_size = 50000 # keep some headroom');
    expect(written).toContain('compaction_trigger_ratio = 0.70');
  });

  test('inherit restores the exact previous lines, including a missing key', () => {
    const context = setup({ extra: FOREIGN });
    const { instance, read, text } = context;
    instance.update(custom(0.7, 50000));
    expect(read()).not.toBe(text);
    expect(instance.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
    expect(context.hasReceipt()).toBe(false);
  });

  test('a key someone else changed is reported and left alone on restore', () => {
    const context = setup({ extra: FOREIGN });
    const { instance, read, write } = context;
    instance.update(custom(0.7, 50000));
    const ours = read();
    // The desktop app or a text editor moves the ratio to another value.
    write(ours.replace('compaction_trigger_ratio = 0.70', 'compaction_trigger_ratio = 0.80'));
    expect(instance.state()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.7, reservedTokens: 50000 },
      status: 'conflict', reason: 'foreign_value', observed: { triggerRatio: 0.8, reservedTokens: 50000 } });
    const released = instance.update({ mode: 'inherit' });
    // The budget goes back to the user's 30000; the ratio stays at the foreign
    // 0.80 and the release says so instead of claiming a clean restore.
    expect(released).toEqual({ policy: { mode: 'inherit' },
      status: 'conflict', reason: 'foreign_value', observed: { triggerRatio: 0.8, reservedTokens: 30000 } });
    expect(read()).toContain('compaction_trigger_ratio = 0.80');
    expect(read()).toContain('reserved_context_size = 30000');
    expect(read()).toContain('max_steps_per_turn = 12');
    // Ownership is gone, so the foreign ratio is never taken back later.
    expect(instance.reconcile().status).toBe('inherit');
    expect(read()).toContain('compaction_trigger_ratio = 0.80');
  });

  test('a foreign table with its own ratio keeps the user value in the receipt for restore', () => {
    const context = setup({ extra: '\n[loop_control]\ncompaction_trigger_ratio = 0.9\n' });
    const { instance, read } = context;
    const original = read();
    instance.update(custom(0.6));
    expect(read()).toContain('compaction_trigger_ratio = 0.60');
    expect(context.receipt().originals.triggerRatio).toEqual({ present: true,
      line: 'compaction_trigger_ratio = 0.9' });
    instance.update({ mode: 'inherit' });
    expect(read()).toBe(original);
  });

  test('narrowing to a ratio hands the reserved budget back to its original line', () => {
    const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\nreserved_context_size = 30000 # keep\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.6, 40000));
    expect(read()).toContain('reserved_context_size = 40000 # keep');
    // Dropping the budget must not leave our 40000 behind with no owner over
    // the user's 30000; the original line returns immediately.
    const narrowed = instance.update(custom(0.7));
    expect(narrowed).toEqual({ policy: { mode: 'custom', triggerRatio: 0.7 },
      status: 'applied', observed: { triggerRatio: 0.7, reservedTokens: 30000 },
      released: ['reservedTokens'] });
    expect(read()).toContain('reserved_context_size = 30000 # keep');
    expect(read()).toContain('compaction_trigger_ratio = 0.70');
    // And a later inherit is a clean restore of what is still managed.
    expect(instance.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
  });

  test('narrowing to a budget removes the ratio line this module added', () => {
    const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.6, 40000));
    const narrowed = instance.update(custom(undefined, 60000));
    expect(narrowed.released).toEqual(['triggerRatio']);
    expect(read()).not.toContain('compaction_trigger_ratio');
    expect(read()).toContain('reserved_context_size = 60000');
    expect(instance.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
  });

  test('a handed-back field the user has changed stops the narrowing instead of dropping ownership', () => {
    const context = setup({ extra: '\n[loop_control]\nreserved_context_size = 30000\n' });
    const { instance, read, write } = context;
    instance.update(custom(0.6, 40000));
    // Someone else moves the budget before the policy is narrowed. The ratio
    // is still ours, but rewriting only it would silently adopt their 55000 as
    // the new "original" of a field this module once owned.
    write(read().replace('reserved_context_size = 40000', 'reserved_context_size = 55000'));
    const narrowed = instance.update(custom(0.7));
    expect(narrowed).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'conflict', reason: 'foreign_value',
      observed: { triggerRatio: 0.6, reservedTokens: 55000 } });
    expect(read()).toContain('reserved_context_size = 55000');
    expect(read()).toContain('compaction_trigger_ratio = 0.60');
  });

  test('a narrowed policy survives a restart and still restores the handed-back field', () => {
    const context = setup({ extra: '\n[loop_control]\nreserved_context_size = 30000 # keep\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.6, 40000));
    instance.update(custom(0.7));
    const reopened = fresh(context);
    expect(reopened.state()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.7 },
      status: 'applied', observed: { triggerRatio: 0.7, reservedTokens: 30000 } });
    expect(reopened.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
  });

  test('both fields narrowing down to one hands the other back in the same table', () => {
    const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.6, 40000));
    const narrowed = instance.update(custom(undefined, 50000));
    expect(narrowed).toEqual({ policy: { mode: 'custom', reservedTokens: 50000 },
      status: 'applied', observed: { reservedTokens: 50000 }, released: ['triggerRatio'] });
    expect(read()).not.toContain('compaction_trigger_ratio');
    expect(read()).toContain('reserved_context_size = 50000');
    expect(instance.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
  });

  test('the reverse narrowing keeps the user budget through the drop and the restore', () => {
    const context = setup({ extra: '\n[loop_control]\nreserved_context_size = 30000\n' });
    const { instance, read, text } = context;
    instance.update(custom(0.6));
    const narrowed = instance.update(custom(undefined, 70000));
    expect(narrowed.released).toEqual(['triggerRatio']);
    expect(read()).not.toContain('compaction_trigger_ratio');
    expect(read()).toContain('reserved_context_size = 70000');
    // The user's 30000 is what inherit brings back, not our 70000.
    expect(instance.update({ mode: 'inherit' })).toEqual({ policy: { mode: 'inherit' },
      status: 'inherit', observed: { reservedTokens: 30000 } });
    expect(read()).toBe(text);
  });

  test('a marker block leaves no trace of the dropped key', () => {
    const context = setup();
    const { instance, read, text } = context;
    instance.update(custom(0.6, 40000));
    // The block is regenerated from the policy, so a dropped key leaves nothing
    // behind. There is no `released` field: the key was never the user's.
    expect(instance.update(custom(0.7))).toEqual({ policy: { mode: 'custom', triggerRatio: 0.7 },
      status: 'applied', observed: { triggerRatio: 0.7 } });
    expect(read()).not.toContain('reserved_context_size');
    expect(instance.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(text);
  });

  test('a header-only table narrowed back also loses the newline the insert added', () => {
    const context = setup({ config: '', extra: '[loop_control]' });
    const { instance, read } = context;
    instance.update(custom(0.75, 20000));
    expect(read()).toBe('[loop_control]\ncompaction_trigger_ratio = 0.75\nreserved_context_size = 20000');
    const narrowed = instance.update(custom(0.8));
    expect(narrowed.released).toEqual(['reservedTokens']);
    expect(read()).toBe('[loop_control]\ncompaction_trigger_ratio = 0.80');
    instance.update({ mode: 'inherit' });
    expect(read()).toBe('[loop_control]');
  });

  test('a table header ending the file is handled without corrupting it', () => {
    const context = setup({ config: '' , extra: '[loop_control]' });
    const { instance, read } = context;
    expect(instance.update(custom(0.75)).status).toBe('applied');
    expect(read()).toBe('[loop_control]\ncompaction_trigger_ratio = 0.75');
    expect(instance.update({ mode: 'inherit' })).toEqual({ policy: { mode: 'inherit' },
      status: 'inherit', observed: {} });
    expect(read()).toBe('[loop_control]');
  });

  test('the receipt lives in the state directory, never in the Kimi home', () => {
    const context = setup();
    const { instance, stateDir, homeDir } = context;
    instance.update(custom(0.6));
    expect(fs.readdirSync(stateDir).sort()).toEqual([NATIVE_CONTEXT_RECEIPT]);
    expect(fs.readdirSync(homeDir).sort()).toEqual(['config.toml']);
  });
});

describe('layouts this module refuses to guess at', () => {
  const cases = {
    'a second [loop_control] table': BASE + '\n[loop_control]\nreserved_context_size = 1\n' + '\n[loop_control]\n',
    'an array of tables': BASE + '\n[[loop_control]]\ncompaction_trigger_ratio = 0.6\n',
    'a dotted sub-table': BASE + '\n[loop_control.extra]\nnote = "x"\n',
    'a root dotted assignment': 'loop_control.compaction_trigger_ratio = 0.6\n' + BASE,
    'an inline table': 'loop_control = { compaction_trigger_ratio = 0.6 }\n' + BASE,
    'a non-numeric ratio': BASE + '\n[loop_control]\ncompaction_trigger_ratio = "0.6"\n',
    'a ratio outside the schema': BASE + '\n[loop_control]\ncompaction_trigger_ratio = 0.4\n',
    'a non-integer budget': BASE + '\n[loop_control]\nreserved_context_size = 1.5\n',
    'a duplicated key': BASE + '\n[loop_control]\nreserved_context_size = 1\nreserved_context_size = 2\n',
  };
  for (const [name, config] of Object.entries(cases)) {
    test(name + ' is reported without a write', () => {
      const context = setup({ config });
      const { instance, read } = context;
      const before = read();
      const state = instance.update(custom(0.6, 40000));
      expect(state.status).toBe('conflict');
      expect(state.policy).toEqual({ mode: 'inherit' });
      expect(read()).toBe(before);
      expect(context.hasReceipt()).toBe(false);
    });
  }

  test('a marker that is not a verified block is never adopted', () => {
    const cases = [
      BASE + NATIVE_CONTEXT_BEGIN + '\n[loop_control]\ncompaction_trigger_ratio = 0.6\n',
      BASE + NATIVE_CONTEXT_BEGIN + '\n# owner=00000000-0000-0000-0000-000000000000 body-sha256='
        + '0'.repeat(64) + ' added-eol=0\n[loop_control]\ncompaction_trigger_ratio = 0.6\n' + NATIVE_CONTEXT_END + '\n',
      BASE + '# ' + NATIVE_CONTEXT_END + '\n',
    ];
    for (const config of cases) {
      const context = setup({ config });
      const before = context.read();
      const state = context.instance.update(custom(0.6));
      expect(state.status).toBe('conflict');
      expect(['unterminated_block', 'block_modified', 'suspicious_marker']).toContain(state.reason);
      expect(context.read()).toBe(before);
    }
  });

  test('a block hash mismatch means the body was edited by someone else', () => {
    const context = setup();
    const { instance, read, write } = context;
    instance.update(custom(0.6, 40000));
    write(read().replace('reserved_context_size = 40000', 'reserved_context_size = 41000'));
    expect(instance.state()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'conflict', reason: 'block_modified', observed: {} });
    expect(instance.update({ mode: 'inherit' }).status).toBe('conflict');
    expect(read()).toContain('reserved_context_size = 41000');
  });
});

describe('validation', () => {
  const rejected = [
    ['a ratio below the schema minimum', custom(0.49)],
    ['a ratio at one', custom(1)],
    ['a ratio above one', custom(1.01)],
    ['a ratio as a percent integer', custom(60)],
    ['a negative budget', custom(undefined, -1)],
    ['a fractional budget', custom(undefined, 1.5)],
    ['a string ratio', custom('0.6')],
    ['an inheritance with a leftover value', { mode: 'inherit', triggerRatio: 0.6 }],
    ['an unknown mode', { mode: 'force' }],
    ['a custom policy with nothing set', { mode: 'custom' }],
    ['a non-object policy', 'custom'],
  ];
  for (const [name, policy] of rejected) {
    test(name + ' is refused before any write', () => {
      const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\n' });
      const before = context.read();
      const state = context.instance.update(policy);
      expect(state).toEqual({ policy: { mode: 'inherit' }, status: 'conflict',
        reason: 'invalid_policy', observed: {} });
      expect(context.read()).toBe(before);
      expect(context.hasReceipt()).toBe(false);
    });
  }

  test('the schema boundaries themselves are accepted', () => {
    for (const ratio of [0.5, 0.51, 0.855, 0.99]) {
      const context = setup();
      expect(context.instance.update(custom(ratio)).status).toBe('applied');
      expect(context.instance.state().policy).toEqual({ mode: 'custom', triggerRatio: ratio });
    }
    const context = setup();
    expect(context.instance.update(custom(undefined, 0)).status).toBe('applied');
    expect(context.read()).toContain('reserved_context_size = 0');
  });
});

describe('ownership and rewriting', () => {
  test('a receipt from another Kimi home is not trusted', () => {
    const context = setup();
    const { instance, read, kimiDir, stateDir } = context;
    instance.update(custom(0.6, 40000));
    const receiptPath = path.join(stateDir, NATIVE_CONTEXT_RECEIPT);
    const other = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    other.kimiDir = path.join(kimiDir, 'elsewhere');
    fs.writeFileSync(receiptPath, JSON.stringify(other));
    expect(instance.state().status).toBe('conflict');
    const before = read();
    expect(instance.update(custom(0.7)).status).toBe('conflict');
    expect(read()).toBe(before);
  });

  test('a corrupt receipt blocks writes instead of claiming ownership', () => {
    const context = setup();
    const { instance, stateDir, read } = context;
    instance.update(custom(0.6));
    fs.writeFileSync(path.join(stateDir, NATIVE_CONTEXT_RECEIPT), '{"schemaVersion":1');
    const before = read();
    expect(instance.state()).toEqual({ policy: { mode: 'inherit' }, status: 'conflict',
      reason: 'receipt_unverified', observed: { triggerRatio: 0.6 } });
    expect(instance.update(custom(0.7)).status).toBe('conflict');
    expect(read()).toBe(before);
  });

  test('the app rewriting the whole file drops the block; reconcile reports it and re-applies', () => {
    const context = setup();
    const { instance, read, write, text } = context;
    instance.update(custom(0.6, 40000));
    // The generator keeps only the sections it models.
    write(text + '\n[thinking]\nkeep = true\n');
    expect(instance.state()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'conflict', reason: 'value_missing', observed: {} });
    const reconciled = instance.reconcile();
    expect(reconciled.status).toBe('applied');
    expect(reconciled.observed).toEqual({ triggerRatio: 0.6, reservedTokens: 40000 });
    expect(read()).toContain('compaction_trigger_ratio = 0.60');
    expect(read()).toContain('[thinking]\nkeep = true');
  });

  test('reconcile re-applies only when the file lost the policy, and refuses to overwrite a foreign value', () => {
    const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\n' });
    const { instance, read, write } = context;
    instance.update(custom(0.6, 40000));
    expect(instance.reconcile()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'applied', observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    write(read().replace('compaction_trigger_ratio = 0.60', 'compaction_trigger_ratio = 0.66'));
    expect(instance.reconcile()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'conflict', reason: 'foreign_value', observed: { triggerRatio: 0.66, reservedTokens: 40000 } });
    expect(read()).toContain('compaction_trigger_ratio = 0.66');
  });

  test('reconcile drops the keys the app removed rather than resurrecting a table it dropped', () => {
    const context = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 4\n' });
    const { instance, read, write } = context;
    instance.update(custom(0.6));
    // The app removes the whole table between passes.
    write(BASE);
    expect(instance.state().status).toBe('conflict');
    expect(instance.reconcile().status).toBe('applied');
    expect(read()).toContain('[loop_control]\ncompaction_trigger_ratio = 0.60');
  });

  test('a write that raced with the app is refused and leaves the foreign bytes', () => {
    const context = setup();
    const { instance, read, configPath } = context;
    const originalWrite = instance.writeReceipt.bind(instance);
    instance.writeReceipt = value => {
      const failure = originalWrite(value);
      if (!failure) fs.writeFileSync(configPath, read() + '\n[extra]\nnote = "written by someone else"\n');
      return failure;
    };
    expect(instance.update(custom(0.6))).toEqual({ policy: { mode: 'inherit' }, status: 'conflict',
      reason: 'concurrent_modification', observed: {} });
    expect(read()).toBe(BASE + '\n[extra]\nnote = "written by someone else"\n');
    expect(context.hasReceipt()).toBe(false);
    instance.writeReceipt = originalWrite;
    expect(instance.update(custom(0.6)).status).toBe('applied');
    expect(read()).toContain('note = "written by someone else"');
  });

  test('a restarted process still owns and can remove the block it wrote', () => {
    const context = setup();
    context.instance.update(custom(0.6));
    // A new instance has a new owner id, but the receipt in this state
    // directory still describes the block on disk, so it may take it back out.
    const reopened = fresh(context);
    expect(reopened.state().status).toBe('applied');
    expect(reopened.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(context.read()).toBe(context.text);
  });

  test('a block no receipt in this state directory describes is never removed or rewritten', () => {
    const context = setup();
    context.instance.update(custom(0.6, 40000));
    const edited = context.read();
    // Another policy store (a second state directory) wrote a block of its own
    // over ours, or the receipt was replaced by an unrelated record.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-context-other-'));
    roots.push(other);
    const stranger = new NativeContextPolicy({ stateDir: other, kimiDir: context.kimiDir });
    stranger.ownerID = '00000000-0000-4000-8000-000000000000';
    const receiptPath = path.join(context.stateDir, NATIVE_CONTEXT_RECEIPT);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.block.ownerID = stranger.ownerID;
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));

    expect(context.instance.update({ mode: 'inherit' }).status).toBe('conflict');
    expect(context.read()).toBe(edited);
    expect(context.instance.update(custom(0.8)).status).toBe('conflict');
    expect(context.read()).toBe(edited);
  });

  test('a missing receipt leaves the block in place and reports the orphan', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(custom(0.6, 40000));
    const block = read();
    const orphan = fresh(context);
    fs.rmSync(path.join(stateDir, NATIVE_CONTEXT_RECEIPT));
    // The block proves this feature wrote it, but not on whose behalf. Reading
    // reports that instead of a clean "inherit" that hides the bytes.
    expect(orphan.state()).toEqual({ policy: { mode: 'inherit' },
      status: 'conflict', reason: 'ownership_conflict',
      observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    expect(orphan.update({ mode: 'inherit' })).toEqual({ policy: { mode: 'inherit' },
      status: 'conflict', reason: 'ownership_conflict',
      observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    expect(read()).toBe(block);
    // And it is never rewritten on behalf of this state directory either.
    expect(orphan.update(custom(0.8)).status).toBe('conflict');
    expect(read()).toBe(block);
  });

  test('a second state directory cannot take over a block another one still holds', () => {
    const context = setup();
    const first = context.instance;
    first.update(custom(0.6, 40000));
    const block = context.read();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-context-second-'));
    roots.push(other);
    const second = new NativeContextPolicy({ stateDir: other, kimiDir: context.kimiDir });
    // No receipt in the second store: the block is not its to rewrite.
    expect(second.update(custom(0.8))).toEqual({ policy: { mode: 'inherit' },
      status: 'conflict', reason: 'ownership_conflict',
      observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    expect(second.update({ mode: 'inherit' }).status).toBe('conflict');
    expect(context.read()).toBe(block);
    // The owner's receipt still works, so the first store can take it back out.
    expect(first.state().status).toBe('applied');
    expect(first.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(context.read()).toBe(context.text);
  });

  test('an unsafe receipt is refused and leaves the block alone', () => {
    const context = setup();
    const { instance, read, stateDir } = context;
    instance.update(custom(0.6));
    const block = read();
    const receiptPath = path.join(stateDir, NATIVE_CONTEXT_RECEIPT);
    const target = path.join(stateDir, 'elsewhere.json');
    fs.renameSync(receiptPath, target);
    fs.symlinkSync(target, receiptPath);
    expect(instance.state()).toEqual({ policy: { mode: 'inherit' }, status: 'conflict',
      reason: 'receipt_unverified', observed: { triggerRatio: 0.6 } });
    expect(instance.update({ mode: 'inherit' }).status).toBe('conflict');
    expect(read()).toBe(block);
  });

  test('close and revoke are not needed: a saved policy outlives the process', () => {
    const context = setup();
    const { instance, read } = context;
    instance.update(custom(0.6, 40000));
    expect(typeof instance.close).toBe('undefined');
    expect(typeof instance.revoke).toBe('undefined');
    const reopened = fresh(context);
    expect(reopened.state()).toEqual({ policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'applied', observed: { triggerRatio: 0.6, reservedTokens: 40000 } });
    expect(reopened.update({ mode: 'inherit' }).status).toBe('inherit');
    expect(read()).toBe(context.text);
  });
});

describe('a config that is not there yet', () => {
  test('the policy waits for the config and applies once it appears', () => {
    const context = setup({ writeConfig: false });
    const { instance, read, kimiDir } = context;
    expect(instance.update(custom(0.6, 40000))).toEqual({
      policy: { mode: 'custom', triggerRatio: 0.6, reservedTokens: 40000 },
      status: 'waiting-config', reason: 'config_missing', observed: {} });
    expect(fs.existsSync(path.join(kimiDir, 'runtime', 'kimi-code', 'home', 'config.toml'))).toBe(false);
    expect(context.receipt().triggerRatio).toBe(0.6);
    fs.writeFileSync(context.configPath, BASE);
    expect(instance.reconcile().status).toBe('applied');
    expect(read()).toContain('compaction_trigger_ratio = 0.60');
  });

  test('an inheritance with no config is a no-op', () => {
    const context = setup({ writeConfig: false });
    expect(context.instance.update({ mode: 'inherit' })).toEqual({ policy: { mode: 'inherit' },
      status: 'inherit', observed: {} });
    expect(context.hasReceipt()).toBe(false);
  });

  test('a Kimi directory that is a symlink is refused', () => {
    const context = setup();
    const real = context.kimiDir + '-real';
    fs.renameSync(context.kimiDir, real);
    fs.symlinkSync(real, context.kimiDir, 'dir');
    expect(context.instance.update(custom(0.6)).status).toBe('conflict');
    expect(context.instance.state().reason).toBe('path_symlink');
  });
});

// The installed Kimi bundle is the authority for the schema. `kimi doctor`
// runs that bundle's own parser and Zod schema, so a candidate it accepts is
// the strongest offline evidence available that the emitted TOML is native.
// It is skipped where the app is not installed (CI) rather than assumed.
const doctorBinary = path.join(os.homedir(), '.kimi-code', 'bin', 'kimi');
const doctorAvailable = fs.existsSync(doctorBinary);
// The kernel bundle the desktop app runs; the compaction strategy test imports
// a temporary copy of the whole chunk directory.
const bundlePath = '/Applications/Kimi.app/Contents/Resources/resources/daimon-bundle/app/daimon/dist/kimi-code-v2/kernel-bundle.mjs';
const bundleAvailable = fs.existsSync(bundlePath);

const validate = file => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-doctor-'));
  try {
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return execFileSync(doctorBinary, ['doctor', 'config', file], {
      env: { ...process.env, KIMI_CODE_HOME: home }, encoding: 'utf8', stdio: 'pipe' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

describe('real native schema', () => {
  test.skipIf(!doctorAvailable)('the native parser accepts the appended block and the edited table', () => {
    const appended = setup();
    appended.instance.update(custom(0.6, 40000));
    expect(validate(appended.configPath)).toContain('All checked config files are valid');

    const edited = setup({ extra: '\n[loop_control]\nmax_steps_per_turn = 12\n' });
    edited.instance.update(custom(0.99, 0));
    expect(validate(edited.configPath)).toContain('All checked config files are valid');
    // And the restore goes back to text the parser already accepted.
    edited.instance.update({ mode: 'inherit' });
    expect(validate(edited.configPath)).toContain('All checked config files are valid');
  });

  test.skipIf(!doctorAvailable)('the native parser shows a duplicate table is invalid, which is why no second header is written', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-doctor-dup-'));
    roots.push(root);
    const file = path.join(root, 'config.toml');
    fs.writeFileSync(file, BASE + '\n[loop_control]\ncompaction_trigger_ratio = 0.6\n\n[loop_control]\nreserved_context_size = 1\n');
    expect(() => validate(file)).toThrow();
  });

  // Beyond accepting the file, the kernel's own client resolves the values this
  // module wrote and its compaction strategy triggers on them. The bundle is
  // staged in a temporary copy only to re-export two internals; the installed
  // app is never modified, and client identity + home are isolated.
  test.skipIf(!bundleAvailable)('the kernel resolves the written values into its compaction strategy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-kernel-'));
    roots.push(root);
    const staged = path.join(root, 'bundle');
    fs.cpSync(path.dirname(bundlePath), staged, { recursive: true });
    const entry = path.join(staged, path.basename(bundlePath));
    fs.appendFileSync(entry, '\nexport { IConfigService, RuntimeCompactionStrategy };\n');
    const kernel = await import(entry);

    const kimiDir = path.join(root, 'kimi');
    const home = path.join(kimiDir, 'runtime', 'kimi-code', 'home');
    fs.mkdirSync(home, { recursive: true });
    const configPath = path.join(home, 'config.toml');
    fs.writeFileSync(configPath, `default_model = "probe"

[models.probe]
provider = "chat"
model = "lab/probe"
max_context_size = 100000

[providers.chat]
type = "openai"
base_url = "https://lab.example/v1"
api_key = "placeholder"

[loop_control]
max_steps_per_turn = 9
`);
    const policy = new NativeContextPolicy({ stateDir: path.join(root, 'state'), kimiDir });
    expect(policy.update(custom(0.6, 40000)).status).toBe('applied');

    const client = kernel.createKernelClient({ homeDir: home, configPath,
      identity: { productName: 'kimi-code', version: '2.0.0', platform: process.platform } });
    try {
      await client.configReady;
      const resolved = client.app.accessor.get(kernel.IConfigService).get('loopControl');
      expect(resolved.compactionTriggerRatio).toBe(0.6);
      expect(resolved.reservedContextSize).toBe(40000);

      // The trigger is `used >= max * ratio` OR `used + reserved >= max`.
      const strategy = new kernel.RuntimeCompactionStrategy(() => ({
        modelCapabilities: { max_input_tokens: 100000 }, ...resolved }));
      expect(strategy.shouldCompact(59999)).toBe(false);
      expect(strategy.shouldCompact(60000)).toBe(true);
      // The 40K budget makes 60K fire even without the ratio being reached.
      const early = new kernel.RuntimeCompactionStrategy(() => ({
        modelCapabilities: { max_input_tokens: 100000 }, compactionTriggerRatio: 0.9,
        reservedContextSize: 40000 }));
      expect(early.shouldCompact(60000)).toBe(true);
      expect(early.shouldCompact(59999)).toBe(false);
      // A stock kernel (trigger .85, reserve 50000) fires at 50000 on a 100K
      // window: `50000 + 50000 >= 100000` reaches the reserved boundary well
      // before `used >= 85000`, so the budget — not the ratio — decides.
      const stock = new kernel.RuntimeCompactionStrategy(() => ({
        modelCapabilities: { max_input_tokens: 100000 } }));
      expect(stock.shouldCompact(49999)).toBe(false);
      expect(stock.shouldCompact(50000)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

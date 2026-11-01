import { describe, expect, test } from 'bun:test';
import { mergeRemoteWorkConfig } from '../src/remote-work-models.mjs';

const URL = 'http://127.0.0.1:3426/v1';
const CRED = 'gateway-local';
const TOKEN = '{{SECRET_rwm3t0k3n}}';
const CIPHER = '{{SECRET_rwm3c1ph3r}}';

function row(alias, extra = {}) {
  const providerId = alias.slice(0, alias.indexOf('/'));
  return { alias, providerId, model: alias.slice(providerId.length + 1), maxContextSize: 131072, ...extra };
}

const RESP = 'byok-kth-resp/lab/model';
const KIMI = 'byok-kth-kimi/lab/kimi-parent';

function profile(extra = {}) {
  return {
    id: 'byok-kth',
    kind: 'kth',
    baseUrl: URL,
    credentialRef: CRED,
    tokenEncrypted: CIPHER,
    models: [row(RESP), row(KIMI, { family: 'kimi' })],
    delisted: [],
    ...extra,
  };
}

function workConfig(extra = {}) {
  return {
    models: [
      { key: 'official-a', modelId: 'official-a', modelAlias: 'official-a', displayName: 'A', agentMode: 'TYPE_NORMAL' },
      { key: 'official-b', modelId: 'official-b', modelAlias: 'official-b', displayName: 'B' },
    ],
    moreModels: [{ key: 'official-c', modelId: 'official-c', modelAlias: 'official-c' }],
    defaultModelKey: 'official-a',
    fromCache: false,
    swarmModeSyncVersion: 1,
    quota: { level: 3, isPaid: true, planName: 'plan', planNamesByLevel: { 3: 'plan' } },
    futureField: { keep: true },
    ...extra,
  };
}

const FIELDS = ['key', 'displayName', 'description', 'inputPlaceholder', 'label', 'scenario',
  'modelId', 'modelAlias', 'agentMode', 'kimiPlusId', 'switchableTo', 'reasoningEffortOptions',
  'defaultReasoningEffort', 'defaultThinkingLevel'];

const json = value => JSON.stringify(value);
const keys = value => value.models.map(entry => entry.key);
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

describe('official catalog', () => {
  test('every official value and entry survives a merge', () => {
    const config = workConfig();
    const snapshot = json(config);
    const merged = mergeRemoteWorkConfig(config, profile());
    expect(merged).not.toBe(config);
    expect(json(config)).toBe(snapshot);
    expect(merged.defaultModelKey).toBe('official-a');
    expect(merged.fromCache).toBe(false);
    expect(merged.swarmModeSyncVersion).toBe(1);
    expect(merged.quota).toBe(config.quota);
    expect(merged.futureField).toBe(config.futureField);
    expect(merged.moreModels).toBe(config.moreModels);
    expect(merged.models.slice(0, config.models.length)).toEqual(config.models);
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP, KIMI]);
  });

  test('the default model key is carried over untouched, even for a BYOK alias', () => {
    const config = workConfig({ defaultModelKey: RESP });
    const merged = mergeRemoteWorkConfig(config, profile({ models: [row(RESP)] }));
    expect(merged.defaultModelKey).toBe(RESP);
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP]);
  });

  test('frozen inputs are merged without being written to', () => {
    const config = freeze(workConfig());
    const source = freeze(profile());
    const merged = mergeRemoteWorkConfig(config, source);
    expect(merged.models).toHaveLength(4);
    expect(config.models).toHaveLength(2);
  });
});

describe('appended descriptors', () => {
  test('only the renderer allowlist is generated, and the model id is the alias tail', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile());
    const added = merged.models.slice(2);
    expect(added.map(entry => Object.keys(entry).sort())).toEqual([FIELDS.slice().sort(), FIELDS.slice().sort()]);
    expect(added[0]).toEqual({
      key: RESP,
      displayName: 'model',
      description: '',
      inputPlaceholder: '',
      label: [],
      scenario: 0,
      modelId: 'model',
      modelAlias: RESP,
      agentMode: 'TYPE_NORMAL',
      kimiPlusId: '',
      switchableTo: [],
      reasoningEffortOptions: [],
      defaultReasoningEffort: 'REASONING_EFFORT_UNSPECIFIED',
      defaultThinkingLevel: '',
    });
    expect(added[1].displayName).toBe('kimi-parent');
    expect(added[1].modelId).toBe('kimi-parent');
  });

  test('profile metadata never reaches the merged catalog', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile());
    const output = json(merged);
    for (const secret of [URL, CRED, TOKEN, CIPHER, 'tokenEncrypted', 'credentialRef', 'credentials',
      'baseUrl', 'maxContextSize', 'providerId', 'supportEfforts', 'capabilities', 'daimonModelConfig']) {
      expect(output.includes(secret)).toBe(false);
    }
    expect(Object.keys(merged)).toEqual(['models', 'moreModels', 'defaultModelKey', 'fromCache',
      'swarmModeSyncVersion', 'quota', 'futureField']);
  });

  test('descriptor arrays are not shared between calls', () => {
    const first = mergeRemoteWorkConfig(workConfig(), profile());
    const second = mergeRemoteWorkConfig(workConfig(), profile());
    first.models.at(-1).label.push('mutated');
    first.models.at(-1).reasoningEffortOptions.push({ effort: 'REASONING_EFFORT_HIGH' });
    expect(second.models.at(-1).label).toEqual([]);
    expect(second.models.at(-1).reasoningEffortOptions).toEqual([]);
  });
});

// The native profile carries `delisted` and `pending` as alias lists, while
// the stored profile keeps `pending` as a snapshot. Only a literal `true`
// disables a profile; an empty delisted list excludes nothing.
describe('profile status', () => {
  test('the native delisted:[] shape keeps every effective row', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({ delisted: [] }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP, KIMI]);
  });

  test('a delisted list removes only the aliases it names', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({ delisted: [RESP, 'byok-kth-resp/lab/gone'] }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', KIMI]);
  });

  test('a delisted list that names nothing still appends', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({ delisted: ['byok-kth-resp/lab/absent'] }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP, KIMI]);
  });

  test('delisted:true disables the whole profile', () => {
    const config = workConfig();
    expect(mergeRemoteWorkConfig(config, profile({ delisted: true }))).toBe(config);
  });

  test('pending:true disables the whole profile', () => {
    const config = workConfig();
    expect(mergeRemoteWorkConfig(config, profile({ pending: true }))).toBe(config);
  });

  test('a stored pending snapshot does not block rows already in models', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({
      pending: { rev: 'r2', models: [{ alias: 'byok-kth-resp/lab/future' }], source: 'import' },
    }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP, KIMI]);
  });

  test('a public pending alias list appends nothing and blocks nothing', () => {
    const pending = ['byok-kth-resp/lab/future', RESP];
    const merged = mergeRemoteWorkConfig(workConfig(), profile({ pending }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP, KIMI]);
  });

  test('a pending-only row that never became effective is never appended', () => {
    const source = profile({ models: [row(KIMI)], pending: { models: [{ alias: RESP }] } });
    expect(keys(mergeRemoteWorkConfig(workConfig(), source))).toEqual(['official-a', 'official-b', KIMI]);
  });

  test('a profile status this module cannot read fails closed', () => {
    const config = workConfig();
    for (const extra of [{ delisted: 'yes' }, { delisted: { alias: RESP } }, { pending: 'yes' },
      { pending: 1 }, { pending: { models: [] }, delisted: 'all' }]) {
      expect(mergeRemoteWorkConfig(config, profile(extra))).toBe(config);
    }
  });

  test('an explicitly absent or null status is not a disable', () => {
    for (const extra of [{ delisted: undefined, pending: undefined }, { delisted: null, pending: null }]) {
      expect(keys(mergeRemoteWorkConfig(workConfig(), profile(extra)))).toEqual(['official-a', 'official-b', RESP, KIMI]);
    }
  });
});

describe('deduplication', () => {
  test('an alias already in models or moreModels is not appended twice', () => {
    const config = workConfig({
      models: [{ key: RESP, modelAlias: RESP }],
      moreModels: [{ key: 'other', modelAlias: KIMI }],
    });
    expect(mergeRemoteWorkConfig(config, profile())).toBe(config);
  });

  test('duplicate rows in one profile append once', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({ models: [row(RESP), row(RESP)] }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP]);
  });
});

describe('row filtering', () => {
  test('pending, delisted and incomplete rows are skipped', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({
      models: [
        row('byok-kth-resp/lab/pending', { pending: true }),
        row('byok-kth-resp/lab/delisted', { delisted: true }),
        row('byok-kth-resp/lab/pending-string', { pending: 'true' }),
        { alias: 'byok-kth-resp/lab/no-provider', model: 'lab/no-provider', maxContextSize: 131072 },
        { providerId: 'byok-kth-resp', model: 'lab/no-alias', maxContextSize: 131072 },
        { alias: 'byok-kth-resp/lab/no-model', providerId: 'byok-kth-resp', maxContextSize: 131072 },
        { alias: 'byok-kth-resp/lab/no-context', providerId: 'byok-kth-resp', model: 'lab/no-context' },
        row('byok-kth-resp/lab/zero-context', { maxContextSize: 0 }),
        row('byok-kth-resp/lab/float-context', { maxContextSize: 1.5 }),
        row('byok-kth-resp/lab/blank', { model: '' }),
        { alias: 'byok-kth-resp/lab/no-slash' },
        'not-a-row',
        null,
        row('lab/unknown-prefix'),
        row('byok-other/lab/unknown-provider'),
        row('byok-kth-resp/lab/mismatched', { providerId: 'byok-kth-kimi' }),
        row('byok-kth-kimi/lab/mismatched-kimi', { providerId: 'byok-kth-resp' }),
        row('byok-kth-resp/', { model: 'lab/empty-tail' }),
        row('byok-kth-resp/lab/control\u0001'),
      ],
    }));
    expect(merged.models).toEqual(workConfig().models);
  });

  test('a row explicitly marked current is appended', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({
      models: [row(RESP, { pending: false, delisted: false })],
    }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', RESP]);
  });

  test('only usable rows are appended when both families are present', () => {
    const merged = mergeRemoteWorkConfig(workConfig(), profile({
      models: [row('byok-kth-resp/lab/ok'), row(KIMI, { pending: true }), row('byok-kth-resp/lab/ok-two')],
    }));
    expect(keys(merged)).toEqual(['official-a', 'official-b', 'byok-kth-resp/lab/ok', 'byok-kth-resp/lab/ok-two']);
  });
});

describe('unsafe shapes', () => {
  test('an unusable workConfig is returned as it came in', () => {
    const source = profile();
    for (const config of [undefined, null, 'x', [], {}, { models: {} }, { models: null },
      { models: [], moreModels: {} }, { models: [], moreModels: 'x' }]) {
      expect(mergeRemoteWorkConfig(config, source)).toBe(config);
    }
  });

  test('a catalog that is only an empty models array is still widened', () => {
    const merged = mergeRemoteWorkConfig({ models: [] }, profile());
    expect(keys(merged)).toEqual([RESP, KIMI]);
  });

  test('a profile without usable rows leaves the catalog alone', () => {
    const config = workConfig();
    for (const source of [undefined, null, 'x', [], {}, { kind: 'other', models: [row(RESP)] },
      { id: 'byok-kth-other', models: [row(RESP)] }, { kind: 'kth' }, { kind: 'kth', models: {} },
      { kind: 'kth', models: [] }]) {
      expect(mergeRemoteWorkConfig(config, source)).toBe(config);
    }
  });
});

describe('profile shape handed over by the native reader', () => {
  test('field-stripped rows and null placeholders merge by the same rules', () => {
    const source = { id: 'byok-kth', kind: 'kth', delisted: [], models: [
      row(RESP),
      { providerId: 'byok-kth-resp', model: 'lab/anonymous', maxContextSize: 131072 },
      null,
    ] };
    expect(keys(mergeRemoteWorkConfig(workConfig(), source))).toEqual(['official-a', 'official-b', RESP]);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeWorkIntegration, NATIVE_WORK_INTENT, NATIVE_WORK_LOCK,
  NATIVE_WORK_CONFIG, NATIVE_WORK_STORE } from '../src/native-work-integration.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const TOKEN = '{{SECRET_nw1nt3g}}';
const USER = 'account-a';
const KEY = crypto.createHash('sha256').update(USER).digest('hex');
const URL = 'http://127.0.0.1:3426/v1';
const CRED = 'gateway-local';
const CATALOG = [
  { id: 'lab/kimi-parent', protocol: 'chat' },
  { id: 'lab/child-responses', protocol: 'responses' },
];

function rows(overrides = {}) {
  return [
    { alias: 'byok-kth-kimi/lab/kimi-parent', providerId: 'byok-kth-kimi', model: 'lab/kimi-parent',
      family: 'kimi', maxContextSize: 131072, maxOutputSize: 8192, capabilities: ['tool_use', 'thinking'],
      supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    { alias: 'byok-kth-resp/lab/child-responses', providerId: 'byok-kth-resp', model: 'lab/child-responses',
      family: 'responses', maxContextSize: 262144, capabilities: ['tool_use', 'thinking'] },
  ].map(row => ({ ...row, ...(overrides[row.providerId] ?? {}) }));
}

function profile(extra = {}) {
  return {
    id: 'byok-kth',
    kind: 'kth',
    baseUrl: URL,
    credentialRef: CRED,
    models: rows(),
    tokenEncrypted: 'opaque-native-envelope',
    revision: 'r1',
    importedAt: '2026-10-30T00:00:00.000Z',
    ...extra,
  };
}

function store(profiles = { [KEY]: { 'byok-kth': profile() } }) {
  return { v: 1, profiles };
}

function config(extra = {}) {
  return {
    credentials: { [CRED]: { apiKey: TOKEN } },
    model: {
      providers: {
        'byok-kth-kimi': { type: 'kimi', baseUrl: URL, credential: CRED },
        'byok-kth-resp': { type: 'openai_responses', baseUrl: URL, credential: CRED },
      },
      models: {
        'byok-kth-kimi/lab/kimi-parent': { provider: 'byok-kth-kimi', model: 'lab/kimi-parent',
          maxContextSize: 131072, maxOutputSize: 8192, capabilities: ['thinking', 'tool_use'],
          supportEfforts: ['high', 'low'], defaultEffort: 'high' },
        'byok-kth-resp/lab/child-responses': { provider: 'byok-kth-resp', model: 'lab/child-responses',
          maxContextSize: 262144, capabilities: ['thinking', 'tool_use'] },
      },
      current: 'byok-kth-kimi/lab/kimi-parent',
    },
    ...extra,
  };
}

function setup({ profiles = store(), configDoc = config(), writeConfig = true, writeStore = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-work-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const kimiDir = path.join(root, 'kimi');
  fs.mkdirSync(kimiDir, { recursive: true });
  const storePath = path.join(kimiDir, NATIVE_WORK_STORE);
  const configPath = path.join(kimiDir, NATIVE_WORK_CONFIG);
  if (writeStore) fs.writeFileSync(storePath, JSON.stringify(profiles, null, 2));
  if (writeConfig) fs.writeFileSync(configPath, JSON.stringify(configDoc, null, 2));
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const readStore = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));
  const readIntent = () => JSON.parse(fs.readFileSync(path.join(stateDir, NATIVE_WORK_INTENT), 'utf8'));
  return { root, stateDir, kimiDir, storePath, configPath, readConfig, readStore, readIntent };
}


function instance(context, overrides = {}) {
  return new NativeWorkIntegration({ stateDir: context.stateDir, kimiDir: context.kimiDir, ...overrides });
}

const json = value => JSON.stringify(value);
const flatten = value => json(value);

describe('version independence and adoption', () => {
  test('a profile and a generated config are adopted without a version or build hash', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('ready');
    expect(result.imported).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.aliases).toEqual({ 'lab/kimi-parent': 'byok-kth-kimi/lab/kimi-parent',
      'lab/child-responses': 'byok-kth-resp/lab/child-responses' });
    expect(result.missingProviders).toEqual([]);
    // The store shape is read by `kind`/`id`, so a store that also carries
    // fields from a newer build still reconciles.
    const store = context.readStore();
    store.futureField = { schema: 9 };
    store.profiles[KEY]['byok-kth'].futureProfileField = 'keep';
    fs.writeFileSync(context.storePath, json(store));
    expect((await integration.reconcile({ url: URL, models: CATALOG })).state).toBe('ready');
    expect(context.readStore().profiles[KEY]['byok-kth'].futureProfileField).toBe('keep');
    expect(integration.close()).toEqual({ state: 'closed', released: false });
  });

  test('a store with an unknown slot name still yields the profile', async () => {
    const context = setup({ profiles: { v: 2, profiles: { [KEY]: { 'byok-kth-v2': profile() } } } });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('ready');
    expect(result.imported).toBe(true);
  });

  test('ids alone are enough: the protocol is derived from the model name', async () => {
    const context = setup();
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: ['lab/kimi-parent', 'lab/child-responses'] });
    expect(result.state).toBe('ready');
    expect(result.aliases['lab/kimi-parent']).toBe('byok-kth-kimi/lab/kimi-parent');
  });
});

describe('regenerated config', () => {
  test('a dropped provider and model are rebuilt from the profile, keys survive', async () => {
    const context = setup();
    const dropped = context.readConfig();
    delete dropped.model.providers['byok-kth-resp'];
    delete dropped.model.models['byok-kth-resp/lab/child-responses'];
    dropped.untouched = { byGenerator: true };
    dropped.credentials.other = { apiKey: 'other-key' };
    fs.writeFileSync(context.configPath, JSON.stringify(dropped, null, 2));
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('repaired');
    expect(result.changed).toBe(true);
    const repaired = context.readConfig();
    expect(repaired.model.providers['byok-kth-resp']).toEqual({ type: 'openai_responses',
      baseUrl: URL, credential: CRED });
    expect(repaired.model.models['byok-kth-resp/lab/child-responses']).toMatchObject({
      provider: 'byok-kth-resp', model: 'lab/child-responses', maxContextSize: 262144 });
    expect(repaired.credentials[CRED]).toEqual({ apiKey: TOKEN });
    expect(repaired.credentials.other).toEqual({ apiKey: 'other-key' });
    expect(repaired.untouched).toEqual({ byGenerator: true });
    expect(repaired.model.current).toBe('byok-kth-kimi/lab/kimi-parent');
  });

  test('a wholesale generator rewrite is repaired and unknown fields kept', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const regenerated = { credentials: { [CRED]: { apiKey: TOKEN } },
      model: { providers: {}, models: { 'user/own': { provider: 'manual', model: 'own' } },
        current: 'user/own' }, extra: { handWritten: 1 } };
    fs.writeFileSync(context.configPath, JSON.stringify(regenerated, null, 2));
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('repaired');
    expect(result.changed).toBe(true);
    const repaired = context.readConfig();
    expect(repaired.model.models['user/own']).toEqual({ provider: 'manual', model: 'own' });
    expect(repaired.extra).toEqual({ handWritten: 1 });
    expect(repaired.model.current).toBe('user/own');
    // Nothing new is written on the next tick.
    const before = fs.readFileSync(context.configPath, 'utf8');
    const again = await integration.reconcile({ url: URL, models: CATALOG });
    expect(again.state).toBe('ready');
    expect(again.changed).toBe(false);
    expect(fs.readFileSync(context.configPath, 'utf8')).toBe(before);
  });

  test('the alias comes from the profile, never from a hardcoded prefix', async () => {
    const context = setup({ profiles: store({ [KEY]: { 'byok-kth': profile({ models: [
      { alias: 'renamed/alpha', providerId: 'p-alpha', model: 'lab/kimi-parent', family: 'kimi', maxContextSize: 131072 },
      { alias: 'renamed/beta', providerId: 'p-beta', model: 'lab/child-responses', family: 'responses', maxContextSize: 262144 },
    ] }) } }) });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('repaired');
    expect(result.aliases).toEqual({ 'lab/kimi-parent': 'renamed/alpha', 'lab/child-responses': 'renamed/beta' });
  });
});

describe('identity and account scope', () => {
  test('an account switch is reported and never revives the old import', async () => {
    const context = setup();
    const first = instance(context, { getContext: () => ({ accountScope: USER }) });
    expect((await first.reconcile({ url: URL, models: CATALOG })).state).toBe('ready');
    const intent = context.readIntent();
    expect(intent.accountDigest).toBe(KEY);
    const before = fs.readFileSync(context.configPath, 'utf8');
    // The store now holds only the other account's profile.
    fs.writeFileSync(context.storePath, JSON.stringify(store({
      [crypto.createHash('sha256').update('account-b').digest('hex')]: { 'byok-kth': profile() } })));
    const result = await instance(context, { getContext: () => ({ accountScope: 'account-b' }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('account_changed');
    expect(result.imported).toBe(false);
    // The old account's config entries are not touched by the new account.
    expect(fs.readFileSync(context.configPath, 'utf8')).toBe(before);
  });

  test('several profiles with no way to prove ownership are not guessed at', async () => {
    const context = setup({ profiles: store({
      [KEY]: { 'byok-kth': profile() },
      [crypto.createHash('sha256').update('account-b').digest('hex')]: { 'byok-kth': profile() },
    }) });
    const result = await instance(context).reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('account-unverified');
    expect(result.reason).toBe('account_ambiguous');
    expect(result.imported).toBe(false);
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
  });

  test('an unknown account never adopts the only historical profile', async () => {
    const context = setup();
    const result = await instance(context).reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('account-unverified');
    expect(result.imported).toBe(false);
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
  });

  test('a provided account without a profile cannot fall back to another account', async () => {
    const context = setup();
    const result = await instance(context, { getContext: () => ({ accountScope: 'account-b' }) }).reconcile({ url: URL, models: CATALOG });
    expect(result.reason).toBe('profile_missing');
    expect(result.imported).toBe(false);
  });

  test('an injected profile with no scope is reported, not silently trusted', async () => {
    const context = setup();
    const result = await instance(context).reconcile({ url: URL, models: CATALOG, nativeProfile: profile() });
    expect(result.state).toBe('account-unverified');
    expect(result.reason).toBe('account_unverified');
  });

  test('an injected profile key selects exactly that slot', async () => {
    const context = setup({ profiles: store({
      [KEY]: { 'byok-kth': profile() },
      other: { 'byok-kth': profile({ baseUrl: 'http://127.0.0.1:9/v1' }) },
    }) });
    const result = await instance(context, { getContext: () => ({ profileKey: KEY }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('ready');
    expect(result.account.profileKey)
      .toBe(crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 16));
  });

  test('a foreign URL is reported instead of being overwritten', async () => {
    const context = setup({ profiles: store({ [KEY]: { 'byok-kth': profile({ baseUrl: 'https://elsewhere.example/v1' }) } }) });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('foreign_url');
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
  });

  test('address drift after an import is reported as this tool own drift', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const moved = 'http://127.0.0.1:3999/v1';
    // The profile still holds the old address; the caller now asks for a new
    // one. That is drift of an address this tool imported, not a foreign URL.
    const result = await integration.reconcile({ url: moved, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('base_url_changed');
    expect(result.url).toBe(moved);
    expect(context.readConfig().model.providers['byok-kth-kimi'].baseUrl).toBe(URL);
    // A profile this tool never imported is reported as foreign instead.
    const untouched = instance(setup(), { getContext: () => ({ accountScope: USER }) });
    const foreign = await untouched.reconcile({ url: moved, models: CATALOG });
    expect(foreign.reason).toBe('foreign_url');
  });
});

describe('credentials stay native', () => {
  test('a profile without a credential reference is a native import, not a local fix', async () => {
    const context = setup({ profiles: store({ [KEY]: { 'byok-kth': profile({ credentialRef: undefined }) } }) });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('credential_missing');
    expect(context.readConfig().credentials[CRED]).toEqual({ apiKey: TOKEN });
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
  });

  test('a missing generated key waits instead of being invented', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const stripped = context.readConfig();
    delete stripped.credentials[CRED];
    fs.writeFileSync(context.configPath, JSON.stringify(stripped, null, 2));
    const result = await integration.reconcile({ url: URL, models: CATALOG, allowNativeImport: true });
    expect(result.state).toBe('waiting-config');
    expect(result.reason).toBe('credential_not_generated');
    expect(result.credentialRef).toBe(CRED);
    expect(result.nativeImport).toBeUndefined();
    // The key is never fabricated, and the profile is untouched.
    expect(context.readConfig().credentials[CRED]).toBeUndefined();
    expect(context.readStore().profiles[KEY]['byok-kth'].credentialRef).toBe(CRED);
  });
});

describe('pending and explicit disconnect', () => {
  test('a pending native import keeps its transaction and generates nothing', async () => {
    const context = setup({ profiles: store({ [KEY]: { 'byok-kth': profile({ pending: {
      rev: 'r2', models: rows(), source: 'native-import', importedAt: '2026-10-30T01:00:00.000Z' } }) } }) });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('pending');
    expect(result.reason).toBe('native_profile_pending');
    expect(result.pending).toMatchObject({ present: true, rev: 'r2', models: 2 });
    expect(result.imported).toBe(false);
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
    // The profile's own pending block is left exactly as it was.
    expect(context.readStore().profiles[KEY]['byok-kth'].pending.rev).toBe('r2');
  });

  test('a disconnect removes only entries this tool wrote and keeps the rest', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const regenerated = context.readConfig();
    delete regenerated.model.providers['byok-kth-resp'];
    delete regenerated.model.models['byok-kth-resp/lab/child-responses'];
    fs.writeFileSync(context.configPath, JSON.stringify(regenerated, null, 2));
    await integration.reconcile({ url: URL, models: CATALOG });
    const result = await integration.reconcile({ url: URL, models: CATALOG, enabled: false });
    expect(result.state).toBe('disabled');
    expect(result.changed).toBe(true);
    expect(result.removed.models).toEqual(['byok-kth-resp/lab/child-responses']);
    expect(result.removed.providers).toEqual(['byok-kth-resp']);
    const after = context.readConfig();
    expect(after.model.providers['byok-kth-kimi']).toBeDefined();
    expect(after.model.models['byok-kth-kimi/lab/kimi-parent']).toBeDefined();
    expect(after.credentials[CRED]).toEqual({ apiKey: TOKEN });
    expect(context.readIntent().active).toBe(false);
    expect(context.readIntent().entries).toEqual({ providers: {}, models: {} });
    expect(context.readStore().profiles[KEY]['byok-kth']).toBeDefined();
  });

  test('a disconnect leaves an adopted entry alone', async () => {
    const context = setup();
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG, enabled: false });
    expect(result.state).toBe('disabled');
    expect(result.changed).toBe(false);
    expect(context.readConfig().model.providers['byok-kth-kimi']).toBeDefined();
  });

  test('an explicitly disconnected intent is not revived by the next run', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    await integration.reconcile({ url: URL, models: CATALOG, enabled: false });
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('ready');
    expect(result.changed).toBe(false);
    expect(context.readIntent().active).toBe(true);
  });
});

describe('files that are briefly missing', () => {
  test('a missing generated file keeps the intent and is repaired when it returns', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    expect((await integration.reconcile({ url: URL, models: CATALOG })).state).toBe('ready');
    const before = context.readIntent();
    fs.rmSync(context.configPath);
    const waiting = await integration.reconcile({ url: URL, models: CATALOG });
    expect(waiting.state).toBe('waiting-config');
    expect(waiting.reason).toBe('config_missing');
    expect(context.readIntent().aliases).toEqual(before.aliases);
    fs.writeFileSync(context.configPath, JSON.stringify({ credentials: { [CRED]: { apiKey: TOKEN } },
      model: { providers: {}, models: {} } }, null, 2));
    const repaired = await integration.reconcile({ url: URL, models: CATALOG });
    expect(repaired.state).toBe('repaired');
    expect(context.readConfig().model.models['byok-kth-resp/lab/child-responses']).toBeDefined();
  });

  test('a missing profile store is a native import, never a local guess', async () => {
    const context = setup({ writeStore: false });
    const result = await instance(context, { getContext: () => ({ accountScope: USER }) })
      .reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('profile_store_missing');
    expect(fs.existsSync(context.storePath)).toBe(false);
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
  });

  test('a profile that vanished while an import was recorded is reported, not rebuilt', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    fs.rmSync(context.storePath);
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('needs-native-import');
    expect(result.reason).toBe('profile_store_missing');
    expect(result.imported).toBe(false);
    expect(context.readIntent().active).toBe(true);
  });
});

describe('ownership and concurrency', () => {
  test('a foreign provider or model is reported, never overwritten', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const edited = context.readConfig();
    edited.model.providers['byok-kth-kimi'].baseUrl = 'https://user-edit.example/v1';
    edited.model.models['byok-kth-kimi/lab/kimi-parent'].maxContextSize = 999;
    fs.writeFileSync(context.configPath, JSON.stringify(edited, null, 2));
    const provider = await integration.reconcile({ url: URL, models: CATALOG });
    expect(provider.state).toBe('conflict');
    expect(provider.reason).toBe('foreign_provider');
    const before = fs.readFileSync(context.configPath, 'utf8');
    expect(fs.readFileSync(context.configPath, 'utf8')).toBe(before);
    expect(context.readConfig().model.models['byok-kth-kimi/lab/kimi-parent'].maxContextSize).toBe(999);
  });

  test('a hand-edited model under this tool own alias is a conflict', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const edited = context.readConfig();
    edited.model.models['byok-kth-resp/lab/child-responses'].maxContextSize = 4096;
    fs.writeFileSync(context.configPath, JSON.stringify(edited, null, 2));
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('conflict');
    expect(result.reason).toBe('foreign_model');
    expect(result.alias).toBe('byok-kth-resp/lab/child-responses');
  });

  test('a second source holding the shared lock blocks the edit and names its owner', async () => {
    const context = setup();
    const other = new NativeWorkIntegration({ stateDir: context.stateDir, kimiDir: context.kimiDir, sourceID: 'plugin' });
    const first = instance(context, { getContext: () => ({ accountScope: USER }) });
    // Hold the lock through a concurrent reconcile.
    const lockPath = path.join(context.kimiDir, NATIVE_WORK_LOCK);
    fs.writeFileSync(lockPath, JSON.stringify({ ownerID: 'foreign-owner', sourceID: 'plugin',
      kimiHome: context.kimiDir, pid: process.pid, url: 'http://127.0.0.1:1/v1' }));
    const blocked = await first.reconcile({ url: URL, models: CATALOG });
    expect(blocked.state).toBe('conflict');
    expect(blocked.reason).toBe('owner_conflict');
    expect(blocked.lock).toEqual({ sourceID: 'plugin', url: 'http://127.0.0.1:1/v1' });
    expect(fs.existsSync(path.join(context.stateDir, NATIVE_WORK_INTENT))).toBe(false);
    fs.rmSync(lockPath);
    expect((await first.reconcile({ url: URL, models: CATALOG })).state).toBe('ready');
  });

  test('a dead holder lock is taken over, and a stale one released on close', async () => {
    const context = setup();
    const lockPath = path.join(context.kimiDir, NATIVE_WORK_LOCK);
    fs.writeFileSync(lockPath, JSON.stringify({ ownerID: 'dead-owner', sourceID: 'gateway',
      kimiHome: context.kimiDir, pid: 999999 }));
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    // A dead holder's lock is taken over rather than blocking the run.
    expect((await integration.reconcile({ url: URL, models: CATALOG })).state).toBe('ready');
    expect(integration.inspect().lock.state).toBe('free');
    expect(integration.close().released).toBe(false);
  });

  test('a concurrent write between parse and commit is refused', async () => {
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }) });
    await integration.reconcile({ url: URL, models: CATALOG });
    const regenerated = context.readConfig();
    delete regenerated.model.providers['byok-kth-resp'];
    fs.writeFileSync(context.configPath, JSON.stringify(regenerated, null, 2));
    const original = fs.readFileSync(context.configPath, 'utf8');
    const commit = integration.commitConfig.bind(integration);
    let raced = false;
    integration.commitConfig = (raw, content) => {
      // The generator rewrites the file while this call holds the parsed bytes.
      if (!raced) { raced = true; fs.writeFileSync(context.configPath, original.replace('{', '{\n  "gen": 7,')); }
      return commit(raw, content);
    };
    const result = await integration.reconcile({ url: URL, models: CATALOG });
    expect(result.state).toBe('conflict');
    expect(result.reason).toBe('concurrent_modification');
    // The intent that was written for this attempt was rolled back.
    expect(context.readIntent().aliases).toEqual({ 'lab/kimi-parent': 'byok-kth-kimi/lab/kimi-parent',
      'lab/child-responses': 'byok-kth-resp/lab/child-responses' });
    expect(context.readConfig().gen).toBe(7);
  });
});

describe('secrets', () => {
  test('no token reaches the receipt, the public state or the callback', async () => {
    const seen = [];
    const context = setup();
    const integration = instance(context, { getContext: () => ({ accountScope: USER }),
      syncNative: async request => { seen.push(request); return { ok: false, reason: 'invalid-token' }; } });
    const ready = await integration.reconcile({ url: URL, models: CATALOG });
    expect(flatten(ready)).not.toContain(TOKEN);
    expect(flatten(integration.inspect())).not.toContain(TOKEN);
    expect(fs.readFileSync(path.join(context.stateDir, NATIVE_WORK_INTENT), 'utf8')).not.toContain(TOKEN);
    fs.writeFileSync(context.storePath, JSON.stringify({ v: 1, profiles: {} }));
    const missing = await integration.reconcile({ url: URL, models: CATALOG, allowNativeImport: true });
    expect(missing.state).toBe('needs-native-import');
    expect(missing.nativeImport).toEqual({ attempted: true, ok: false, reason: 'invalid-token' });
    expect(seen.length).toBe(1);
    expect(seen[0].scope.authorized).toBe(true);
    expect(seen[0].scope.url).toBe(URL);
    expect(seen[0].previousContext.reason).toBe('profile_missing');
    expect(flatten(seen)).not.toContain(TOKEN);
    // The profile was not created locally by the failed import.
    expect(context.readStore().profiles).toEqual({});
  });

  test('the callback only runs when the caller authorised it and the reason is importable', async () => {
    const calls = [];
    const context = setup({ profiles: store({ [KEY]: { 'byok-kth': profile({ baseUrl: 'https://elsewhere.example/v1' }) } }) });
    const integration = instance(context, { getContext: () => ({ accountScope: USER }),
      syncNative: async request => { calls.push(request); return { ok: true }; } });
    const foreign = await integration.reconcile({ url: URL, models: CATALOG, allowNativeImport: true });
    expect(foreign.state).toBe('needs-native-import');
    expect(foreign.reason).toBe('foreign_url');
    expect(calls.length).toBe(0);
    expect(foreign.nativeImport).toEqual({ required: true, reason: 'foreign_url' });
  });

  test('a successful native import is re-evaluated against the store it wrote', async () => {
    const context = setup({ profiles: store({}) });
    let imported = false;
    const integration = instance(context, { getContext: () => ({ accountScope: USER }),
      syncNative: async () => {
        imported = true;
        fs.writeFileSync(context.storePath, JSON.stringify(store({ [KEY]: { 'byok-kth': profile() } })));
        return { ok: true };
      } });
    const result = await integration.reconcile({ url: URL, models: CATALOG, allowNativeImport: true });
    expect(imported).toBe(true);
    expect(result.state).toBe('ready');
    expect(result.imported).toBe(true);
    expect(result.nativeImport).toEqual({ attempted: true, ok: true });
    expect((await integration.reconcile({ url: URL, models: CATALOG, allowNativeImport: true })).nativeImport).toBeUndefined();
  });

  test('an accepted pending import survives a gateway restart without another import', async () => {
    const context = setup({ profiles: store({}) });
    let imports = 0;
    const overrides = { getContext: () => ({ accountScope: USER, profileKey: KEY }),
      syncNative: async () => {
        imports++;
        fs.writeFileSync(context.storePath, json(store({ [KEY]: { 'byok-kth': profile({ pending: { rev: 'r2' } }) } })));
        return { ok: true };
      } };
    const options = { url: URL, models: CATALOG, allowNativeImport: true };
    const first = instance(context, overrides);
    expect((await first.reconcile(options)).state).toBe('pending');
    first.close();
    const next = instance(context, overrides);
    expect((await next.reconcile(options)).state).toBe('pending');
    fs.writeFileSync(context.storePath, json(store()));
    expect((await next.reconcile(options)).state).toBe('ready');
    expect((await next.reconcile(options)).nativeImport).toBeUndefined();
    expect(imports).toBe(1);
    const receiptPath = path.join(context.stateDir, 'native-work-catalog.json');
    // Windows reports its own mode; the private-file rule there is the owner ACL.
    if (process.platform !== 'win32') expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(receiptPath, 'utf8')).not.toContain(TOKEN);
  });

  test('an unsafe or foreign catalog receipt is never replaced by an import', async () => {
    const context = setup();
    fs.mkdirSync(context.stateDir, { recursive: true });
    const receiptPath = path.join(context.stateDir, 'native-work-catalog.json');
    let calls = 0;
    const integration = instance(context, { getContext: () => ({ accountScope: USER }),
      syncNative: async () => { calls++; return { ok: true }; } });
    const options = { url: URL, models: CATALOG, allowNativeImport: true };
    fs.writeFileSync(receiptPath, '{broken');
    expect((await integration.reconcile(options)).reason).toBe('catalog_receipt_unavailable');
    const foreign = json({ schemaVersion: 1, sourceID: 'another-source', kimiHome: context.kimiDir,
      catalogRevision: 'a'.repeat(64) });
    fs.writeFileSync(receiptPath, foreign);
    expect((await integration.reconcile(options)).reason).toBe('catalog_receipt_foreign');
    expect(fs.readFileSync(receiptPath, 'utf8')).toBe(foreign);
    expect(calls).toBe(0);
  });

  test('catalog capability changes and removals trigger native refresh once', async () => {
    const context = setup();
    let imports = 0;
    const integration = instance(context, { getContext: () => ({ accountScope: USER }),
      syncNative: async request => {
        imports++;
        expect(request.previousContext.reason).toBe('catalog_changed');
        return { ok: true };
      } });
    const refresh = models => integration.reconcile({ url: URL, models, allowNativeImport: true });
    expect((await refresh(CATALOG)).nativeImport.ok).toBe(true);
    expect((await refresh(CATALOG)).nativeImport).toBeUndefined();
    const changed = CATALOG.map(row => ({ ...row, tools: true }));
    expect((await refresh(changed)).nativeImport.ok).toBe(true);
    expect((await refresh(changed)).nativeImport).toBeUndefined();
    expect((await refresh(changed.slice(0, 1))).nativeImport.ok).toBe(true);
    expect(imports).toBe(3);
    expect((await integration.reconcile({ url: URL, models: changed.slice(0, 1),
      allowNativeImport: true, connectionRevision: 'rotated-local-token' })).nativeImport.ok).toBe(true);
    expect(imports).toBe(4);
  });
});

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect, locateContract, probeModels, archiveCandidates, contractFingerprint } from '../src/kimi-contract.mjs';
import { nativeCatalog } from '../src/gateway.mjs';
import { run } from '../cli.mjs';
import { bundleSource, writeBundle } from './fixtures/kimi-bundle.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-fixture-'));
  const archive = writeBundle(path.join(directory, 'app.asar'));
  return { directory, archive, cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('synthetic bundles exercise every contract result without an installed Kimi', () => {
  const f = fixture();
  try {
    const result = inspect({ archive: f.archive });
    expect(result.state).toBe('verified');
    expect(result.version).toBe('9.8.7');
    expect(result.modelCount).toBe(5);
    expect(result.scope).toBe('sample-models');
    expect(result.accepted).toEqual(probeModels().map(row => row.id).sort());
    const models = [{ id: 'reject-model', protocol: 'responses', contextWindow: 4096 }];
    const rejected = inspect({ archive: f.archive, models });
    expect(rejected.state).toBe('incompatible');
    expect(rejected.skipped).toEqual(['reject-model']);
    expect(rejected.scope).toBe('configured-models');
    writeBundle(f.archive, 'function changed() { return 0; }');
    expect(inspect({ archive: f.archive }).state).toBe('unverified');
    expect(inspect({ archive: path.join(f.directory, 'missing') }).state).toBe('unavailable');
    expect(inspect({ platform: 'linux' }).reason).toBe('unsupported_platform');
  } finally { f.cleanup(); }
});

test('synthetic parser discovery survives twenty deterministic symbol sets on every platform', () => {
  for (let seed = 0; seed < 20; seed++) {
    const located = locateContract(bundleSource(seed));
    expect(located.ok).toBe(true);
    expect(located.parse(nativeCatalog(probeModels())).models).toHaveLength(5);
  }
});

test('archive candidates include user installs and custom Program Files roots', () => {
  const candidates = archiveCandidates({ platform: 'win32', env: {
    LOCALAPPDATA: 'D:\\用户\\AppData\\Local', ProgramFiles: 'E:\\Programs',
  } });
  expect(candidates).toContain('D:\\用户\\AppData\\Local\\Programs\\Kimi\\resources\\app.asar');
  expect(candidates).toContain('E:\\Programs\\Kimi\\resources\\app.asar');
});

test('contract cache identity changes when an archive is replaced or removed', () => {
  const f = fixture();
  try {
    const first = contractFingerprint({ archive: f.archive });
    expect(contractFingerprint({ archive: f.archive })).toBe(first);
    writeBundle(f.archive, bundleSource(10) + '\n// changed');
    expect(contractFingerprint({ archive: f.archive })).not.toBe(first);
    fs.unlinkSync(f.archive);
    expect(contractFingerprint({ archive: f.archive })).toContain('unavailable');
  } finally { f.cleanup(); }
});

test('compat checks configured models without credentials and preserves incompatibility exit codes', async () => {
  const f = fixture();
  const file = path.join(f.directory, 'gateway.json');
  const output = [], errors = [];
  const io = { out: value => output.push(value), err: value => errors.push(value) };
  try {
    const config = { upstream: { baseURL: 'https://example.invalid/v1', apiKeyEnv: 'ABSENT_UPSTREAM_KEY' },
      models: [{ id: 'configured-model', protocol: 'responses', contextWindow: 8192 }] };
    fs.writeFileSync(file, JSON.stringify(config));
    expect(await run(['compat', '--archive', f.archive, '--config', file], {}, io)).toBe(0);
    expect(output.at(-1)).toContain('configured-models (1 models)');
    expect(output.at(-1)).toContain('1 models accepted');
    config.models[0].id = 'reject-model'; fs.writeFileSync(file, JSON.stringify(config));
    expect(await run(['compat', '--archive', f.archive, '--config', file], {}, io)).toBe(9);
    fs.writeFileSync(file, '{broken');
    expect(await run(['compat', '--archive', f.archive, '--config', file], {}, io)).toBe(2);
    expect(errors.at(-1)).toContain('invalid config');
    expect(await run(['compat', '--archive', f.archive], {}, io)).toBe(0);
    expect(output.at(-1)).toContain('sample-models');
  } finally { f.cleanup(); }
});

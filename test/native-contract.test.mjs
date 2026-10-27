import { test, expect } from 'bun:test';
import { nativeCatalog, validateModels } from '../src/index.mjs';
import { inspectKimiContract as inspect, summarizeKimiContract as summarize,
  probeModels, locateContract, readAsarEntry } from '../src/index.mjs';
import fs from 'node:fs';

const archive = '/Applications/Kimi.app/Contents/Resources/app.asar';
const hasKimi = process.platform === 'darwin' && fs.existsSync(archive);

// The probe reads the installed bundle by shape, not by symbol name, so this
// asserts the contract and not a particular Kimi build. A bundle it cannot
// read is reported as `unverified`; that is deliberately not a failure, since
// the gateway only emits the documented api.json shape and never patches Kimi.
test.skipIf(!hasKimi)('the installed Kimi parser accepts the generated catalog', () => {
  const result = inspect();
  expect(['verified', 'unverified', 'unavailable']).toContain(result.state);
  if (result.state !== 'verified') return;

  expect(result.skipped).toHaveLength(0);
  expect(result.accepted.sort()).toEqual(probeModels().map(row => row.id).sort());
  expect(result.families['kimi-probe-model']).toBe('kimi');
  expect(result.families['gpt-probe-model']).toBe('gpt');
  expect(result.families['plain-probe-id']).toBe('generic');
});

test.skipIf(!hasKimi)('the probe reports the runtime contract markers it depends on', () => {
  const result = inspect();
  if (result.state === 'unverified' && !result.contracts) return;
  expect(result.contracts).toBeDefined();
  expect(result.contracts.native_byok_flag).toBe(true);
  expect(result.contracts.native_profile_store).toBe(true);
  expect(result.contracts.native_catalog_route).toBe(true);
});

test.skipIf(!hasKimi)('the probe never depends on obfuscated symbol names', () => {
  const text = readAsarEntry(archive);
  const located = locateContract(text);
  if (!located.ok) return;
  // Whatever the current build calls them, the located symbols must be the
  // ones the structure points at, not names written down here.
  expect(text.includes('function ' + located.table + '(')).toBe(true);
  expect(text.includes('function ' + located.decoder + '(')).toBe(true);
  expect(text.includes('function ' + located.parser + '(')).toBe(true);
});

test('summarize explains every state without throwing', () => {
  for (const state of ['verified', 'incompatible', 'unverified', 'unavailable']) {
    const text = summarize({ state, reason: 'synthetic', accepted: [], skipped: [] });
    expect(text).toContain('kimi: unknown');
    expect(text.length).toBeGreaterThan(0);
  }
  expect(summarize({ state: 'verified', accepted: [{ model: 'a' }], skipped: [] }))
    .toContain('1 models accepted');
  expect(summarize({ state: 'incompatible', reason: 'models_skipped', skipped: ['x'] }))
    .toContain('INCOMPATIBLE');
});

test('models that declare no capabilities do not claim tools or reasoning', () => {
  const groups = nativeCatalog(validateModels([{ id: 'bare', protocol: 'responses', contextWindow: 4096 }]));
  expect(groups.responses.models.bare).toEqual({
    name: 'bare',
    limit: { context: 4096 },
    tool_call: false,
    reasoning: false,
    modalities: { input: ['text'], output: ['text'] },
  });
});

test('the kimi group is emitted only for chat models and keeps its limits', () => {
  const groups = nativeCatalog(validateModels([
    { id: 'kimi-x', protocol: 'chat', contextWindow: 262144, maxOutputTokens: 32768,
      tools: true, reasoning: true, inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
    { id: 'plain', protocol: 'responses', contextWindow: 8192 },
  ]));
  expect(Object.keys(groups).sort()).toEqual(['kimi', 'responses']);
  expect(groups.kimi.models['kimi-x']).toMatchObject({
    limit: { context: 262144, output: 32768 },
    tool_call: true, reasoning: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    support_efforts: ['low', 'high'], default_effort: 'high',
  });
  expect(groups.responses.models.plain.tool_call).toBe(false);
});

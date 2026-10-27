import { test, expect } from 'bun:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { locateContract, readAsarEntry, probeModels } from '../src/kimi-contract.mjs';
import { nativeCatalog } from '../src/gateway.mjs';

// Kimi renames every obfuscated symbol on each release. This test simulates
// that drift on the real bundle instead of on a stand-in: every `_0x…` name is
// replaced with a fresh random one, so any name the probe had learned from the
// installed build becomes wrong, while the structure stays untouched.
//
// A probe that keeps working across these rounds does not depend on a build.

const archive = '/Applications/Kimi.app/Contents/Resources/app.asar';
const available = process.platform === 'darwin' && fs.existsSync(archive);

function renameSymbols(text) {
  // Collecting every symbol first keeps this linear: a per-match `includes`
  // over a 10 MB bundle is quadratic and takes minutes.
  const originals = [...new Set(text.match(/_0x[0-9a-f]+/g))];
  const taken = new Set(originals);
  const mapping = new Map();
  for (const original of originals) {
    let replacement;
    do {
      replacement = '_0x' + crypto.randomBytes(4).toString('hex');
    } while (taken.has(replacement));
    taken.add(replacement);
    mapping.set(original, replacement);
  }
  return text.replace(/_0x[0-9a-f]+/g, original => mapping.get(original));
}

test.skipIf(!available)('the probe survives a full symbol rename of the installed bundle', () => {
  const original = readAsarEntry(archive);
  const catalog = nativeCatalog(probeModels());
  let rounds = 0;

  for (let round = 0; round < 3; round++) {
    const renamed = renameSymbols(original);
    // Nothing the probe previously knew by name may survive.
    const baseline = locateContract(original);
    if (!baseline.ok) return;
    expect(renamed.includes('function ' + baseline.table + '(')).toBe(false);

    const located = locateContract(renamed);
    expect(located.ok).toBe(true);
    if (!located.ok) continue;
    rounds++;

    const parsed = located.parse(catalog);
    expect(parsed.skippedModels).toHaveLength(0);
    const families = Object.fromEntries(parsed.models.map(row => [row.model, row.family]));
    expect(families['kimi-probe-model']).toBe('kimi');
    expect(families['gpt-probe-model']).toBe('gpt');
    expect(families['plain-probe-id']).toBe('generic');
  }
  expect(rounds).toBe(3);
});

test.skipIf(!available)('renamed symbols never coincide with the ones the probe pins', () => {
  const original = readAsarEntry(archive);
  const baseline = locateContract(original);
  if (!baseline.ok) return;
  const renamed = renameSymbols(original);
  // The names the installed build used must be gone, and the names the probe
  // discovers in the copy must be different ones. `_0x59c770` is the only
  // symbol the source still spells out as a fallback, so its presence after a
  // rename would mean the mapping missed it.
  expect(renamed.includes('function ' + baseline.decoder + '(')).toBe(false);
  expect(renamed.includes('function ' + baseline.parser + '(')).toBe(false);
  expect(renamed.includes(baseline.table + '()')).toBe(false);

  const relocated = locateContract(renamed);
  expect(relocated.ok).toBe(true);
  if (!relocated.ok) return;
  expect(relocated.decoder).not.toBe(baseline.decoder);
  expect(relocated.parser).not.toBe(baseline.parser);
  expect(relocated.table).not.toBe(baseline.table);
});

test('locating a bundle that is not an obfuscated Kimi build reports a reason', () => {
  const located = locateContract('function nothing() { return 1; }');
  expect(located.ok).toBe(false);
  expect(located.reason).toBe('table_not_found');
});

import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeAccountContext } from '../src/native-account-context.mjs';

const roots = [], profileKey = crypto.createHash('sha256').update('synthetic-account').digest('hex');
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-account-context-'));
  roots.push(root);
  const kimiDir = path.join(root, 'app', 'daimon-share', 'daimon'), authFile = path.join(root, 'auth.json');
  fs.mkdirSync(kimiDir, { recursive: true });
  fs.writeFileSync(authFile, 'opaque synthetic encrypted state');
  fs.writeFileSync(path.join(kimiDir, 'byok-providers.json'), JSON.stringify({ profiles: { [profileKey]: { 'byok-kth': { kind: 'kth' } } } }));
  fs.writeFileSync(path.join(kimiDir, 'config.json'), JSON.stringify({ model: { models: {}, providers: {} }, credentials: {} }));
  return { root, kimiDir, authFile, context: new NativeAccountContext({ kimiDir, authFile }) };
}

test('a captured native account remains usable across instances and generated-config rebuilds without version metadata', () => {
  const f = fixture();
  expect(f.context.read()).toEqual({});
  f.context.capture(profileKey);
  fs.writeFileSync(path.join(f.kimiDir, 'config.json'), '{}');
  expect(new NativeAccountContext({ kimiDir: f.kimiDir, authFile: f.authFile }).read()).toEqual({ accountScope: profileKey, profileKey });
  expect(fs.readFileSync(f.context.file, 'utf8')).not.toContain('opaque synthetic encrypted state');
});

test('the native current-user field initializes automatically and survives token refresh without reimport', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.kimiDir, 'config.json'), JSON.stringify({ credentials: { kimiWeb: { userId: 'synthetic-account' } } }));
  expect(f.context.read()).toEqual({ accountScope: profileKey, profileKey });
  fs.writeFileSync(f.authFile, 'refreshed opaque synthetic encrypted state');
  expect(f.context.read()).toEqual({ accountScope: profileKey, profileKey });
  const next = crypto.createHash('sha256').update('another-account').digest('hex');
  fs.writeFileSync(path.join(f.kimiDir, 'config.json'), JSON.stringify({ credentials: { kimiWeb: { userId: 'another-account' } } }));
  expect(f.context.read()).toEqual({ accountScope: next, profileKey: next });
});

test('changing native authentication state invalidates the proof even when one historical profile remains', () => {
  const f = fixture();
  f.context.capture(profileKey);
  fs.writeFileSync(f.authFile, 'different opaque synthetic encrypted state');
  expect(f.context.read()).toEqual({});
  expect(fs.existsSync(f.context.file)).toBe(true);
});

test('missing identity never guesses a profile and symlinked authentication state is refused', () => {
  const f = fixture();
  expect(f.context.read()).toEqual({});
  const link = path.join(f.root, 'auth-link.json');
  fs.symlinkSync(f.authFile, link);
  const context = new NativeAccountContext({ kimiDir: f.kimiDir, authFile: link });
  expect(context.read()).toEqual({});
  expect(() => context.capture(profileKey)).toThrow('native_account_unavailable');
});

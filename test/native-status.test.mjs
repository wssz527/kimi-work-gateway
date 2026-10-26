import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSetupProbe } from '../src/index.mjs';
import { copySetupToken } from '../src/native-clipboard.mjs';

function fixture(value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-status-'));
  const flagFile = path.join(directory, 'kimi-agent', 'byok-availability.json');
  if (value !== undefined) {
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, value);
  }
  return { directory, flagFile, cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('the probe separates a revealed flag from an actually reachable intranet name', async () => {
  const f = fixture(JSON.stringify({ revealed: true }));
  try {
    const failing = new NativeSetupProbe({ flagFile: f.flagFile, lookupFn: async () => ({ address: '203.0.113.9' }) });
    expect(await failing.check()).toEqual({ revealed: true, flag: 'revealed',
      intranet: { passed: false, address: '203.0.113.9' } });
    const passing = new NativeSetupProbe({ flagFile: f.flagFile, lookupFn: async () => ({ address: '10.255.255.254' }) });
    expect((await passing.check()).intranet).toEqual({ passed: true, address: '10.255.255.254' });
  } finally { f.cleanup(); }
});

test('a missing or unreadable flag is reported without pretending setup succeeded', async () => {
  const missing = fixture();
  try {
    const probe = new NativeSetupProbe({ flagFile: missing.flagFile, lookupFn: async () => ({ address: '10.0.0.1' }) });
    expect((await probe.check()).flag).toBe('missing');
  } finally { missing.cleanup(); }
  for (const [value, flag] of [['not json', 'unavailable'], ['[]', 'hidden'], ['{"revealed":false}', 'hidden']]) {
    const f = fixture(value);
    try {
      const probe = new NativeSetupProbe({ flagFile: f.flagFile, lookupFn: async () => ({ address: '10.0.0.1' }) });
      const result = await probe.check();
      expect(result.flag).toBe(flag);
      expect(result.revealed).toBe(false);
    } finally { f.cleanup(); }
  }
});

test('a lookup that never answers is reported as unavailable, not as success', async () => {
  const f = fixture('{"revealed":true}');
  try {
    const probe = new NativeSetupProbe({ flagFile: f.flagFile, timeoutMs: 20,
      lookupFn: () => new Promise(() => {}) });
    expect((await probe.check()).intranet).toEqual({ passed: false, error: 'dns_unavailable' });
  } finally { f.cleanup(); }
});

test('the probe caches a lookup so repeated checks do not re-resolve', async () => {
  const f = fixture('{"revealed":true}');
  let calls = 0;
  try {
    const probe = new NativeSetupProbe({ flagFile: f.flagFile, lookupFn: async () => { calls++; return { address: '10.0.0.1' }; } });
    await probe.check();
    await probe.check();
    expect(calls).toBe(1);
  } finally { f.cleanup(); }
});

test('clipboard copying needs a fresh request and records only the request id', async () => {
  const f = fixture();
  try {
    const copied = [];
    const request = { id: 'a'.repeat(32), at: Date.now() };
    expect(copySetupToken({ request: { ...request, at: 0 }, stateDir: f.directory, key: 'secret', copy: v => copied.push(v) }))
      .toBe('expired');
    expect(copySetupToken({ request, stateDir: f.directory, key: '', copy: v => copied.push(v) })).toBe('unavailable');
    expect(copySetupToken({ request, stateDir: f.directory, key: 'secret', copy: v => copied.push(v) })).toBe('copied');
    expect(copySetupToken({ request, stateDir: f.directory, key: 'secret', copy: v => copied.push(v) })).toBe('copied');
    expect(copied).toEqual(['secret']);
    const receipt = fs.readFileSync(path.join(f.directory, 'native-copy-receipt.json'), 'utf8');
    expect(receipt).not.toContain('secret');
    expect(copySetupToken({ request: { ...request, id: 'b'.repeat(32) }, stateDir: f.directory, key: 'secret',
      copy: () => { throw Error('no clipboard'); } })).toBe('unavailable');
  } finally { f.cleanup(); }
});

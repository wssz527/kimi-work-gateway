import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSetup, resolverScript, hostsScript, updateHosts, hostsEntry, HOSTS_MARKER, DEFAULT_HOSTS,
  verdictFailure } from '../src/native-setup.mjs';
import { resolverConfiguration } from '../src/native-dns.mjs';

function fixture(platform, admin, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-win-'));
  const stateDir = path.join(directory, 'state'), support = path.join(directory, 'kimi-desktop');
  fs.mkdirSync(stateDir); fs.mkdirSync(support);
  const flagFile = path.join(support, 'kimi-agent', 'byok-availability.json');
  const hostsPath = path.join(directory, 'hosts');
  return { directory, stateDir, flagFile, hostsPath, admin,
    setup: new NativeSetup({ stateDir, flagFile, platform, admin, hostsPath, ...extra }),
    request(action = 'prepare') { return { action, id: crypto.randomUUID(), at: Date.now() }; },
    cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('windows setup runs the hosts script and reveals the same flag', async () => {
  let script = null;
  const f = fixture('win32', async value => { script = value; });
  try {
    const result = await f.setup.run(f.request('prepare'));
    expect(result).toEqual({ action: 'prepare', state: 'done' });
    expect(script).toContain("$path = '" + f.hostsPath.replaceAll("'", "''") + "'");
    expect(script).toContain(HOSTS_MARKER);
    expect(script).toContain(hostsEntry());
    expect(script).toContain('ipconfig /flushdns');
    // No macOS-only behaviour may leak into the Windows path.
    expect(script).not.toContain('osascript');
    expect(script).not.toContain('/etc/resolver');
    expect(JSON.parse(fs.readFileSync(f.flagFile, 'utf8'))).toEqual({ revealed: true });
  } finally { f.cleanup(); }
});

test('a platform other than macos and windows is still refused before any prompt', async () => {
  let calls = 0;
  const f = fixture('linux', async () => { calls++; });
  try {
    expect((await f.setup.run(f.request())).state).toBe('unsupported-platform');
    expect(calls).toBe(0);
  } finally { f.cleanup(); }
});

test('the hosts editor round-trips BOM, mixed newlines, blank lines and the original EOF', () => {
  for (const original of ['', '127.0.0.1 localhost', '127.0.0.1 localhost\r\n# mixed\n\n', '\uFEFF# comment\nlast']) {
    expect(updateHosts(original, 'remove-dns')).toEqual({ content: original, changed: false });
    const added = updateHosts(original, 'prepare');
    expect(added.changed).toBe(true);
    expect(updateHosts(added.content, 'prepare')).toEqual({ content: added.content, changed: false });
    expect(updateHosts(added.content, 'remove-dns').content).toBe(original);
  }
  const original = Buffer.from([239, 187, 191, 35, 32, 255, 13, 10]);
  const added = updateHosts(original, 'prepare');
  expect(updateHosts(added.content, 'remove-dns').content).toEqual(original);
  expect(() => updateHosts(Buffer.from([255, 254, 0, 65]), 'prepare')).toThrow('unsupported_hosts_encoding');
});

test('manual entries satisfy prepare without granting removal ownership', () => {
  for (const entry of [hostsEntry(), '10.255.255.254\tDEV.MSH.TEAM # manual']) {
    const original = '127.0.0.1 localhost\r\n' + entry;
    for (const action of ['prepare', 'remove-dns']) {
      expect(updateHosts(original, action)).toEqual({ content: original, changed: false });
    }
  }
});

test('foreign aliases and damaged owned pairs are preserved as conflicts', () => {
  for (const original of ['192.0.2.1 DEV.MSH.TEAM\n', '10.255.255.254 dev.msh.team other\n', HOSTS_MARKER + '\n', HOSTS_MARKER + '\n192.0.2.1 dev.msh.team\n']) {
    for (const action of ['prepare', 'remove-dns']) expect(() => updateHosts(original, action)).toThrow('resolver_conflict');
  }
  expect(() => updateHosts('127.0.0.1 localhost # dev.msh.team', 'prepare')).not.toThrow();
  const legacy = '127.0.0.1 localhost\n' + HOSTS_MARKER + '\n' + hostsEntry() + '\n';
  expect(updateHosts(legacy, 'remove-dns').content).toBe('127.0.0.1 localhost\n');
});

test('a conflict raised by the elevated script maps to resolver-conflict', async () => {
  const f = fixture('win32', async () => { throw verdictFailure('resolver_conflict'); });
  try {
    expect((await f.setup.run(f.request('prepare'))).state).toBe('resolver-conflict');
    expect(fs.existsSync(f.flagFile)).toBe(false);
  } finally { f.cleanup(); }
});

test('a cancelled UAC prompt maps to cancelled without retrying', async () => {
  let calls = 0;
  const f = fixture('win32', async () => { calls++; throw Error('setup_cancelled'); });
  try {
    const request = f.request('prepare');
    expect((await f.setup.run(request)).state).toBe('cancelled');
    expect((await f.setup.run(request)).state).toBe('cancelled');
    expect(calls).toBe(1);
    expect(fs.existsSync(f.flagFile)).toBe(false);
  } finally { f.cleanup(); }
});

test('only an explicit successful verdict is accepted', () => {
  expect(verdictFailure('resolver_conflict').stderr).toBe('resolver_conflict');
  expect(verdictFailure('anything_else').stderr).toBe('anything_else');
  expect(verdictFailure('').message).toBe('setup_report_missing');
  expect(verdictFailure('done')).toBe(null);
});

test('the windows script uses literal paths, byte writes and readback verification', () => {
  const script = hostsScript('prepare', DEFAULT_HOSTS, true, "C:\\Temp\\user's $report");
  expect(script).toContain("$path = '" + DEFAULT_HOSTS + "'");
  expect(script).toContain("$report = 'C:\\Temp\\user''s $report'");
  expect(script).toContain('[System.IO.File]::WriteAllBytes');
  expect(script).toContain('hosts_verify_failed');
  expect(script).toContain('Write-Verdict "done"');
  expect(script).toContain("-split '\\s+'");
  expect(script).not.toContain('Set-Content');
});

test('the macos resolver script is unchanged byte for byte', () => {
  // The installed resolver is compared against this exact text, so an earlier
  // installation must keep matching after an upgrade.
  expect(resolverConfiguration().content)
    .toBe('# Magpie Kimi Work native BYOK\nnameserver 127.0.0.1\nport 53535\ntimeout 1\n');
  const script = resolverScript('prepare', '/tmp/source');
  expect(script).toContain("'/etc/resolver/dev.msh.team'");
  expect(script).toContain('/usr/bin/dscacheutil -flushcache');
  expect(script).not.toContain('powershell');
});

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeSetup, resolverScript, hostsScript, updateHosts, hostsEntry, HOSTS_MARKER, DEFAULT_HOSTS }
  from '../src/native-setup.mjs';
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
    expect(script).toContain(f.hostsPath);
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

test('the hosts editor adds its two lines and leaves everything else byte-identical', () => {
  const original = '127.0.0.1 localhost\r\n10.0.0.5 build.local\r\n';
  const added = updateHosts(original, 'prepare');
  expect(added.content).toBe(original + HOSTS_MARKER + '\r\n' + hostsEntry() + '\r\n');
  expect(added.content.split('\r\n')[0]).toBe('127.0.0.1 localhost');

  const removed = updateHosts(added.content, 'remove-dns');
  expect(removed.content).toBe(original);
});

test('the hosts editor is idempotent and preserves a BOM', () => {
  const original = '\uFEFF127.0.0.1 localhost\n';
  const once = updateHosts(original, 'prepare');
  const twice = updateHosts(once.content, 'prepare');
  expect(twice.content).toBe(once.content);
  expect(twice.changed).toBe(false);
  expect(once.content.startsWith('\uFEFF')).toBe(true);
  expect(once.content.match(new RegExp(hostsEntry().replaceAll('.', '\\.'), 'g'))).toHaveLength(1);
});

test('an existing entry written by hand is adopted, not duplicated', () => {
  const original = '127.0.0.1 localhost\n' + hostsEntry() + '\n';
  const prepared = updateHosts(original, 'prepare');
  // Adopted as it stands: the file the user maintains is not rewritten.
  expect(prepared.content).toBe(original);
  expect(prepared.changed).toBe(false);
  // Removing still works, because the entry is the one this tool manages.
  expect(updateHosts(prepared.content, 'remove-dns').content).toBe('127.0.0.1 localhost\n');
});

test('another program claiming the name is a conflict, never shadowed', () => {
  const original = '127.0.0.1 localhost\n1.2.3.4 dev.msh.team\n';
  expect(() => updateHosts(original, 'prepare')).toThrow('resolver_conflict');
  expect(() => updateHosts(original, 'remove-dns')).toThrow('resolver_conflict');
  // Comments mentioning the name are not a claim.
  const commented = '# see dev.msh.team\n127.0.0.1 localhost\n';
  expect(() => updateHosts(commented, 'prepare')).not.toThrow();
});

test('removing when nothing was installed changes nothing', () => {
  const original = '127.0.0.1 localhost\n';
  expect(updateHosts(original, 'remove-dns').content).toBe(original);
});

test('a conflict raised by the elevated script maps to resolver-conflict', async () => {
  const f = fixture('win32', async () => {
    const failure = new Error('command failed');
    failure.stderr = 'resolver_conflict';
    throw failure;
  });
  try {
    expect((await f.setup.run(f.request('prepare'))).state).toBe('resolver-conflict');
    expect(fs.existsSync(f.flagFile)).toBe(false);
  } finally { f.cleanup(); }
});

test('a cancelled UAC prompt maps to cancelled without retrying', async () => {
  let calls = 0;
  const f = fixture('win32', async () => {
    calls++;
    const failure = new Error('The operation was canceled by the user.');
    throw failure;
  });
  try {
    expect((await f.setup.run(f.request('prepare'))).state).toBe('cancelled');
    expect(calls).toBe(1);
  } finally { f.cleanup(); }
});

test('the windows script rewrites only the lines it owns', () => {
  const script = hostsScript('prepare', DEFAULT_HOSTS);
  expect(script).toContain(JSON.stringify(DEFAULT_HOSTS));
  expect(script).toContain('$bom');
  expect(script).toContain('ipconfig /flushdns');
  // It must never clobber the file wholesale.
  expect(script).not.toContain('Set-Content -Value @"');
  expect(hostsScript('remove-dns')).not.toContain('[void]$kept.Add($marker)');
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

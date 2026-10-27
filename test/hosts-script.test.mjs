import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NativeSetup, defaultHostsPath, elevationCommand, hostsScript, hostsEntry, HOSTS_MARKER,
  updateHosts, windowsAdministrator } from '../src/native-setup.mjs';

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-script-'));
  return { directory, report: path.join(directory, 'report'), cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('Windows hosts discovery follows SystemRoot and supports explicit overrides', () => {
  expect(defaultHostsPath({ SystemRoot: 'D:\\WinDir' })).toBe('D:\\WinDir\\System32\\drivers\\etc\\hosts');
  expect(new NativeSetup({ hostsPath: 'custom' }).hostsPath).toBe('custom');
});

test('elevation transports Unicode script and paths without command-line quoting loss', () => {
  const script = hostsScript('prepare', "D:\\用户 name\\user's $file`name", false, 'D:\\用户 name\\report');
  const command = elevationCommand(script);
  const encoded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(command)?.[1];
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script);
  expect(command).toContain('-Wait -PassThru');
  expect(command).toContain('NativeErrorCode -ne 1223');
});

test('elevation requires both a successful child and a successful report', async () => {
  const f = fixture();
  try {
    await expect(windowsAdministrator('script', f.report, async () => {})).rejects.toThrow('setup_report_missing');
    for (const verdict of ['resolver_conflict', 'hosts_edit_failed', 'damaged']) {
      fs.writeFileSync(f.report, verdict);
      await expect(windowsAdministrator('script', f.report, async () => {})).rejects.toThrow(verdict);
    }
    fs.writeFileSync(f.report, 'done');
    expect(await windowsAdministrator('script', f.report, async () => {})).toBe('done');
    await expect(windowsAdministrator('script', f.report, async () => { throw Error('child_failed'); })).rejects.toThrow('child_failed');
    await expect(windowsAdministrator('script', f.report, async () => {
      throw Object.assign(Error('localized cancellation'), { stderr: 'setup_cancelled' });
    })).rejects.toThrow('setup_cancelled');
  } finally { f.cleanup(); }
});

test('a child without a verdict cannot reveal the native flag', async () => {
  const f = fixture();
  const support = path.join(f.directory, 'support');
  fs.mkdirSync(support);
  const flagFile = path.join(support, 'kimi-agent', 'byok-availability.json');
  const setup = new NativeSetup({ stateDir: f.directory, flagFile, platform: 'win32',
    admin: (script, report) => windowsAdministrator(script, report, async () => {}) });
  try {
    expect((await setup.run({ action: 'prepare', id: crypto.randomUUID(), at: Date.now() })).state).toBe('failed');
    expect(fs.existsSync(flagFile)).toBe(false);
  } finally { f.cleanup(); }
});

test.skipIf(process.platform !== 'win32')('generated PowerShell edits real temporary files identically to the byte editor', () => {
  const f = fixture();
  const directory = path.join(f.directory, "用户 name ' $dollar`tick [x]");
  fs.mkdirSync(directory);
  const hosts = path.join(directory, 'hosts');
  const run = action => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(hostsScript(action, hosts, false, f.report), 'utf16le').toString('base64')], { stdio: 'pipe', timeout: 10000 });
  try {
    for (const original of [Buffer.alloc(0), Buffer.from('127.0.0.1 localhost'),
      Buffer.from('\uFEFF# Unicode 中文\r\n127.0.0.1 localhost\n\n'), Buffer.from([35, 32, 255, 13, 10])]) {
      fs.writeFileSync(hosts, original);
      run('prepare');
      expect(fs.readFileSync(hosts)).toEqual(updateHosts(original, 'prepare').content);
      expect(fs.readFileSync(f.report, 'utf8')).toBe('done');
      fs.utimesSync(hosts, 100000, 100000);
      const before = fs.statSync(hosts).mtimeMs;
      run('prepare');
      expect(fs.statSync(hosts).mtimeMs).toBe(before);
      run('remove-dns');
      expect(fs.readFileSync(hosts)).toEqual(original);
    }
    const manual = Buffer.from(hostsEntry() + ' # manual');
    fs.writeFileSync(hosts, manual);
    run('prepare'); run('remove-dns');
    expect(fs.readFileSync(hosts)).toEqual(manual);
    for (const conflict of ['192.0.2.1 DEV.MSH.TEAM', HOSTS_MARKER + '\n', '10.255.255.254 dev.msh.team alias']) {
      fs.writeFileSync(hosts, conflict);
      expect(() => run('prepare')).toThrow();
      expect(fs.readFileSync(hosts, 'utf8')).toBe(conflict);
      expect(fs.readFileSync(f.report, 'utf8')).toBe('resolver_conflict');
    }
    fs.unlinkSync(hosts); fs.mkdirSync(hosts);
    expect(() => run('prepare')).toThrow();
    expect(fs.readFileSync(f.report, 'utf8')).toBe('hosts_edit_failed');
  } finally { f.cleanup(); }
}, 120000);

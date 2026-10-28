import { test, expect } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { defaultStateDirectory } from '../src/paths.mjs';
import {
  GatewayUpdater, gatewayPackageTreeDigest, gatewayUpdateDirectory, inspectGatewayPackage,
} from '../src/update-manager.mjs';

const API_URL = 'https://api.github.com/repos/wssz527/kimi-work-gateway/releases/latest';
const DOWNLOAD = 'https://github.com/wssz527/kimi-work-gateway/releases/download';

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-update-'));
  return {
    directory,
    updateDir: path.join(directory, 'state', 'program-updates'),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
    file(...parts) { return path.join(directory, ...parts); },
  };
}

function makePackage(root, { version = '0.6.0', name = 'kimi-work-gateway', files = {}, bin = './bin/kimi-work-gateway.mjs' } = {}) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  const entries = {
    'package.json': JSON.stringify({ name, version, type: 'module', main: './src/index.mjs',
      bin: { 'kimi-work-gateway': bin } }, null, 2),
    'cli.mjs': 'export async function main() { return "' + version + '"; }\n',
    'src/index.mjs': 'export const version = "' + version + '";\n',
    'bin/kimi-work-gateway.mjs': '#!/usr/bin/env node\nimport { main } from "../cli.mjs";\nawait main();\n',
    ...files,
  };
  for (const [relative, content] of Object.entries(entries)) {
    if (content === null) continue;
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function pack(base, packageRoot, name = 'asset.tgz') {
  const target = path.join(base, name);
  execFileSync('tar', ['-czf', target, '-C', path.dirname(packageRoot), 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: 'pipe',
  });
  return target;
}

function tarHeader(name, size, type = '0', linkname = '') {
  const header = Buffer.alloc(512);
  Buffer.from(name, 'utf8').copy(header, 0, 0, 100);
  header.write(type === '5' ? '0000755\0' : '0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 'latin1');
  if (linkname) Buffer.from(linkname, 'utf8').copy(header, 157, 0, 100);
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const body = entry.type === '5' ? Buffer.alloc(0) : Buffer.from(entry.content ?? '', 'utf8');
    blocks.push(tarHeader(entry.name, body.length, entry.type ?? '0', entry.linkname ?? ''));
    if (body.length) blocks.push(body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function packageEntries({ version = '0.6.0', overrides = {}, extra = [], omit = [] } = {}) {
  const files = {
    'package/package.json': JSON.stringify({ name: 'kimi-work-gateway', version, main: './src/index.mjs',
      bin: { 'kimi-work-gateway': './bin/kimi-work-gateway.mjs' } }),
    'package/cli.mjs': 'export async function main() { return "' + version + '"; }\n',
    'package/src/index.mjs': 'export const version = "' + version + '";\n',
    'package/bin/kimi-work-gateway.mjs': '#!/usr/bin/env node\n',
    ...overrides,
  };
  for (const name of omit) delete files[name];
  const entries = [
    { name: 'package/', type: '5' },
    { name: 'package/src/', type: '5' },
    { name: 'package/bin/', type: '5' },
  ];
  for (const [name, content] of Object.entries(files)) entries.push({ name, content });
  return [...entries, ...extra];
}

function releaseJSON({ version = '0.6.0', asset, size, digest, sums, tag } = {}) {
  const releaseTag = tag ?? 'v' + version;
  const assetName = 'kimi-work-gateway-' + version + '.tgz';
  const digestValue = digest === undefined ? 'sha256:' + crypto.createHash('sha256').update(asset).digest('hex') : digest;
  const assets = [{
    name: assetName,
    size: size ?? asset.length,
    state: 'uploaded',
    browser_download_url: DOWNLOAD + '/' + releaseTag + '/' + assetName,
    ...(digestValue === null ? {} : { digest: digestValue }),
  }];
  if (sums !== undefined) {
    assets.push({
      name: 'SHA256SUMS',
      size: sums.length,
      state: 'uploaded',
      browser_download_url: DOWNLOAD + '/' + releaseTag + '/SHA256SUMS',
    });
  }
  return {
    tag_name: releaseTag,
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/wssz527/kimi-work-gateway/releases/tag/' + releaseTag,
    assets,
  };
}

function mockFetch({ release, asset, sums, apiStatus = 200, assetStatus = 200, override } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (typeof override === 'function') {
      const replaced = await override(value, init);
      if (replaced !== undefined) return replaced;
    }
    if (value === API_URL) {
      if (apiStatus !== 200) return new Response('{"message":"denied"}', { status: apiStatus });
      return new Response(JSON.stringify(release), { status: 200 });
    }
    if (value.endsWith('/SHA256SUMS')) {
      return sums ? new Response(sums, { status: 200 }) : new Response('missing', { status: 404 });
    }
    if (value.includes('/releases/download/')) {
      return assetStatus === 200 ? new Response(asset, { status: 200 }) : new Response('denied', { status: assetStatus });
    }
    return new Response('not found', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

function updaterFor(work, { release, asset, sums, packageRoot, currentVersion = '0.5.0', ...options } = {}) {
  return new GatewayUpdater({
    updateDir: work.updateDir,
    packageRoot: packageRoot ?? work.file('base', 'package'),
    currentVersion,
    env: {},
    fetchImpl: mockFetch({ release, asset, sums, ...options }),
    ...options,
  });
}

function basePackage(work, version = '0.5.0') {
  return makePackage(work.file('base', 'package'), { version });
}

// The published archive for a release, packed from its own versioned tree.
function releaseAsset(work, version = '0.6.0', options = {}) {
  const root = makePackage(work.file('release-' + version, 'package'), { version, ...options });
  const file = pack(work.directory, root);
  const buffer = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return buffer;
}

function releaseFor(work, version = '0.6.0', options = {}) {
  const asset = releaseAsset(work, version, options);
  return { asset, release: releaseJSON({ version, asset }) };
}

function readActive(work) {
  return JSON.parse(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8'));
}

test('the update directory defaults to the state directory and only accepts absolute overrides', () => {
  expect(gatewayUpdateDirectory({})).toBe(path.join(defaultStateDirectory(), 'program-updates'));
  expect(gatewayUpdateDirectory({ KIMI_WORK_GATEWAY_UPDATE_DIR: path.join(os.tmpdir(), 'x') }))
    .toBe(path.resolve(os.tmpdir(), 'x'));
  for (const value of ['relative/dir', '~/state', '.']) {
    expect(() => gatewayUpdateDirectory({ KIMI_WORK_GATEWAY_UPDATE_DIR: value })).toThrow('update_directory_invalid');
  }
  const work = workspace();
  try {
    const root = basePackage(work);
    expect(() => new GatewayUpdater({ updateDir: path.join(root, 'updates'), packageRoot: root, env: {} }))
      .toThrow('update_directory_invalid');
    expect(() => new GatewayUpdater({ updateDir: work.updateDir, packageRoot: root, currentVersion: 'v0.5.0', env: {} }))
      .toThrow('update_version_invalid');
  } finally { work.cleanup(); }
});

test('check reads only the fixed stable release and never sends credentials', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const release = releaseJSON({ asset });
    const updater = updaterFor(work, { release, asset });
    const state = await updater.check();
    expect(state).toMatchObject({
      currentVersion: '0.5.0',
      state: 'available',
      latestVersion: '0.6.0',
      releaseURL: 'https://github.com/wssz527/kimi-work-gateway/releases/tag/v0.6.0',
    });
    expect(Number.isFinite(Date.parse(state.checkedAt))).toBe(true);
    expect(updater.fetchImpl.calls.map(call => call.url)).toEqual([API_URL]);
    const init = updater.fetchImpl.calls[0].init;
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');
    const names = Object.keys(init.headers).map(name => name.toLowerCase());
    for (const forbidden of ['authorization', 'cookie', 'private-token']) expect(names).not.toContain(forbidden);
    expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    expect(updater.inspect().state).toBe('available');
    // Checking records the release but never stages or switches anything.
    expect(fs.readdirSync(work.updateDir).sort()).toEqual(['last-check.json']);
  } finally { work.cleanup(); }
});

test('install downloads with the same credential-free request options as check', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset, release } = releaseFor(work);
    const updater = updaterFor(work, { release, asset });
    expect((await updater.install()).state).toBe('staged');
    expect(updater.fetchImpl.calls.map(call => call.url)).toEqual([
      API_URL,
      DOWNLOAD + '/v0.6.0/kimi-work-gateway-0.6.0.tgz',
    ]);
    for (const call of updater.fetchImpl.calls) {
      expect(call.init.redirect).toBe('manual');
      expect(call.init.credentials).toBe('omit');
      const names = Object.keys(call.init.headers).map(name => name.toLowerCase());
      expect(names).not.toContain('authorization');
      expect(names).not.toContain('cookie');
      expect(call.init.headers['accept-encoding']).toBe('identity');
    }
  } finally { work.cleanup(); }
});

test('the update tree holds only releases and pointers, never configuration or credentials', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset, release } = releaseFor(work);
    const updater = updaterFor(work, { release, asset });
    expect((await updater.install()).state).toBe('staged');
    const entries = fs.readdirSync(work.updateDir).sort();
    expect(entries).toEqual(['active.json', 'last-check.json', 'releases', 'tmp']);
    const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => (
      entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
    for (const file of [...walk(path.join(work.updateDir, 'releases')), path.join(work.updateDir, 'active.json'),
      path.join(work.updateDir, 'last-check.json')]) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/api[_-]?key\s*[:=]/i);
      expect(text).not.toContain('KIMI_WORK_GATEWAY_TOKEN');
    }
    expect(JSON.parse(fs.readFileSync(path.join(work.updateDir, 'last-check.json'), 'utf8')))
      .toEqual({ schema: 1, checkedAt: expect.any(String), latestVersion: '0.6.0',
        releaseURL: 'https://github.com/wssz527/kimi-work-gateway/releases/tag/v0.6.0' });
  } finally { work.cleanup(); }
});

test('check refuses drafts, pre-releases, loose versions and assets that are not this repository', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const cases = [
      [{ ...releaseJSON({ asset }), draft: true }, 'update_release_unstable'],
      [{ ...releaseJSON({ asset }), prerelease: true }, 'update_release_unstable'],
      [releaseJSON({ asset, tag: 'v0.6.0-rc.1' }), 'update_release_version_invalid'],
      [releaseJSON({ asset, tag: 'v0.06.0' }), 'update_release_version_invalid'],
      [releaseJSON({ asset, tag: 'latest' }), 'update_release_version_invalid'],
      [{ ...releaseJSON({ asset }), html_url: 'https://example.com/release' }, 'update_release_invalid'],
      [{ ...releaseJSON({ asset }), assets: [] }, 'update_release_invalid'],
      [(() => {
        const release = releaseJSON({ asset });
        release.assets[0].browser_download_url = DOWNLOAD.replace('wssz527', 'attacker') + '/v0.6.0/kimi-work-gateway-0.6.0.tgz';
        return release;
      })(), 'update_release_asset_invalid'],
      [(() => {
        const release = releaseJSON({ asset });
        release.assets[0].browser_download_url = release.assets[0].browser_download_url.replace('https:', 'http:');
        return release;
      })(), 'update_release_asset_invalid'],
      [(() => {
        const release = releaseJSON({ asset });
        release.assets[0].digest = 'sha256:nothex';
        return release;
      })(), 'update_release_asset_invalid'],
      [(() => {
        const release = releaseJSON({ asset });
        release.assets[0].name = 'kimi-work-gateway-0.6.0.zip';
        return release;
      })(), 'update_release_asset_missing'],
    ];
    for (const [release, reason] of cases) {
      const updater = updaterFor(work, { release, asset });
      const state = await updater.check();
      expect(state.state).toBe('failed');
      expect(state.reason).toBe(reason);
      expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    }
  } finally { work.cleanup(); }
});

test('network failures and rate limiting report update codes without exposing remote text', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const release = releaseJSON({ asset });
    const cases = [
      [{ apiStatus: 403 }, 'update_rate_limited'],
      [{ apiStatus: 429 }, 'update_rate_limited'],
      [{ apiStatus: 404 }, 'update_release_not_found'],
      [{ apiStatus: 500 }, 'update_release_http_error'],
      [{ override: () => { throw new Error('getaddrinfo ENOTFOUND api.github.com <html>secret</html>'); } }, 'update_network_error'],
      [{ override: () => new Response('<html>not json</html>', { status: 200 }) }, 'update_release_invalid'],
      [{ override: () => new Response(JSON.stringify(release), { status: 200, headers: { 'content-type': 'text/html' } }) },
        'update_release_invalid'],
      [{ override: () => {
        const response = new Response(JSON.stringify(release), { status: 200 });
        Object.defineProperty(response, 'redirected', { value: true });
        return response;
      } }, 'update_redirect_rejected'],
    ];
    for (const [options, reason] of cases) {
      const updater = updaterFor(work, { release, asset, ...options });
      const state = await updater.check();
      expect(state.state).toBe('failed');
      expect(state.reason).toBe(reason);
      expect(state.reason).toMatch(/^update_[a-z0-9_]+$/);
      expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    }
  } finally { work.cleanup(); }
});

test('a request that never answers times out instead of hanging', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: work.file('base', 'package'),
      currentVersion: '0.5.0',
      env: {},
      timeoutMs: 50,
      fetchImpl: () => new Promise(() => {}),
    });
    const state = await updater.check();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_timeout');
  } finally { work.cleanup(); }
});

test('install stages a verified archive, switches active atomically and repeats idempotently', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const release = releaseJSON({ asset });
    const updater = updaterFor(work, { release, asset });

    expect(updater.inspect()).toEqual({ currentVersion: '0.5.0', state: 'not-checked' });
    const staged = await updater.install();
    expect(staged).toMatchObject({
      currentVersion: '0.5.0', state: 'staged', latestVersion: '0.6.0', pendingVersion: '0.6.0',
      rollbackVersion: '0.5.0',
    });

    const active = readActive(work);
    expect(active.generation).toBe(1);
    expect(active.current.source).toBe('release');
    expect(active.current.version).toBe('0.6.0');
    expect(active.current.sha256).toBe(crypto.createHash('sha256').update(asset).digest('hex'));
    const key = '0.6.0-' + active.current.sha256.slice(0, 12);
    expect(active.current.key).toBe(key);
    const releaseDir = path.join(work.updateDir, 'releases', key);
    expect(active.current.root).toBe(path.join(releaseDir, 'package'));
    expect(active.current.cli).toBe(path.join(releaseDir, 'package', 'cli.mjs'));
    expect(fs.readdirSync(releaseDir).sort()).toEqual(['package', 'release.json']);
    expect(fs.readdirSync(path.join(releaseDir, 'package')).sort()).toEqual(['bin', 'cli.mjs', 'package.json', 'src']);
    expect(fs.readFileSync(active.current.cli, 'utf8')).toContain('"0.6.0"');
    expect(fs.statSync(path.join(work.updateDir, 'active.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(work.updateDir, 'tmp'))).toEqual([]);
    expect(fs.existsSync(path.join(work.updateDir, 'lock'))).toBe(false);

    const again = await updater.install();
    expect(again).toMatchObject({ state: 'staged', pendingVersion: '0.6.0' });
    expect(readActive(work).generation).toBe(1);
    expect(fs.readdirSync(path.join(work.updateDir, 'releases'))).toEqual([key]);
  } finally { work.cleanup(); }
});

test('an older or equal release is not installed and leaves the active pointer alone', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const release = releaseJSON({ version: '0.5.0', asset });
    const updater = updaterFor(work, { release, asset, currentVersion: '0.5.0' });
    const state = await updater.install();
    expect(state.state).toBe('current');
    expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    expect(fs.existsSync(path.join(work.updateDir, 'releases'))).toBe(false);
  } finally { work.cleanup(); }
});

test('a wrong checksum or a size that does not match the release never changes active', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const good = releaseJSON({ asset });

    const tampered = Buffer.from(asset);
    tampered[tampered.length - 1] ^= 0xff;
    const badDigest = releaseJSON({ asset, digest: 'sha256:' + crypto.createHash('sha256').update(asset).digest('hex') });
    const wrongSize = releaseJSON({ asset, size: asset.length + 10 });

    for (const [release, body, reason] of [
      [badDigest, tampered, 'update_checksum_mismatch'],
      [wrongSize, asset, 'update_size_mismatch'],
      [(() => {
        const release = releaseJSON({ asset });
        release.assets[0].size = asset.length + 10;
        return release;
      })(), asset, 'update_size_mismatch'],
    ]) {
      const updater = updaterFor(work, { release, asset: body });
      const state = await updater.install();
      expect(state.state).toBe('failed');
      expect(state.reason).toBe(reason);
      expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    }

    const ok = updaterFor(work, { release: good, asset });
    expect((await ok.install()).state).toBe('staged');
    expect(readActive(work).current.version).toBe('0.6.0');
  } finally { work.cleanup(); }
});

test('checksums come from the release digest or from SHA256SUMS in the same release', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const digest = crypto.createHash('sha256').update(asset).digest('hex');
    const sums = digest + '  kimi-work-gateway-0.6.0.tgz\n';

    const viaSums = updaterFor(work, { release: releaseJSON({ asset, digest: null, sums }), asset, sums });
    expect((await viaSums.install()).state).toBe('staged');
    expect(viaSums.fetchImpl.calls.map(call => call.url)).toContain(DOWNLOAD + '/v0.6.0/SHA256SUMS');

    const work2 = workspace();
    try {
      basePackage(work2);
      const noChecksum = updaterFor(work2, { release: releaseJSON({ asset, digest: null }), asset });
      const state = await noChecksum.install();
      expect(state.state).toBe('failed');
      expect(state.reason).toBe('update_checksum_unavailable');
      expect(fs.existsSync(path.join(work2.updateDir, 'active.json'))).toBe(false);

      const missingRow = updaterFor(work2, {
        release: releaseJSON({ asset, digest: null, sums: 'a'.repeat(64) + '  other.tgz\n' }), asset,
        sums: 'a'.repeat(64) + '  other.tgz\n',
      });
      expect((await missingRow.install()).reason).toBe('update_checksum_unavailable');

      const wrongRow = updaterFor(work2, {
        release: releaseJSON({ asset, digest: null, sums: 'b'.repeat(64) + '  kimi-work-gateway-0.6.0.tgz\n' }),
        asset,
        sums: 'b'.repeat(64) + '  kimi-work-gateway-0.6.0.tgz\n',
      });
      expect((await wrongRow.install()).reason).toBe('update_checksum_mismatch');
      expect(fs.existsSync(path.join(work2.updateDir, 'active.json'))).toBe(false);
    } finally { work2.cleanup(); }
  } finally { work.cleanup(); }
});

test('malformed archives are rejected before extraction and never become active', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const cases = [
      ['traversal', packageEntries({ extra: [{ name: 'package/../evil.mjs', content: 'x' }] })],
      ['absolute', packageEntries({ extra: [{ name: '/etc/evil.mjs', content: 'x' }] })],
      ['nested traversal', packageEntries({ extra: [{ name: 'package/src/../../evil.mjs', content: 'x' }] })],
      ['symlink', packageEntries({ extra: [{ name: 'package/link', type: '2', linkname: '/etc/passwd' }] })],
      ['hardlink', packageEntries({ extra: [{ name: 'package/hard', type: '1', linkname: 'package/cli.mjs' }] })],
      ['device', packageEntries({ extra: [{ name: 'package/dev', type: '3' }] })],
      ['outside package root', packageEntries({ extra: [{ name: 'other/file.mjs', content: 'x' }] })],
      ['duplicate entry', packageEntries({ extra: [{ name: 'package/cli.mjs', content: 'x' }] })],
      ['file used as directory', packageEntries({ extra: [{ name: 'package/src', content: 'file' }] })],
      ['child of a file', packageEntries({ extra: [{ name: 'package/cli.mjs/nested', content: 'x' }] })],
      ['windows device name', packageEntries({ extra: [{ name: 'package/aux.mjs', content: 'x' }] })],
      ['backslash path', packageEntries({ extra: [{ name: 'package\\evil.mjs', content: 'x' }] })],
      ['missing manifest', packageEntries({ omit: ['package/package.json'] })],
      ['missing cli', packageEntries({ omit: ['package/cli.mjs'] })],
      ['missing src index', packageEntries({ omit: ['package/src/index.mjs'] })],
      ['missing bin entry', packageEntries({ omit: ['package/bin/kimi-work-gateway.mjs'] })],
      ['wrong package name', packageEntries({
        overrides: { 'package/package.json': JSON.stringify({ name: 'some-other-package', version: '0.6.0',
          bin: { 'kimi-work-gateway': './bin/kimi-work-gateway.mjs' } }) },
      })],
      ['wrong package version', packageEntries({ version: '0.6.1' })],
      ['bin escapes the package', packageEntries({
        overrides: { 'package/package.json': JSON.stringify({ name: 'kimi-work-gateway', version: '0.6.0',
          bin: { 'kimi-work-gateway': '../../outside.mjs' } }) },
      })],
    ];
    for (const [label, entries] of cases) {
      const asset = zlib.gzipSync(tarArchive(entries));
      const release = releaseJSON({ asset });
      const updater = updaterFor(work, { release, asset });
      const state = await updater.install();
      expect({ label, state: state.state, reason: state.reason }).toEqual({
        label,
        state: 'failed',
        reason: label === 'missing cli' || label === 'missing src index' || label === 'missing bin entry'
          || label === 'wrong package name' || label === 'wrong package version' || label === 'bin escapes the package'
          ? 'update_package_invalid' : 'update_package_archive_unsafe',
      });
      expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
      expect(fs.existsSync(path.join(work.updateDir, 'releases'))).toBe(false);
    }
  } finally { work.cleanup(); }
});

test('an archive that decompresses past the limit is refused as too large', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const entries = packageEntries();
    entries.push({ name: 'package/filler.bin', content: Buffer.alloc(2 * 1024 * 1024, 0x61) });
    const asset = zlib.gzipSync(tarArchive(entries));
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: work.file('base', 'package'),
      currentVersion: '0.5.0',
      env: {},
      maxAssetBytes: 8 * 1024 * 1024,
      maxUnpackedBytes: 512 * 1024,
      fetchImpl: mockFetch({ release: releaseJSON({ asset }), asset }),
    });
    const state = await updater.install();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_package_too_large');
    expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
  } finally { work.cleanup(); }
});

test('an asset larger than the configured limit is refused from release metadata', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: work.file('base', 'package'),
      currentVersion: '0.5.0',
      env: {},
      maxAssetBytes: 16,
      fetchImpl: mockFetch({ release: releaseJSON({ asset }), asset }),
    });
    const state = await updater.install();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_release_asset_invalid');
  } finally { work.cleanup(); }
});

test('redirects are followed only to GitHub-controlled hosts', async () => {
  const work = workspace();
  try {
    basePackage(work);
    const { asset } = releaseFor(work);
    const release = releaseJSON({ asset });
    const redirected = 'https://objects.githubusercontent.com/release-assets/kimi-work-gateway-0.6.0.tgz';

    const allowed = updaterFor(work, {
      release, asset,
      override: url => (url === release.assets[0].browser_download_url
        ? new Response(null, { status: 302, headers: { location: redirected } })
        : url === redirected ? new Response(asset, { status: 200 }) : undefined),
    });
    expect((await allowed.install()).state).toBe('staged');

    const work2 = workspace();
    try {
      basePackage(work2);
      for (const target of ['https://evil.example.com/x.tgz', 'http://github.com/wssz527/kimi-work-gateway/releases/download/v0.6.0/x.tgz',
        'https://api.github.com/repos/other/repo']) {
        const updater = updaterFor(work2, {
          release, asset,
          override: url => (url === release.assets[0].browser_download_url
            ? new Response(null, { status: 302, headers: { location: target } })
            : undefined),
        });
        const state = await updater.install();
        expect(state.state).toBe('failed');
        expect(state.reason).toBe('update_redirect_rejected');
        expect(fs.existsSync(path.join(work2.updateDir, 'active.json'))).toBe(false);
      }
    } finally { work2.cleanup(); }
  } finally { work.cleanup(); }
});

test('an installed release survives later offline or failed checks and installs', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const ok = updaterFor(work, { release: releaseJSON({ asset }), asset });
    expect((await ok.install()).state).toBe('staged');
    const before = fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8');

    const offline = updaterFor(work, {
      release: releaseJSON({ asset }), asset,
      override: () => { throw new Error('offline'); },
    });
    const failedCheck = await offline.check();
    expect(failedCheck.state).toBe('failed');
    expect(failedCheck.reason).toBe('update_network_error');
    expect(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8')).toBe(before);

    const { asset: nextAsset } = releaseFor(work, '0.7.0');
    const badNext = updaterFor(work, {
      release: releaseJSON({ version: '0.7.0', asset: nextAsset, digest: 'sha256:' + 'c'.repeat(64) }),
      asset: nextAsset,
    });
    const failedInstall = await badNext.install();
    expect(failedInstall.reason).toBe('update_checksum_mismatch');
    expect(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8')).toBe(before);
    const fresh = updaterFor(work, { release: releaseJSON({ asset }), asset });
    expect(fresh.inspect()).toMatchObject({ state: 'staged', pendingVersion: '0.6.0' });
  } finally { work.cleanup(); }
});

test('two concurrent installs of the same release produce one switch and no leftover work', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const release = releaseJSON({ asset });
    const left = updaterFor(work, { release, asset });
    const right = updaterFor(work, { release, asset });
    const states = await Promise.all([left.install(), right.install()]);
    for (const state of states) expect(state).toMatchObject({ state: 'staged', pendingVersion: '0.6.0' });
    const active = readActive(work);
    expect(active.generation).toBe(1);
    expect(fs.readdirSync(path.join(work.updateDir, 'releases'))).toHaveLength(1);
    expect(fs.readdirSync(path.join(work.updateDir, 'tmp'))).toEqual([]);
    expect(fs.existsSync(path.join(work.updateDir, 'lock'))).toBe(false);
  } finally { work.cleanup(); }
});

test('a held lock blocks an install until its timeout and changes nothing', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    fs.mkdirSync(path.join(work.updateDir, 'lock'), { recursive: true });
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: work.file('base', 'package'),
      currentVersion: '0.5.0',
      env: {},
      lockTimeoutMs: 120,
      fetchImpl: mockFetch({ release: releaseJSON({ asset }), asset }),
    });
    const state = await updater.install();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_lock_timeout');
    expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);
    expect(fs.existsSync(path.join(work.updateDir, 'lock'))).toBe(true);
  } finally { work.cleanup(); }
});

test('a stale lock is reclaimed instead of blocking updates forever', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const lock = path.join(work.updateDir, 'lock');
    fs.mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(lock, old, old);
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: work.file('base', 'package'),
      currentVersion: '0.5.0',
      env: {},
      lockTimeoutMs: 1000,
      lockStaleMs: 60_000,
      fetchImpl: mockFetch({ release: releaseJSON({ asset }), asset }),
    });
    expect((await updater.install()).state).toBe('staged');
    expect(fs.existsSync(lock)).toBe(false);
  } finally { work.cleanup(); }
});

test('rollback returns to the package this copy was installed from and is idempotent', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const updater = updaterFor(work, { release: releaseJSON({ asset }), asset });
    expect((await updater.rollback()).reason).toBe('update_rollback_unavailable');
    expect(fs.existsSync(path.join(work.updateDir, 'active.json'))).toBe(false);

    expect((await updater.install()).state).toBe('staged');
    const installed = readActive(work);
    expect(installed.rollback).toMatchObject({ source: 'baseline', version: '0.5.0', key: 'baseline:0.5.0' });

    const rolledBack = await updater.rollback();
    expect(rolledBack).toMatchObject({ currentVersion: '0.5.0', state: 'available', latestVersion: '0.6.0' });
    expect(rolledBack.pendingVersion).toBeUndefined();
    const after = readActive(work);
    expect(after.generation).toBe(2);
    expect(after.current).toMatchObject({ source: 'baseline', version: '0.5.0' });
    expect(after.rollback).toBeNull();
    expect(after.rolledBackTo).toBe('baseline:0.5.0');

    const again = await updater.rollback();
    expect(again.state).toBe('available');
    expect(readActive(work).generation).toBe(2);
  } finally { work.cleanup(); }
});

test('rollback uses KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT as the baseline for a managed copy', async () => {
  const work = workspace();
  try {
    const original = basePackage(work, '0.5.0');
    const managed = makePackage(work.file('managed', 'package'), { version: '0.5.0' });
    const { asset } = releaseFor(work);
    fs.mkdirSync(work.updateDir, { recursive: true });
    // A managed copy also carries its own (identical) package tree.
    const updater = new GatewayUpdater({
      updateDir: work.updateDir,
      packageRoot: managed,
      currentVersion: '0.5.0',
      env: { KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT: original },
      fetchImpl: mockFetch({ release: releaseJSON({ asset }), asset }),
    });
    expect((await updater.install()).state).toBe('staged');
    expect(readActive(work).rollback).toMatchObject({ source: 'baseline', root: original });
    expect((await updater.rollback()).state).toBe('available');
    expect(readActive(work).current.root).toBe(original);
  } finally { work.cleanup(); }
});

test('rollback refuses a baseline whose tree no longer matches the recorded digest', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    const { asset } = releaseFor(work);
    const updater = updaterFor(work, { release: releaseJSON({ asset }), asset });
    expect((await updater.install()).state).toBe('staged');
    fs.writeFileSync(path.join(work.file('base', 'package'), 'cli.mjs'), 'export async function main() {}\n');
    const state = await updater.rollback();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_rollback_target_invalid');
    expect(readActive(work).generation).toBe(1);
  } finally { work.cleanup(); }
});

test('a corrupt active pointer is reported as failed and never replaced silently', async () => {
  const work = workspace();
  try {
    basePackage(work, '0.5.0');
    fs.mkdirSync(work.updateDir, { recursive: true });
    const activeFile = path.join(work.updateDir, 'active.json');
    fs.writeFileSync(activeFile, '{"schema":1,"generation":1,"current":{}}');
    const updater = updaterFor(work, { release: releaseJSON({ asset: Buffer.from('x') }), asset: Buffer.from('x') });
    const state = updater.inspect();
    expect(state.state).toBe('failed');
    expect(state.reason).toBe('update_active_invalid');
    const installed = await updater.install();
    expect(installed.state).toBe('failed');
    expect(installed.reason).toBe('update_active_invalid');
    expect(fs.readFileSync(activeFile, 'utf8')).toBe('{"schema":1,"generation":1,"current":{}}');
  } finally { work.cleanup(); }
});

test('package trees are hashed deterministically and symlinks are refused', () => {
  const work = workspace();
  try {
    const root = makePackage(work.file('pkg', 'package'));
    const first = gatewayPackageTreeDigest(root);
    expect(gatewayPackageTreeDigest(root)).toEqual(first);
    fs.symlinkSync(path.join(root, 'cli.mjs'), path.join(root, 'link.mjs'));
    expect(() => gatewayPackageTreeDigest(root)).toThrow('update_package_corrupt');
    fs.rmSync(path.join(root, 'link.mjs'));
    expect(inspectGatewayPackage(root, { version: '0.6.0' }).tree.sha256).toBe(first.sha256);
    expect(() => inspectGatewayPackage(root, { version: '0.7.0' })).toThrow('update_package_invalid');
  } finally { work.cleanup(); }
});

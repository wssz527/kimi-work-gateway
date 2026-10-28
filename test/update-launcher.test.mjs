import { test, expect } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { GatewayUpdater } from '../src/update-manager.mjs';
import { resolveGatewayCLI, resolveGatewayTarget } from '../src/update-launcher.mjs';

const API_URL = 'https://api.github.com/repos/wssz527/kimi-work-gateway/releases/latest';
const DOWNLOAD = 'https://github.com/wssz527/kimi-work-gateway/releases/download';

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-launch-'));
  return {
    directory,
    updateDir: path.join(directory, 'state', 'program-updates'),
    cleanup() { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); },
    file(...parts) { return path.join(directory, ...parts); },
  };
}

function makePackage(root, { version = '0.6.0' } = {}) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'kimi-work-gateway', version, type: 'module', main: './src/index.mjs',
    bin: { 'kimi-work-gateway': './bin/kimi-work-gateway.mjs' },
  }));
  fs.writeFileSync(path.join(root, 'cli.mjs'), 'export async function main() { return "' + version + '"; }\n');
  fs.writeFileSync(path.join(root, 'src', 'index.mjs'), 'export const version = "' + version + '";\n');
  fs.writeFileSync(path.join(root, 'bin', 'kimi-work-gateway.mjs'), '#!/usr/bin/env node\n');
  return root;
}

function pack(base, packageRoot) {
  const target = path.join(base, 'asset.tgz');
  execFileSync('tar', ['-czf', target, '-C', path.dirname(packageRoot), 'package'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: 'pipe',
  });
  return fs.readFileSync(target);
}

function releaseFor(asset, version = '0.6.0') {
  const assetName = 'kimi-work-gateway-' + version + '.tgz';
  return {
    tag_name: 'v' + version,
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/wssz527/kimi-work-gateway/releases/tag/v' + version,
    assets: [{
      name: assetName,
      size: asset.length,
      state: 'uploaded',
      digest: 'sha256:' + crypto.createHash('sha256').update(asset).digest('hex'),
      browser_download_url: DOWNLOAD + '/v' + version + '/' + assetName,
    }],
  };
}

function fetchFor(asset) {
  const release = releaseFor(asset);
  return async url => (String(url) === API_URL
    ? new Response(JSON.stringify(release), { status: 200 })
    : new Response(asset, { status: 200 }));
}

async function installRelease(work, { baseVersion = '0.5.0', version = '0.6.0' } = {}) {
  const base = makePackage(work.file('base', 'package'), { version: baseVersion });
  const asset = pack(work.directory, makePackage(work.file('release', 'package'), { version }));
  const updater = new GatewayUpdater({
    updateDir: work.updateDir,
    packageRoot: base,
    currentVersion: baseVersion,
    env: {},
    fetchImpl: fetchFor(asset),
  });
  const state = await updater.install();
  return { base, state };
}

test('without an update the launcher runs the CLI from the package it was installed with', () => {
  const work = workspace();
  try {
    const base = makePackage(work.file('base', 'package'), { version: '0.5.0' });
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .toBe(path.join(base, 'cli.mjs'));
    expect(resolveGatewayTarget({ updateDir: work.updateDir, basePackageRoot: base }))
      .toEqual({ cli: path.join(base, 'cli.mjs'), source: 'base', root: path.resolve(base), version: '0.5.0' });
    expect(fs.existsSync(work.updateDir)).toBe(false);
  } finally { work.cleanup(); }
});

test('after an install the launcher runs the staged CLI instead of the base package', async () => {
  const work = workspace();
  try {
    const { base, state } = await installRelease(work);
    expect(state.state).toBe('staged');
    const cli = resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base });
    expect(cli).not.toBe(path.join(base, 'cli.mjs'));
    expect(cli).toBe(path.join(work.updateDir, 'releases', state.pendingVersion + '-'
      + JSON.parse(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8')).current.sha256.slice(0, 12),
    'package', 'cli.mjs'));
    expect(path.isAbsolute(cli)).toBe(true);
    expect(fs.readFileSync(cli, 'utf8')).toContain('0.6.0');
    const target = resolveGatewayTarget({ updateDir: work.updateDir, basePackageRoot: base });
    expect(target).toMatchObject({ cli, source: 'release', version: '0.6.0' });
    // The chosen CLI is a real module that can be imported without recursion.
    const module = await import(cli + '?v=' + Date.now());
    expect(await module.main()).toBe('0.6.0');
  } finally { work.cleanup(); }
});

test('a tampered staged package is rejected before its CLI runs', async () => {
  const work = workspace();
  try {
    const { base } = await installRelease(work);
    const active = JSON.parse(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8'));
    const cli = path.join(active.current.root, 'cli.mjs');
    fs.writeFileSync(cli, 'export async function main() { return "pwned"; }\n');
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .toThrow('update_package_corrupt');

    // Adding an unrecorded file is also a change to the tree.
    const restored = makePackage(active.current.root, { version: '0.6.0' });
    fs.writeFileSync(path.join(restored, 'extra.mjs'), 'export {};\n');
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .toThrow('update_package_corrupt');

    fs.rmSync(path.join(restored, 'extra.mjs'));
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base })).toBe(cli);
  } finally { work.cleanup(); }
});

test('a replaced or symlinked staged tree is refused rather than followed', async () => {
  const work = workspace();
  try {
    const { base } = await installRelease(work);
    const active = JSON.parse(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8'));
    const root = active.current.root;
    const outside = makePackage(work.file('outside', 'package'), { version: '0.6.0' });
    fs.rmSync(root, { recursive: true, force: true });
    fs.symlinkSync(outside, root);
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .toThrow('update_package_corrupt');
  } finally { work.cleanup(); }
});

test('a malformed or unsafe active pointer raises a diagnostic error instead of guessing', () => {
  const work = workspace();
  try {
    const base = makePackage(work.file('base', 'package'), { version: '0.5.0' });
    const activeFile = path.join(work.updateDir, 'active.json');
    fs.mkdirSync(work.updateDir, { recursive: true });
    const cases = [
      'not json',
      '[]',
      '{}',
      JSON.stringify({ schema: 2, generation: 1, current: null }),
      JSON.stringify({ schema: 1, generation: 0, current: null }),
      JSON.stringify({ schema: 1, generation: 1, current: { source: 'release', version: '0.6.0', key: '0.6.0-'
        + 'a'.repeat(12), root: '/tmp/elsewhere/package', cli: '/tmp/elsewhere/package/cli.mjs',
      sha256: 'a'.repeat(64), treeSha256: 'b'.repeat(64) } }),
      JSON.stringify({ schema: 1, generation: 1, current: { source: 'release', version: '0.6.0', key: '0.6.0-'
        + 'a'.repeat(12), root: path.join(work.updateDir, 'releases', '0.6.0-' + 'a'.repeat(12), 'package'),
      cli: path.join(work.updateDir, 'releases', '0.6.0-' + 'a'.repeat(12), 'package', 'other.mjs'),
      sha256: 'a'.repeat(64), treeSha256: 'b'.repeat(64) } }),
      JSON.stringify({ schema: 1, generation: 1, current: { source: 'baseline', version: '0.5.0',
        key: 'baseline:0.5.0', root: base, cli: path.join(base, 'cli.mjs'), treeSha256: 'b'.repeat(64) } }),
      // A baseline may only name the package this install came from.
      JSON.stringify({ schema: 1, generation: 1, current: { source: 'baseline', version: '0.5.0',
        key: 'baseline:0.5.0', root: work.file('elsewhere', 'package'),
        cli: work.file('elsewhere', 'package', 'cli.mjs'), treeSha256: 'b'.repeat(64) } }),
    ];
    for (const value of cases) {
      fs.writeFileSync(activeFile, value);
      let failure = null;
      try { resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }); }
      catch (error) { failure = error; }
      expect(failure).not.toBeNull();
      expect(failure.message).toMatch(/^update_(active_invalid|package_corrupt)$/);
      expect(failure.code).toBe(failure.message);
    }
  } finally { work.cleanup(); }
});

test('a base package that is not this gateway is reported instead of returned', () => {
  const work = workspace();
  try {
    const root = work.file('base', 'package');
    makePackage(root, { version: '0.5.0' });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'other', version: '0.5.0' }));
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: root }))
      .toThrow('update_baseline_invalid');
    fs.rmSync(path.join(root, 'cli.mjs'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'kimi-work-gateway', version: '0.5.0' }));
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: root }))
      .toThrow('update_baseline_invalid');
  } finally { work.cleanup(); }
});

test('the update directory is read from the environment when no path is given', async () => {
  const work = workspace();
  const previous = process.env.KIMI_WORK_GATEWAY_UPDATE_DIR;
  try {
    const { base } = await installRelease(work);
    process.env.KIMI_WORK_GATEWAY_UPDATE_DIR = work.updateDir;
    const cli = resolveGatewayCLI({ basePackageRoot: base });
    expect(cli).toContain(path.join('program-updates', 'releases'));
    expect(cli.endsWith(path.join('package', 'cli.mjs'))).toBe(true);
    process.env.KIMI_WORK_GATEWAY_UPDATE_DIR = 'relative';
    expect(() => resolveGatewayCLI({ basePackageRoot: base })).toThrow('update_directory_invalid');
  } finally {
    if (previous === undefined) delete process.env.KIMI_WORK_GATEWAY_UPDATE_DIR;
    else process.env.KIMI_WORK_GATEWAY_UPDATE_DIR = previous;
    work.cleanup();
  }
});

test('the launcher falls back to the base CLI after rollback', async () => {
  const work = workspace();
  try {
    const { base } = await installRelease(work);
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base })).not.toBe(path.join(base, 'cli.mjs'));
    const updater = new GatewayUpdater({
      updateDir: work.updateDir, packageRoot: base, currentVersion: '0.5.0', env: {},
      fetchImpl: async () => { throw Error('offline'); },
    });
    expect((await updater.rollback()).state).toBe('available');
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base })).toBe(path.join(base, 'cli.mjs'));
    expect(resolveGatewayTarget({ updateDir: work.updateDir, basePackageRoot: base }).source).toBe('base');
  } finally { work.cleanup(); }
});

test('a base package upgraded outside the updater is never replaced by an older release', async () => {
  const work = workspace();
  try {
    const { base } = await installRelease(work, { baseVersion: '0.5.0', version: '0.6.0' });
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .not.toBe(path.join(base, 'cli.mjs'));
    // npm installs a newer gateway over the old one while a 0.6.0 release stays recorded.
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
    manifest.version = '0.7.0';
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(base, 'cli.mjs'), 'export async function main() { return "0.7.0"; }\n');
    expect(resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base })).toBe(path.join(base, 'cli.mjs'));
    expect(resolveGatewayTarget({ updateDir: work.updateDir, basePackageRoot: base }))
      .toMatchObject({ source: 'base', version: '0.7.0' });
  } finally { work.cleanup(); }
});

test('a truncated archive is refused by the launcher path when its package no longer verifies', async () => {
  const work = workspace();
  try {
    const { base } = await installRelease(work);
    const active = JSON.parse(fs.readFileSync(path.join(work.updateDir, 'active.json'), 'utf8'));
    const src = path.join(active.current.root, 'src', 'index.mjs');
    fs.writeFileSync(src, zlib.gzipSync(Buffer.from('anything')));
    expect(() => resolveGatewayCLI({ updateDir: work.updateDir, basePackageRoot: base }))
      .toThrow('update_package_corrupt');
  } finally { work.cleanup(); }
});

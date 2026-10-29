import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectSubagentLaunchContract, probeSubagentLaunchSource } from '../src/subagent-launch-contract.mjs';
import { bundleSource, writeBundle } from './fixtures/kimi-bundle.mjs';

function source({ packaged = true, prefix = 'runtime', compact = false } = {}) {
  const code = `
function ${prefix}Allowed(packaged = app.isPackaged) {
  return ${packaged ? 'true' : '!packaged'};
}
function ${prefix}Env(name, env = process.env, packaged = app.isPackaged) {
  return ${prefix}Allowed(packaged) ? env[name] : undefined;
}
function ${prefix}Reference() {
  return ${prefix}Env('DAIMON_BUNDLE_DIR');
}
`;
  return compact ? code.replace(/\s+/g, ' ') : code;
}

test('launch capability follows packaged behavior across names and formatting', () => {
  for (const prefix of ['runtime', 'differentBuild', '_0x12ab']) {
    for (const compact of [false, true]) {
      expect(probeSubagentLaunchSource(source({ prefix, compact })).state).toBe('supported');
      expect(probeSubagentLaunchSource(source({ prefix, compact, packaged: false }))).toEqual({
        state: 'unsupported', reason: 'packaged_bundle_override_disabled',
      });
    }
  }
});

test('missing and ambiguous launch interfaces never report support', () => {
  expect(probeSubagentLaunchSource('function changed() { return 1; }').state).toBe('unverified');
  expect(probeSubagentLaunchSource(source() + source({ prefix: 'another' })).state).toBe('unverified');
  expect(probeSubagentLaunchSource(source().replace('env[name]', 'unknownCapability(name)')).state).toBe('unverified');
});

test('an updated archive invalidates the cached launch verdict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-contract-'));
  const archive = path.join(dir, 'app.asar');
  try {
    writeBundle(archive, bundleSource(1) + source());
    expect(inspectSubagentLaunchContract(archive).state).toBe('supported');
    writeBundle(archive, bundleSource(2) + source({ packaged: false }));
    expect(inspectSubagentLaunchContract(archive).state).toBe('unsupported');
    fs.unlinkSync(archive);
    expect(inspectSubagentLaunchContract(archive).state).toBe('unavailable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installed archive probing completes within a bounded child process on the current runtime', async () => {
  const { archiveCandidates } = await import('../src/kimi-contract.mjs');
  const archive = archiveCandidates().find(file => fs.existsSync(file));
  if (!archive) return;
  const { spawnSync } = await import('node:child_process');
  const moduleURL = new URL('../src/subagent-launch-contract.mjs', import.meta.url).href;
  const script = 'import {inspectSubagentLaunchContract} from ' + JSON.stringify(moduleURL)
    + '; console.log(JSON.stringify(inspectSubagentLaunchContract(' + JSON.stringify(archive) + ')));';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  expect({ status: result.status, error: result.error?.code, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  expect(['supported', 'unsupported', 'unverified']).toContain(JSON.parse(result.stdout).state);
});

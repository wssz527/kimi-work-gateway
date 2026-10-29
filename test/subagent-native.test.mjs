import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSubagentInstallation } from '../src/subagent-runtime.mjs';
import { inspectSubagentLaunchContract } from '../src/subagent-launch-contract.mjs';

let installed = false, launchState = 'unavailable';
try {
  const installation = findSubagentInstallation();
  installed = Boolean(installation.bundleDir);
  if (installed) launchState = inspectSubagentLaunchContract(installation.archive).state;
} catch {}
const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
// The copy channel is only meaningful while the desktop still accepts a
// bundle override. A version that refuses it (or no longer ships copyable
// links) has no copy path to adapt, so the direct-kernel check is skipped
// rather than reported as a failure of this package.
const capable = installed && launchState === 'supported'
  && node.status === 0 && Number(node.stdout.match(/^v(\d+)/)?.[1]) >= 24;

test.skipIf(!capable)('the adapted installed kernel runs native subagents via direct import and an isolated gateway', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-subagents-'));
  try {
    const child = spawnSync('node', [fileURLToPath(new URL('./fixtures/native-subagent-runner.mjs', import.meta.url)), root],
      { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    expect({ code: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ code: 0, error: undefined, stderr: '' });
    const result = JSON.parse(child.stdout.trim());
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(12);
    expect(result.blocked).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 65000);

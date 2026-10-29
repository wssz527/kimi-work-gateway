import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSubagentInstallation } from '../src/subagent-runtime.mjs';

let installed = false;
try { installed = Boolean(findSubagentInstallation().bundleDir); } catch {}
const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
const capable = installed && node.status === 0 && Number(node.stdout.match(/^v(\d+)/)?.[1]) >= 24;
test.skipIf(!capable)('unmodified Work loads the native pool, selects a child and recovers from desktop config regeneration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-native-pool-'));
  try {
    const child = spawnSync('node', [fileURLToPath(new URL('./fixtures/native-pool-runner.mjs', import.meta.url)), root],
      { encoding: 'utf8', timeout: 65000, maxBuffer: 1024 * 1024 });
    expect({ code: child.status, error: child.error?.message, stderr: child.stderr }).toEqual({ code: 0, error: undefined, stderr: '' });
    const result = JSON.parse(child.stdout.trim());
    expect(result.ok).toBe(true); expect(result.unmodifiedKernel).toBe(true); expect(result.unmodifiedWorkAdapter).toBe(true);
    expect(result.subagentsCompleted).toBeGreaterThanOrEqual(2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 70000);

import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findSubagentInstallation } from '../src/subagent-runtime.mjs';

let installed = false;
try { findSubagentInstallation(); installed = true; } catch {}
const node = spawnSync('node', ['--version'], { encoding: 'utf8' });
const capable = installed && node.status === 0 && Number(node.stdout.match(/^v(\d+)/)?.[1]) >= 24;

test.skipIf(!capable)('the installed Work kernel runs native subagents through the shipped runtime and gateway', () => {
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

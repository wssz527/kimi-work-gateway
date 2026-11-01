import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { publicRemoteRuntime, readRemoteRuntime } from '../src/remote-runtime-state.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-remote-state-')); roots.push(stateDir);
  const sessionID = crypto.randomUUID(), applicationPid = 1234;
  fs.mkdirSync(path.join(stateDir, 'remote-runtime'));
  const file = path.join(stateDir, 'remote-runtime', 'status-' + sessionID + '.json');
  const value = { schemaVersion: 1, sessionID, applicationPid, state: 'ready', catalog: 'catalog-extended', added: 6,
    updater: 'delegated', credentials: 'private-secret', baseUrl: 'https://private.invalid', models: ['private'] };
  const write = next => fs.writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
  write(value);
  return { stateDir, sessionID, applicationPid, file, value, write };
}

describe('remote status provenance', () => {
  test('reports only the fixed public state and count fields', () => {
    const context = fixture();
    const result = readRemoteRuntime(context.stateDir, context.sessionID, context.applicationPid);
    expect(result).toEqual({ state: 'ready', catalog: 'catalog-extended', added: 6, updater: 'delegated' });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('rejects another session, process or schema instead of reviving stale readiness', () => {
    const context = fixture();
    for (const patch of [{ schemaVersion: 2 }, { sessionID: crypto.randomUUID() }, { applicationPid: 5678 }]) {
      context.write({ ...context.value, ...patch });
      expect(readRemoteRuntime(context.stateDir, context.sessionID, context.applicationPid)).toBeUndefined();
    }
  });

  test('does not follow symlinks or read oversized state files', () => {
    const context = fixture();
    fs.unlinkSync(context.file);
    const target = path.join(context.stateDir, 'other.json');
    fs.writeFileSync(target, JSON.stringify(context.value), { mode: 0o600 });
    fs.symlinkSync(target, context.file);
    expect(readRemoteRuntime(context.stateDir, context.sessionID, context.applicationPid)).toBeUndefined();
    fs.unlinkSync(context.file);
    fs.writeFileSync(context.file, ' '.repeat(16385), { mode: 0o600 });
    expect(readRemoteRuntime(context.stateDir, context.sessionID, context.applicationPid)).toBeUndefined();
  });

  test('refuses unsafe identifiers and permission modes', () => {
    const context = fixture();
    expect(readRemoteRuntime(context.stateDir, '../other', context.applicationPid)).toBeUndefined();
    expect(readRemoteRuntime(context.stateDir, context.sessionID, undefined)).toBeUndefined();
    if (process.platform !== 'win32') {
      fs.chmodSync(context.file, 0o644);
      expect(readRemoteRuntime(context.stateDir, context.sessionID, context.applicationPid)).toBeUndefined();
    }
  });

  test('unknown states and unbounded values are not exposed', () => {
    expect(publicRemoteRuntime({ state: 'private-secret' })).toBeUndefined();
    expect(publicRemoteRuntime({ state: 'unverified', reason: 'private-secret', catalog: 'private-secret', added: 1000000, updater: 'private-secret' }))
      .toEqual({ state: 'unverified' });
    expect(publicRemoteRuntime({ state: 'unverified', reason: 'remote_update_helper_unverified' }))
      .toEqual({ state: 'unverified', reason: 'remote_update_helper_unverified' });
  });
});

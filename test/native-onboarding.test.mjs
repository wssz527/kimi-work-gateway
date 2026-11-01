import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeOnboarding } from '../src/native-onboarding.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kwg-onboarding-')); roots.push(root);
  const kimiDir = path.join(root, 'daimon-share', 'daimon'); fs.mkdirSync(kimiDir, { recursive: true });
  return { stateDir: path.join(root, 'state'), kimiDir };
}

test('enabled connection prepares once and does not reprompt after cancellation', async () => {
  const env = fixture(); let runs = 0;
  const setup = { run: async () => { runs++; return { state: 'cancelled' }; } };
  const probe = { check: async () => ({ revealed: false, intranet: { passed: false } }) };
  const first = new NativeOnboarding({ ...env, setup, probe });
  expect((await first.ensure()).state).toBe('cancelled');
  expect((await first.ensure()).state).toBe('cancelled');
  expect((await new NativeOnboarding({ ...env, setup, probe }).ensure()).state).toBe('cancelled');
  expect(runs).toBe(1);
  expect((await first.ensure({ retry: true })).state).toBe('cancelled'); expect(runs).toBe(2);
});

test('a reset reveal flag is restored without administrator access when DNS already works', async () => {
  const env = fixture(); let runs = 0;
  const setup = { flagValue: () => ({ revealed: true, future: 'kept' }), run: async () => { runs++; } };
  const probe = { check: async () => ({ revealed: false, intranet: { passed: true } }), cached: {} };
  const onboarding = new NativeOnboarding({ ...env, setup, probe });
  expect((await onboarding.ensure()).state).toBe('ready');
  expect(JSON.parse(fs.readFileSync(onboarding.flagFile, 'utf8'))).toEqual({ revealed: true, future: 'kept' });
  expect(runs).toBe(0); expect(probe.cached).toBeNull();
});

test('Kimi data not created yet waits without consuming the first preparation attempt', async () => {
  const env = fixture(); fs.rmSync(path.dirname(env.kimiDir), { recursive: true });
  const onboarding = new NativeOnboarding({ ...env, setup: {}, probe: { check: async () => ({ intranet: { passed: false } }) } });
  expect((await onboarding.ensure()).state).toBe('waiting-kimi'); expect(fs.existsSync(onboarding.file)).toBe(false);
});

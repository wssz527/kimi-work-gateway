import { test, expect } from 'bun:test';
import { normalizeSubagentPolicy } from '../src/subagent-policy.mjs';

const models = [{ id: 'vendor/child', protocol: 'responses', contextWindow: 128000, tools: true }];

test('subagent targets resolve through the active native profile instead of an assumed provider prefix', () => {
  const aliases = { 'vendor/child': 'native-provider/vendor/child' };
  const selected = { mode: 'pool', model: models[0].id, models: [{ id: models[0].id, description: 'Review' }] };
  const policy = normalizeSubagentPolicy(selected, models, aliases);
  expect(policy.modelAlias).toBe(aliases['vendor/child']);
  expect(policy.models[0].modelAlias).toBe(aliases['vendor/child']);
});

test('a model absent from the confirmed native profile blocks without fabricating an alias', () => {
  expect(() => normalizeSubagentPolicy({ mode: 'force', model: models[0].id }, models, {})).toThrow('subagent_native_model_missing');
});

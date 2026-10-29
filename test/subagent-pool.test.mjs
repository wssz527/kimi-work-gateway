import { expect, test } from 'bun:test';
import { normalizeSubagentPolicy } from '../src/subagent-policy.mjs';

const models = [
  { id: 'lab/kimi-parent', protocol: 'chat', contextWindow: 64000, tools: true },
  { id: 'lab/child', protocol: 'responses', contextWindow: 64000, tools: true },
  { id: 'lab/no-tools', protocol: 'responses', contextWindow: 64000 },
];
const desired = { mode: 'pool', model: models[1].id, models: [
  { id: models[0].id, description: 'Implementation' }, { id: models[1].id, description: 'Independent review' },
] };
test('native pools retain individual aliases, descriptions and an explicit default', () => {
  expect(normalizeSubagentPolicy(desired, models)).toEqual({ ...desired, transport: 'native-config',
    modelAlias: 'byok-kth-resp/lab/child', models: [
      { ...desired.models[0], modelAlias: 'byok-kth-kimi/lab/kimi-parent' },
      { ...desired.models[1], modelAlias: 'byok-kth-resp/lab/child' },
    ] });
  expect(normalizeSubagentPolicy({ mode: 'inherit', transport: 'native-config' })).toEqual({ mode: 'inherit', transport: 'native-config' });
});
test('pools refuse unavailable models, duplicates, no tools and a missing default', () => {
  for (const value of [
    { ...desired, models: [] }, { ...desired, models: [desired.models[0]] },
    { ...desired, models: [desired.models[1], desired.models[1]] },
    { ...desired, models: [{ id: 'lab/no-tools', description: '' }, desired.models[1]] },
    { ...desired, models: [{ id: 'gone/child', description: '' }, desired.models[1]] },
    { ...desired, effort: 'high' }, { ...desired, transport: 'guess' },
    { ...desired, models: [{ id: models[1].id, description: 'line\nbreak' }] },
    { ...desired, models: [{ id: models[1].id, description: '   ' }] },
  ]) expect(() => normalizeSubagentPolicy(value, models)).toThrow();
});

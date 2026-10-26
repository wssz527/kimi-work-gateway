import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { nativeCatalog, validateModels } from '../src/index.mjs';

const archive = '/Applications/Kimi.app/Contents/Resources/app.asar';

function installedContract() {
  const bytes = fs.readFileSync(archive);
  const tree = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
  let entry = tree;
  for (const part of 'out/main/index.js'.split('/')) entry = entry.files[part];
  const base = 8 + bytes.readUInt32LE(4);
  const text = bytes.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size).toString();
  const table = text.match(/function _0x9700\(\) \{[\s\S]*?\n\}/)?.[0];
  const decoder = text.match(/function _0x5c0f\([^\n]*\) \{[\s\S]*?\n\}/)?.[0];
  const marker = '})(_0x9700, 467652)';
  if (!table || !decoder || !text.includes(marker)) throw Error('installed Kimi contract changed; review before using native mode');
  const strings = vm.createContext({});
  vm.runInContext(table + '\n' + decoder + '\n'
    + text.slice(text.indexOf('(function('), text.indexOf(marker) + marker.length) + ';', strings, { timeout: 2000 });
  const aliases = new Set(['_0x5c0f', '_0x3180cc']);
  for (let i = 0; i < 4; i++) for (const match of text.matchAll(/\b(_0x[a-f0-9]+)\s*=\s*(_0x[a-f0-9]+)\s*[,;]/g)) {
    if (aliases.has(match[2])) aliases.add(match[1]);
  }
  const decode = value => value.replace(/\b(_0x[a-f0-9]+)\((\d+)\)/g, (all, name, index) =>
    aliases.has(name) ? JSON.stringify(strings._0x5c0f(Number(index))) : all);
  const source = name => {
    const match = text.match(new RegExp('(?:async\\s+)?function ' + name + '\\('));
    if (!match) throw Error('native contract function missing: ' + name);
    return decode(text.slice(match.index, text.indexOf('\n}', match.index) + 2));
  };
  const functions = ['_0x3d394c', '_0x5e5623', '_0x167d08', '_0x344e46', '_0x235e21', '_0x1f87b3', '_0x588f2a',
    '_0x52469d', '_0x321891', '_0x4f10ee', '_0x58ac37', '_0xcdb585', '_0x215cc2', '_0x3a6e0d'];
  const constants = decode(text.slice(text.indexOf('const _0x76d39 ='), text.indexOf('function _0x4c1da4')));
  const rank = decode(text.match(/_0x26a83e\s*=\s*(\{[^}]*\})/)[1]);
  const context = vm.createContext({ _0x3180cc: () => { throw Error('unexpected native string lookup'); },
    _0x20c936: { warn: () => {} }, _0x1ab58c: 'isolated-contract', _0x216f22: 131072 });
  vm.runInContext(constants + '\nconst _0x26a83e = ' + rank + ';\n' + functions.map(source).join('\n'),
    context, { timeout: 2000 });
  return context;
}

test.skipIf(process.platform !== 'darwin' || !fs.existsSync(archive))(
  'the installed Kimi parser accepts every generated model and drops none', () => {
    const models = validateModels([
      { id: 'kimi-k3.1-pro', protocol: 'chat', contextWindow: 262144, maxOutputTokens: 32768, tools: true,
        reasoning: true, inputModalities: ['text', 'image'], reasoningEfforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'vendor/kimi-k3.5', protocol: 'chat', contextWindow: 131072, tools: true },
      { id: 'glm-5-3-flash', protocol: 'responses', contextWindow: 131072, maxOutputTokens: 32768 },
      { id: 'group/deepseek-v4-1-flash', protocol: 'responses', contextWindow: 131072 },
      { id: 'plain-id-without-any-family', protocol: 'responses', contextWindow: 8192 },
    ]);
    const context = installedContract();
    context.fixture = nativeCatalog(models);
    const parsed = vm.runInContext('_0xcdb585(fixture)', context, { timeout: 2000 });
    expect(parsed.skippedModels).toHaveLength(0);
    expect(parsed.models.map(row => row.model).sort()).toEqual(models.map(row => row.id).sort());
    const kimi = parsed.models.filter(row => row.family === 'kimi').map(row => row.model).sort();
    expect(kimi).toEqual(['kimi-k3.1-pro', 'vendor/kimi-k3.5']);
    expect(parsed.models.find(row => row.model === 'kimi-k3.1-pro')).toMatchObject({
      maxContextSize: 262144, maxOutputSize: 32768, supportEfforts: ['low', 'high'],
    });
  });

test.skipIf(process.platform !== 'darwin' || !fs.existsSync(archive))(
  'the installed Kimi parser silently drops a chat model whose ID does not start with kimi-', () => {
    const context = installedContract();
    context.fixture = { kimi: { type: 'kimi', models: {
      'glm-5-3': { name: 'glm-5-3', limit: { context: 131072 }, tool_call: true, reasoning: true,
        modalities: { input: ['text'], output: ['text'] } },
    } } };
    const parsed = vm.runInContext('_0xcdb585(fixture)', context, { timeout: 2000 });
    expect(parsed.skippedModels).toEqual(['glm-5-3']);
    expect(parsed.models).toHaveLength(0);
  });

test('models that declare no capabilities do not claim tools or reasoning', () => {
  const groups = nativeCatalog(validateModels([{ id: 'bare', protocol: 'responses', contextWindow: 4096 }]));
  expect(groups.responses.models.bare).toEqual({
    name: 'bare', limit: { context: 4096 }, tool_call: false, reasoning: false, modalities: { input: ['text'], output: ['text'] },
  });
  expect(groups.kimi).toBeUndefined();
});

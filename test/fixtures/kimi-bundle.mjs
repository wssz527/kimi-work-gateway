import fs from 'node:fs';

export function bundleSource(seed = 0) {
  const source = `
function _0xa1() {
  const _0xa2 = ['fixture'];
  return _0xa2;
}
function _0xa3(_0xa4, _0xa5) {
  _0xa4 = _0xa4 - 0;
  return _0xa1()[_0xa4];
}
(function(_0xa6, _0xa7) {
  _0xa6();
})(_0xa1, 1);
function _0xa8(catalog) {
  const models = [];
  const skippedModels = [];
  for (const group of Object.values(catalog)) {
    for (const [id, value] of Object.entries(group.models)) {
      if (id.includes('reject')) { skippedModels.push(id); continue; }
      const name = id.toLowerCase().split('/').pop();
      models.push({ model: id, family: name.startsWith('kimi-') ? 'kimi' : name.startsWith('gpt-') ? 'gpt' : 'generic', maxContextSize: value.limit.context });
    }
  }
  return { models, skippedModels };
}
// byok-availability.json byok-providers.json models/api.json
`;
  return source.replace(/_0xa([1-8])/g, (_, value) => '_0x' + (0x1000 + seed * 16 + Number(value)).toString(16));
}

export function writeBundle(file, source = bundleSource()) {
  const code = Buffer.from(source);
  const manifest = Buffer.from(JSON.stringify({ name: 'kimi-desktop-fixture', version: '9.8.7' }));
  const index = { files: {
    out: { files: { main: { files: { 'index.js': { size: code.length, offset: '0' } } } } },
    'package.json': { size: manifest.length, offset: String(code.length) },
  } };
  const json = Buffer.from(JSON.stringify(index));
  const headerSize = 8 + Math.ceil((json.length + 1) / 4) * 4;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  fs.writeFileSync(file, Buffer.concat([header, code, manifest]));
  return file;
}

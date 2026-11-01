import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configured = process.argv.find(value => value.startsWith('--headers='))?.slice(10) || process.env.NODE_INCLUDE_DIR;
const candidates = configured ? [configured] : [
  path.resolve(path.dirname(fs.realpathSync(process.execPath)), '../include/node'),
  path.resolve(path.dirname(process.execPath), '../include/node'),
];
const include = candidates.find(directory => fs.existsSync(path.join(directory, 'node_api.h')));
const architectures = process.argv.includes('--arm64-only') ? ['arm64'] : ['arm64', 'x86_64'];
if (process.platform !== 'darwin' || !include) {
  throw Error('remote_update_build_requires_macos_and_node_headers');
}
const target = path.join(root, 'src/native/remote-official-updater.node');
const result = spawnSync('/usr/bin/xcrun', ['clang++', ...architectures.flatMap(arch => ['-arch', arch]),
  '-std=c++17', '-fobjc-arc', '-fmodules', '-Wall', '-Wextra', '-mmacosx-version-min=13.0', '-DNAPI_VERSION=8',
  '-I', include, '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit', '-framework', 'Foundation',
  '-framework', 'Security', path.join(root, 'src/native/remote-official-updater.mm'), '-o', target],
{ cwd: root, encoding: 'utf8' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const signing = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', target], { encoding: 'utf8' });
if (signing.status !== 0) throw Error('remote_update_build_sign_failed');
console.log(JSON.stringify({ binary: target, napi: 8, architectures, runtimeTestedArchitectures: [] }));

// Syntax-checks every shipped module without a shell loop, so the same
// command works on macOS, Windows and CI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function expand(patterns) {
  const files = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) { files.push(pattern); continue; }
    const directory = path.dirname(pattern);
    const suffix = pattern.slice(pattern.indexOf('*') + 1);
    for (const name of fs.readdirSync(path.join(here, directory))) {
      if (name.endsWith(suffix)) files.push(path.join(directory, name));
    }
  }
  return [...new Set(files)];
}

const targets = expand(process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['src/*.mjs', 'cli.mjs', 'bin/*.mjs']);

let failed = 0;
for (const relative of targets) {
  const file = path.join(here, relative);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (failure) {
    failed++;
    process.stderr.write(relative + ': ' + String(failure.stderr || failure.message).trim() + '\n');
  }
}
process.stdout.write('checked ' + targets.length + ' files' + (failed ? ', ' + failed + ' failed' : '') + '\n');
process.exit(failed ? 1 : 0);

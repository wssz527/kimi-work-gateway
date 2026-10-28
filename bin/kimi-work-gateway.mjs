#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGatewayCLI } from '../src/update-launcher.mjs';

const basePackageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.env.KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT = basePackageRoot;
const fallback = path.join(basePackageRoot, 'cli.mjs');
let target;
try { target = resolveGatewayCLI({ basePackageRoot }); }
catch { process.stderr.write('kimi-work-gateway: update_state_invalid; using the installed package\n'); target = fallback; }
let module;
try {
  module = await import(pathToFileURL(target).href);
  if (typeof module.main !== 'function') throw Error('update_entry_invalid');
} catch (error) {
  if (target === fallback) throw error;
  process.stderr.write('kimi-work-gateway: update_launch_failed; using the installed package\n');
  module = await import(pathToFileURL(fallback).href);
}
await module.main();

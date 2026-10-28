// Chooses the CLI to execute when the standalone gateway starts.
//
// install() writes active.json only after the staged package has been checked.
// This module re-checks the recorded tree digest on every launch, so a pointer
// that survived a crash, a partial copy or manual editing never selects a
// tampered package. A broken pointer throws a diagnostic update_* error and the
// caller keeps running the package it shipped with; nothing here downloads,
// installs or hot-swaps a running process.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATEWAY_PACKAGE_NAME, gatewayUpdateDirectory, readGatewayActivePointer,
  verifyGatewayUpdateEntry } from './update-manager.mjs';

function launcherError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function defaultBasePackageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function readBaseManifest(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch { throw launcherError('update_baseline_invalid'); }
  if (manifest?.name !== GATEWAY_PACKAGE_NAME) throw launcherError('update_baseline_invalid');
  if (typeof manifest.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
    throw launcherError('update_baseline_invalid');
  }
  return manifest;
}

function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
}

function baselineRoots(baseRoot) {
  const roots = [path.resolve(baseRoot)];
  const bootstrap = process.env.KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT;
  if (typeof bootstrap === 'string' && bootstrap !== '' && path.isAbsolute(bootstrap)) {
    roots.push(path.resolve(bootstrap));
  }
  return roots;
}

function baseCLI(basePackageRoot) {
  const root = path.resolve(basePackageRoot);
  readBaseManifest(root);
  const cli = path.join(root, 'cli.mjs');
  let stat;
  try { stat = fs.lstatSync(cli); } catch { throw launcherError('update_baseline_invalid'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw launcherError('update_baseline_invalid');
  return cli;
}

// Returns the absolute cli.mjs path for the active package, or for the package
// this copy was installed from when no update has been recorded.
//
// `basePackageRoot` is the package this process was started from (after npm
// installed or upgraded it). A recorded update older than that base is never
// selected: installing a newer gateway must not be undone by a stale pointer.
export function resolveGatewayCLI({ updateDir, basePackageRoot } = {}) {
  const directory = path.resolve(updateDir ?? gatewayUpdateDirectory());
  const baseRoot = path.resolve(basePackageRoot ?? defaultBasePackageRoot());
  const base = readBaseManifest(baseRoot);
  let active;
  try { active = readGatewayActivePointer(directory, { baselineRoots: baselineRoots(baseRoot) }); }
  catch { throw launcherError('update_active_invalid'); }
  if (!active) return baseCLI(baseRoot);
  const entry = active.current;
  if (entry.source === 'baseline') {
    // A baseline entry always has to match its recorded digest, even when it
    // points at this very package: a stale or edited pointer must not be
    // mistaken for a healthy one.
    try {
      verifyGatewayUpdateEntry(entry, directory);
    } catch {
      throw launcherError('update_package_corrupt');
    }
    if (path.resolve(entry.root) === baseRoot) return baseCLI(baseRoot);
    return entry.cli;
  }
  try {
    if (path.resolve(entry.root) !== path.resolve(directory, 'releases', entry.key, 'package')) {
      throw launcherError('update_active_invalid');
    }
    verifyGatewayUpdateEntry(entry, directory);
  } catch (error) {
    const code = error?.code ?? error?.message;
    if (code === 'update_active_invalid') throw launcherError('update_active_invalid');
    throw launcherError('update_package_corrupt');
  }
  // A base package from npm that is at least as new wins over an older release.
  if (atLeast(base.version, entry.version)) return baseCLI(baseRoot);
  return entry.cli;
}

// Same decision as resolveGatewayCLI, with the facts a caller needs to report
// which package is running. Additive helper; resolveGatewayCLI is the contract.
export function resolveGatewayTarget({ updateDir, basePackageRoot } = {}) {
  const directory = path.resolve(updateDir ?? gatewayUpdateDirectory());
  const baseRoot = path.resolve(basePackageRoot ?? defaultBasePackageRoot());
  const base = readBaseManifest(baseRoot);
  let active;
  try { active = readGatewayActivePointer(directory, { baselineRoots: baselineRoots(baseRoot) }); }
  catch { throw launcherError('update_active_invalid'); }
  const cli = resolveGatewayCLI({ updateDir: directory, basePackageRoot: baseRoot });
  if (!active || cli === path.join(baseRoot, 'cli.mjs')) {
    return { cli, source: 'base', root: baseRoot, version: base.version };
  }
  return {
    cli,
    source: active.current.source,
    root: active.current.root,
    version: active.current.version,
  };
}

// Official GitHub release updates for the standalone gateway.
//
// Only one repository and one channel are trusted: the latest stable release of
// wssz527/kimi-work-gateway. A download is staged outside the installed package,
// checked against the release's own SHA-256, inspected entry by entry, and only
// then recorded in active.json. A failed download or a malformed archive never
// touches the active pointer, and the running process is never replaced on
// disk while it executes.
//
// The module has no runtime dependencies. Archives are validated here and
// unpacked with the system tar that the project already requires.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultStateDirectory } from './paths.mjs';

export const GATEWAY_PACKAGE_NAME = 'kimi-work-gateway';
export const GATEWAY_REPOSITORY = 'wssz527/kimi-work-gateway';
export const GATEWAY_LATEST_RELEASE_URL = 'https://api.github.com/repos/' + GATEWAY_REPOSITORY + '/releases/latest';
export const GATEWAY_RELEASE_DOWNLOAD_ROOT = 'https://github.com/' + GATEWAY_REPOSITORY + '/releases/download';
export const GATEWAY_RELEASE_PAGE_ROOT = 'https://github.com/' + GATEWAY_REPOSITORY + '/releases/tag';
export const GATEWAY_GIT_URL = 'https://github.com/' + GATEWAY_REPOSITORY;
// GitHub serves each repository's releases as a static Atom feed. It is a
// plain file, so it is neither rate limited nor tied to an account: the same
// anonymous request works for every user, on every platform, with or without
// git installed.
export const GATEWAY_RELEASES_FEED_URL = 'https://github.com/' + GATEWAY_REPOSITORY + '/releases.atom';

const ACTIVE_SCHEMA = 1;
const RELEASE_SCHEMA = 1;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ENTRY_KEY_PATTERN = /^(?:[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}|baseline:[0-9]+\.[0-9]+\.[0-9]+)$/;
const MAX_ACTIVE_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SHA256SUMS_BYTES = 64 * 1024;
const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
const MAX_RELEASE_FEED_BYTES = 1024 * 1024;
const REDIRECT_LIMIT = 4;
const USER_AGENT = 'kimi-work-gateway-updater/1';
const ASSET_REDIRECT_SUFFIX = '.githubusercontent.com';
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function updateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function reasonOf(error) {
  const message = error && typeof error.message === 'string' ? error.message : '';
  return /^update_[a-z0-9_]+$/.test(message) ? message : 'update_internal_error';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInsideOrEqual(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function parseGatewayVersion(value) {
  if (typeof value !== 'string') return null;
  const match = SEMVER_PATTERN.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  const a = parseGatewayVersion(left);
  const b = parseGatewayVersion(right);
  if (!a || !b) throw updateError('update_version_invalid');
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function gatewayUpdateDirectory(env = process.env) {
  const value = env?.KIMI_WORK_GATEWAY_UPDATE_DIR;
  if (value === undefined || value === null || value === '') {
    return path.join(defaultStateDirectory(), 'program-updates');
  }
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw updateError('update_directory_invalid');
  return path.resolve(value);
}

function defaultPackageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function readPackageVersion(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' && SEMVER_PATTERN.test(manifest.version) ? manifest.version : null;
  } catch { return null; }
}

function readSmallFile(file, maxBytes, failureCode) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw updateError(failureCode);
  }
  if (!stat.isFile() || stat.size > maxBytes) throw updateError(failureCode);
  try {
    return fs.readFileSync(file);
  } catch {
    throw updateError(failureCode);
  }
}

function writeJSONAtomic(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + process.pid
    + '.' + crypto.randomBytes(6).toString('hex'));
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw updateError('update_write_failed');
  }
  try { fs.chmodSync(file, 0o600); } catch {}
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return null;
  let normalized = value;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  if (/[\0-\x1f\x7f]/.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
}

// --- active pointer ---------------------------------------------------------

function normalizeActiveEntry(value, updateDir, baselineRoots = []) {
  if (!isPlainObject(value)) throw updateError('update_active_invalid');
  if (value.source !== 'release' && value.source !== 'baseline') throw updateError('update_active_invalid');
  if (typeof value.version !== 'string' || !SEMVER_PATTERN.test(value.version)) throw updateError('update_active_invalid');
  if (typeof value.key !== 'string' || !ENTRY_KEY_PATTERN.test(value.key)) throw updateError('update_active_invalid');
  if (typeof value.root !== 'string' || !path.isAbsolute(value.root)) throw updateError('update_active_invalid');
  if (typeof value.cli !== 'string' || !path.isAbsolute(value.cli)) throw updateError('update_active_invalid');
  if (!SHA256_PATTERN.test(value.treeSha256)) throw updateError('update_active_invalid');
  const root = path.resolve(value.root);
  if (path.resolve(value.cli) !== path.join(root, 'cli.mjs')) throw updateError('update_active_invalid');
  if (value.source === 'release') {
    if (!SHA256_PATTERN.test(value.sha256)) throw updateError('update_active_invalid');
    if (value.key !== value.version + '-' + value.sha256.slice(0, 12)) throw updateError('update_active_invalid');
    const expected = path.join(path.resolve(updateDir), 'releases', value.key, 'package');
    if (root !== path.resolve(expected)) throw updateError('update_active_invalid');
  } else {
    if (value.key !== 'baseline:' + value.version) throw updateError('update_active_invalid');
    // A baseline is the package the gateway was installed from. Restricting it
    // to a known root keeps a hand-edited pointer from naming an arbitrary
    // directory as the program to run.
    if (!baselineRoots.some(allowed => path.resolve(allowed) === root)) throw updateError('update_active_invalid');
  }
  return {
    source: value.source,
    version: value.version,
    key: value.key,
    root,
    cli: path.join(root, 'cli.mjs'),
    treeSha256: value.treeSha256,
    ...(value.source === 'release' ? { sha256: value.sha256 } : {}),
    ...(typeof value.installedAt === 'string' ? { installedAt: value.installedAt } : {}),
    ...(typeof value.recordedAt === 'string' ? { recordedAt: value.recordedAt } : {}),
  };
}

export function readGatewayActivePointer(updateDir, { baselineRoots = [] } = {}) {
  const directory = path.resolve(updateDir);
  const buffer = readSmallFile(path.join(directory, 'active.json'), MAX_ACTIVE_BYTES, 'update_active_invalid');
  if (buffer === null) return null;
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); }
  catch { throw updateError('update_active_invalid'); }
  if (!isPlainObject(value) || value.schema !== ACTIVE_SCHEMA) throw updateError('update_active_invalid');
  if (!Number.isInteger(value.generation) || value.generation < 1) throw updateError('update_active_invalid');
  const current = normalizeActiveEntry(value.current, directory, baselineRoots);
  const rollback = value.rollback === undefined || value.rollback === null
    ? null : normalizeActiveEntry(value.rollback, directory, baselineRoots);
  let rolledBackTo = null;
  if (value.rolledBackTo !== undefined && value.rolledBackTo !== null) {
    if (typeof value.rolledBackTo !== 'string' || !ENTRY_KEY_PATTERN.test(value.rolledBackTo)) {
      throw updateError('update_active_invalid');
    }
    rolledBackTo = value.rolledBackTo;
  }
  return {
    schema: ACTIVE_SCHEMA,
    generation: value.generation,
    current,
    rollback,
    rolledBackTo,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

function readLastCheck(updateDir) {
  let buffer;
  try {
    buffer = readSmallFile(path.join(path.resolve(updateDir), 'last-check.json'), MAX_ACTIVE_BYTES, 'update_last_check_invalid');
  } catch { return null; }
  if (buffer === null) return null;
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    if (!isPlainObject(value) || value.schema !== 1) return null;
    if (typeof value.latestVersion !== 'string' || !SEMVER_PATTERN.test(value.latestVersion)) return null;
    if (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))) return null;
    if (typeof value.releaseURL !== 'string') return null;
    let url;
    try { url = new URL(value.releaseURL); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== ''
      || url.username || url.password) return null;
    return { latestVersion: value.latestVersion, checkedAt: value.checkedAt, releaseURL: value.releaseURL };
  } catch { return null; }
}

// --- package trees ----------------------------------------------------------

function assertPlainFileName(name) {
  if (!name || name.includes('\\') || name.includes('/') || /[\0-\x1f\x7f]/.test(name)) {
    throw updateError('update_package_corrupt');
  }
}

export function gatewayPackageTreeDigest(root, { maxFiles = 5000, maxBytes = 256 * 1024 * 1024 } = {}) {
  const directory = path.resolve(root);
  const hash = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (current, relative) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { throw updateError('update_package_corrupt'); }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const childRelative = relative ? relative + '/' + entry.name : entry.name;
      assertPlainFileName(childRelative.split('/').pop());
      if (entry.isSymbolicLink()) throw updateError('update_package_corrupt');
      const absolute = path.join(current, entry.name);
      let stat;
      try { stat = fs.lstatSync(absolute); } catch { throw updateError('update_package_corrupt'); }
      if (stat.isSymbolicLink()) throw updateError('update_package_corrupt');
      if (stat.isDirectory()) {
        walk(absolute, childRelative);
        continue;
      }
      if (!stat.isFile()) throw updateError('update_package_corrupt');
      bytes += stat.size;
      if (bytes > maxBytes) throw updateError('update_package_too_large');
      files += 1;
      if (files > maxFiles) throw updateError('update_package_corrupt');
      let digest;
      try { digest = hashFile(absolute); } catch { throw updateError('update_package_corrupt'); }
      hash.update(childRelative);
      hash.update('\0');
      hash.update(String(stat.size));
      hash.update('\0');
      hash.update(digest);
      hash.update('\n');
    }
  };
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw updateError('update_package_corrupt'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw updateError('update_package_corrupt');
  walk(directory, '');
  return { sha256: hash.digest('hex'), files, bytes };
}

function requireRegularFile(file, failureCode) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw updateError(failureCode); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw updateError(failureCode);
}

function readPackageManifest(root, failureCode) {
  const buffer = readSmallFile(path.join(root, 'package.json'), MAX_MANIFEST_BYTES, failureCode);
  if (buffer === null) throw updateError(failureCode);
  let manifest;
  try { manifest = JSON.parse(buffer.toString('utf8')); }
  catch { throw updateError(failureCode); }
  if (!isPlainObject(manifest)) throw updateError(failureCode);
  return manifest;
}

export function inspectGatewayPackage(root, { version, treeSha256, failureCode = 'update_package_invalid' } = {}) {
  const directory = path.resolve(root);
  let stat;
  try { stat = fs.lstatSync(directory); } catch { throw updateError(failureCode); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw updateError(failureCode);
  const manifest = readPackageManifest(directory, failureCode);
  if (manifest.name !== GATEWAY_PACKAGE_NAME) throw updateError(failureCode);
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) throw updateError(failureCode);
  if (version !== undefined && manifest.version !== version) throw updateError(failureCode);
  const tree = gatewayPackageTreeDigest(directory);
  if (treeSha256 !== undefined && tree.sha256 !== treeSha256) throw updateError('update_package_corrupt');
  requireRegularFile(path.join(directory, 'cli.mjs'), failureCode);
  let bin = manifest.bin;
  if (isPlainObject(bin)) bin = bin[GATEWAY_PACKAGE_NAME];
  const relativeBin = safeRelativePath(bin);
  if (!relativeBin) throw updateError(failureCode);
  requireRegularFile(path.join(directory, relativeBin), failureCode);
  requireRegularFile(path.join(directory, 'src', 'index.mjs'), failureCode);
  if (manifest.main !== undefined) {
    const relativeMain = safeRelativePath(manifest.main);
    if (!relativeMain) throw updateError(failureCode);
    requireRegularFile(path.join(directory, relativeMain), failureCode);
  }
  return { manifest, tree };
}

export function verifyGatewayUpdateEntry(entry, updateDir) {
  const directory = path.resolve(updateDir);
  if (entry.source === 'baseline') {
    inspectGatewayPackage(entry.root, { version: entry.version, treeSha256: entry.treeSha256 });
    return entry.cli;
  }
  const expectedRoot = path.join(directory, 'releases', entry.key, 'package');
  if (path.resolve(entry.root) !== path.resolve(expectedRoot)) throw updateError('update_package_corrupt');
  inspectGatewayPackage(expectedRoot, { version: entry.version, treeSha256: entry.treeSha256 });
  return entry.cli;
}

// --- archive validation -----------------------------------------------------

function readTarString(block, offset, length) {
  let end = block.indexOf(0, offset);
  if (end === -1 || end > offset + length) end = offset + length;
  try { return UTF8.decode(block.subarray(offset, end)); }
  catch { throw updateError('update_package_archive_unsafe'); }
}

function parseTarOctal(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  if (field[0] === 0x80) return null;
  const text = field.toString('latin1').replace(/[\0 ]+$/g, '').replace(/^ +/, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  return Number.parseInt(text, 8);
}

function parsePaxRecords(body) {
  const records = new Map();
  let offset = 0;
  // Record lengths are byte counts, so offsets stay in bytes even when a path
  // is UTF-8 encoded. Values other than `path` may be arbitrary bytes (xattrs),
  // so they are kept raw.
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space === -1) throw updateError('update_package_archive_unsafe');
    const digits = body.subarray(offset, space).toString('latin1');
    if (!/^[1-9]\d{0,9}$/.test(digits)) throw updateError('update_package_archive_unsafe');
    const length = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(length) || offset + length > body.length) {
      throw updateError('update_package_archive_unsafe');
    }
    const recordBody = body.subarray(space + 1, offset + length);
    if (recordBody[recordBody.length - 1] !== 0x0a || recordBody.length < 3) {
      throw updateError('update_package_archive_unsafe');
    }
    const equals = recordBody.indexOf(0x3d);
    if (equals <= 0) throw updateError('update_package_archive_unsafe');
    const key = recordBody.subarray(0, equals).toString('latin1');
    if (!/^[A-Za-z0-9_.]+$/.test(key)) throw updateError('update_package_archive_unsafe');
    records.set(key, recordBody.subarray(equals + 1, recordBody.length - 1));
    offset += length;
  }
  return records;
}

function assertSafeArchiveName(name, directory) {
  if (!name || name.length > 1024 || name.includes('\\') || /[\0-\x1f\x7f]/.test(name)) {
    throw updateError('update_package_archive_unsafe');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw updateError('update_package_archive_unsafe');
  const trailingSlash = name.endsWith('/');
  const trimmed = trailingSlash ? name.slice(0, -1) : name;
  if (!trimmed) throw updateError('update_package_archive_unsafe');
  for (const segment of trimmed.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw updateError('update_package_archive_unsafe');
    // Reserved device names and trailing dots/spaces alias other names on Windows.
    if (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) {
      throw updateError('update_package_archive_unsafe');
    }
  }
  if (trimmed !== 'package' && !trimmed.startsWith('package/')) {
    throw updateError('update_package_archive_unsafe');
  }
  if (trimmed === 'package' && !directory) throw updateError('update_package_archive_unsafe');
  return { name: trimmed, trailingSlash, isRoot: trimmed === 'package' };
}

function validateTarBuffer(buffer, { maxUnpackedBytes, maxFiles }) {
  if (buffer.length < 1024 || buffer.length % 512 !== 0) throw updateError('update_package_archive_unsafe');
  let offset = 0;
  let files = 0;
  let seenEnd = false;
  const filesByName = new Set();
  const directories = new Set();
  let pendingName = null;
  const claim = (name, directory) => {
    // A name already used as a file cannot also be a directory (or vice versa),
    // and no entry may live below a regular file.
    if (!directory && (filesByName.has(name) || directories.has(name))) {
      throw updateError('update_package_archive_unsafe');
    }
    if (directory && filesByName.has(name)) throw updateError('update_package_archive_unsafe');
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index++) {
      const ancestor = segments.slice(0, index).join('/');
      if (filesByName.has(ancestor)) throw updateError('update_package_archive_unsafe');
    }
    if (directory) directories.add(name); else filesByName.add(name);
  };
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    let allZero = true;
    for (const byte of block) {
      if (byte !== 0) { allZero = false; break; }
    }
    if (allZero) {
      seenEnd = true;
      offset += 512;
      for (; offset < buffer.length; offset++) {
        if (buffer[offset] !== 0) throw updateError('update_package_archive_unsafe');
      }
      break;
    }
    let sum = 0;
    for (let index = 0; index < 512; index++) {
      sum += index >= 148 && index < 156 ? 0x20 : block[index];
    }
    const storedSum = parseTarOctal(block, 148, 8);
    if (storedSum === null || storedSum !== sum) throw updateError('update_package_archive_unsafe');
    let name = readTarString(block, 0, 100);
    const prefix = readTarString(block, 345, 155);
    const magic = block.subarray(257, 263).toString('latin1');
    if (prefix) {
      if (!magic.startsWith('ustar')) throw updateError('update_package_archive_unsafe');
      name = prefix + '/' + name;
    }
    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    const size = parseTarOctal(block, 124, 12);
    if (size === null || size < 0 || size > maxUnpackedBytes) throw updateError('update_package_archive_unsafe');
    const dataOffset = offset + 512;
    if (dataOffset + size > buffer.length) throw updateError('update_package_archive_unsafe');
    const body = buffer.subarray(dataOffset, dataOffset + size);
    offset = dataOffset + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const records = parsePaxRecords(body);
      for (const key of records.keys()) {
        // `path` is applied below; time and xattr records carry no extraction
        // target. Anything else (linkpath, size, ...) could redirect an entry.
        if (!['path', 'mtime', 'atime', 'ctime'].includes(key)
          && !key.startsWith('LIBARCHIVE.xattr.') && !key.startsWith('SCHILY.xattr.')) {
          throw updateError('update_package_archive_unsafe');
        }
      }
      if (records.has('path')) {
        if (pendingName !== null) throw updateError('update_package_archive_unsafe');
        let decoded;
        try { decoded = UTF8.decode(records.get('path')); }
        catch { throw updateError('update_package_archive_unsafe'); }
        pendingName = decoded;
      }
      continue;
    }
    if (type === 'g' || type === 'K' || type === 'L') throw updateError('update_package_archive_unsafe');
    if (type !== '0' && type !== '5') throw updateError('update_package_archive_unsafe');
    if (type === '5' && size !== 0) throw updateError('update_package_archive_unsafe');
    const effectiveName = pendingName === null ? name : pendingName;
    pendingName = null;
    // macOS tar writes AppleDouble metadata next to the top-level directory.
    // Outside `package/` it is never extracted into the package tree, so it is
    // ignored; inside the package it would become package content and is
    // rejected by the name rules below.
    if (type === '0' && /^\._[^/]*$/.test(effectiveName)) continue;
    const safe = assertSafeArchiveName(effectiveName, type === '5');
    if (safe.isRoot && type !== '5') throw updateError('update_package_archive_unsafe');
    if (type === '0' && safe.trailingSlash) throw updateError('update_package_archive_unsafe');
    claim(safe.name, type === '5');
    if (type === '0') {
      files += 1;
      if (files > maxFiles) throw updateError('update_package_archive_unsafe');
    }
  }
  if (!seenEnd) throw updateError('update_package_archive_unsafe');
  if (pendingName !== null) throw updateError('update_package_archive_unsafe');
  if (files === 0 || !filesByName.has('package/package.json')) throw updateError('update_package_archive_unsafe');
}

// tar restores the recorded modes, which may include read-only directories.
// Always make a tree writable before removing it, so cleanup cannot strand a
// staging directory that later blocks the same path.
export function removeTree(target) {
  const makeWritable = current => {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    try { fs.chmodSync(current, 0o700); } catch {}
    let entries = [];
    try { entries = fs.readdirSync(current); } catch {}
    for (const entry of entries) makeWritable(path.join(current, entry));
  };
  makeWritable(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

function tryRemoveTree(target) {
  try { removeTree(target); return true; } catch { return false; }
}

function readArchiveBytes(file, maxUnpackedBytes) {
  let raw;
  try { raw = fs.readFileSync(file); } catch { throw updateError('update_package_archive_unsafe'); }
  try {
    return zlib.gunzipSync(raw, { maxOutputLength: maxUnpackedBytes });
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw updateError('update_package_too_large');
    throw updateError('update_package_archive_unsafe');
  }
}

function extractArchive(file, destination) {
  // The archive was validated to contain only `package/...` plus optional
  // AppleDouble metadata. Extraction goes to a scratch directory and only the
  // package tree is moved into place, so nothing else can escape.
  const staging = destination + '.extract';
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    execFileSync('tar', ['-xzf', file, '-C', staging], {
      timeout: 60_000,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    tryRemoveTree(staging);
    throw updateError('update_package_extract_failed');
  }
  const extracted = path.join(staging, 'package');
  let stat;
  try { stat = fs.lstatSync(extracted); }
  catch {
    tryRemoveTree(staging);
    throw updateError('update_package_extract_failed');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    tryRemoveTree(staging);
    throw updateError('update_package_extract_failed');
  }
  try {
    fs.renameSync(extracted, destination);
  } catch {
    tryRemoveTree(staging);
    throw updateError('update_package_extract_failed');
  }
  tryRemoveTree(staging);
}

// --- HTTP -------------------------------------------------------------------

function requestHeaders(kind) {
  const accept = kind === 'api' ? 'application/vnd.github+json'
    : kind === 'feed' ? 'application/atom+xml, application/xml;q=0.9, */*;q=0.8'
      : 'application/octet-stream';
  const headers = {
    accept,
    'accept-encoding': 'identity',
    'user-agent': USER_AGENT,
  };
  if (kind === 'api') headers['x-github-api-version'] = '2022-11-28';
  return headers;
}

function redirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function httpFailure(status) {
  if (status === 404) return updateError('update_release_not_found');
  if (status === 403 || status === 429) return updateError('update_rate_limited');
  return updateError('update_release_http_error');
}

function releasePage(tag) {
  return GATEWAY_RELEASE_PAGE_ROOT + '/' + encodeURIComponent(tag);
}

// A release discovered from git: the tag is known, the archive size is not.
// Everything else is derived from the fixed release URL layout, so no API
// metadata is required. `size` stays null and the download is bounded by
// maxAssetBytes instead of an exact equality check.
function releaseFromTag(tag, version) {
  const assetName = GATEWAY_PACKAGE_NAME + '-' + version + '.tgz';
  const sumsURL = GATEWAY_RELEASE_DOWNLOAD_ROOT + '/' + encodeURIComponent(tag) + '/SHA256SUMS';
  return {
    version,
    tag,
    releaseURL: releasePage(tag),
    asset: {
      name: assetName,
      size: null,
      url: GATEWAY_RELEASE_DOWNLOAD_ROOT + '/' + encodeURIComponent(tag) + '/' + encodeURIComponent(assetName),
      digest: null,
    },
    sums: { name: 'SHA256SUMS', size: null, url: sumsURL },
    discoveredBy: 'git',
  };
}

// Stable versions only: no pre-release suffixes, no build metadata. Tags that
// do not parse are skipped rather than failing the whole check.
export function stableTagsFromRefs(text) {
  if (typeof text !== 'string') throw updateError('update_git_unavailable');
  const versions = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^[0-9a-f]{40,64}\trefs\/tags\/(.+)$/.exec(line.trim());
    if (!match) continue;
    let tag = match[1];
    if (tag.endsWith('^{}')) tag = tag.slice(0, -3);
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!SEMVER_PATTERN.test(version)) continue;
    versions.set(version, 'v' + version);
  }
  return [...versions.keys()].sort((left, right) => compareVersions(right, left))
    .map(version => ({ version, tag: versions.get(version) }));
}

function latestTagsViaGit({ timeoutMs, gitPath }) {
  const binary = typeof gitPath === 'string' && gitPath !== '' ? gitPath : 'git';
  let output;
  try {
    output = execFileSync(binary, ['ls-remote', '--tags', '--refs', GATEWAY_GIT_URL], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    throw updateError('update_git_unavailable');
  }
  return stableTagsFromRefs(output);
}

// The feed lists published releases only, newest first, which is exactly what
// the API's "latest release" answers. Parse the entry ids rather than trusting
// order, and keep the same stable-only rule as the git path.
export function stableTagsFromFeed(text) {
  if (typeof text !== 'string') throw updateError('update_release_invalid');
  const versions = new Map();
  for (const match of text.matchAll(/<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g)) {
    let tag = match[1].trim();
    if (tag.endsWith('^{}')) tag = tag.slice(0, -3);
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    if (!SEMVER_PATTERN.test(version)) continue;
    versions.set(version, 'v' + version);
  }
  return [...versions.keys()].sort((left, right) => compareVersions(right, left))
    .map(version => ({ version, tag: versions.get(version) }));
}

function validateDownloadURL(value, tag, assetName) {
  if (typeof value !== 'string' || value.length > 2048) throw updateError('update_release_asset_invalid');
  let url;
  try { url = new URL(value); } catch { throw updateError('update_release_asset_invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port !== ''
    || url.username || url.password || url.search || url.hash) {
    throw updateError('update_release_asset_invalid');
  }
  const expected = new URL(GATEWAY_RELEASE_DOWNLOAD_ROOT).pathname
    + '/' + encodeURIComponent(tag) + '/' + encodeURIComponent(assetName);
  if (url.pathname !== expected) throw updateError('update_release_asset_invalid');
  return url.href;
}

function validateReleaseObject(value, maxAssetBytes) {
  if (!isPlainObject(value)) throw updateError('update_release_invalid');
  if (value.draft === true || value.prerelease === true) throw updateError('update_release_unstable');
  if (typeof value.tag_name !== 'string' || value.tag_name.length === 0 || value.tag_name.length > 64) {
    throw updateError('update_release_invalid');
  }
  const tag = value.tag_name;
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  if (!SEMVER_PATTERN.test(version)) throw updateError('update_release_version_invalid');
  if (value.html_url !== undefined) {
    if (typeof value.html_url !== 'string' || value.html_url !== releasePage(tag)) {
      throw updateError('update_release_invalid');
    }
  }
  if (value.url !== undefined) {
    let url;
    try { url = new URL(value.url); } catch { throw updateError('update_release_invalid'); }
    if (url.protocol !== 'https:' || url.hostname !== 'api.github.com' || url.port !== ''
      || !url.pathname.startsWith('/repos/wssz527/kimi-work-gateway/releases/')) {
      throw updateError('update_release_invalid');
    }
  }
  if (!Array.isArray(value.assets) || value.assets.length === 0 || value.assets.length > 200) {
    throw updateError('update_release_invalid');
  }
  const assetName = GATEWAY_PACKAGE_NAME + '-' + version + '.tgz';
  const asset = value.assets.find(candidate => isPlainObject(candidate) && candidate.name === assetName);
  if (!asset) throw updateError('update_release_asset_missing');
  if (!Number.isInteger(asset.size) || asset.size < 1 || asset.size > maxAssetBytes) {
    throw updateError('update_release_asset_invalid');
  }
  if (asset.state !== undefined && asset.state !== 'uploaded') throw updateError('update_release_asset_invalid');
  const downloadURL = validateDownloadURL(asset.browser_download_url, tag, assetName);
  let digest = null;
  if (asset.digest !== undefined && asset.digest !== null) {
    if (typeof asset.digest !== 'string') throw updateError('update_release_asset_invalid');
    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
    if (!match) throw updateError('update_release_asset_invalid');
    digest = match[1].toLowerCase();
  }
  let sums = null;
  const sumsAsset = value.assets.find(candidate => isPlainObject(candidate) && candidate.name === 'SHA256SUMS');
  if (sumsAsset) {
    if (!Number.isInteger(sumsAsset.size) || sumsAsset.size < 1 || sumsAsset.size > MAX_SHA256SUMS_BYTES) {
      throw updateError('update_release_asset_invalid');
    }
    if (sumsAsset.state !== undefined && sumsAsset.state !== 'uploaded') {
      throw updateError('update_release_asset_invalid');
    }
    sums = {
      name: 'SHA256SUMS',
      size: sumsAsset.size,
      url: validateDownloadURL(sumsAsset.browser_download_url, tag, 'SHA256SUMS'),
    };
  }
  return {
    version,
    tag,
    releaseURL: releasePage(tag),
    asset: { name: assetName, size: asset.size, url: downloadURL, digest },
    sums,
  };
}

function parseChecksums(buffer, assetName) {
  let text;
  try { text = UTF8.decode(buffer); } catch { throw updateError('update_sums_invalid'); }
  if (text.includes('\0')) throw updateError('update_sums_invalid');
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?([^/\\\0]+)$/.exec(trimmed);
    if (!match) continue;
    const name = match[2].trim();
    if (name !== assetName) continue;
    const digest = match[1].toLowerCase();
    if (found !== null && found !== digest) throw updateError('update_sums_invalid');
    found = digest;
  }
  if (found === null) throw updateError('update_checksum_unavailable');
  return found;
}

function raceDeadline(promise, controller, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(updateError('update_timeout'));
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { controller.abort(); } catch {}
      reject(updateError('update_timeout'));
    }, remaining);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// --- updater ----------------------------------------------------------------

export class GatewayUpdater {
  constructor({
    updateDir, packageRoot, currentVersion, fetchImpl, env,
    timeoutMs, maxAssetBytes, maxUnpackedBytes, maxFiles, lockTimeoutMs, lockStaleMs, now,
    gitImpl, gitPath,
  } = {}) {
    this.packageRoot = path.resolve(packageRoot ?? defaultPackageRoot());
    this.env = env ?? process.env;
    this.updateDir = path.resolve(updateDir ?? gatewayUpdateDirectory(this.env));
    if (isInsideOrEqual(this.updateDir, this.packageRoot)) throw updateError('update_directory_invalid');
    try {
      const stat = fs.lstatSync(this.updateDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw updateError('update_directory_invalid');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw updateError('update_directory_invalid');
    }
    if (currentVersion !== undefined && currentVersion !== null) {
      if (typeof currentVersion !== 'string' || !SEMVER_PATTERN.test(currentVersion)) {
        throw updateError('update_version_invalid');
      }
      this.currentVersion = currentVersion;
    } else {
      this.currentVersion = readPackageVersion(this.packageRoot);
    }
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw updateError('update_config_invalid');
    if (gitImpl !== undefined && typeof gitImpl !== 'function') throw updateError('update_config_invalid');
    this.fetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.gitImpl = gitImpl ?? null;
    this.gitPath = typeof gitPath === 'string' && gitPath !== '' ? gitPath : null;
    this.timeoutMs = positiveInteger(timeoutMs, 30_000);
    this.maxAssetBytes = positiveInteger(maxAssetBytes, 32 * 1024 * 1024);
    this.maxUnpackedBytes = positiveInteger(maxUnpackedBytes, 128 * 1024 * 1024);
    this.maxFiles = positiveInteger(maxFiles, 5000);
    this.lockTimeoutMs = positiveInteger(lockTimeoutMs, 10_000);
    this.lockStaleMs = positiveInteger(lockStaleMs, 120_000);
    this.now = typeof now === 'function' ? now : () => new Date();
  }

  stamp() {
    const value = this.now();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw updateError('update_clock_invalid');
    return date.toISOString();
  }

  effectiveVersion(active) {
    let effective = this.currentVersion;
    if (active?.current?.version) {
      if (!effective || compareVersions(active.current.version, effective) > 0) {
        effective = active.current.version;
      }
    }
    return effective ?? null;
  }

  inspect() {
    let active;
    try {
      active = readGatewayActivePointer(this.updateDir,
        { baselineRoots: [this.packageRoot, ...this.bootstrapRoots()] });
    } catch {
      return presentState({ currentVersion: this.currentVersion, state: 'failed', reason: 'update_active_invalid' });
    }
    const last = readLastCheck(this.updateDir);
    const currentVersion = this.currentVersion ?? active?.current?.version ?? null;
    const effective = this.effectiveVersion(active);
    // Only a package newer than the one running waits for a restart to take
    // effect; an older recorded package is a downgrade, not a pending update.
    const pending = active?.current && currentVersion
      && compareVersions(active.current.version, currentVersion) > 0
      ? active.current.version : undefined;
    const extra = {
      ...(last ? { latestVersion: last.latestVersion, checkedAt: last.checkedAt, releaseURL: last.releaseURL } : {}),
      ...(active?.rollback ? { rollbackVersion: active.rollback.version } : {}),
    };
    if (this.checking) return presentState({ currentVersion, state: 'checking', ...extra, ...(pending ? { pendingVersion: pending } : {}) });
    if (pending) {
      return presentState({ currentVersion, state: 'staged', ...extra, pendingVersion: pending });
    }
    if (last && effective && compareVersions(last.latestVersion, effective) > 0) {
      return presentState({ currentVersion, state: 'available', ...extra });
    }
    if (last || active) return presentState({ currentVersion, state: 'current', ...extra });
    return presentState({ currentVersion, state: 'not-checked' });
  }

  failedState(reason) {
    let base;
    try { base = this.inspect(); }
    catch { base = presentState({ currentVersion: this.currentVersion, state: 'failed' }); }
    return presentState({ ...base, state: 'failed', reason });
  }

  async check() {
    this.checking = true;
    try {
      const release = await this.loadRelease();
      this.writeCheck(release);
    } catch (error) {
      this.checking = false;
      return this.failedState(reasonOf(error));
    }
    this.checking = false;
    return this.inspect();
  }

  async install() {
    this.checking = true;
    let result;
    try {
      const release = await this.loadRelease();
      this.writeCheck(release);
      const active = this.readActive();
      const effective = this.effectiveVersion(active);
      if (effective && compareVersions(release.version, effective) <= 0) {
        this.checking = false;
        return this.inspect();
      }
      const sha256 = await this.resolveChecksum(release);
      const key = release.version + '-' + sha256.slice(0, 12);
      const releaseDir = path.join(this.updateDir, 'releases', key);
      const prepared = this.readStagedRelease(releaseDir, release.version, sha256)
        ? null : await this.buildStagedRelease(release, sha256, key);
      try {
        result = await this.withLock(async () => {
          const fresh = this.readActive();
          if (fresh?.current?.source === 'release'
            && fresh.current.version === release.version && fresh.current.sha256 === sha256) {
            return 'unchanged';
          }
          if (prepared) this.moveStagedRelease(prepared.directory, releaseDir, release.version, sha256);
          const staged = this.readStagedRelease(releaseDir, release.version, sha256);
          if (!staged) throw updateError('update_package_invalid');
          const entry = {
            source: 'release',
            version: release.version,
            key,
            root: path.join(releaseDir, 'package'),
            cli: path.join(releaseDir, 'package', 'cli.mjs'),
            sha256,
            treeSha256: staged.treeSha256,
            installedAt: this.stamp(),
          };
          const next = {
            schema: ACTIVE_SCHEMA,
            generation: (fresh?.generation ?? 0) + 1,
            current: entry,
            rollback: this.rollbackTarget(fresh),
            rolledBackTo: null,
            updatedAt: this.stamp(),
          };
          writeJSONAtomic(path.join(this.updateDir, 'active.json'), next);
          return 'installed';
        });
      } finally {
        if (prepared) tryRemoveTree(prepared.tempRoot);
      }
    } catch (error) {
      this.checking = false;
      return this.failedState(reasonOf(error));
    }
    this.checking = false;
    return this.inspect();
  }

  async rollback() {
    this.checking = true;
    try {
      await this.withLock(async () => {
        const active = this.readActive();
        if (!active) throw updateError('update_rollback_unavailable');
        if (!active.rollback) {
          if (active.rolledBackTo === active.current.key) return;
          throw updateError('update_rollback_unavailable');
        }
        if (active.rollback.key === active.current.key) throw updateError('update_rollback_unavailable');
        try { verifyGatewayUpdateEntry(active.rollback, this.updateDir); }
        catch { throw updateError('update_rollback_target_invalid'); }
        const next = {
          schema: ACTIVE_SCHEMA,
          generation: active.generation + 1,
          current: active.rollback,
          rollback: null,
          rolledBackTo: active.rollback.key,
          updatedAt: this.stamp(),
        };
        writeJSONAtomic(path.join(this.updateDir, 'active.json'), next);
      });
    } catch (error) {
      this.checking = false;
      return this.failedState(reasonOf(error));
    }
    this.checking = false;
    return this.inspect();
  }

  readActive() {
    try {
      return readGatewayActivePointer(this.updateDir, { baselineRoots: [this.packageRoot, ...this.bootstrapRoots()] });
    } catch { throw updateError('update_active_invalid'); }
  }

  bootstrapRoots() {
    const value = this.env?.KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT;
    if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) return [];
    return [path.resolve(value)];
  }

  rollbackTarget(active) {
    if (active?.current) return { ...active.current };
    const bootstrap = this.env?.KIMI_WORK_GATEWAY_BOOTSTRAP_ROOT;
    if (bootstrap !== undefined && bootstrap !== null && bootstrap !== '') {
      if (typeof bootstrap !== 'string' || !path.isAbsolute(bootstrap)) throw updateError('update_baseline_invalid');
      return this.baselineEntry(bootstrap, 'update_baseline_invalid');
    }
    if (!isInsideOrEqual(this.packageRoot, this.updateDir)) {
      return this.baselineEntry(this.packageRoot, 'update_baseline_invalid');
    }
    return null;
  }

  baselineEntry(root, failureCode) {
    const directory = path.resolve(root);
    let manifest;
    let tree;
    try {
      ({ manifest, tree } = inspectGatewayPackage(directory, { failureCode }));
    } catch {
      throw updateError(failureCode);
    }
    return {
      source: 'baseline',
      version: manifest.version,
      key: 'baseline:' + manifest.version,
      root: directory,
      cli: path.join(directory, 'cli.mjs'),
      treeSha256: tree.sha256,
      recordedAt: this.stamp(),
    };
  }

  async loadRelease() {
    const discovered = await this.discoverViaGit();
    if (discovered) return discovered;
    const fed = await this.discoverViaFeed();
    if (fed) return fed;
    return this.loadReleaseViaAPI();
  }

  // git tells us which tags exist, not which of them carry a published
  // archive. Probe the archive checksum of each candidate newest-first and use
  // the first tag whose release is actually downloadable. A tag without a
  // release is skipped; it is not an error.
  async discoverViaGit() {
    let candidates;
    try {
      candidates = this.gitImpl
        ? this.gitImpl()
        : latestTagsViaGit({ timeoutMs: this.timeoutMs, gitPath: this.gitPath });
    } catch {
      return null;
    }
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    return this.pickRelease(candidates, 'git');
  }

  // Without git (a stock Windows install, for example), the static releases
  // feed answers the same question and, being a plain file rather than an API
  // call, costs nothing from anyone's rate limit.
  async discoverViaFeed() {
    let body;
    try {
      const session = await this.openResponse(new URL(GATEWAY_RELEASES_FEED_URL), 'feed', MAX_RELEASE_FEED_BYTES);
      body = await this.readResponse(session, MAX_RELEASE_FEED_BYTES, 'update_response_too_large');
    } catch {
      return null;
    }
    let candidates;
    try { candidates = stableTagsFromFeed(body.toString('utf8')); }
    catch { return null; }
    if (candidates.length === 0) return null;
    return this.pickRelease(candidates, 'feed');
  }

  async pickRelease(candidates, source) {
    const effective = this.effectiveVersion(this.readActiveOrNull());
    let lastReason = null;
    for (const candidate of candidates.slice(0, 5)) {
      if (typeof candidate?.version !== 'string' || !SEMVER_PATTERN.test(candidate.version)) continue;
      // Nothing at or below the installed version needs a download: report it
      // as the latest so the check settles on "current".
      if (effective && compareVersions(candidate.version, effective) <= 0) {
        return releaseFromTag(candidate.tag ?? 'v' + candidate.version, candidate.version);
      }
      const release = releaseFromTag(candidate.tag ?? 'v' + candidate.version, candidate.version);
      try {
        release.asset.digest = await this.fetchSumsDigest(release);
        return release;
      } catch (error) {
        lastReason = reasonOf(error);
      }
    }
    // The discovery source answered but no candidate had a usable archive:
    // that is a real failure, not a reason to fall back to the API.
    throw updateError(lastReason ?? 'update_release_not_found');
  }

  readActiveOrNull() {
    try { return this.readActive(); } catch { return null; }
  }

  async fetchSumsDigest(release) {
    const session = await this.openResponse(new URL(release.sums.url), 'sums', MAX_SHA256SUMS_BYTES);
    const body = await this.readResponse(session, MAX_SHA256SUMS_BYTES, 'update_sums_invalid');
    return parseChecksums(body, release.asset.name);
  }

  async loadReleaseViaAPI() {
    const session = await this.openResponse(new URL(GATEWAY_LATEST_RELEASE_URL), 'api', MAX_RELEASE_JSON_BYTES);
    const body = await this.readResponse(session, MAX_RELEASE_JSON_BYTES, 'update_response_too_large');
    let value;
    try { value = JSON.parse(body.toString('utf8')); }
    catch { throw updateError('update_release_invalid'); }
    return validateReleaseObject(value, this.maxAssetBytes);
  }

  writeCheck(release) {
    writeJSONAtomic(path.join(this.updateDir, 'last-check.json'), {
      schema: 1,
      checkedAt: this.stamp(),
      latestVersion: release.version,
      releaseURL: release.releaseURL,
    });
  }

  async resolveChecksum(release) {
    if (release.asset.digest) return release.asset.digest;
    if (!release.sums) throw updateError('update_checksum_unavailable');
    const session = await this.openResponse(new URL(release.sums.url), 'sums', MAX_SHA256SUMS_BYTES);
    const body = await this.readResponse(session, MAX_SHA256SUMS_BYTES, 'update_sums_invalid');
    return parseChecksums(body, release.asset.name);
  }

  assertTargetAllowed(url, kind) {
    if (!(url instanceof URL)) throw updateError('update_release_invalid');
    if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') {
      throw updateError(kind === 'api' ? 'update_release_invalid' : 'update_release_asset_invalid');
    }
    if (kind === 'api') {
      if (url.hostname !== 'api.github.com') throw updateError('update_release_invalid');
      return;
    }
    if (kind === 'feed') {
      // The feed is one fixed static file; never follow it elsewhere.
      const expected = new URL(GATEWAY_RELEASES_FEED_URL).pathname;
      if (url.hostname !== 'github.com' || url.pathname !== expected) {
        throw updateError('update_release_invalid');
      }
      return;
    }
    if (url.hostname === 'github.com' || url.hostname.endsWith(ASSET_REDIRECT_SUFFIX)) return;
    throw updateError('update_release_asset_invalid');
  }

  async openResponse(startURL, kind, maxBytes) {
    const deadline = Date.now() + this.timeoutMs;
    let current = startURL;
    for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
      this.assertTargetAllowed(current, kind);
      const controller = new AbortController();
      let response;
      try {
        const pending = this.fetchImpl(current.href, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
          headers: requestHeaders(kind),
        });
        response = await raceDeadline(Promise.resolve(pending), controller, deadline);
      } catch (error) {
        if (reasonOf(error) === 'update_timeout') throw updateError('update_timeout');
        throw updateError('update_network_error');
      }
      if (response.redirected) throw updateError('update_redirect_rejected');
      if (redirectStatus(response.status)) {
        let location = null;
        try { location = response.headers.get('location'); } catch {}
        try { await response.body?.cancel?.(); } catch {}
        if (typeof location !== 'string' || location === '') throw updateError('update_redirect_rejected');
        let next;
        try { next = new URL(location, current); } catch { throw updateError('update_redirect_rejected'); }
        if (!(next instanceof URL)) throw updateError('update_redirect_rejected');
        if (next.protocol !== 'https:' || next.username || next.password || next.port !== '') {
          throw updateError('update_redirect_rejected');
        }
        if (kind === 'api') {
          if (next.hostname !== 'api.github.com') throw updateError('update_redirect_rejected');
        } else if (kind === 'feed') {
          // A feed is served in place; any hop is a redirect to somewhere else.
          throw updateError('update_redirect_rejected');
        } else if (next.hostname !== 'github.com' && !next.hostname.endsWith(ASSET_REDIRECT_SUFFIX)) {
          throw updateError('update_redirect_rejected');
        }
        current = next;
        continue;
      }
      if (response.status !== 200) {
        try { await response.body?.cancel?.(); } catch {}
        throw httpFailure(response.status);
      }
      // GitHub answers JSON. Reject an HTML login or error page that happens to
      // answer 200, but do not require the header: a plain text answer is
      // parsed below and rejected there if it is not JSON.
      if (kind === 'api' || kind === 'feed') {
        let type = '';
        try { type = (response.headers.get('content-type') || '').toLowerCase(); } catch {}
        if (type.includes('text/html') || type.includes('application/xhtml')) {
          try { await response.body?.cancel?.(); } catch {}
          throw updateError('update_release_invalid');
        }
      }
      const declared = contentLength(response);
      if (declared !== null && declared > maxBytes) {
        try { await response.body?.cancel?.(); } catch {}
        throw updateError(kind === 'asset' ? 'update_package_too_large' : 'update_response_too_large');
      }
      return { response, controller, deadline };
    }
    throw updateError('update_redirect_rejected');
  }

  async readResponse(session, maxBytes, overflowCode) {
    const { response, controller, deadline } = session;
    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader() : null;
    if (!reader) {
      let buffer;
      try { buffer = Buffer.from(await response.arrayBuffer()); }
      catch (error) {
        if (reasonOf(error) === 'update_timeout') throw updateError('update_timeout');
        throw updateError('update_network_error');
      }
      if (buffer.length > maxBytes) throw updateError(overflowCode);
      return buffer;
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      let row;
      try { row = await raceDeadline(reader.read(), controller, deadline); }
      catch (error) {
        if (reasonOf(error) === 'update_timeout') throw updateError('update_timeout');
        throw updateError('update_network_error');
      }
      if (row.done) break;
      const chunk = Buffer.from(row.value);
      total += chunk.length;
      if (total > maxBytes) throw updateError(overflowCode);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  tmpDirectory() {
    const directory = path.join(this.updateDir, 'tmp');
    try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
    catch { throw updateError('update_write_failed'); }
    return directory;
  }

  readStagedRelease(releaseDir, version, sha256) {
    try {
      let stat;
      try { stat = fs.lstatSync(releaseDir); } catch { return null; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
      const buffer = readSmallFile(path.join(releaseDir, 'release.json'), 64 * 1024, 'update_package_invalid');
      if (buffer === null) return null;
      let metadata;
      try { metadata = JSON.parse(buffer.toString('utf8')); } catch { return null; }
      if (!isPlainObject(metadata) || metadata.schema !== RELEASE_SCHEMA) return null;
      if (metadata.name !== GATEWAY_PACKAGE_NAME || metadata.version !== version) return null;
      if (metadata.sha256 !== sha256 || !SHA256_PATTERN.test(metadata.treeSha256)) return null;
      const packageRoot = path.join(releaseDir, 'package');
      const { tree } = inspectGatewayPackage(packageRoot, {
        version,
        treeSha256: metadata.treeSha256,
        failureCode: 'update_package_invalid',
      });
      return { root: packageRoot, treeSha256: tree.sha256, installedAt: metadata.installedAt };
    } catch { return null; }
  }

  async buildStagedRelease(release, sha256, key) {
    const tempRoot = fs.mkdtempSync(path.join(this.tmpDirectory(), 'build-'));
    let keep = false;
    try {
      const archive = path.join(tempRoot, 'asset.tgz');
      const actual = await this.downloadAsset(release.asset, archive);
      if (actual !== sha256) throw updateError('update_checksum_mismatch');
      const unpacked = path.join(tempRoot, 'unpacked');
      validateTarBuffer(readArchiveBytes(archive, this.maxUnpackedBytes), {
        maxUnpackedBytes: this.maxUnpackedBytes,
        maxFiles: this.maxFiles,
      });
      const packageRoot = path.join(unpacked, 'package');
      extractArchive(archive, packageRoot);
      const { tree } = inspectGatewayPackage(packageRoot, { version: release.version });
      const metadata = {
        schema: RELEASE_SCHEMA,
        name: GATEWAY_PACKAGE_NAME,
        version: release.version,
        key,
        sha256,
        assetName: release.asset.name,
        assetSize: release.asset.size,
        treeSha256: tree.sha256,
        installedAt: this.stamp(),
      };
      writeJSONAtomic(path.join(unpacked, 'release.json'), metadata);
      keep = true;
      return { tempRoot, directory: unpacked };
    } finally {
      if (!keep) {
        tryRemoveTree(tempRoot);
      }
    }
  }

  moveStagedRelease(preparedDirectory, releaseDir, version, sha256) {
    try { fs.mkdirSync(path.dirname(releaseDir), { recursive: true, mode: 0o700 }); }
    catch { throw updateError('update_write_failed'); }
    try {
      fs.renameSync(preparedDirectory, releaseDir);
      return;
    } catch {}
    if (this.readStagedRelease(releaseDir, version, sha256)) return;
    tryRemoveTree(releaseDir);
    try {
      fs.renameSync(preparedDirectory, releaseDir);
    } catch {
      if (!this.readStagedRelease(releaseDir, version, sha256)) throw updateError('update_write_failed');
    }
  }

  async downloadAsset(asset, destination) {
    const session = await this.openResponse(new URL(asset.url), 'asset', this.maxAssetBytes);
    const { response, controller, deadline } = session;
    const declared = contentLength(response);
    const expectedSize = Number.isInteger(asset.size) && asset.size > 0 ? asset.size : null;
    if (expectedSize !== null && declared !== null && declared !== expectedSize) {
      try { await response.body?.cancel?.(); } catch {}
      throw updateError('update_size_mismatch');
    }
    let handle;
    try { handle = fs.openSync(destination, 'wx', 0o600); }
    catch { throw updateError('update_write_failed'); }
    const hash = crypto.createHash('sha256');
    let total = 0;
    const write = chunk => {
      let offset = 0;
      while (offset < chunk.length) offset += fs.writeSync(handle, chunk, offset, chunk.length - offset);
      hash.update(chunk);
      total += chunk.length;
      if (total > this.maxAssetBytes) throw updateError('update_package_too_large');
    };
    try {
      const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader() : null;
      if (!reader) {
        let buffer;
        try { buffer = Buffer.from(await response.arrayBuffer()); }
        catch (error) {
          if (reasonOf(error) === 'update_timeout') throw updateError('update_timeout');
          throw updateError('update_network_error');
        }
        write(buffer);
      } else {
        for (;;) {
          let row;
          try { row = await raceDeadline(reader.read(), controller, deadline); }
          catch (error) {
            if (reasonOf(error) === 'update_timeout') throw updateError('update_timeout');
            throw updateError('update_network_error');
          }
          if (row.done) break;
          write(Buffer.from(row.value));
        }
      }
    } catch (error) {
      try { fs.closeSync(handle); } catch {}
      handle = null;
      try { fs.rmSync(destination, { force: true }); } catch {}
      throw error;
    } finally {
      if (handle !== undefined && handle !== null) {
        try { fs.closeSync(handle); } catch {}
      }
    }
    if (expectedSize !== null && total !== expectedSize) {
      try { fs.rmSync(destination, { force: true }); } catch {}
      throw updateError('update_size_mismatch');
    }
    return hash.digest('hex');
  }

  async withLock(callback) {
    const lockDir = path.join(this.updateDir, 'lock');
    try { fs.mkdirSync(this.updateDir, { recursive: true, mode: 0o700 }); }
    catch { throw updateError('update_write_failed'); }
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try { fs.mkdirSync(lockDir, { mode: 0o700 }); break; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw updateError('update_write_failed');
        let stat = null;
        try { stat = fs.statSync(lockDir); } catch {}
        if (stat && Date.now() - stat.mtimeMs > this.lockStaleMs) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
          continue;
        }
        if (Date.now() >= deadline) throw updateError('update_lock_timeout');
        const pause = 20 + Math.floor(Math.random() * 20);
        await new Promise(resolve => setTimeout(resolve, pause));
      }
    }
    try {
      return await callback();
    } finally {
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
    }
  }
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// A missing header is unknown, not zero: Number(null) would be 0.
function contentLength(response) {
  let value = null;
  try { value = response.headers.get('content-length'); } catch {}
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function presentState(fields) {
  const state = { currentVersion: fields.currentVersion ?? null, state: fields.state };
  for (const key of ['latestVersion', 'checkedAt', 'releaseURL', 'pendingVersion', 'rollbackVersion', 'reason']) {
    if (fields[key] !== undefined && fields[key] !== null) state[key] = fields[key];
  }
  return state;
}

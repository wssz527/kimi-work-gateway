import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Kimi's native context strategy lives in one real TOML table, `[loop_control]`.
// The installed kernel's `LoopControlSchema` accepts exactly:
//
//   compaction_trigger_ratio: number in [0.5, 0.99]
//   reserved_context_size:    integer >= 0
//
// `resolveModelContext` copies both into the compaction strategy, and
// `shouldCompact` fires on `used >= maxSize * triggerRatio` or
// `used + reservedSize >= maxSize` (defaults .85 and 50000). The kernel has no
// post-compaction target ratio, so this module offers a trigger threshold and a
// reserved budget only — nothing here can promise a context size after
// compaction.
//
// The desktop app owns `config.toml` and may rewrite it wholesale, dropping
// whatever it does not model. So every write here is textual and minimal:
//
// - A real TOML parser rejects a second `[loop_control]` header, so an existing
//   table is edited key by key: only the value token of a key this module owns
//   is replaced, and a missing key is inserted right after the header. Foreign
//   keys, comments, key spelling and line endings survive untouched.
// - With no table, one marker-delimited block is appended. The block names its
//   owner and hashes its body, which is what makes a rewrite or removal safe.
// - A layout this module cannot edit without guessing — `[[loop_control]]`,
//   `[loop_control.x]`, a root `loop_control.x = …`, an inline
//   `loop_control = { … }` — is a conflict, never a rewrite.
//
// Provenance is recorded in one private receipt under `stateDir`, never in the
// Kimi home. For the table layout it keeps the exact line this module wrote per
// key and the exact line (or absence) it replaced, which is what makes a
// restore possible; a key someone else has since changed to another value is
// left alone and reported. Narrowing a policy hands back every field it stops
// covering in the same write, so a later inherit cannot leave our number behind
// over the user's. A block whose receipt is missing or unreadable is not
// attributed to this state directory at all: it is reported and left in place
// rather than rewritten or deleted on a guess.
//
// `policy` is the SAVED policy, and `applied` means only that the file on disk
// was observed to carry it. Whether a session picked it up needs a session
// reload, which this module never claims to have done.
export const NATIVE_CONTEXT_BEGIN = '# BEGIN KIMI WORK GATEWAY CONTEXT POLICY';
export const NATIVE_CONTEXT_END = '# END KIMI WORK GATEWAY CONTEXT POLICY';
export const NATIVE_CONTEXT_RECEIPT = 'native-context-policy-receipt.json';
export const NATIVE_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;
export const NATIVE_CONTEXT_RATIO_MIN = 0.5;
export const NATIVE_CONTEXT_RATIO_MAX = 0.99;

const TABLE = 'loop_control';
const MARKER_WORD = 'KIMI WORK GATEWAY CONTEXT POLICY';
const FIELDS = ['triggerRatio', 'reservedTokens'];
const KEY_OF = { triggerRatio: 'compaction_trigger_ratio', reservedTokens: 'reserved_context_size' };
const NAME_OF = Object.fromEntries(Object.entries(KEY_OF).map(([field, key]) => [key, field]));
const RECEIPT_MAX_BYTES = 1024 * 1024;
const LINE_MAX = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const OWNER_LINE = /^# owner=([0-9a-f-]{36}) body-sha256=([a-f0-9]{64}) added-eol=([01])$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const NUMBER = /^[0-9A-Za-z_+\-.]+$/;
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

// --- TOML surface reading --------------------------------------------------

function splitLines(raw) {
  const lines = [];
  let at = 0;
  for (const match of raw.matchAll(/\r\n|\n/g)) {
    lines.push({ text: raw.slice(at, match.index), eol: match[0] });
    at = match.index + match[0].length;
  }
  if (at < raw.length) lines.push({ text: raw.slice(at), eol: '' });
  return lines;
}

function stringEnd(text, at) {
  const quote = text[at];
  for (let i = at + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i + 1;
  }
  return -1;
}

// Masks strings and comments with spaces while preserving offsets, so a key or
// header can be read and a value token replaced without re-emitting the line.
function maskLine(text) {
  let code = '';
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (char === '#') break;
    if (char === '"' || char === "'") {
      if (text.startsWith(char.repeat(3), at)) return { error: 'multiline' };
      const end = stringEnd(text, at);
      if (end < 0) return { error: 'string' };
      code += ' '.repeat(end - at);
      at = end;
      continue;
    }
    code += char;
    at++;
  }
  return { code };
}

function parseKey(text, start, end) {
  const segments = [];
  let at = start;
  while (at < end) {
    while (at < end && /\s/.test(text[at])) at++;
    if (at >= end) break;
    const quote = text[at];
    let segment;
    if (quote === '"' || quote === "'") {
      const close = stringEnd(text, at);
      if (close < 0 || close > end) return null;
      segment = text.slice(at + 1, close - 1);
      at = close;
    } else {
      const from = at;
      while (at < end && /[A-Za-z0-9_-]/.test(text[at])) at++;
      if (at === from) return null;
      segment = text.slice(from, at);
    }
    segments.push(segment);
    while (at < end && /\s/.test(text[at])) at++;
    if (at >= end) break;
    if (text[at] !== '.') return null;
    at++;
  }
  return segments.length ? segments : null;
}

function parseHeader(text, code) {
  const lead = code.search(/\S/);
  if (lead < 0 || code[lead] !== '[') return null;
  const array = code.startsWith('[[', lead);
  const close = code.lastIndexOf(array ? ']]' : ']');
  if (close < 0) return null;
  if (code.slice(close + (array ? 2 : 1)).trim()) return null;
  const segments = parseKey(text, lead + (array ? 2 : 1), lead + close);
  return segments ? { segments, array } : null;
}

// Only plain TOML numbers are manageable; strings, booleans and dates are
// reported instead of being coerced into one.
function parseTomlNumber(token) {
  const raw = token.replace(/_/g, '');
  if (/^0x[0-9a-fA-F]+$/.test(raw)) return parseInt(raw.slice(2), 16);
  if (/^0o[0-7]+$/.test(raw)) return parseInt(raw.slice(2), 8);
  if (/^0b[01]+$/.test(raw)) return parseInt(raw.slice(2), 2);
  if (/^[+-]?\d+$/.test(raw)) return Number(raw);
  if (/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  return null;
}

function validValue(field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return field === 'triggerRatio'
    ? value >= NATIVE_CONTEXT_RATIO_MIN && value <= NATIVE_CONTEXT_RATIO_MAX
    : Number.isSafeInteger(value) && value >= 0;
}

// The UI sends a decimal ratio (50% → 0.50). A value that already has two
// decimals keeps that shape; anything finer is written exactly as given.
function renderValue(field, value) {
  if (field === 'reservedTokens') return String(value);
  return Math.round(value * 100) / 100 === value ? value.toFixed(2) : String(value);
}

const keyLine = (field, value) => KEY_OF[field] + ' = ' + renderValue(field, value);

// Value token offsets for a `key = value` line, ignoring a trailing comment.
function valueToken(code, eq) {
  const rest = code.slice(eq + 1);
  const token = rest.trim();
  if (!NUMBER.test(token)) return null;
  const start = eq + 1 + (rest.length - rest.trimStart().length);
  return { start, end: start + token.length, token };
}

// Every line outside a string keeps bracket depth, so `[loop_control]` inside a
// multi-line string or array is never mistaken for a table.
function advance(text, mode, depth) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (mode === 'basic') {
      if (char === '\\') i++;
      else if (char === '"') mode = null;
      continue;
    }
    if (mode === 'literal') {
      if (char === "'") mode = null;
      continue;
    }
    if (mode === 'ml-basic') {
      if (char === '\\') i++;
      else if (text.startsWith('"""', i)) { mode = null; i += 2; }
      continue;
    }
    if (mode === 'ml-literal') {
      if (text.startsWith("'''", i)) { mode = null; i += 2; }
      continue;
    }
    if (char === '#') break;
    if (char === '"') {
      if (text.startsWith('"""', i)) { mode = 'ml-basic'; i += 2; } else mode = 'basic';
      continue;
    }
    if (char === "'") {
      if (text.startsWith("'''", i)) { mode = 'ml-literal'; i += 2; } else mode = 'literal';
      continue;
    }
    if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth < 0) return { issue: 'unsupported_toml' };
    }
  }
  return { mode, depth };
}

// A block is ours only while it still has the exact shape this module writes:
// one `[loop_control]` header and one or two known numeric keys.
function parseBlock(lines, begin, end) {
  const owner = OWNER_LINE.exec(lines[begin + 1]?.text ?? '');
  if (!owner) return null;
  const body = lines.slice(begin + 2, end).map(line => line.text);
  if (sha256(body.join('\n')) !== owner[2]) return null;
  let header = false;
  const values = {};
  for (const text of body) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const masked = maskLine(text);
    if (masked.error) return null;
    if (trimmed.startsWith('[')) {
      if (header) return null;
      const parsed = parseHeader(text, masked.code);
      if (!parsed || parsed.array || parsed.segments.length !== 1 || parsed.segments[0] !== TABLE) return null;
      header = true;
      continue;
    }
    if (!header) return null;
    const eq = masked.code.indexOf('=');
    if (eq < 0) return null;
    const segments = parseKey(text, text.search(/\S/), eq);
    if (!segments || segments.length !== 1 || !NAME_OF[segments[0]]) return null;
    const field = NAME_OF[segments[0]];
    if (values[field] !== undefined) return null;
    const token = valueToken(masked.code, eq);
    if (!token) return null;
    const value = parseTomlNumber(token.token);
    if (!validValue(field, value)) return null;
    values[field] = value;
  }
  return header && Object.keys(values).length
    ? { ownerID: owner[1], bodyHash: owner[2], addedEol: owner[3] === '1', values } : null;
}

function findBlock(lines) {
  const begins = [];
  const ends = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].text.trim();
    if (trimmed === NATIVE_CONTEXT_BEGIN) begins.push(i);
    else if (trimmed === NATIVE_CONTEXT_END) ends.push(i);
  }
  if (!begins.length && !ends.length) {
    // A near-miss marker outside a verified block is ambiguous: refuse rather
    // than append a second block next to whatever produced it.
    if (lines.some(line => line.text.includes(MARKER_WORD))) return { issue: 'suspicious_marker' };
    return { block: null };
  }
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { issue: 'unterminated_block' };
  const block = parseBlock(lines, begins[0], ends[0]);
  if (!block) return { issue: 'block_modified' };
  // The marker word may only appear inside the block; anywhere else the file
  // is ambiguous, so it is refused rather than scanned in the wrong region.
  for (let i = 0; i < lines.length; i++) {
    if (i >= begins[0] && i <= ends[0]) continue;
    if (lines[i].text.includes(MARKER_WORD)) return { issue: 'suspicious_marker' };
  }
  return { block: { begin: begins[0], end: ends[0], ...block } };
}

// One structural pass over everything outside the block.
function scanDocument(raw) {
  const lines = splitLines(raw);
  const found = findBlock(lines);
  if (found.issue) return { issue: found.issue };
  const block = found.block;
  const out = { lines, block, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
  const tables = [];
  const keys = [];
  let mode = null;
  let depth = 0;
  let table = -1;
  for (let i = 0; i < lines.length; i++) {
    if (block && i >= block.begin && i <= block.end) continue;
    const text = lines[i].text;
    const lead = text.search(/\S/);
    if (mode === null && depth === 0 && lead >= 0 && text[lead] !== '#') {
      const masked = maskLine(text);
      if (masked.error) return { issue: 'unsupported_toml' };
      if (text[lead] === '[') {
        const header = parseHeader(text, masked.code);
        if (!header) return { issue: 'unsupported_toml' };
        if (table >= 0) tables[table].end = i;
        tables.push({ ...header, line: i, end: lines.length });
        table = tables.length - 1;
      } else {
        const eq = masked.code.indexOf('=');
        if (eq < 0) return { issue: 'unsupported_toml' };
        const segments = parseKey(text, lead, eq);
        if (!segments) return { issue: 'unsupported_toml' };
        keys.push({ segments, line: i, table, token: valueToken(masked.code, eq) });
      }
    }
    const advanced = advance(text, mode, depth);
    if (advanced.issue) return { issue: advanced.issue };
    mode = advanced.mode;
    depth = advanced.depth;
  }
  if (mode !== null || depth !== 0) return { issue: 'unsupported_toml' };
  return { ...out, tables, keys };
}

// Which layout the file is in and whether this module may edit it.
function classify(scan) {
  const loop = scan.tables.filter(table => table.segments[0] === TABLE);
  if (loop.some(table => table.array || table.segments.length > 1)) return { issue: 'unsupported_layout' };
  if (scan.block && loop.length) return { issue: 'duplicate_table' };
  if (loop.length > 1) return { issue: 'duplicate_table' };
  // A root `loop_control.x = …` or `loop_control = { … }` defines the same
  // table in a shape whose merge rules differ; guessing could produce invalid
  // TOML, so it is refused.
  if (scan.keys.some(key => key.table === -1 && key.segments[0] === TABLE)) {
    return { issue: 'unsupported_layout' };
  }
  const table = loop[0];
  if (!table) return { layout: 'none', keys: {} };
  const index = scan.tables.indexOf(table);
  const keys = {};
  for (const key of scan.keys) {
    if (key.table !== index || !NAME_OF[key.segments[0]]) continue;
    if (key.segments.length > 1) return { issue: 'unsupported_layout' };
    if (keys[key.segments[0]]) return { issue: 'duplicate_key' };
    if (!key.token) return { issue: 'unsupported_value' };
    const field = NAME_OF[key.segments[0]];
    const value = parseTomlNumber(key.token.token);
    if (!validValue(field, value)) return { issue: 'unsupported_value' };
    keys[key.segments[0]] = { field, value, line: key.line, start: key.token.start, end: key.token.end };
  }
  return { layout: 'table', table: { header: table.line, end: table.end }, keys };
}

function observedOf(scan, classification) {
  if (scan.block) return { ...scan.block.values };
  const out = {};
  if (classification.layout !== 'table') return out;
  for (const entry of Object.values(classification.keys)) out[entry.field] = entry.value;
  return out;
}

// --- rendering -------------------------------------------------------------

function renderBody(policy) {
  return ['[' + TABLE + ']',
    ...FIELDS.filter(field => policy[field] !== undefined).map(field => keyLine(field, policy[field]))];
}

function writtenLines(policy) {
  const out = {};
  for (const field of FIELDS) if (policy[field] !== undefined) out[field] = keyLine(field, policy[field]);
  return out;
}

function managedLines(body, ownerID, addedEol) {
  return [NATIVE_CONTEXT_BEGIN,
    '# owner=' + ownerID + ' body-sha256=' + sha256(body.join('\n')) + ' added-eol=' + (addedEol ? '1' : '0'),
    ...body, NATIVE_CONTEXT_END];
}

function withBlock(raw, scan, body, ownerID, eol) {
  const lines = scan.lines.map(line => ({ ...line }));
  if (scan.block) {
    const { begin, end, addedEol } = scan.block;
    const text = managedLines(body, ownerID, addedEol);
    const closing = lines[end].eol;
    const rendered = text.map((line, index) => ({ text: line, eol: index === text.length - 1 ? closing : eol }));
    return { text: [...lines.slice(0, begin), ...rendered, ...lines.slice(end + 1)]
      .map(line => line.text + line.eol).join(''), addedEol };
  }
  // Appending needs one separator newline when the file does not end with one;
  // the block records that so removal can restore the original bytes.
  const addedEol = !raw.endsWith('\n');
  const text = managedLines(body, ownerID, addedEol);
  if (addedEol && lines.length) lines[lines.length - 1].eol = eol;
  const trailing = addedEol ? '' : eol;
  const rendered = text.map((line, index) => ({ text: line, eol: index === text.length - 1 ? trailing : eol }));
  return { text: [...lines, ...rendered].map(line => line.text + line.eol).join(''), addedEol };
}

function blockRange(scan) {
  let start = 0;
  let end = 0;
  for (let i = 0; i <= scan.block.end; i++) {
    const size = scan.lines[i].text.length + scan.lines[i].eol.length;
    if (i < scan.block.begin) start += size;
    end += size;
  }
  return { start, end };
}

// Removing the block restores the surrounding bytes exactly: the only newline
// this module adds to the original text is the separator before an appended
// block, and the block records whether it had to.
function withoutBlock(raw, scan) {
  const { start, end } = blockRange(scan);
  let head = raw.slice(0, start);
  const tail = raw.slice(end);
  if (!tail && scan.block.addedEol) head = head.replace(/\r\n$|\n$/, '');
  return head + tail;
}

// Replaces only the value token of a key this module manages and inserts a
// missing key right after the header; every other byte is copied. A field the
// new policy no longer covers is handed back here rather than left behind
// without an owner: its recorded original line returns, or the line this
// module added is removed. A field someone else has since changed is not ours
// any more and is left exactly as it is.
function editTable(scan, classification, policy, held) {
  const lines = scan.lines.map(line => ({ ...line }));
  const originals = {};
  const written = {};
  const inserts = [];
  const released = [];
  for (const field of FIELDS) {
    if (policy[field] === undefined) continue;
    const key = KEY_OF[field];
    const current = classification.keys[key];
    const rendered = renderValue(field, policy[field]);
    // The pre-policy line is carried forward only while the key still holds
    // what this module wrote; otherwise the current line is the new original.
    const carried = held?.[field]?.ours ? held[field].original : undefined;
    if (current) {
      originals[field] = carried ?? { present: true, line: lines[current.line].text };
      lines[current.line].text = lines[current.line].text.slice(0, current.start) + rendered
        + lines[current.line].text.slice(current.end);
      written[field] = lines[current.line].text;
    } else {
      originals[field] = carried ?? { present: false };
      inserts.push(keyLine(field, policy[field]));
      written[field] = keyLine(field, policy[field]);
    }
  }
  const remove = [];
  for (const field of FIELDS) {
    if (policy[field] !== undefined || !held?.[field]?.ours) continue;
    const entry = classification.keys[KEY_OF[field]];
    if (!entry) continue;
    if (held[field].original.present) lines[entry.line].text = held[field].original.line;
    else remove.push(entry.line);
    released.push(field);
  }
  // A file that ends on the header has no newline to insert after; one is
  // added and remembered so removing the keys restores the original ending.
  const header = classification.table.header;
  const endedOnHeader = !lines[header].eol;
  const insertsAfterBareHeader = inserts.length > 0 && endedOnHeader;
  if (insertsAfterBareHeader) lines[header].eol = scan.eol;
  for (const index of remove.sort((a, b) => b - a)) lines.splice(index, 1);
  const rendered = inserts.map((text, index) => ({
    text, eol: insertsAfterBareHeader && index === inserts.length - 1 ? '' : scan.eol }));
  if (rendered.length) lines.splice(header + 1, 0, ...rendered);
  // Handing back inserted keys must leave the file ending the way it did
  // before the insert added a newline after a bare header: no trailing newline.
  if (!inserts.length && held?.headerEolPatched && lines.length) {
    lines[lines.length - 1].eol = '';
  }
  return { text: lines.map(line => line.text + line.eol).join(''), originals, written,
    headerEolPatched: insertsAfterBareHeader || (!inserts.length && held?.headerEolPatched === true),
    released };
}

// Puts back the recorded line for every key that still carries what this module
// wrote. A key holding a different value belongs to someone else and is left
// alone, which the caller reports instead of overwriting.
function restoreTable(scan, classification, receipt) {
  const lines = scan.lines.map(line => ({ ...line }));
  const remove = [];
  let conflict = null;
  for (const [field, original] of Object.entries(receipt.originals)) {
    const entry = classification.keys[KEY_OF[field]];
    if (!entry) continue;
    const ours = receipt.written[field] === scan.lines[entry.line].text || receipt[field] === entry.value;
    if (!ours) { conflict = 'foreign_value'; continue; }
    if (original.present) lines[entry.line].text = original.line;
    else remove.push(entry.line);
  }
  for (const index of remove.sort((a, b) => b - a)) lines.splice(index, 1);
  // Inserting after a header that ended the file added a newline; removing
  // those keys means the file ends on the header again, without one.
  if (receipt.headerEolPatched && lines.length) {
    const last = lines[lines.length - 1];
    if (last.text.trim() === '[' + TABLE + ']') last.eol = '';
  }
  return { text: lines.map(line => line.text + line.eol).join(''), conflict };
}

// --- policy validation -----------------------------------------------------

// `triggerRatio` is always the decimal the kernel's schema takes (0.50 … 0.99);
// percent is a presentation concern of the caller.
function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  if (policy.mode === 'inherit') {
    return policy.triggerRatio === undefined && policy.reservedTokens === undefined ? { mode: 'inherit' } : null;
  }
  if (policy.mode !== 'custom') return null;
  const out = { mode: 'custom' };
  let chosen = 0;
  for (const field of FIELDS) {
    if (policy[field] === undefined) continue;
    if (!validValue(field, policy[field])) return null;
    out[field] = policy[field];
    chosen++;
  }
  return chosen ? out : null;
}

function policyShape(policy) {
  const out = { mode: policy.mode };
  if (policy.mode === 'custom') {
    for (const field of FIELDS) if (policy[field] !== undefined) out[field] = policy[field];
  }
  return out;
}

const plainLine = value => typeof value === 'string' && value.length > 0 && value.length <= LINE_MAX
  && !CONTROL.test(value);

// The receipt names one exact block: its owner line and its body hash. Only a
// block that matches both may be rewritten or removed on that receipt's behalf.
const describes = (receipt, block) => receipt.layout === 'block'
  && receipt.block.ownerID === block.ownerID && receipt.block.bodyHash === block.bodyHash;

// --- module ----------------------------------------------------------------

export class NativeContextPolicy {
  constructor({ stateDir, kimiDir } = {}) {
    this.stateDir = path.resolve(stateDir);
    this.kimiDir = path.resolve(kimiDir);
    this.homeDir = path.join(this.kimiDir, 'runtime', 'kimi-code', 'home');
    this.configPath = path.resolve(kimiDir, 'runtime', 'kimi-code', 'home', 'config.toml');
    this.receiptPath = path.join(this.stateDir, NATIVE_CONTEXT_RECEIPT);
    // Only the directories this module composes are checked, so an unrelated
    // symlink far above the user's home cannot veto the whole feature.
    this.ancestors = [this.kimiDir, path.join(this.kimiDir, 'runtime'),
      path.join(this.kimiDir, 'runtime', 'kimi-code'), this.homeDir];
    this.ownerID = crypto.randomUUID();
  }

  // --- reads ---------------------------------------------------------------

  guardPaths() {
    for (const dir of this.ancestors) {
      let stat;
      try { stat = fs.lstatSync(dir); } catch (error) {
        return error.code === 'ENOENT' ? 'config_missing' : 'path_unavailable';
      }
      if (stat.isSymbolicLink()) return 'path_symlink';
      if (!stat.isDirectory()) return 'path_not_directory';
    }
    let stat;
    try { stat = fs.lstatSync(this.configPath); } catch (error) {
      return error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable';
    }
    if (stat.isSymbolicLink()) return 'config_symlink';
    if (!stat.isFile()) return 'config_not_file';
    if (stat.size > NATIVE_CONTEXT_MAX_BYTES) return 'config_too_large';
    return null;
  }

  readReceipt() {
    let stat;
    try { stat = fs.lstatSync(this.receiptPath); } catch { return { kind: 'absent' }; }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > RECEIPT_MAX_BYTES) return { kind: 'unsafe' };
    let raw;
    try { raw = fs.readFileSync(this.receiptPath, 'utf8'); } catch { return { kind: 'unsafe' }; }
    let value;
    try { value = JSON.parse(raw); } catch { return { kind: 'corrupt' }; }
    const parsed = this.parseReceipt(value);
    // A receipt written for another Kimi home cannot describe this file.
    if (!parsed || parsed.kimiDir !== this.kimiDir || parsed.configPath !== this.configPath) {
      return { kind: 'corrupt' };
    }
    return { kind: 'valid', raw, value: parsed };
  }

  parseReceipt(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.schemaVersion !== 1 || typeof value.ownerID !== 'string' || !UUID.test(value.ownerID)) return null;
    if (typeof value.configPath !== 'string' || typeof value.kimiDir !== 'string') return null;
    if (value.mode !== 'custom' || (value.layout !== 'block' && value.layout !== 'table')) return null;
    const out = { schemaVersion: 1, ownerID: value.ownerID, kimiDir: value.kimiDir,
      configPath: value.configPath, mode: 'custom', layout: value.layout };
    let chosen = 0;
    for (const field of FIELDS) {
      if (value[field] === undefined) continue;
      if (!validValue(field, value[field])) return null;
      out[field] = value[field];
      chosen++;
    }
    if (!chosen) return null;
    if (!value.written || typeof value.written !== 'object' || Array.isArray(value.written)) return null;
    // A policy saved while `config.toml` did not exist yet edited no line, so
    // it carries no written line and no original to restore.
    out.pending = value.pending === true;
    out.written = {};
    for (const field of FIELDS) {
      if (out[field] === undefined) continue;
      if (value.written[field] === undefined && out.pending) continue;
      if (!plainLine(value.written[field])) return null;
      out.written[field] = value.written[field];
    }
    if (value.layout === 'block') {
      const block = value.block;
      if (!block || typeof block !== 'object' || !UUID.test(block.ownerID ?? '')
        || !SHA.test(block.bodyHash ?? '') || typeof block.addedEol !== 'boolean') return null;
      out.block = { ownerID: block.ownerID, bodyHash: block.bodyHash, addedEol: block.addedEol };
      return out;
    }
    if (!value.originals || typeof value.originals !== 'object' || Array.isArray(value.originals)) return null;
    out.originals = {};
    for (const field of FIELDS) {
      if (out[field] === undefined) continue;
      const original = value.originals[field];
      if (original === undefined && out.pending) continue;
      if (!original || typeof original !== 'object') return null;
      if (original.present === false) { out.originals[field] = { present: false }; continue; }
      if (original.present !== true || !plainLine(original.line)) return null;
      out.originals[field] = { present: true, line: original.line };
    }
    out.headerEolPatched = value.headerEolPatched === true;
    return out;
  }

  snapshot() {
    const issue = this.guardPaths();
    const receipt = this.readReceipt();
    if (issue) return { issue, receipt };
    let raw;
    try { raw = fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
      return { issue: error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable', receipt };
    }
    const scan = scanDocument(raw);
    if (scan.issue) return { issue: scan.issue, receipt };
    const classification = classify(scan);
    if (classification.issue) return { issue: classification.issue, receipt };
    return { raw, scan, classification, eol: scan.eol, receipt };
  }

  savedPolicy(snapshot) {
    const receipt = snapshot.receipt;
    if (!receipt || receipt.kind !== 'valid') return { mode: 'inherit' };
    const policy = { mode: 'custom' };
    for (const field of FIELDS) if (receipt.value[field] !== undefined) policy[field] = receipt.value[field];
    return policy;
  }

  // `applied` never means "a session is using this": the file was observed to
  // carry the saved policy, and that is all this module can prove.
  evaluate(snapshot, saved, observed) {
    if (snapshot.receipt.kind === 'corrupt' || snapshot.receipt.kind === 'unsafe') {
      return { status: 'conflict', reason: 'receipt_unverified' };
    }
    if (snapshot.issue === 'config_missing') {
      return saved.mode === 'custom'
        ? { status: 'waiting-config', reason: 'config_missing' } : { status: 'inherit' };
    }
    if (snapshot.issue) return { status: 'conflict', reason: snapshot.issue };
    // A marker block no receipt here describes is still on disk: this module
    // wrote it for someone, and reporting a plain "inherit" would hide both the
    // bytes and the fact that they cannot be attributed to this state directory.
    if (snapshot.scan.block && (snapshot.receipt.kind !== 'valid'
      || !describes(snapshot.receipt.value, snapshot.scan.block))) {
      return { status: 'conflict', reason: 'ownership_conflict' };
    }
    if (saved.mode !== 'custom') return { status: 'inherit' };
    for (const field of FIELDS) {
      if (saved[field] === undefined) continue;
      if (observed[field] === undefined) return { status: 'conflict', reason: 'value_missing' };
      if (observed[field] !== saved[field]) return { status: 'conflict', reason: 'foreign_value' };
    }
    return { status: 'applied' };
  }

  report(snapshot, status, reason) {
    const saved = this.savedPolicy(snapshot);
    const observed = snapshot.issue || !snapshot.scan
      ? {} : observedOf(snapshot.scan, snapshot.classification);
    const outcome = status ? { status, reason } : this.evaluate(snapshot, saved, observed);
    return { policy: policyShape(saved), status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}), observed };
  }

  state() {
    return this.report(this.snapshot());
  }

  // --- writes --------------------------------------------------------------

  writeReceipt(value) {
    try { fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); } catch { return 'receipt_conflict'; }
    let stat;
    try { stat = fs.lstatSync(this.stateDir); } catch { return 'receipt_conflict'; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'receipt_conflict';
    try {
      const current = fs.lstatSync(this.receiptPath);
      if (current.isSymbolicLink() || !current.isFile()) return 'receipt_conflict';
    } catch (error) { if (error.code !== 'ENOENT') return 'receipt_conflict'; }
    const temporary = this.receiptPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.receiptPath);
      return null;
    } catch { return 'receipt_conflict'; } finally { fs.rmSync(temporary, { force: true }); }
  }

  removeReceipt() {
    try {
      const stat = fs.lstatSync(this.receiptPath);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      fs.rmSync(this.receiptPath);
    } catch {}
  }

  // Rewrites the whole file atomically, but only after re-reading it: a write
  // that raced with the desktop generator or a text editor is refused.
  commit(snapshot, next) {
    let current;
    try { current = fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
      return error.code === 'ENOENT' ? 'config_missing' : 'config_unavailable';
    }
    if (current !== snapshot.raw) return 'concurrent_modification';
    let mode = 0o600;
    try { mode = fs.statSync(this.configPath).mode & 0o777; } catch {}
    const temporary = this.configPath + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, next, { mode, flag: 'wx' });
      fs.renameSync(temporary, this.configPath);
      return null;
    } catch { return 'write_failed'; } finally { fs.rmSync(temporary, { force: true }); }
  }

  // The receipt is written first so ownership never outlives a failed apply,
  // and a receipt from a failed apply is rolled back to the previous one.
  persist(snapshot, text, receipt) {
    const previous = snapshot.receipt.kind === 'valid' ? snapshot.receipt.raw : undefined;
    const failure = this.writeReceipt(receipt);
    if (failure) return failure;
    if (text === snapshot.raw) return null;
    const written = this.commit(snapshot, text);
    if (!written) return null;
    if (previous === undefined) this.removeReceipt();
    else this.writeReceipt(JSON.parse(previous));
    return written;
  }

  receiptFor(policy, extra) {
    const receipt = { schemaVersion: 1, ownerID: this.ownerID, kimiDir: this.kimiDir,
      configPath: this.configPath, mode: 'custom' };
    for (const field of FIELDS) if (policy[field] !== undefined) receipt[field] = policy[field];
    return { ...receipt, ...extra };
  }

  failureResult(snapshot, failure) {
    return this.report(snapshot, failure === 'config_missing' ? 'waiting-config' : 'conflict', failure);
  }

  // --- public surface ------------------------------------------------------

  // `policy` mode "custom" needs at least one of triggerRatio / reservedTokens.
  // Nothing here closes or revokes on shutdown: a saved policy is meant to
  // outlive the process, and `update({ mode: 'inherit' })` is the explicit way
  // to take it back out.
  update(policy) {
    const wanted = normalizePolicy(policy);
    const snapshot = this.snapshot();
    if (!wanted) return this.report(snapshot, 'conflict', 'invalid_policy');
    if (wanted.mode === 'inherit') return this.release(snapshot);
    return this.apply(snapshot, wanted, false);
  }

  // Re-derives the state after the app rewrote the file. The saved policy is
  // re-applied only where the file no longer carries it: a key someone else
  // moved to another number is reported, never replaced.
  reconcile() {
    const snapshot = this.snapshot();
    const saved = this.savedPolicy(snapshot);
    if (saved.mode !== 'custom') return this.report(snapshot);
    return this.apply(snapshot, saved, true);
  }

  release(snapshot) {
    if (snapshot.receipt.kind === 'corrupt' || snapshot.receipt.kind === 'unsafe') {
      return this.report(snapshot, 'conflict', 'receipt_unverified');
    }
    if (snapshot.issue) {
      if (snapshot.issue === 'config_missing') {
        if (snapshot.receipt.kind === 'valid') this.removeReceipt();
        return this.report(this.snapshot(), 'inherit');
      }
      return this.report(snapshot, 'conflict', snapshot.issue);
    }
    const receipt = snapshot.receipt;
    if (snapshot.scan.block) {
      const block = snapshot.scan.block;
      // A block this state directory's receipt does not describe is not ours to
      // delete: another policy record may hold it, and guessing would erase a
      // policy this module cannot reproduce. That includes a missing receipt,
      // whose block still proves this feature wrote it but not on whose behalf.
      if (receipt.kind !== 'valid' || !describes(receipt.value, block)) {
        return this.report(snapshot, 'conflict', 'ownership_conflict');
      }
      const failure = this.commit(snapshot, withoutBlock(snapshot.raw, snapshot.scan));
      if (failure) return this.failureResult(snapshot, failure);
      this.removeReceipt();
      return this.report(this.snapshot(), 'inherit');
    }
    if (receipt.kind !== 'valid') return this.report(snapshot, 'inherit');
    if (receipt.value.layout !== 'table') {
      // The app dropped the whole block: there is nothing of ours left.
      this.removeReceipt();
      return this.report(this.snapshot(), 'inherit');
    }
    const restored = restoreTable(snapshot.scan, snapshot.classification, receipt.value);
    if (restored.text !== snapshot.raw) {
      const failure = this.commit(snapshot, restored.text);
      if (failure) return this.failureResult(snapshot, failure);
    }
    // Ownership is released either way: a key someone else has since changed
    // must never be re-asserted by a later reconcile.
    this.removeReceipt();
    // Reporting "inherit" over a key that kept a foreign value would claim a
    // restore that did not happen, so that case stays visible as a conflict.
    return restored.conflict
      ? this.report(this.snapshot(), 'conflict', restored.conflict)
      : this.report(this.snapshot(), 'inherit');
  }

  apply(snapshot, policy, reassert) {
    if (snapshot.issue) {
      if (snapshot.issue !== 'config_missing') return this.report(snapshot, 'conflict', snapshot.issue);
      // The policy is still saved: the receipt records it without any file
      // change, so a later call knows a custom policy is waiting for the config.
      if (!reassert) {
        const failure = this.writeReceipt(this.receiptFor(policy,
          { layout: 'table', originals: {}, written: {}, headerEolPatched: false, pending: true }));
        if (failure) return this.report(snapshot, 'conflict', failure);
      }
      return this.report(this.snapshot(), 'waiting-config', 'config_missing');
    }
    const receipt = snapshot.receipt;
    if (receipt.kind === 'corrupt' || receipt.kind === 'unsafe') {
      return this.report(snapshot, 'conflict', 'receipt_unverified');
    }
    if (snapshot.scan.block) return this.applyBlock(snapshot, policy, reassert);
    if (snapshot.classification.layout === 'table') return this.applyTable(snapshot, policy, reassert);
    return this.applyAppend(snapshot, policy);
  }

  // Our marker block is present. Ownership is decided per policy record: the
  // receipt in `stateDir` names exactly one block by owner and body hash. A
  // block that receipt does not describe is not this state directory's to
  // rewrite or delete, even when the block's own marker looks verifiable —
  // accepting it would let a second state directory silently take over (or a
  // receipt that went missing hand us a deletion we cannot attribute).
  applyBlock(snapshot, policy, reassert) {
    const block = snapshot.scan.block;
    const receipt = snapshot.receipt;
    if (receipt.kind !== 'valid' || !describes(receipt.value, block)) {
      return this.report(snapshot, 'conflict', 'ownership_conflict');
    }
    if (reassert) {
      for (const field of FIELDS) {
        if (policy[field] === undefined) continue;
        if (block.values[field] !== policy[field]) return this.report(snapshot, 'conflict', 'foreign_value');
      }
      // The block still carries the saved policy; re-point the receipt at it
      // (a restart gets a new instance, and the owner line follows on rewrite).
      const failure = this.writeReceipt(this.receiptFor(policy, { layout: 'block',
        block: { ownerID: block.ownerID, bodyHash: block.bodyHash, addedEol: block.addedEol },
        written: writtenLines(policy) }));
      return failure ? this.report(snapshot, 'conflict', failure) : this.report(snapshot, 'applied');
    }
    const body = renderBody(policy);
    const rendered = withBlock(snapshot.raw, snapshot.scan, body, this.ownerID, snapshot.eol);
    const failure = this.persist(snapshot, rendered.text, this.receiptFor(policy,
      { layout: 'block', block: { ownerID: this.ownerID, bodyHash: sha256(body.join('\n')),
        addedEol: rendered.addedEol }, written: writtenLines(policy) }));
    return failure ? this.failureResult(snapshot, failure)
      : this.report(this.snapshot(), 'applied');
  }

  applyTable(snapshot, policy, reassert) {
    const held = snapshot.receipt.kind === 'valid' && snapshot.receipt.value.layout === 'table'
      ? snapshot.receipt.value : null;
    if (reassert) {
      for (const field of FIELDS) {
        if (policy[field] === undefined) continue;
        const entry = snapshot.classification.keys[KEY_OF[field]];
        if (entry && entry.value !== policy[field]) return this.report(snapshot, 'conflict', 'foreign_value');
      }
    }
    const result = this.editOwnedTable(snapshot, policy, held);
    if (result.foreign) {
      // A key this policy still covers was moved by someone else; rewriting the
      // rest would leave a receipt claiming a field it no longer controls.
      return this.report(snapshot, 'conflict', 'foreign_value');
    }
    const failure = this.persist(snapshot, result.edited.text, this.receiptFor(policy,
      { layout: 'table', originals: result.edited.originals, written: result.edited.written,
        headerEolPatched: result.edited.headerEolPatched }));
    if (failure) return this.failureResult(snapshot, failure);
    const next = this.report(this.snapshot(), 'applied');
    // A field the policy no longer covers was handed back on disk; the state
    // still reports it so the caller can see the release rather than infer it.
    return result.edited.released.length
      ? { ...next, released: [...result.edited.released] } : next;
  }

  // Which fields of the held policy this module still owns on disk, and whether
  // any field it must account for has been taken over by someone else. A key
  // that is simply gone (the app dropped the table) is not a takeover — there
  // is nothing to hand back. A key still present with another value is, even
  // when the new policy no longer covers it: quietly narrowing past it would
  // erase the only record of a line this module once wrote over the user's.
  editOwnedTable(snapshot, policy, held) {
    const owned = {};
    let foreign = false;
    if (held) {
      for (const field of FIELDS) {
        const original = held.originals[field];
        if (!original) continue;
        const entry = snapshot.classification.keys[KEY_OF[field]];
        if (!entry) continue;
        const ours = held.written[field] === snapshot.scan.lines[entry.line].text
          || held[field] === entry.value;
        if (!ours) { foreign = true; continue; }
        owned[field] = { ours: true, original };
      }
    }
    return { foreign,
      edited: editTable(snapshot.scan, snapshot.classification, policy, held ? { ...owned,
        headerEolPatched: held.headerEolPatched } : undefined) };
  }

  applyAppend(snapshot, policy) {
    const body = renderBody(policy);
    const rendered = withBlock(snapshot.raw, snapshot.scan, body, this.ownerID, snapshot.eol);
    const failure = this.persist(snapshot, rendered.text, this.receiptFor(policy,
      { layout: 'block', block: { ownerID: this.ownerID, bodyHash: sha256(body.join('\n')),
        addedEol: rendered.addedEol }, written: writtenLines(policy) }));
    return failure ? this.failureResult(snapshot, failure)
      : this.report(this.snapshot(), 'applied');
  }
}

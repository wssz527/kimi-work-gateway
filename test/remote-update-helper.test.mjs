import { describe, expect, test } from 'bun:test';
import { normalizeRemoteFeed, remoteUpdateEvent, createRemoteUpdateFrameDecoder } from '../src/remote-update-helper.mjs';

function decoder() {
  const requests = [], errors = [];
  const push = createRemoteUpdateFrameDecoder({ onRequest: value => requests.push(value), onError: code => errors.push(code) });
  return { push, requests, errors };
}

function sizedFrame(bytes) {
  const base = { id: 1, operation: 'inspect', value: '' };
  const size = Buffer.byteLength(JSON.stringify(base) + '\n');
  return Buffer.from(JSON.stringify({ ...base, value: 'x'.repeat(bytes - size) }) + '\n');
}

describe('remote update helper input and event boundaries', () => {
  test('accepts a feed string and preserves only supported feed fields', () => {
    expect(normalizeRemoteFeed('http://127.0.0.1:1234/feed')).toEqual({ url: 'http://127.0.0.1:1234/feed', headers: {} });
    const value = { url: 'https://example.invalid/feed', headers: { Authorization: 'fixture-only', 'X-Probe': '1' } };
    expect(normalizeRemoteFeed(value)).toEqual(value);
    expect(() => normalizeRemoteFeed({ ...value, eval: 'disabled' })).toThrow('remote_update_feed_invalid');
    for (const url of ['file:///tmp/feed', 'javascript:void(0)', '', null]) {
      expect(() => normalizeRemoteFeed({ url })).toThrow('remote_update_feed_invalid');
    }
  });

  test('rejects invalid header names, values and size limits', () => {
    for (const headers of [{ 'bad name': 'x' }, { 'X-Probe': 'line\r\ninjection' }, { 'X-Probe': '\0' },
      { 'X-Probe': 1 }, { 'X-Probe': 'x'.repeat(16385) }, { ['x'.repeat(257)]: 'x' }, [],
      Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-${index}`, 'x']))]) {
      expect(() => normalizeRemoteFeed({ url: 'http://127.0.0.1/feed', headers })).toThrow('remote_update_feed_invalid');
    }
  });

  test('decodes fragmented UTF-8 and multiple JSON frames in one chunk', () => {
    const fixture = decoder();
    const request = { id: 1, operation: 'inspect', value: '测试' };
    const frame = Buffer.from(JSON.stringify(request) + '\n');
    for (const byte of frame) fixture.push(Buffer.from([byte]));
    fixture.push(Buffer.from('{"id":2,"operation":"inspect"}\n{"id":3,"operation":"inspect"}\n'));
    expect(fixture.requests).toEqual([request, { id: 2, operation: 'inspect' }, { id: 3, operation: 'inspect' }]);
    expect(fixture.errors).toEqual([]);
  });

  test('accepts exactly 256 KiB including newline and rejects one byte more', () => {
    const exact = decoder();
    const frame = sizedFrame(256 * 1024);
    expect(exact.push(frame.subarray(0, frame.length - 1))).toBe(true);
    expect(exact.push(frame.subarray(-1))).toBe(true);
    expect(exact.requests).toHaveLength(1);
    const oversized = decoder();
    expect(oversized.push(sizedFrame(256 * 1024 + 1))).toBe(false);
    expect(oversized.requests).toHaveLength(0);
    expect(oversized.errors).toEqual(['remote_update_frame_invalid']);
    expect(oversized.push(Buffer.from('{}\n'))).toBe(false);
  });

  test('rejects unterminated oversized, empty, malformed and invalid UTF-8 frames without echoing input', () => {
    const large = decoder();
    expect(large.push(Buffer.alloc(256 * 1024, 120))).toBe(false);
    const empty = decoder();
    expect(empty.push(Buffer.from('\n'))).toBe(false);
    const malformed = decoder();
    malformed.push(Buffer.from('not-json\n'));
    malformed.push(Buffer.from([0xff, 10]));
    expect(large.errors).toEqual(['remote_update_frame_invalid']);
    expect(empty.errors).toEqual(['remote_update_frame_invalid']);
    expect(malformed.errors).toEqual(['remote_update_frame_invalid', 'remote_update_frame_invalid']);
    expect(malformed.requests).toEqual([]);
  });

  test('uses an event and field allowlist with bounded downloaded metadata', () => {
    expect(remoteUpdateEvent({ type: 'eval', value: 'disabled' })).toBeNull();
    for (const type of ['checking-for-update', 'update-available', 'update-not-available']) {
      expect(remoteUpdateEvent({ type, url: 'discarded', headers: { key: 'discarded' } })).toEqual({ type });
    }
    expect(remoteUpdateEvent({ type: 'error', code: 'remote_update_signature_invalid', message: 'discarded', url: 'discarded' }))
      .toEqual({ type: 'error', code: 'remote_update_signature_invalid' });
    expect(remoteUpdateEvent({ type: 'error', code: 'https://example.invalid/ignored' })).toEqual({ type: 'error', code: 'remote_update_check_failed' });
    const event = remoteUpdateEvent({ type: 'update-downloaded', releaseNotes: 'n'.repeat(17000), releaseName: 'r'.repeat(600),
      releaseDate: 123, updateURL: 'u'.repeat(9000), headers: {}, body: 'discarded' });
    expect(Object.keys(event).sort()).toEqual(['releaseDate', 'releaseName', 'releaseNotes', 'type', 'updateURL']);
    expect(event.releaseNotes).toHaveLength(16384);
    expect(event.releaseName).toHaveLength(512);
    expect(event.updateURL).toHaveLength(8192);
    expect(remoteUpdateEvent({ type: 'update-downloaded', releaseDate: NaN, releaseNotes: {} })).toEqual({ type: 'update-downloaded' });
  });
});

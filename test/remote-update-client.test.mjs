import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { OfficialUpdateClient } from '../src/remote-update-client.mjs';

function setup({ respond, timeout = 1000 } = {}) {
  const frames = [], events = [], launches = [];
  let child;
  const application = '/Applications/Kimi.app/Contents/MacOS/Kimi';
  const client = new OfficialUpdateClient({ application, helper: '/own/remote-update-helper.mjs', addon: '/own/update.node', cacheHome: '/own/update-home',
    timeout, parentPid: 1234, env: { HOME: '/own/home', PATH: '/usr/bin', PRIVATE_API_KEY: 'private-secret', NODE_OPTIONS: '--inspect' },
    onEvent: value => events.push(value), spawnImpl: (...args) => {
      launches.push(args);
      child = new EventEmitter();
      const output = new PassThrough();
      child.stdio = [null, null, null, new Writable({ write(data, _encoding, callback) {
        const frame = JSON.parse(String(data));
        frames.push(frame);
        queueMicrotask(() => {
          const answer = respond ? respond(frame) : { id: frame.id, ok: true,
            ...(frame.operation === 'hello' ? { identityVerified: true, application } : {}) };
          if (answer) output.write(JSON.stringify(answer) + '\n');
        });
        callback();
      } }), output];
      child.unref = () => {};
      return child;
    } });
  return { client, frames, events, launches, child: () => child, application };
}

describe('official updater private transport', () => {
  test('proves the official helper identity before forwarding update operations', async () => {
    const fixture = setup();
    const feed = { url: 'http://127.0.0.1:12345', headers: { Authorization: 'private-feed' } };
    expect((await fixture.client.request('set-feed', feed)).ok).toBe(true);
    await fixture.client.request('check');
    expect(fixture.frames.map(row => row.operation)).toEqual(['hello', 'set-feed', 'check']);
    expect(fixture.frames[0].value).toEqual({ parentPid: 1234, application: fixture.application, cacheHome: '/own/update-home' });
    expect(fixture.frames[1].value).toEqual(feed);
    expect(fixture.launches).toHaveLength(1);
    expect(fixture.launches[0][0]).toBe(fixture.application);
    // TMPDIR is derived with path.join like the client does, so the expectation
    // holds on every platform instead of assuming POSIX separators.
    expect(fixture.launches[0][2].env).toEqual({ HOME: '/own/update-home', TMPDIR: path.join('/own/update-home', 'tmp'), PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' });
    expect(JSON.stringify(fixture.events)).not.toContain('private-feed');
  });

  test('an unverified helper cannot receive a feed or installation command', async () => {
    const fixture = setup({ respond: frame => ({ id: frame.id, ok: true, identityVerified: false }) });
    await expect(fixture.client.request('set-feed', {})).rejects.toThrow('remote_update_helper_identity_unverified');
    expect(fixture.frames.map(row => row.operation)).toEqual(['hello']);
    expect(fixture.events).toEqual([{ type: 'error' }]);
  });

  test('does not accept an identity for another installation', async () => {
    const fixture = setup({ respond: frame => ({ id: frame.id, ok: true, identityVerified: true, application: '/other/Kimi' }) });
    await expect(fixture.client.request('relaunch-after-parent-exit')).rejects.toThrow('remote_update_helper_identity_unverified');
    expect(fixture.frames).toHaveLength(1);
  });

  test('times out without invoking a kill or installation fallback', async () => {
    const fixture = setup({ respond: () => null, timeout: 10 });
    await expect(fixture.client.request('check')).rejects.toThrow('remote_update_helper_timeout');
    expect(fixture.frames.map(row => row.operation)).toEqual(['hello']);
    expect(fixture.client.closed).toBe(true);
  });

  test('rejects arbitrary operations before starting a process', async () => {
    const fixture = setup();
    await expect(fixture.client.request('eval', 'private')).rejects.toThrow('remote_update_request_invalid');
    expect(fixture.launches).toHaveLength(0);
  });

  test('fails pending work on a malformed response without exposing its content', async () => {
    const fixture = setup({ respond: () => null });
    const pending = fixture.client.request('check');
    await Promise.resolve();
    fixture.child().stdio[4].write('private-malformed-content\n');
    await expect(pending).rejects.toThrow('remote_update_helper_unavailable');
    expect(fixture.events).toEqual([{ type: 'error' }]);
  });
});

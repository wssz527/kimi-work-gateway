import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installRemoteUpdateProxy } from '../src/remote-update-proxy.mjs';

function setup(request = async () => ({})) {
  const updater = new EventEmitter(), nativeCalls = [], errors = [], states = [];
  for (const name of ['setFeedURL', 'getFeedURL', 'checkForUpdates', 'quitAndInstall']) {
    updater[name] = (...args) => nativeCalls.push({ name, args });
  }
  updater.on('error', error => errors.push(error.message));
  let quitCount = 0;
  const proxy = installRemoteUpdateProxy({ updater, app: { quit: () => { quitCount++; } }, request,
    onState: value => states.push(value) });
  return { proxy, updater, nativeCalls, errors, states, quitCount: () => quitCount };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('official update delegation', () => {
  test('routes native update operations to the helper without invoking the companion updater', async () => {
    const calls = [], fixture = setup(async (...args) => { calls.push(args); return { ok: true }; });
    const feed = { url: 'http://127.0.0.1:23456', headers: { Authorization: 'private-update-header' } };
    fixture.updater.setFeedURL(feed);
    fixture.updater.checkForUpdates();
    await settled();
    expect(calls).toEqual([['set-feed', feed], ['check', undefined]]);
    expect(fixture.updater.getFeedURL()).toBe(feed.url);
    expect(fixture.nativeCalls).toHaveLength(0);
    expect(JSON.stringify(fixture.states)).not.toContain('private-update-header');
    fixture.proxy.uninstall();
  });

  test('waits for the helper to acknowledge relaunch before asking the parent to quit', async () => {
    let acknowledge;
    const fixture = setup(() => new Promise(resolve => { acknowledge = resolve; }));
    let beforeQuit = 0;
    fixture.updater.on('before-quit-for-update', () => { beforeQuit++; });
    fixture.updater.quitAndInstall();
    fixture.updater.quitAndInstall();
    await settled();
    expect(fixture.quitCount()).toBe(0);
    expect(fixture.nativeCalls).toHaveLength(0);
    acknowledge({ ok: true });
    await settled();
    expect(fixture.quitCount()).toBe(1);
    expect(beforeQuit).toBe(1);
    fixture.proxy.uninstall();
  });

  test('does not quit when the helper cannot acknowledge the install request', async () => {
    const fixture = setup(async () => { throw Error('private-feed-url'); });
    fixture.updater.quitAndInstall();
    await settled();
    expect(fixture.quitCount()).toBe(0);
    expect(fixture.errors).toEqual(['remote_update_helper_unavailable']);
    expect(JSON.stringify(fixture.states)).not.toContain('private-feed-url');
    fixture.proxy.uninstall();
  });

  test('forwards native staging events while rejecting arbitrary event names', () => {
    const fixture = setup();
    let downloaded;
    fixture.updater.on('update-downloaded', (...args) => { downloaded = args; });
    expect(fixture.proxy.receive({ type: 'arbitrary', method: 'quitAndInstall' })).toBe(false);
    expect(fixture.proxy.receive({ type: 'update-downloaded', releaseName: '3.2.24', releaseNotes: 'notes', releaseDate: 1000 })).toBe(true);
    expect(downloaded[2]).toBe('3.2.24');
    expect(downloaded[3].getTime()).toBe(1000);
    expect(fixture.quitCount()).toBe(0);
    expect(fixture.nativeCalls).toHaveLength(0);
    fixture.proxy.uninstall();
  });

  test('restores the original native methods without removing later owners', () => {
    const fixture = setup();
    const later = () => {};
    fixture.updater.checkForUpdates = later;
    expect(fixture.proxy.uninstall()).toBe(true);
    expect(fixture.updater.checkForUpdates).toBe(later);
    fixture.updater.setFeedURL('restored');
    expect(fixture.nativeCalls).toEqual([{ name: 'setFeedURL', args: ['restored'] }]);
    expect(fixture.proxy.receive({ type: 'update-downloaded' })).toBe(false);
    expect(fixture.proxy.uninstall()).toBe(false);
  });
});

import { describe, expect, test } from 'bun:test';
import { installRemoteWorkCatalog, locateRemoteControlPlane, transformRemoteMain } from '../src/remote-work-hook.mjs';

const profile = { id: 'byok-kth', kind: 'kth', models: [{ alias: 'byok-kth-resp/lab/model', providerId: 'byok-kth-resp', model: 'lab/model', maxContextSize: 8192 }] };
const config = () => ({ models: [{ key: 'official', modelAlias: 'official' }], moreModels: [], defaultModelKey: 'official', quota: { level: 3, isPaid: true } });
const remote = { kind: 'remote' };
const source = `class RenamedPlane {
  #localMethods;
  #isRemoteAllowed;
  async #dispatchInner() {}
  #invokeLocal() {}
  async dispatch() {}
}
const after = true;`;

function plane(response) {
  const calls = [];
  class Plane { async dispatch(origin, request) { calls.push({ origin, request }); return response; } }
  return { Plane, calls, instance: new Plane() };
}

describe('remote model dispatch integration', () => {
  test('appends only to successful remote catalog responses after native dispatch', async () => {
    const workConfig = config(), response = { ok: true, result: workConfig };
    const fixture = plane(response);
    let callsAtRead;
    const remove = installRemoteWorkCatalog(fixture.Plane, { getProfile: async () => { callsAtRead = fixture.calls.length; return profile; } });
    const request = { method: 'app.models.getWorkConfig', params: { locale: 'zh-CN' } };
    const result = await fixture.instance.dispatch(remote, request);
    expect(result.result.models).toHaveLength(2);
    expect(result.result.defaultModelKey).toBe('official');
    expect(result.result.quota).toBe(workConfig.quota);
    expect(callsAtRead).toBe(1);
    expect(fixture.calls[0]).toEqual({ origin: remote, request });
    expect(workConfig.models).toHaveLength(1);
    expect(remove()).toBe(true);
    expect(await fixture.instance.dispatch(remote, request)).toBe(response);
  });

  test('preserves native failures and desktop responses without querying profile', async () => {
    let count = 0;
    for (const [origin, response] of [[remote, { ok: false, error: { code: 'REMOTE_FORBIDDEN' } }], [{ kind: 'ipc' }, { ok: true, result: config() }]]) {
      const fixture = plane(response);
      installRemoteWorkCatalog(fixture.Plane, { getProfile: () => { count++; return profile; } });
      expect(await fixture.instance.dispatch(origin, { method: 'app.models.getWorkConfig' })).toBe(response);
    }
    expect(count).toBe(0);
  });

  test('does not rewrite any sending or model selection request', async () => {
    const response = { ok: true, result: { accepted: true } }, fixture = plane(response);
    installRemoteWorkCatalog(fixture.Plane, { getProfile: () => { throw Error('should not read'); } });
    for (const method of ['daimon.conversations.send', 'app.messageQueue.submit', 'app.remoteInputs.v1.submit', 'daimon.conversations.setModel']) {
      const request = { method, params: { conversationKey: 'test-conversation', modelAlias: 'official', request: { modelAlias: profile.models[0].alias } } };
      expect(await fixture.instance.dispatch(remote, request)).toBe(response);
      expect(fixture.calls.at(-1).request).toBe(request);
    }
  });

  test('returns the original catalog when native profile reading is unavailable', async () => {
    const response = { ok: true, result: config() }, fixture = plane(response), status = [];
    installRemoteWorkCatalog(fixture.Plane, { getProfile: () => { throw Error('private failure'); }, onStatus: value => status.push(value) });
    expect(await fixture.instance.dispatch(remote, { method: 'app.models.getWorkConfig' })).toBe(response);
    expect(status.at(-1)).toEqual({ state: 'catalog-unavailable', added: 0 });
    expect(JSON.stringify(status)).not.toContain('private');
  });

  test('uninstall leaves any subsequently installed dispatch owner in place', () => {
    const fixture = plane({});
    const remove = installRemoteWorkCatalog(fixture.Plane, { getProfile: () => profile });
    const replacement = async () => ({ ok: false });
    fixture.Plane.prototype.dispatch = replacement;
    expect(remove()).toBe(false);
    expect(fixture.Plane.prototype.dispatch).toBe(replacement);
  });
});

describe('main source contract discovery', () => {
  test('discovers a renamed class and inserts the install immediately after it', () => {
    const key = '__kwgRemoteInstall_' + 'a'.repeat(32), expression = 'globalThis.' + key;
    const target = locateRemoteControlPlane(source);
    expect(target.name).toBe('RenamedPlane');
    const output = transformRemoteMain(source, expression);
    let installed;
    globalThis[key] = Type => { installed = Type; };
    try { new Function(output)(); } finally { delete globalThis[key]; }
    expect(installed.name).toBe('RenamedPlane');
    expect(output.slice(0, target.end)).toBe(source.slice(0, target.end));
    expect(output.endsWith(source.slice(target.end))).toBe(true);
  });

  test('captures the native account getter without changing the IPC handler', async () => {
    const classKey = '__kwgRemoteInstall_' + 'c'.repeat(32), profileKey = '__kwgRemoteProfile_' + 'd'.repeat(32);
    const getterSource = source + `
register(channels["BYOK_GET_PROFILE"], async () => {
    return {"profile": await readProfile(nativeAPI["getUserId"]())};
  });`;
    const output = transformRemoteMain(getterSource, 'globalThis.' + classKey,
      { profileExpression: 'globalThis.' + profileKey });
    let captured, registered, account = 'account-a';
    globalThis[classKey] = () => {};
    globalThis[profileKey] = handler => { captured = handler; return handler; };
    try {
      new Function('register', 'channels', 'nativeAPI', 'readProfile', output)(
        (_channel, handler) => { registered = handler; }, { BYOK_GET_PROFILE: 'native-profile' },
        { getUserId: () => account }, async id => ({ id }));
    } finally { delete globalThis[classKey]; delete globalThis[profileKey]; }
    expect(captured).toBe(registered);
    expect(await captured()).toEqual({ profile: { id: 'account-a' } });
    account = 'account-b';
    expect(await captured()).toEqual({ profile: { id: 'account-b' } });
  });

  test('requires a unique native getter when profile capture is requested', () => {
    const install = 'globalThis.__kwgRemoteInstall_' + 'e'.repeat(32);
    expect(() => transformRemoteMain(source, install, { profileExpression: 'globalThis.arbitrary' }))
      .toThrow('remote_profile_expression_invalid');
    expect(() => transformRemoteMain(source, install,
      { profileExpression: 'globalThis.__kwgRemoteProfile_' + 'f'.repeat(32) }))
      .toThrow('remote_profile_contract_unverified');
  });

  test('rejects absent, ambiguous or changed contracts and arbitrary expressions', () => {
    expect(() => locateRemoteControlPlane('class Nothing {}')).toThrow('remote_control_plane_unverified');
    expect(() => locateRemoteControlPlane(source + '\n' + source.replaceAll('RenamedPlane', 'SecondPlane'))).toThrow('remote_control_plane_unverified');
    expect(() => locateRemoteControlPlane(source.replace('#isRemoteAllowed;', '#permissions;'))).toThrow('remote_control_plane_unverified');
    expect(() => transformRemoteMain(source, 'globalThis.anything()')).toThrow('remote_install_expression_invalid');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AjaxCloud, CloudError, sha256 } from '../../src/cloud/ajax.js';
import { GrpcChannel, GrpcStatus } from '../../src/cloud/grpc.js';
import { Message, Writer } from '../../src/cloud/protobuf.js';
import { totp } from '../../src/cloud/totp.js';
import { FakeGrpcServer, type Call, type Reply } from './fakeGrpc.js';

const LOGIN = 'LoginByPasswordService/execute';
const LOGIN_TOTP = 'LoginByTotpService/execute';
const SPACES = 'FindUserSpacesWithPaginationService/execute';
const security = (command: string) => `SpaceSecurityService/${command}`;

const server = new FakeGrpcServer();
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

let cloud: AjaxCloud;
let handlers: Record<string, (call: Call) => Reply>;

beforeEach(async () => {
  handlers = {};
  server.calls.length = 0;
  server.handler = (call) => {
    const key = Object.keys(handlers).find((suffix) => call.path.endsWith(suffix));
    return key ? handlers[key]!(call) : { status: GrpcStatus.UNIMPLEMENTED, text: `no handler for ${call.path}` };
  };
  cloud = make(new GrpcChannel(await server.start()));
});

afterEach(async () => {
  vi.useRealTimers();
  await server.stop();
});

function make(channel?: GrpcChannel, extra: { totpSecret?: string; deviceModel?: string; deviceOs?: string } = {}): AjaxCloud {
  return new AjaxCloud({
    host: 'unused',
    port: 0,
    email: 'me@example.com',
    passwordHash: sha256('hunter2'),
    deviceId: 'device-1',
    clientVersion: '3.57',
    ...(channel ? { channel } : {}),
    ...extra,
  });
}

const loginSuccess = (token = 'a1b2c3', user = 'deadbeef') =>
  new Writer().message(1, new Writer().bytes(1, Buffer.from(token, 'hex')).message(2, new Writer().string(1, user))).finish();
const loginFailure = (field: number, inner = new Writer()) => new Writer().message(2, new Writer().message(field, inner)).finish();
const success = () => new Writer().message(1, new Writer()).finish();
const failure = (field: number) => new Writer().message(2, new Writer().message(field, new Writer())).finish();
const space = (id: string, name: string, state: number, hubId = '', online = true) =>
  new Writer().string(1, id).message(2, new Writer().string(1, name)).varint(3, state)
    .varint(998, online ? 1 : 2).string(999, hubId);

describe('login', () => {
  it('sends the credentials as the app does and keeps the session', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess('a1b2c3d4e5f6', 'deadbeef') });

    await expect(cloud.login()).resolves.toEqual({ token: 'a1b2c3d4e5f6', userId: 'deadbeef' });

    const [call] = server.calls;
    const request = Message.decode(call!.message);
    expect(request.string(1)).toBe('me@example.com');
    expect(request.string(2)).toBe(sha256('hunter2'));
    expect(request.varint(3)).toBe(1);
    expect(call!.headers['client-device-id']).toBe('device-1');
    expect(call!.headers['client-version-major']).toBe('3.57');
    expect(call!.headers['client-session-token']).toBeUndefined();
    expect(cloud.current).toEqual({ token: 'a1b2c3d4e5f6', userId: 'deadbeef' });
  });

  it('never sends the clear text password', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess() });
    await cloud.login();
    expect(server.calls[0]!.message.includes(Buffer.from('hunter2'))).toBe(false);
  });

  it.each([
    [3, 'account-not-confirmed'],
    [4, 'account-locked'],
    [5, 'invalid-credentials'],
    [1, 'rejected'],
  ])('maps login failure %i to %s', async (field, reason) => {
    handlers[LOGIN] = () => ({ message: loginFailure(field) });
    await expect(cloud.login()).rejects.toMatchObject({ reason });
  });

  it('explains how to continue when two-factor authentication is required', async () => {
    handlers[LOGIN] = () => ({ message: loginFailure(2, new Writer().string(1, 'req-42')) });
    await expect(cloud.login()).rejects.toMatchObject({ reason: 'two-factor-required', message: expect.stringContaining('totpSecret') });
  });

  describe('with two-factor authentication', () => {
    it('completes the login with the authenticator code', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(59_000);
      handlers[LOGIN] = () => ({ message: loginFailure(2, new Writer().string(1, 'req-42')) });
      handlers[LOGIN_TOTP] = () => ({ message: loginSuccess('0badcafe', 'cafe1234') });
      const twoFactor = await withTotp();

      await expect(twoFactor.login()).resolves.toEqual({ token: '0badcafe', userId: 'cafe1234' });

      const request = Message.decode(server.calls[1]!.message);
      expect(request.string(1)).toBe('me@example.com');
      expect(request.varint(2)).toBe(1);
      expect(request.string(3)).toBe(totp(TOTP_SECRET, 59_000));
      expect(request.string(4)).toBe('req-42');
    });

    it('reports a wrong code', async () => {
      handlers[LOGIN] = () => ({ message: loginFailure(2, new Writer().string(1, 'req-42')) });
      handlers[LOGIN_TOTP] = () => ({ message: new Writer().message(2, new Writer().message(4, new Writer())).finish() });
      await expect((await withTotp()).login()).rejects.toMatchObject({
        reason: 'invalid-credentials',
        message: expect.stringContaining('two-factor'),
      });
    });

    async function withTotp(): Promise<AjaxCloud> {
      const channel = (cloud as unknown as { channel: GrpcChannel }).channel;
      return make(channel, { totpSecret: TOTP_SECRET });
    }
  });

  it('tells the user when Ajax has retired the client version', async () => {
    handlers[LOGIN] = () => ({ status: GrpcStatus.PERMISSION_DENIED, text: 'Request is blacklisted' });
    await expect(cloud.login()).rejects.toMatchObject({ reason: 'client-rejected', message: expect.stringContaining('clientVersion') });
  });

  it('does not mistake a plain permission error for a retired client', async () => {
    handlers[LOGIN] = () => ({ status: GrpcStatus.PERMISSION_DENIED, text: 'no access' });
    await expect(cloud.login()).rejects.toMatchObject({ reason: 'rejected' });
  });

  it('reports an unreachable cloud', async () => {
    handlers[LOGIN] = () => ({ status: GrpcStatus.UNAVAILABLE, text: 'down' });
    await expect(cloud.login()).rejects.toMatchObject({ reason: 'unavailable' });
  });

  it('refuses a success without a session', async () => {
    handlers[LOGIN] = () => ({ message: success() });
    await expect(cloud.login()).rejects.toMatchObject({ reason: 'rejected' });
  });
});

describe('device identity', () => {
  it('names the device the way the caller asks, for the list of sessions in the Ajax app', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess() });
    const channel = (cloud as unknown as { channel: GrpcChannel }).channel;
    await make(channel, { deviceModel: 'Homebridge', deviceOs: 'Linux' }).login();

    const { headers } = server.calls[0]!;
    expect(headers['client-device-model']).toBe('Homebridge');
    expect(headers['client-os']).toBe('Linux');
  });

  it('keeps announcing the same identity on later calls', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess() });
    handlers[SPACES] = () => ({ message: new Writer().message(1, new Writer()).finish() });
    const channel = (cloud as unknown as { channel: GrpcChannel }).channel;
    await make(channel, { deviceModel: 'Homebridge', deviceOs: 'Linux' }).spaces();

    expect(server.calls[1]!.headers['client-device-model']).toBe('Homebridge');
    expect(server.calls[1]!.headers['client-os']).toBe('Linux');
  });
});

describe('logout', () => {
  const LOGOUT = 'LogoutService/execute';

  it('ends the session on the Ajax side and forgets it', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess('a1b2', 'deadbeef') });
    handlers[LOGOUT] = () => ({ message: success() });
    await cloud.login();

    await cloud.logout();

    const call = server.calls.find((c) => c.path.endsWith(LOGOUT))!;
    expect(call.headers['client-session-token']).toBe('a1b2');
    expect(call.message).toHaveLength(0);
    expect(cloud.current).toBeUndefined();
  });

  it('does nothing without a session', async () => {
    await cloud.logout();
    expect(server.calls).toHaveLength(0);
  });

  it('forgets the session even when Ajax cannot be reached', async () => {
    handlers[LOGIN] = () => ({ message: loginSuccess() });
    handlers[LOGOUT] = () => ({ status: GrpcStatus.UNAVAILABLE, text: 'down' });
    await cloud.login();

    await expect(cloud.logout()).resolves.toBeUndefined();
    expect(cloud.current).toBeUndefined();
  });
});

describe('spaces', () => {
  beforeEach(() => {
    handlers[LOGIN] = () => ({ message: loginSuccess('a1b2', 'deadbeef') });
  });

  it('lists the spaces with their state', async () => {
    handlers[SPACES] = () => ({
      message: new Writer().message(1, new Writer()
        .message(1, space('space-1', 'Home', 3, '00AB12CD'))
        .message(1, space('space-2', 'Garage', 2, '', false)))
        .finish(),
    });

    expect(await cloud.spaces()).toEqual([
      { id: 'space-1', hubId: '00AB12CD', name: 'Home', state: 'night', online: true },
      { id: 'space-2', hubId: '', name: 'Garage', state: 'disarmed', online: false },
    ]);
  });

  it('logs in by itself and presents the session', async () => {
    handlers[SPACES] = () => ({ message: new Writer().message(1, new Writer()).finish() });
    await cloud.spaces();

    expect(server.calls.map((call) => call.path.split('/').pop())).toEqual(['execute', 'execute']);
    const headers = server.calls[1]!.headers;
    expect(headers['client-session-token']).toBe('a1b2');
    expect(headers['a911-user-id']).toBe('deadbeef');
    expect(headers['client-user-login']).toBe('me@example.com');
    expect(headers['client-user-role']).toBe('USER');
    expect(Message.decode(server.calls[1]!.message).varint(1)).toBe(100);
  });

  it.each([
    [1, 'armed'], [2, 'disarmed'], [3, 'night'], [4, 'partial'], [5, 'exit-delay'], [0, 'none'], [99, 'unknown'],
  ])('reads state %i as %s', async (value, state) => {
    handlers[SPACES] = () => ({ message: new Writer().message(1, new Writer().message(1, space('s', 'S', value))).finish() });
    expect((await cloud.spaces())[0]!.state).toBe(state);
  });

  it('logs in again once when the session has expired', async () => {
    let attempts = 0;
    handlers[SPACES] = () => (++attempts === 1
      ? { status: GrpcStatus.UNAUTHENTICATED, text: 'expired' }
      : { message: new Writer().message(1, new Writer()).finish() });

    await expect(cloud.spaces()).resolves.toEqual([]);
    expect(server.calls.filter((call) => call.path.endsWith(LOGIN))).toHaveLength(2);
  });

  it('does not loop when the new session is refused too', async () => {
    handlers[SPACES] = () => ({ status: GrpcStatus.UNAUTHENTICATED, text: 'expired' });
    await expect(cloud.spaces()).rejects.toMatchObject({ reason: 'unauthenticated' });
    expect(server.calls.filter((call) => call.path.endsWith(SPACES))).toHaveLength(2);
  });

  it('reuses a restored session without logging in', async () => {
    handlers[SPACES] = () => ({ message: new Writer().message(1, new Writer()).finish() });
    cloud.restore({ token: 'cafe', userId: 'beef' });
    await cloud.spaces();

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.headers['client-session-token']).toBe('cafe');
  });
});

describe('commands', () => {
  beforeEach(() => {
    handlers[LOGIN] = () => ({ message: loginSuccess() });
  });

  it.each(['arm', 'disarm', 'armToNightMode', 'disarmFromNightMode'] as const)('%s targets the space', async (command) => {
    handlers[security(command)] = () => ({ message: success() });
    await cloud.command('space-001', command);

    const call = server.calls.find((c) => c.path.endsWith(security(command)))!;
    // ArmSpaceRequest { space_locator { space_id: "space-001" } } and ignore_alarms left false.
    expect(call.message.toString('hex')).toBe('0a0b0a0973706163652d303031');
    expect(call.path).toBe(`/systems.ajax.api.mobile.v2.space.security.${security(command)}`);
  });

  it('counts "already in that state" as success', async () => {
    handlers[security('arm')] = () => ({ message: failure(5) });
    await expect(cloud.command('s', 'arm')).resolves.toBeUndefined();
  });

  it.each([
    ['arm', 8, 'hub busy'],
    ['arm', 11, 'hub detected malfunctions'],
    ['arm', 10, 'hub alarm reset required'],
    ['disarm', 3, 'permission denied'],
    ['disarm', 9, 'space locked'],
    ['arm', 99, 'error 99'],
  ] as const)('explains why %s was refused (%i)', async (command, field, text) => {
    handlers[security(command)] = () => ({ message: failure(field) });
    await expect(cloud.command('s', command)).rejects.toMatchObject({ reason: 'rejected', message: expect.stringContaining(text) });
  });

  it('keeps the name Ajax gave to a refusal', async () => {
    handlers[security('disarmFromNightMode')] = () => ({ message: failure(6) });
    await expect(cloud.command('s', 'disarmFromNightMode')).rejects.toMatchObject({ detail: 'illegal_space_security_mode' });
  });

  it('is a CloudError', async () => {
    handlers[security('arm')] = () => ({ message: failure(7) });
    await expect(cloud.command('s', 'arm')).rejects.toBeInstanceOf(CloudError);
  });
});

import { connect } from 'node:net';

import hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from 'homebridge';

import { Message, Writer } from '../src/cloud/protobuf.js';
import { AjaxSiaPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { FakeGrpcServer, type Call, type Reply } from './cloud/fakeGrpc.js';
import { createApi, createLog, freePort } from './fakeHomebridge.js';
import { ACCOUNT, hubMessage } from './helpers.js';

const { Service, Characteristic } = hap;
const State = Characteristic.SecuritySystemCurrentState;
const Target = Characteristic.SecuritySystemTargetState;

const cloud = new FakeGrpcServer();
let shutdown: (() => void) | undefined;
let handlers: Record<string, (call: Call) => Reply>;

const loginOk = () => ({
  message: new Writer()
    .message(1, new Writer().bytes(1, Buffer.from('a1b2c3', 'hex')).message(2, new Writer().string(1, 'deadbeef')))
    .finish(),
});
const ok = () => ({ message: new Writer().message(1, new Writer()).finish() });
const fail = (field: number) => ({ message: new Writer().message(2, new Writer().message(field, new Writer())).finish() });
const spaces = (state: number) => ({
  message: new Writer()
    .message(1, new Writer().message(1, new Writer().string(1, 'space-1').message(2, new Writer().string(1, 'Home')).varint(3, state)))
    .finish(),
});

beforeEach(async () => {
  handlers = { 'LoginByPasswordService/execute': loginOk, 'FindUserSpacesWithPaginationService/execute': () => spaces(2) };
  cloud.calls.length = 0;
  cloud.handler = (call) => {
    const key = Object.keys(handlers).find((suffix) => call.path.endsWith(suffix));
    return key ? handlers[key]!(call) : { status: 12, text: call.path };
  };
});

afterEach(async () => {
  shutdown?.();
  shutdown = undefined;
  await cloud.stop();
});

async function launch(settings: Record<string, unknown> = {}) {
  const origin = await cloud.start();
  const { api, emit, registered } = createApi();
  const { log, messages } = createLog();
  const port = await freePort();
  const config = {
    platform: PLATFORM_NAME,
    name: 'Ajax',
    accountId: ACCOUNT,
    port,
    listenAddress: '127.0.0.1',
    protocol: 'tcp',
    maxTimeSkewSeconds: 0,
    cloud: { email: 'me@example.com', password: 'hunter2', host: origin, syncIntervalMinutes: 0, ...settings },
  } as PlatformConfig;

  new AjaxSiaPlatform(log, config, api);
  shutdown = () => emit('shutdown');
  emit('didFinishLaunching');
  await vi.waitFor(() => expect(messages.info.some((line) => line.includes('Listening'))).toBe(true));

  const hub = registered[0]!;
  const service = hub.getService(Service.SecuritySystem)!;
  return {
    port,
    messages,
    current: () => service.getCharacteristic(Characteristic.SecuritySystemCurrentState).value,
    target: service.getCharacteristic(Target),
  };
}

const commandsSent = () => cloud.calls.map((call) => call.path.split('/').pop()).filter((name) => !['execute'].includes(name!));

async function hubSends(port: number, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(hubMessage({ data }), 'latin1'));
    socket.once('data', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

describe('AjaxSiaPlatform with commands enabled', () => {
  it('reads the real state from Ajax at startup', async () => {
    handlers['FindUserSpacesWithPaginationService/execute'] = () => spaces(3);
    const { current } = await launch();
    await vi.waitFor(() => expect(current()).toBe(State.NIGHT_ARM));
  });

  it('arms the system when HomeKit asks for Away', async () => {
    handlers['SpaceSecurityService/arm'] = ok;
    const { target } = await launch();

    await target.handleSetRequest(Target.AWAY_ARM);

    expect(commandsSent()).toContain('arm');
    const arm = cloud.calls.find((call) => call.path.endsWith('/arm'))!;
    expect(Message.decode(arm.message).message(1)?.string(1)).toBe('space-1');
    expect(arm.headers['client-session-token']).toBe('a1b2c3');
  });

  it('disarms, using the disarm-from-night command when the system is in night mode', async () => {
    handlers['FindUserSpacesWithPaginationService/execute'] = () => spaces(3);
    handlers['SpaceSecurityService/disarmFromNightMode'] = ok;
    const { current, target } = await launch();
    await vi.waitFor(() => expect(current()).toBe(State.NIGHT_ARM));

    await target.handleSetRequest(Target.DISARM);
    expect(commandsSent()).toContain('disarmFromNightMode');
  });

  it('reports a refusal to HomeKit and logs why', async () => {
    handlers['SpaceSecurityService/arm'] = () => fail(8);
    const { target, messages } = await launch();

    await expect(target.handleSetRequest(Target.AWAY_ARM)).rejects.toBeDefined();
    expect(messages.error.some((line) => line.includes('hub busy'))).toBe(true);
  });

  it('keeps the SIA events flowing alongside', async () => {
    const { port, current } = await launch();
    await hubSends(port, 'Nri1/CL501');
    expect(current()).toBe(State.AWAY_ARM);
  });

  it('warns that the protocol is unofficial', async () => {
    const { messages } = await launch();
    expect(messages.warn.some((line) => line.includes('not an official API'))).toBe(true);
  });

  it('never logs the password', async () => {
    const { messages } = await launch();
    const all = Object.values(messages).flat().join('\n');
    expect(all).not.toContain('hunter2');
  });

  it('stays usable when Ajax cannot be reached', async () => {
    handlers['LoginByPasswordService/execute'] = () => ({ status: 14, text: 'down' });
    const { port, current, messages } = await launch();

    await hubSends(port, 'Nri1/CL501');
    expect(current()).toBe(State.AWAY_ARM);
    await vi.waitFor(() => expect(messages.warn.some((line) => line.includes('Could not read the state from Ajax'))).toBe(true));
  });

  it('says what to do when Ajax has retired the client version', async () => {
    handlers['LoginByPasswordService/execute'] = () => ({ status: 7, text: 'Request is blacklisted' });
    const { messages } = await launch();
    await vi.waitFor(() => expect(messages.warn.some((line) => line.includes('clientVersion'))).toBe(true));
  });
});

describe('AjaxSiaPlatform without cloud settings', () => {
  it('leaves the tile read-only', async () => {
    const { api, emit, registered } = createApi();
    const { log, messages } = createLog();
    const port = await freePort();
    const config = { platform: PLATFORM_NAME, name: 'Ajax', accountId: ACCOUNT, port, listenAddress: '127.0.0.1', protocol: 'tcp' };
    new AjaxSiaPlatform(log, config as PlatformConfig, api);
    emit('didFinishLaunching');
    await vi.waitFor(() => expect(messages.info.some((line) => line.includes('Listening'))).toBe(true));

    const target = registered[0]!.getService(Service.SecuritySystem)!.getCharacteristic(Target);
    expect(target.props.perms).not.toContain(hap.Perms.PAIRED_WRITE);
    emit('shutdown');
  });
});

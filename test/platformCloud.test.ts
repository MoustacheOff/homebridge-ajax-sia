import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

import hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from 'homebridge';

import { Message, Writer } from '../src/cloud/protobuf.js';
import { AjaxSiaPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { battery, hubDevice, snapshot, temperature } from './cloud/deviceFixtures.js';
import { FakeGrpcServer, type Call, type Reply } from './cloud/fakeGrpc.js';
import { GrpcStatus } from '../src/cloud/grpc.js';
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

async function launch(
  settings: Record<string, unknown> = {},
  seed?: unknown,
  platformSettings: Record<string, unknown> = {},
  cached: unknown[] = [],
) {
  const origin = await cloud.start();
  const { api, emit, registered, unregistered, storage } = createApi();
  if (seed) {
    writeFileSync(join(storage, 'homebridge-ajax-sia-cloud.json'), JSON.stringify(seed));
  }
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
    ...platformSettings,
  } as PlatformConfig;

  const platform = new AjaxSiaPlatform(log, config, api);
  cached.forEach((accessory) => platform.configureAccessory(accessory as never));
  shutdown = () => emit('shutdown');
  emit('didFinishLaunching');
  await vi.waitFor(() => expect(messages.info.some((line) => line.includes('Listening'))).toBe(true));

  const hub = [...registered, ...cached as typeof registered].find((accessory) => accessory.getService(Service.SecuritySystem))!;
  const service = hub.getService(Service.SecuritySystem)!;
  return {
    registered,
    unregistered,
    port,
    storage,
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

  it('leaves night mode with a plain disarm, as a space without groups requires', async () => {
    handlers['FindUserSpacesWithPaginationService/execute'] = () => spaces(3);
    handlers['SpaceSecurityService/disarm'] = ok;
    const { current, target } = await launch();
    await vi.waitFor(() => expect(current()).toBe(State.NIGHT_ARM));

    await target.handleSetRequest(Target.DISARM);
    expect(commandsSent()).toContain('disarm');
    expect(commandsSent()).not.toContain('disarmFromNightMode');
  });

  it('falls back to the night mode command when Ajax says the space uses groups', async () => {
    handlers['FindUserSpacesWithPaginationService/execute'] = () => spaces(3);
    handlers['SpaceSecurityService/disarm'] = () => fail(6);
    handlers['SpaceSecurityService/disarmFromNightMode'] = ok;
    const { current, target } = await launch();
    await vi.waitFor(() => expect(current()).toBe(State.NIGHT_ARM));

    await target.handleSetRequest(Target.DISARM);
    expect(commandsSent()).toEqual(expect.arrayContaining(['disarm', 'disarmFromNightMode']));
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

describe('AjaxSiaPlatform with the devices of the Ajax account', () => {
  const STREAM = 'StreamLightDevicesService/execute';
  const MOTION = 2;
  const DOOR = 4;
  const SIREN = 31;
  const HUB = 114;
  const named = (registered: { displayName: string }[]) => registered.map((accessory) => accessory.displayName);
  const devicesRead = () => cloud.calls.filter((call) => call.path.endsWith(STREAM)).length;

  const detectors = [
    { zone: 1, name: 'Living room', type: 'motion' },
    { zone: 2, name: 'Front door', type: 'contact' },
  ];
  const level = (accessory: { getService: (service: never) => { getCharacteristic: (c: never) => { value: unknown } } | undefined }) =>
    accessory.getService(Service.Battery as never)?.getCharacteristic(Characteristic.BatteryLevel as never).value;

  beforeEach(() => {
    handlers[STREAM] = () => ({
      stream: [snapshot(
        hubDevice({ id: 'D1', name: 'MotionProtect Plus', index: 1, type: MOTION, statuses: [battery(1, 55), temperature(21)] }),
        hubDevice({ id: 'D2', name: 'DoorProtect Plus', index: 2, type: DOOR, states: [9], statuses: [battery(3, 7)] }),
      )],
    });
  });

  it('gives each detector the user listed what the account says about it, matched by its number', async () => {
    const { registered } = await launch({}, undefined, { devices: detectors });
    await vi.waitFor(() => expect(devicesRead()).toBe(1));

    const room = registered.find((accessory) => accessory.displayName === 'Living room')!;
    const door = registered.find((accessory) => accessory.displayName === 'Front door')!;
    await vi.waitFor(() => expect(level(room)).toBe(55));
    expect(level(door)).toBe(7);
    expect(door.getService(Service.ContactSensor)!.getCharacteristic(Characteristic.StatusFault).value).toBe(1);
    const thermometer = room.getServiceById(Service.TemperatureSensor, 'temperature')!;
    expect(thermometer.getCharacteristic(Characteristic.CurrentTemperature).value).toBe(21);
    expect(named(registered)).not.toContain('MotionProtect Plus');
  });

  it('opens a single session at startup, although it reads both the state and the devices', async () => {
    await launch({}, undefined, { devices: detectors });
    await vi.waitFor(() => expect(devicesRead()).toBe(1));
    expect(cloud.calls.filter((call) => call.path.endsWith('LoginByPasswordService/execute'))).toHaveLength(1);
  });

  it('reports the hub as faulty when the account says it is offline', async () => {
    handlers[STREAM] = () => ({ stream: [snapshot(hubDevice({ name: 'Hub 2 (4G)', index: 0, type: HUB, states: [9] }))] });
    const { registered, messages } = await launch();
    const hub = registered.find((accessory) => accessory.getService(Service.SecuritySystem))!;
    const fault = () => hub.getService(Service.SecuritySystem)!.getCharacteristic(Characteristic.StatusFault).value;
    await vi.waitFor(() => expect(fault()).toBe(1));
    expect(messages.warn.some((line) => line.startsWith('Hub 2 (4G) is offline'))).toBe(true);
  });

  it('writes a line in the log, once, when a siren or a keyfob needs attention, and when it is fine again', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(
        hubDevice({ id: 'S1', name: 'StreetSiren', index: 5, type: SIREN, states: [9], statuses: [battery(3, 9)] }),
        hubDevice({ id: 'D1', name: 'Garage', index: 2, type: MOTION, states: [9] }),
      )],
    });
    const { messages } = await launch();
    await vi.waitFor(() => expect(messages.warn.some((line) => line.includes('StreetSiren is offline, low on battery (9%)'))).toBe(true));
    // A detector has its own status in Apple Home: it is not written to the log as well.
    expect(messages.warn.some((line) => line.includes('Garage'))).toBe(false);
    expect(messages.warn.filter((line) => line.includes('StreetSiren'))).toHaveLength(1);
  });

  it('exposes the detectors the user did not list, and nothing else', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(
        hubDevice({ name: 'Hub 2 (4G)', index: 0, type: HUB }),
        hubDevice({ name: 'DoorProtect Plus', index: 1, type: DOOR }),
        hubDevice({ name: 'MotionProtect Plus', index: 2, type: MOTION }),
        hubDevice({ name: 'MotionProtect Plus', index: 3, type: MOTION }),
        hubDevice({ name: 'StreetSiren', index: 5, type: SIREN }),
        hubDevice({ name: 'Mystery', index: 6, type: 9999 }),
      )],
    });
    const { registered, messages } = await launch();
    await vi.waitFor(() => expect(named(registered).length).toBe(4));

    expect(named(registered).sort()).toEqual(['Ajax', 'DoorProtect Plus', 'MotionProtect Plus 2', 'MotionProtect Plus 3']);
    expect(messages.info.some((line) => line.includes('Found MotionProtect Plus (zone 2)'))).toBe(true);
  });

  it('makes the discovered detectors react to what the hub reports', async () => {
    handlers[STREAM] = () => ({ stream: [snapshot(hubDevice({ name: 'Garage', index: 2, type: MOTION }))] });
    const { registered, port } = await launch();
    await vi.waitFor(() => expect(named(registered)).toContain('Garage'));

    await hubSends(port, 'Nri1/BA2');
    const garage = registered.find((accessory) => accessory.displayName === 'Garage')!;
    expect(garage.getService(Service.MotionSensor)!.getCharacteristic(Characteristic.MotionDetected).value).toBe(true);
  });

  it('keeps the name the user gave, and does not add the detector a second time', async () => {
    const { registered } = await launch({}, undefined, { devices: [{ zone: 1, name: 'Mouvement salon', type: 'motion' }] });
    await vi.waitFor(() => expect(devicesRead()).toBe(1));
    await vi.waitFor(() => expect(named(registered)).toContain('DoorProtect Plus'));
    expect(named(registered).filter((name) => /Mouvement salon|MotionProtect Plus/.test(name))).toEqual(['Mouvement salon']);
  });

  it('adds nothing when the user turned discovery off, but still reports on the listed detectors', async () => {
    const { registered } = await launch({ discoverDevices: false }, undefined, { devices: [detectors[0]] });
    await vi.waitFor(() => expect(devicesRead()).toBe(1));
    const room = registered.find((accessory) => accessory.displayName === 'Living room')!;
    await vi.waitFor(() => expect(level(room)).toBe(55));
    expect(named(registered).sort()).toEqual(['Ajax', 'Living room']);
  });

  it('adds no temperature sensor when the user turned it off', async () => {
    const { registered } = await launch({ temperatureSensors: false }, undefined, { devices: [detectors[0]] });
    const room = registered.find((accessory) => accessory.displayName === 'Living room')!;
    await vi.waitFor(() => expect(level(room)).toBe(55));
    expect(room.getServiceById(Service.TemperatureSensor, 'temperature')).toBeUndefined();
  });

  it('keeps the discovered detectors across a restart, and forgets the ones that left the account', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(hubDevice({ name: 'Garage', index: 2, type: MOTION }), hubDevice({ name: 'Cave', index: 3, type: DOOR }))],
    });
    const first = await launch();
    await vi.waitFor(() => expect(named(first.registered).sort()).toEqual(['Ajax', 'Cave', 'Garage']));
    const known = [...first.registered];
    shutdown?.();
    cloud.calls.length = 0;

    // Second start, with the same accessories in the cache and one detector gone from the account.
    handlers[STREAM] = () => ({ stream: [snapshot(hubDevice({ name: 'Garage', index: 2, type: MOTION }))] });
    const second = await launch({}, undefined, {}, known);
    await vi.waitFor(() => expect(named(second.unregistered)).toEqual(['Cave']));
    expect(named(second.registered)).not.toContain('Garage');
  });

  it('keeps the detectors it knows when the account cannot be read', async () => {
    handlers[STREAM] = () => ({ status: GrpcStatus.UNAVAILABLE, text: 'down' });
    const first = await launch({}, undefined, { devices: detectors });
    await vi.waitFor(() => expect(first.messages.warn.some((line) => line.includes('Could not read the devices'))).toBe(true));
    expect(named(first.registered).sort()).toEqual(['Ajax', 'Front door', 'Living room']);
    expect(first.unregistered).toEqual([]);
  });
});

describe('AjaxSiaPlatform renaming itself in the Ajax account', () => {
  const LOGIN_PATH = 'LoginByPasswordService/execute';
  const LOGOUT_PATH = 'LogoutService/execute';
  const sent = (suffix: string) => cloud.calls.filter((call) => call.path.endsWith(suffix));
  const started = (messages: { info: string[] }) =>
    vi.waitFor(() => expect(messages.info.some((line) => line.includes('Using Ajax space'))).toBe(true));
  const OLD = { deviceId: 'device-1', session: { token: 'aabb', userId: 'cc' }, identity: 'SM-A536B|Android' };

  it('ends a session opened under another name, then logs in under the current one', async () => {
    handlers[LOGOUT_PATH] = ok;
    const { storage, messages } = await launch({}, OLD);
    await started(messages);
    expect(messages.info.some((line) => line.includes('ending it and logging in again as "Homebridge"'))).toBe(true);

    expect(cloud.calls[0]!.path.endsWith(LOGOUT_PATH)).toBe(true);
    expect(cloud.calls[0]!.headers['client-session-token']).toBe('aabb');
    expect(cloud.calls[1]!.path.endsWith(LOGIN_PATH)).toBe(true);
    expect(cloud.calls[1]!.headers['client-device-model']).toBe('Homebridge');
    expect(cloud.calls[1]!.headers['client-device-id']).toBe('device-1');

    const file = readFileSync(join(storage, 'homebridge-ajax-sia-cloud.json'), 'utf8');
    const stored = JSON.parse(file) as { identity: string; session: { token: string } };
    expect(stored.identity.startsWith('Homebridge|')).toBe(true);
    expect(stored.session.token).toBe('a1b2c3');
  });

  it('logs in anyway when Ajax cannot end the old session', async () => {
    handlers[LOGOUT_PATH] = () => ({ status: 14, text: 'down' });
    const { messages } = await launch({}, OLD);
    await started(messages);

    expect(sent(LOGIN_PATH)).toHaveLength(1);
  });

  it('keeps a session that already has the right name, without logging in again', async () => {
    const { DEFAULT_DEVICE_MODEL, DEFAULT_DEVICE_OS } = await import('../src/config.js');
    const { messages } = await launch({}, { ...OLD, identity: `${DEFAULT_DEVICE_MODEL}|${DEFAULT_DEVICE_OS}` });
    await started(messages);

    expect(sent(LOGIN_PATH)).toHaveLength(0);
    expect(sent(LOGOUT_PATH)).toHaveLength(0);
    expect(cloud.calls[0]!.headers['client-session-token']).toBe('aabb');
  });

  it('does not log out a plugin that has never logged in', async () => {
    const { messages } = await launch();
    await started(messages);
    expect(sent(LOGOUT_PATH)).toHaveLength(0);
  });
});

describe('AjaxSiaPlatform protecting the Ajax account', () => {
  const LOGIN_PATH = 'LoginByPasswordService/execute';
  const logins = () => cloud.calls.filter((call) => call.path.endsWith(LOGIN_PATH)).length;

  it.each([
    ['wrong credentials', () => fail(5)],
    ['a locked account', () => fail(4)],
    ['a retired client version', () => ({ status: 7, text: 'Request is blacklisted' })],
  ])('stops calling Ajax after %s, instead of repeating a failure that cannot succeed', async (_label, reply) => {
    handlers[LOGIN_PATH] = reply as never;
    const { target, messages } = await launch();
    await vi.waitFor(() => expect(messages.error.some((line) => line.includes('stopped to protect your account'))).toBe(true));
    const before = cloud.calls.length;

    await expect(target.handleSetRequest(Target.AWAY_ARM)).rejects.toBeDefined();
    await expect(target.handleSetRequest(Target.DISARM)).rejects.toBeDefined();

    expect(cloud.calls.length).toBe(before);
    expect(logins()).toBe(1);
  });

  it('keeps trying after a network problem, which is not the account\'s fault', async () => {
    let attempts = 0;
    handlers[LOGIN_PATH] = () => (++attempts === 1 ? { status: 14, text: 'down' } : loginOk());
    handlers['SpaceSecurityService/arm'] = ok;
    const { target, messages } = await launch();
    await vi.waitFor(() => expect(messages.warn.some((line) => line.includes('Could not read the state from Ajax'))).toBe(true));

    await target.handleSetRequest(Target.AWAY_ARM);

    expect(commandsSent()).toContain('arm');
    expect(messages.error.some((line) => line.includes('stopped to protect'))).toBe(false);
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

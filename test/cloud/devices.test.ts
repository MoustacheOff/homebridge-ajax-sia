import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AjaxCloud, CloudError, sha256 } from '../../src/cloud/ajax.js';
import { displayFamily, familyName, sensorKind } from '../../src/cloud/deviceTypes.js';
import { GrpcChannel, GrpcStatus } from '../../src/cloud/grpc.js';
import { Message, Writer } from '../../src/cloud/protobuf.js';
import { battery, flag, hubDevice, signal, snapshot, temperature } from './deviceFixtures.js';
import { FakeGrpcServer, type Call, type Reply } from './fakeGrpc.js';

const LOGIN = 'LoginByPasswordService/execute';
const STREAM = 'StreamLightDevicesService/execute';

const loginSuccess = () =>
  new Writer().message(1, new Writer().bytes(1, Buffer.from('a1b2c3', 'hex')).message(2, new Writer().string(1, 'deadbeef'))).finish();

const server = new FakeGrpcServer();
let cloud: AjaxCloud;
let handlers: Record<string, (call: Call) => Reply>;

beforeEach(async () => {
  handlers = { [LOGIN]: () => ({ message: loginSuccess() }) };
  server.calls.length = 0;
  server.handler = (call) => {
    const key = Object.keys(handlers).find((suffix) => call.path.endsWith(suffix));
    return key ? handlers[key]!(call) : { status: GrpcStatus.UNIMPLEMENTED, text: `no handler for ${call.path}` };
  };
  cloud = new AjaxCloud({
    host: 'unused',
    port: 0,
    email: 'me@example.com',
    passwordHash: sha256('hunter2'),
    deviceId: 'device-1',
    clientVersion: '3.57',
    channel: new GrpcChannel(await server.start()),
  });
});

afterEach(async () => {
  await server.stop();
});

describe('AjaxCloud.devices', () => {
  it('asks for the devices of the space and reads the first message of the stream', async () => {
    handlers[STREAM] = () => ({ stream: [snapshot(hubDevice({ name: 'Salon' }))] });

    const devices = await cloud.devices('space-1');

    expect(devices.map((device) => device.name)).toEqual(['Salon']);
    const call = server.calls.find((entry) => entry.path.endsWith(STREAM))!;
    expect(Message.decode(call.message).string(1)).toBe('space-1');
    expect(call.headers['client-session-token']).toBe('a1b2c3');
    await expect.poll(() => server.streamsClosedByClient).toBe(1);
  });

  it('reads the identity of each device', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(hubDevice({ id: '1A2B3C4D', name: 'Entrée', index: 3, type: 2 }))],
    });
    const [device] = await cloud.devices('space-1');
    expect(device).toMatchObject({ id: '1A2B3C4D', hubId: 'hub-1', name: 'Entrée', index: 3, family: 'motion_protect' });
  });

  it('leaves the family out when it does not know it', async () => {
    handlers[STREAM] = () => ({ stream: [snapshot(hubDevice({ type: 9999 }), hubDevice({}))] });
    const devices = await cloud.devices('space-1');
    expect(devices.map((device) => device.family)).toEqual([undefined, undefined]);
  });

  it('reads the battery, the signal and the temperature', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(
        hubDevice({ name: 'ok', statuses: [battery(1, 87), signal(4), temperature(21)] }),
        hubDevice({ name: 'weak', statuses: [battery(3, 12), signal(2), temperature(-4)] }),
      )],
    });
    const [ok, weak] = await cloud.devices('space-1');
    expect(ok).toMatchObject({ batteryPercent: 87, batteryLow: false, signal: 'strong', temperature: 21 });
    expect(weak).toMatchObject({ batteryPercent: 12, batteryLow: true, signal: 'weak', temperature: -4 });
  });

  it('knows a device that is offline, deactivated, tampered or in trouble', async () => {
    handlers[STREAM] = () => ({
      stream: [snapshot(
        hubDevice({ name: 'fine' }),
        hubDevice({ name: 'offline', states: [9] }),
        hubDevice({ name: 'updating', states: [10, 9] }),
        hubDevice({ name: 'bypassed', bypassed: true }),
        hubDevice({ name: 'lid', statuses: [flag(82)] }),
        hubDevice({ name: 'trouble', malfunctions: 2 }),
        hubDevice({ name: 'flagged', statuses: [flag(50)] }),
      )],
    });
    const devices = await cloud.devices('space-1');
    const by = Object.fromEntries(devices.map((device) => [device.name, device]));

    expect(by.fine).toMatchObject({ online: true, bypassed: false, tampered: false, malfunction: false });
    expect(by.offline!.online).toBe(false);
    expect(by.updating!.online).toBe(false);
    expect(by.bypassed!.bypassed).toBe(true);
    expect(by.lid!.tampered).toBe(true);
    expect(by.trouble!.malfunction).toBe(true);
    expect(by.flagged!.malfunction).toBe(true);
  });

  it('reads states that were packed into one block', async () => {
    // States 10 and 9 packed into a single field.
    const profile = new Writer().string(1, 'X').string(2, 'packed').bytes(8, Buffer.from([10, 9])).varint(11, 1);
    const device = new Writer().message(1, new Writer().message(1, new Writer().message(1, profile).string(2, 'hub-1')));
    handlers[STREAM] = () => ({ stream: [snapshot(device)] });
    const [read] = await cloud.devices('space-1');
    expect(read!.online).toBe(false);
  });

  it('ignores what is not a device of the hub, such as a camera', async () => {
    const camera = new Writer().message(2, new Writer().string(1, 'camera-1'));
    handlers[STREAM] = () => ({ stream: [snapshot(camera, hubDevice({ name: 'Salon' }))] });
    const devices = await cloud.devices('space-1');
    expect(devices.map((device) => device.name)).toEqual(['Salon']);
  });

  it('logs in again when the session has expired', async () => {
    let attempts = 0;
    handlers[STREAM] = () => (++attempts === 1
      ? { status: GrpcStatus.UNAUTHENTICATED, text: 'expired' }
      : { stream: [snapshot(hubDevice({ name: 'Salon' }))] });
    const devices = await cloud.devices('space-1');
    expect(devices).toHaveLength(1);
    expect(server.calls.filter((call) => call.path.endsWith(LOGIN))).toHaveLength(2);
  });

  it('says so when the server answers with something else than the list', async () => {
    handlers[STREAM] = () => ({ stream: [new Writer().message(2, new Writer().message(1, new Writer())).finish()] });
    await expect(cloud.devices('space-1')).rejects.toBeInstanceOf(CloudError);
  });

  it('reports a server that is not reachable', async () => {
    handlers[STREAM] = () => ({ status: GrpcStatus.UNAVAILABLE, text: 'down' });
    await expect(cloud.devices('space-1')).rejects.toMatchObject({ reason: 'unavailable' });
  });
});

describe('device families', () => {
  it('names the families of the Ajax apps by their number', () => {
    expect(familyName(1)).toBe('door_protect');
    expect(familyName(2)).toBe('motion_protect');
    expect(familyName(22)).toBe('leak_protect');
    expect(familyName(114)).toBe('hub_two_4g');
    expect(familyName(0)).toBeUndefined();
  });

  it.each([
    ['motion_protect', 'motion'],
    ['motion_cam_phod', 'motion'],
    ['combi_protect_fibra', 'motion'],
    ['door_protect_plus', 'contact'],
    ['glass_protect', 'contact'],
    ['fire_protect_two_hsc_ac', 'smoke'],
    ['leak_protect', 'leak'],
    ['home_siren', undefined],
    ['street_siren_double_deck', undefined],
    ['keypad_plus', undefined],
    ['hub_two_4g', undefined],
    ['space_control', undefined],
    [undefined, undefined],
  ])('exposes %s as %s', (family, kind) => {
    expect(sensorKind(family)).toBe(kind);
  });

  it('writes a family the way a person would', () => {
    expect(displayFamily('motion_protect_plus_fibra')).toBe('Motion Protect Plus Fibra');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AjaxCloud, CloudError, sha256, type CloudDevice } from '../../src/cloud/ajax.js';
import { GrpcChannel, GrpcStatus, type Stream } from '../../src/cloud/grpc.js';
import { Message, Writer } from '../../src/cloud/protobuf.js';
import { UPDATE, battery, flag, hubDevice, malfunctionsUpdate, snapshot, statusUpdate, updatesMessage } from './deviceFixtures.js';
import { FakeGrpcServer, type Call } from './fakeGrpc.js';

const LOGIN = 'LoginByPasswordService/execute';
const STREAM = 'StreamLightDevicesService/execute';

const loginSuccess = () =>
  new Writer().message(1, new Writer().bytes(1, Buffer.from('a1b2c3', 'hex')).message(2, new Writer().string(1, 'deadbeef'))).finish();

const server = new FakeGrpcServer();
let cloud: AjaxCloud;
let first: Buffer;
let streams: Stream[];

interface Seen {
  lists: CloudDevice[][];
  ends: (CloudError | undefined)[];
  skipped: Error[];
}

const watch = (): Seen => {
  const seen: Seen = { lists: [], ends: [], skipped: [] };
  streams.push(cloud.watchDevices('space-1', {
    devices: (devices) => seen.lists.push(devices),
    end: (error) => seen.ends.push(error),
    skipped: (error) => seen.skipped.push(error),
  }));
  return seen;
};

beforeEach(async () => {
  streams = [];
  server.calls.length = 0;
  server.open.length = 0;
  first = snapshot(hubDevice({ id: 'A1', name: 'Salon', statuses: [battery(1, 90)] }), hubDevice({ id: 'B2', name: 'Porte' }));
  server.handler = (call: Call) => {
    if (call.path.endsWith(LOGIN)) {
      return { message: loginSuccess() };
    }
    return call.path.endsWith(STREAM) ? { stream: [first] } : { status: GrpcStatus.UNIMPLEMENTED };
  };
  cloud = new AjaxCloud({
    host: 'unused',
    port: 0,
    email: 'me@example.com',
    passwordHash: sha256('hunter2'),
    deviceId: 'device-1',
    clientVersion: '3.60',
    channel: new GrpcChannel(await server.start()),
  });
  await cloud.login();
});

afterEach(async () => {
  streams.forEach((stream) => stream.close());
  await server.stop();
});

describe('AjaxCloud.watchDevices', () => {
  it('opens the stream for the space with the session, and reports the snapshot', async () => {
    const seen = watch();
    await expect.poll(() => seen.lists.length).toBe(1);

    expect(seen.lists[0]!.map((device) => device.name)).toEqual(['Salon', 'Porte']);
    const call = server.calls.find((entry) => entry.path.endsWith(STREAM))!;
    expect(Message.decode(call.message).string(1)).toBe('space-1');
    expect(call.headers['client-session-token']).toBe('a1b2c3');
  });

  it('reports the whole list again each time a device changes', async () => {
    const seen = watch();
    await expect.poll(() => seen.lists.length).toBe(1);

    server.push(updatesMessage(statusUpdate('A1', battery(2, 12))));
    await expect.poll(() => seen.lists.length).toBe(2);
    expect(seen.lists[1]!.find((device) => device.id === 'A1')).toMatchObject({ batteryPercent: 12, batteryLow: true });
    expect(seen.lists[1]!.find((device) => device.id === 'B2')).toMatchObject({ tampered: false });

    server.push(updatesMessage(statusUpdate('B2', flag(82), UPDATE.add)));
    await expect.poll(() => seen.lists.length).toBe(3);
    expect(seen.lists[2]!.find((device) => device.id === 'B2')).toMatchObject({ tampered: true });
  });

  it('stays quiet when an update changes nothing', async () => {
    const seen = watch();
    await expect.poll(() => seen.lists.length).toBe(1);

    server.push(updatesMessage(statusUpdate('A1', battery(1, 90))));
    server.push(updatesMessage(malfunctionsUpdate('A1', 0)));
    server.push(updatesMessage(statusUpdate('ZZ', battery(3, 1))));
    server.push(updatesMessage(statusUpdate('A1', battery(1, 80))));
    await expect.poll(() => seen.lists.length).toBe(2);
    expect(seen.lists[1]!.find((device) => device.id === 'A1')?.batteryPercent).toBe(80);
  });

  it('replaces everything when the stream sends a new snapshot', async () => {
    const seen = watch();
    await expect.poll(() => seen.lists.length).toBe(1);
    server.push(snapshot(hubDevice({ id: 'C3', name: 'Cave' })));
    await expect.poll(() => seen.lists.length).toBe(2);
    expect(seen.lists[1]!.map((device) => device.name)).toEqual(['Cave']);
  });

  it('skips a message it cannot read and keeps going', async () => {
    const seen = watch();
    await expect.poll(() => seen.lists.length).toBe(1);
    server.push(Buffer.from([0x0a, 0x7f]));
    await expect.poll(() => seen.skipped.length).toBe(1);

    server.push(updatesMessage(statusUpdate('A1', battery(2, 5))));
    await expect.poll(() => seen.lists.length).toBe(2);
    expect(seen.ends).toEqual([]);
  });

  it('ends when Ajax sends a failure instead of devices', async () => {
    first = new Writer().message(2, new Writer().message(1, new Writer())).finish();
    const seen = watch();
    await expect.poll(() => seen.ends.length).toBe(1);
    expect(seen.ends[0]).toMatchObject({ reason: 'rejected' });
    expect(seen.lists).toEqual([]);
  });

  it('tells an expired session from a stream that just ended', async () => {
    const seen = watch();
    await expect.poll(() => server.open.length).toBe(1);
    server.endStreams(GrpcStatus.UNAUTHENTICATED, 'expired');
    await expect.poll(() => seen.ends.length).toBe(1);
    expect(seen.ends[0]).toMatchObject({ reason: 'unauthenticated' });

    // The session was dropped with the error, so the next attempt has to log in again.
    expect(cloud.current).toBeUndefined();
    await cloud.login();
    const again = watch();
    await expect.poll(() => server.open.length).toBe(1);
    server.endStreams();
    await expect.poll(() => again.ends.length).toBe(1);
    expect(again.ends[0]).toBeUndefined();
  });

  it('translates a retired client version', async () => {
    server.handler = (call) => (call.path.endsWith(LOGIN)
      ? { message: loginSuccess() }
      : { status: GrpcStatus.PERMISSION_DENIED, text: 'client version is in blacklist' });
    const seen = watch();
    await expect.poll(() => seen.ends.length).toBe(1);
    expect(seen.ends[0]).toMatchObject({ reason: 'client-rejected' });
  });

  it('needs a session', () => {
    const other = new AjaxCloud({ host: 'unused', port: 0, email: 'a@b.c', passwordHash: 'x', deviceId: 'd', clientVersion: '3.60' });
    expect(() => other.watchDevices('space-1', { devices: () => undefined, end: () => undefined })).toThrow(CloudError);
  });
});

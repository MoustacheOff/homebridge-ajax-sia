import { connect } from 'node:net';

import hap from '@homebridge/hap-nodejs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfig } from 'homebridge';

import { AjaxSiaPlatform } from '../src/platform.js';
import { PLATFORM_NAME } from '../src/settings.js';
import { createApi, createLog, freePort } from './fakeHomebridge.js';
import { ACCOUNT, KEY, hubMessage } from './helpers.js';

const { Service, Characteristic } = hap;
const State = Characteristic.SecuritySystemCurrentState;

const platforms: { shutdown(): void }[] = [];

afterEach(() => {
  platforms.splice(0).forEach((platform) => platform.shutdown());
});

async function launch(overrides: Record<string, unknown> = {}, cached: unknown[] = []) {
  const { api, emit, registered, unregistered, FakeAccessory } = createApi();
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
    devices: [
      { zone: 1, name: 'Living room', type: 'motion' },
      { zone: 2, name: 'Front door', type: 'contact' },
    ],
    ...overrides,
  } as PlatformConfig;

  const platform = new AjaxSiaPlatform(log, config, api);
  cached.forEach((accessory) => platform.configureAccessory(accessory as never));
  platforms.push({ shutdown: () => emit('shutdown') });
  emit('didFinishLaunching');
  // Give the server a moment to bind.
  await vi.waitFor(() => expect(messages.info.some((line) => line.includes('Listening'))).toBe(true));

  return { port, registered, unregistered, messages, FakeAccessory, api };
}

/** Plays the hub: sends one message and waits for the acknowledgement. */
async function hubSends(port: number, frame: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(frame, 'latin1'));
    socket.once('data', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

const characteristic = (accessory: { getService: (s: never) => { getCharacteristic: (c: never) => { value: unknown } } | undefined },
  service: unknown, name: unknown) => Number(accessory.getService(service as never)!.getCharacteristic(name as never).value);

describe('AjaxSiaPlatform', () => {
  it('registers a hub and one accessory per configured device', async () => {
    const { registered } = await launch();
    expect(registered.map((accessory) => accessory.displayName)).toEqual(['Ajax', 'Living room', 'Front door']);
  });

  it('turns hub messages into HomeKit state', async () => {
    const { port, registered } = await launch();
    const [hub, motion, door] = registered as [typeof registered[0], typeof registered[0], typeof registered[0]];

    await hubSends(port, hubMessage({ data: 'Nri1/CL501' }));
    expect(characteristic(hub, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState)).toBe(State.AWAY_ARM);

    await hubSends(port, hubMessage({ data: 'Nri1/BA1' }));
    expect(characteristic(motion, Service.MotionSensor, Characteristic.MotionDetected)).toBe(1);
    expect(characteristic(hub, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState)).toBe(State.ALARM_TRIGGERED);

    await hubSends(port, hubMessage({ data: 'Nri1/BA2' }));
    expect(characteristic(door, Service.ContactSensor, Characteristic.ContactSensorState)).toBe(1);

    await hubSends(port, hubMessage({ data: 'Nri1/OP501' }));
    expect(characteristic(hub, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState)).toBe(State.DISARMED);
    expect(characteristic(motion, Service.MotionSensor, Characteristic.MotionDetected)).toBe(0);
  });

  it('works with an encrypted hub', async () => {
    const { port, registered } = await launch({ encryptionKey: KEY.toString('latin1'), maxTimeSkewSeconds: 60 });
    await hubSends(port, hubMessage({ data: 'Nri1/NL4', key: KEY, at: new Date() }));
    expect(characteristic(registered[0]!, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState)).toBe(State.NIGHT_ARM);
  });

  it('tells the user about zones it does not know', async () => {
    const { port, messages } = await launch();
    await hubSends(port, hubMessage({ data: 'Nri1/BA7' }));
    await hubSends(port, hubMessage({ data: 'Nri1/BA7' }));
    const hints = messages.info.filter((line) => line.includes('Zone 7'));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('"zone": 7');
  });

  it('does not mistake a user number for a zone', async () => {
    const { port, messages } = await launch();
    await hubSends(port, hubMessage({ data: 'Nri1/CL501' }));
    expect(messages.info.some((line) => line.includes('Zone 501'))).toBe(false);
  });

  it('restores the last known arming state after a restart', async () => {
    const first = await launch();
    await hubSends(first.port, hubMessage({ data: 'Nri1/NL4' }));
    const hub = first.registered[0]!;
    platforms.splice(0).forEach((platform) => platform.shutdown());

    const second = await launch({}, [hub]);
    expect(second.registered).toHaveLength(2);
    expect(characteristic(hub as never, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState)).toBe(State.NIGHT_ARM);
  });

  it('removes accessories that are no longer configured', async () => {
    const first = await launch();
    const [hub, motion, door] = first.registered;
    platforms.splice(0).forEach((platform) => platform.shutdown());

    const second = await launch({ devices: [{ zone: 1, name: 'Living room', type: 'motion' }] }, [hub, motion, door]);
    expect(second.unregistered).toEqual([door]);
  });

  it('rebuilds an accessory whose type changed', async () => {
    const first = await launch();
    const [hub, motion, door] = first.registered;
    platforms.splice(0).forEach((platform) => platform.shutdown());

    const second = await launch(
      { devices: [{ zone: 1, name: 'Living room', type: 'contact' }, { zone: 2, name: 'Front door', type: 'contact' }] },
      [hub, motion, door],
    );
    expect(second.unregistered).toContain(motion);
    expect(second.registered).toHaveLength(1);
  });

  it('reports a silent hub as a fault', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const { registered } = await launch({ heartbeatTimeoutMinutes: 1 });
      const fault = () => characteristic(registered[0]!, Service.SecuritySystem, Characteristic.StatusFault);
      expect(fault()).toBe(0);
      vi.advanceTimersByTime(90_000);
      expect(fault()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AjaxSiaPlatform with a bad configuration', () => {
  it('logs every problem and registers nothing', () => {
    const { api, emit, registered } = createApi();
    const { log, messages } = createLog();
    new AjaxSiaPlatform(log, { platform: PLATFORM_NAME, name: 'Ajax', port: 0 } as PlatformConfig, api);
    emit('didFinishLaunching');

    expect(messages.error.some((line) => line.includes('accountId'))).toBe(true);
    expect(messages.error.some((line) => line.includes('port'))).toBe(true);
    expect(messages.error.some((line) => line.includes('disabled'))).toBe(true);
    expect(registered).toHaveLength(0);
  });
});

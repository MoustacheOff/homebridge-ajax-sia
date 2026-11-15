import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CloudError, type CloudDevice, type DeviceListener } from '../../src/cloud/ajax.js';
import type { Stream } from '../../src/cloud/grpc.js';
import { LiveDevices, type LiveHandlers } from '../../src/cloud/live.js';

const device = (name: string): CloudDevice => ({
  id: name, hubId: 'h', name, index: 1, online: true, bypassed: false, malfunction: false, tampered: false,
});

interface Attempt {
  listener: DeviceListener;
  closed: boolean;
}

let attempts: Attempt[];
let refuse: Error | undefined;
let events: string[];
let live: LiveDevices;

const handlers = (fatal: (error: Error) => boolean = () => false): LiveHandlers => ({
  devices: (devices) => events.push(`devices:${devices.map((entry) => entry.name).join(',')}`),
  up: () => events.push('up'),
  down: (error, retryInMs) => events.push(`down:${error ? error.message : 'closed'}:${retryInMs}`),
  fatal,
  retryFailed: (error) => events.push(`retryFailed:${error.message}`),
});

const make = (h: LiveHandlers = handlers()) => {
  live = new LiveDevices(
    async (listener) => {
      if (refuse) {
        throw refuse;
      }
      const attempt: Attempt = { listener, closed: false };
      attempts.push(attempt);
      return { close: () => void (attempt.closed = true) } satisfies Stream;
    },
    h,
    { minDelayMs: 1000, maxDelayMs: 4000, stableMs: 10_000 },
  );
  return live;
};

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  attempts = [];
  events = [];
  refuse = undefined;
});

afterEach(() => {
  live?.stop();
  vi.useRealTimers();
});

describe('LiveDevices', () => {
  it('opens the stream and passes the devices on, saying the link is up once', async () => {
    make().start();
    await flush();
    attempts[0]!.listener.devices([device('Salon')]);
    attempts[0]!.listener.devices([device('Salon'), device('Porte')]);
    expect(events).toEqual(['up', 'devices:Salon', 'devices:Salon,Porte']);
    expect(live.connected).toBe(true);
  });

  it('opens it again after a loss, and says so once', async () => {
    make().start();
    await flush();
    attempts[0]!.listener.devices([device('A')]);
    attempts[0]!.listener.end(new CloudError('unavailable', 'gone'));
    expect(live.connected).toBe(false);
    expect(events).toContain('down:gone:1000');
    expect(attempts[0]!.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toHaveLength(2);
    attempts[1]!.listener.devices([device('A')]);
    expect(events.filter((event) => event === 'up')).toHaveLength(2);
  });

  it('waits twice as long after each failure, up to a ceiling, without repeating the news', async () => {
    refuse = new Error('refused');
    make().start();
    await flush();
    expect(events).toEqual(['down:refused:1000']);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(events.filter((event) => event.startsWith('down'))).toHaveLength(1);
    expect(events.filter((event) => event.startsWith('retryFailed'))).toHaveLength(4);
  });

  it('starts the waits over once a link held long enough', async () => {
    make().start();
    await flush();
    attempts[0]!.listener.devices([device('A')]);
    await vi.advanceTimersByTimeAsync(11_000);
    attempts[0]!.listener.end(new CloudError('unavailable', 'x'));
    expect(events).toContain('down:x:1000');
    await vi.advanceTimersByTimeAsync(1000);
    attempts[1]!.listener.devices([device('A')]);
    attempts[1]!.listener.end(new CloudError('unavailable', 'y'));
    // This one held no time at all, so the wait grows.
    expect(events).toContain('down:y:2000');
  });

  it('retries when Ajax closes the stream normally', async () => {
    make().start();
    await flush();
    attempts[0]!.listener.devices([device('A')]);
    attempts[0]!.listener.end(undefined);
    expect(events).toContain('down:closed:1000');
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toHaveLength(2);
  });

  it('gives up on a failure that trying again cannot fix', async () => {
    refuse = new CloudError('client-rejected', 'retired');
    make(handlers((error) => error instanceof CloudError && error.reason === 'client-rejected')).start();
    await flush();
    expect(events).toEqual([`down:retired:${Infinity}`]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toHaveLength(0);
  });

  it('stops for good, closing the stream and ignoring what it still says', async () => {
    make().start();
    await flush();
    attempts[0]!.listener.devices([device('A')]);
    live.stop();
    expect(attempts[0]!.closed).toBe(true);
    attempts[0]!.listener.devices([device('B')]);
    attempts[0]!.listener.end(new CloudError('unavailable', 'late'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toEqual(['up', 'devices:A']);
    expect(attempts).toHaveLength(1);
    expect(live.connected).toBe(false);
  });

  it('ignores a second start()', async () => {
    make().start();
    live.start();
    await flush();
    expect(attempts).toHaveLength(1);
  });
});

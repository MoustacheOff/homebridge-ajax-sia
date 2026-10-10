import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';

import hap from '@homebridge/hap-nodejs';
import { vi } from 'vitest';
import type { API, Logging } from 'homebridge';

/** A real HAP implementation behind a minimal stand-in for the Homebridge API. */
export function createApi() {
  class FakeAccessory extends hap.Accessory {
    context: Record<string, unknown> = {};
  }

  const registered: FakeAccessory[] = [];
  const unregistered: FakeAccessory[] = [];

  const events = new EventEmitter();
  const api = Object.assign(events, {
    hap,
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => registered.push(...accessories),
    unregisterPlatformAccessories: (_plugin: string, _platform: string, accessories: FakeAccessory[]) => unregistered.push(...accessories),
    updatePlatformAccessories: vi.fn(),
  }) as unknown as API;

  const emit = (event: 'didFinishLaunching' | 'shutdown') => void events.emit(event);

  return { api, emit, registered, unregistered, FakeAccessory };
}

export function createLog() {
  const messages: Record<'debug' | 'info' | 'warn' | 'error', string[]> = { debug: [], info: [], warn: [], error: [] };
  const record = (level: keyof typeof messages) => (message: string) => void messages[level].push(message);
  const log = Object.assign(vi.fn(), {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    success: vi.fn(),
    log: vi.fn(),
  }) as unknown as Logging;
  return { log, messages };
}

/** A TCP port nobody is using right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

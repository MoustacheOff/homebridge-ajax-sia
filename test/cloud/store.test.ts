import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CloudStore } from '../../src/cloud/store.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ajax-store-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe('CloudStore', () => {
  it('creates a device id and keeps it', () => {
    const first = new CloudStore(directory);
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new CloudStore(directory).deviceId).toBe(first.deviceId);
  });

  it('remembers the session', () => {
    new CloudStore(directory).save({ token: 'abc', userId: 'u1' });
    expect(new CloudStore(directory).session).toEqual({ token: 'abc', userId: 'u1' });
  });

  it('forgets the session', () => {
    const store = new CloudStore(directory);
    store.save({ token: 'abc', userId: 'u1' });
    store.save(undefined);
    expect(new CloudStore(directory).session).toBeUndefined();
  });

  it('is readable by its owner only', () => {
    new CloudStore(directory).save({ token: 'abc', userId: 'u1' });
    expect(statSync(join(directory, 'homebridge-ajax-sia-cloud.json')).mode & 0o777).toBe(0o600);
  });

  it('starts over when the file is corrupted', () => {
    writeFileSync(join(directory, 'homebridge-ajax-sia-cloud.json'), '{nope');
    const store = new CloudStore(directory);
    expect(store.deviceId).toBeTruthy();
    expect(JSON.parse(readFileSync(join(directory, 'homebridge-ajax-sia-cloud.json'), 'utf8')).deviceId).toBe(store.deviceId);
  });

  it('survives an unwritable directory', () => {
    const store = new CloudStore(join(directory, 'missing', 'deeper'));
    expect(store.deviceId).toBeTruthy();
    expect(() => store.save({ token: 'a', userId: 'b' })).not.toThrow();
  });
});

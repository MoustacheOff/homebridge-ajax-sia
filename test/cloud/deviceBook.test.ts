import { describe, expect, it } from 'vitest';

import { DeviceBook } from '../../src/cloud/ajax.js';
import { Message } from '../../src/cloud/protobuf.js';
import {
  UPDATE, battery, deviceUpdate, flag, hubDevice, malfunctionsUpdate, removal, signal, snapshot, stateUpdate, statusUpdate, temperature,
  updatesMessage,
} from './deviceFixtures.js';

/** The `Success` of a response, which is where the book reads from. */
const success = (response: Buffer) => Message.decode(response).message(1)!;

function bookWith(...devices: Parameters<typeof snapshot>) {
  const book = new DeviceBook();
  book.load(success(snapshot(...devices)).message(1)!);
  return book;
}

const apply = (book: DeviceBook, ...updates: Parameters<typeof updatesMessage>) =>
  book.apply(success(updatesMessage(...updates)).message(2)!);

const only = (book: DeviceBook) => book.list()[0]!;

describe('DeviceBook updates', () => {
  it('follows a battery that drains and a temperature that moves', () => {
    const book = bookWith(hubDevice({ id: 'A1', statuses: [battery(1, 90), temperature(20)] }));
    expect(apply(book, statusUpdate('A1', battery(2, 14)), statusUpdate('A1', temperature(23)))).toBe(true);
    expect(only(book)).toMatchObject({ batteryPercent: 14, batteryLow: true, temperature: 23 });
  });

  it('raises the tamper flag when the lid opens and clears it when the status goes away', () => {
    const book = bookWith(hubDevice({ id: 'A1' }));
    apply(book, statusUpdate('A1', flag(82), UPDATE.add));
    expect(only(book).tampered).toBe(true);
    apply(book, statusUpdate('A1', flag(82), UPDATE.remove));
    expect(only(book).tampered).toBe(false);
  });

  it('keeps the other statuses when one goes away', () => {
    const book = bookWith(hubDevice({ id: 'A1', statuses: [battery(1, 55), signal(4), flag(82)] }));
    apply(book, statusUpdate('A1', flag(82), UPDATE.remove));
    expect(only(book)).toMatchObject({ tampered: false, batteryPercent: 55, signal: 'strong' });
  });

  it('marks a device offline and back online', () => {
    const book = bookWith(hubDevice({ id: 'A1' }));
    apply(book, stateUpdate('A1', 9, UPDATE.add));
    expect(only(book).online).toBe(false);
    apply(book, stateUpdate('A1', 9, UPDATE.remove));
    expect(only(book).online).toBe(true);
  });

  it('follows the malfunctions of the device', () => {
    const book = bookWith(hubDevice({ id: 'A1' }));
    apply(book, malfunctionsUpdate('A1', 2));
    expect(only(book).malfunction).toBe(true);
    apply(book, malfunctionsUpdate('A1', 0));
    expect(only(book).malfunction).toBe(false);
  });

  it('keeps a malfunction status apart from the count', () => {
    const book = bookWith(hubDevice({ id: 'A1', statuses: [flag(50)] }));
    apply(book, malfunctionsUpdate('A1', 0));
    expect(only(book).malfunction).toBe(true);
  });

  it('replaces a device when the stream sends it again, and drops it when it is removed', () => {
    const book = bookWith(hubDevice({ id: 'A1', name: 'Salon', index: 3 }));
    apply(book, deviceUpdate('A1', hubDevice({ id: 'A1', name: 'Séjour', index: 3 })));
    expect(book.list().map((device) => device.name)).toEqual(['Séjour']);
    expect(apply(book, removal('A1'))).toBe(true);
    expect(book.list()).toEqual([]);
  });

  it('adds a device that appears', () => {
    const book = bookWith(hubDevice({ id: 'A1' }));
    apply(book, deviceUpdate('B2', hubDevice({ id: 'B2', name: 'New' }), UPDATE.add));
    expect(book.list().map((device) => device.name)).toContain('New');
  });

  it('ignores an update for a device it does not know, or for another hub', () => {
    const book = bookWith(hubDevice({ id: 'A1', statuses: [battery(1, 80)] }));
    expect(apply(book, statusUpdate('ZZ', battery(3, 1)))).toBe(false);
    expect(apply(book, statusUpdate('A1', battery(3, 1), UPDATE.update, 'hub-2'))).toBe(false);
    expect(only(book).batteryPercent).toBe(80);
  });

  it('starts again from a new snapshot', () => {
    const book = bookWith(hubDevice({ id: 'A1' }), hubDevice({ id: 'B2' }));
    book.load(success(snapshot(hubDevice({ id: 'C3', name: 'Only' }))).message(1)!);
    expect(book.list().map((device) => device.name)).toEqual(['Only']);
  });
});

import { describe, expect, it } from 'vitest';

import { SiaReceiver } from '../src/sia/receiver.js';
import { buildFrame, parseFrame } from '../src/sia/frame.js';
import { ACCOUNT, KEY, hubMessage, unframe } from './helpers.js';

const NOW = new Date(Date.UTC(2026, 9, 10, 14, 0, 0));
const plain = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 60 });
const secure = new SiaReceiver({ account: ACCOUNT, key: KEY, maxTimeSkewSeconds: 60 });

const verdict = (reply: string | null): string | undefined => /^\n[0-9A-F]{8}"\*?([A-Z]{3})"/.exec(reply ?? '')?.[1];

describe('SiaReceiver (plain)', () => {
  it('accepts an event and acknowledges it', () => {
    const { reply, message, problem } = plain.receive(unframe(hubMessage({ sequence: '0042', data: 'Nri1/CL501' })), NOW);
    expect(problem).toBeUndefined();
    expect(message?.events).toEqual([{ code: 'CL', zone: 501, area: 1 }]);

    // The ACK echoes sequence, receiver, line and account, and is itself a valid message.
    const ack = parseFrame(unframe(reply!));
    expect(ack).toMatchObject({ id: 'ACK', sequence: '0042', receiver: 'R0001', line: 'L0001', account: ACCOUNT });
  });

  it('acknowledges a link test without producing events', () => {
    const { reply, message } = plain.receive(unframe(hubMessage({ id: 'NULL' })), NOW);
    expect(verdict(reply)).toBe('ACK');
    expect(message?.events).toEqual([]);
  });

  it('answers NAK to a corrupted message', () => {
    const corrupted = unframe(hubMessage({ data: 'Nri1/CL501' })).replace('CL501', 'OP501');
    const { reply, message, problem } = plain.receive(corrupted, NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(message).toBeUndefined();
    expect(problem).toMatch(/CRC/);
  });

  it('stays silent on traffic that is not DC-09', () => {
    expect(plain.receive('GET / HTTP/1.1', NOW)).toMatchObject({ reply: null });
  });

  it('refuses another account', () => {
    const { reply, problem } = plain.receive(unframe(hubMessage({ account: 'FFFF', data: 'Nri1/CL501' })), NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(problem).toMatch(/Unknown account FFFF/);
  });

  it('answers DUH to a protocol it does not speak', () => {
    const { reply, problem } = plain.receive(unframe(hubMessage({ id: 'ADM-CID', data: '1 401 01 001' })), NOW);
    expect(verdict(reply)).toBe('DUH');
    expect(problem).toMatch(/ADM-CID/);
  });

  it('answers DUH to a data block it cannot read', () => {
    const { reply } = plain.receive(unframe(buildFrame(`"SIA-DCS"0001R0001L0001#${ACCOUNT}[|Nri1/??]`)), NOW);
    expect(verdict(reply)).toBe('DUH');
  });

  it('refuses encrypted traffic when no key is configured', () => {
    const { reply, problem } = plain.receive(unframe(hubMessage({ data: 'Nri1/CL501', key: KEY })), NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(problem).toMatch(/no encryptionKey/);
  });

  describe('timestamps', () => {
    const at = (offsetSeconds: number) => new Date(NOW.getTime() + offsetSeconds * 1000);

    it('accepts a message within the limit', () => {
      const { message } = plain.receive(unframe(hubMessage({ data: 'Nri1/CL501', at: at(-30) })), NOW);
      expect(message?.timestamp).toEqual(at(-30));
    });

    it.each([-120, 120])('refuses a message %is away', (offset) => {
      const { reply, message, problem } = plain.receive(unframe(hubMessage({ data: 'Nri1/CL501', at: at(offset) })), NOW);
      expect(verdict(reply)).toBe('NAK');
      expect(message).toBeUndefined();
      expect(problem).toMatch(/clock/);
    });

    it('can be switched off', () => {
      const lax = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
      expect(lax.receive(unframe(hubMessage({ data: 'Nri1/CL501', at: at(-86400) })), NOW).message).toBeDefined();
    });
  });
});

describe('SiaReceiver (encrypted)', () => {
  it('decrypts the event and sends an encrypted acknowledgement', () => {
    const { reply, message } = secure.receive(unframe(hubMessage({ sequence: '0007', data: 'Nri1/NL4', key: KEY, at: NOW })), NOW);
    expect(message?.events).toEqual([{ code: 'NL', zone: 4, area: 1 }]);

    const ack = parseFrame(unframe(reply!));
    expect(ack).toMatchObject({ id: 'ACK', encrypted: true, sequence: '0007' });
    expect(ack.body).toMatch(/^[0-9A-F]{32,}$/);
  });

  it('refuses unencrypted traffic: it could be forged without the key', () => {
    const { reply, message, problem } = secure.receive(unframe(hubMessage({ data: 'Nri1/OP001' })), NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(message).toBeUndefined();
    expect(problem).toMatch(/Unencrypted/);
  });

  it('refuses a message encrypted with another key', () => {
    const other = Buffer.from('fedcba9876543210', 'latin1');
    const { reply, problem } = secure.receive(unframe(hubMessage({ data: 'Nri1/OP001', key: other, at: NOW })), NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(problem).toMatch(/wrong key/);
  });

  it('checks the timestamp hidden inside the ciphertext', () => {
    const stale = new Date(NOW.getTime() - 3600_000);
    const { reply, problem } = secure.receive(unframe(hubMessage({ data: 'Nri1/OP001', key: KEY, at: stale })), NOW);
    expect(verdict(reply)).toBe('NAK');
    expect(problem).toMatch(/clock/);
  });

  it('acknowledges an encrypted link test', () => {
    const { reply, message } = secure.receive(unframe(hubMessage({ id: 'NULL', key: KEY, at: NOW })), NOW);
    expect(verdict(reply)).toBe('ACK');
    expect(message?.events).toEqual([]);
  });
});

describe('SiaReceiver repeats', () => {
  const frame = (sequence: string, data = 'Nri1/BA001') => unframe(hubMessage({ sequence, data, at: NOW }));
  const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

  it('acknowledges a message the hub sends again but flags it as a repeat', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    const first = receiver.receive(frame('0042'), NOW);
    const again = receiver.receive(frame('0042'), later(10));

    expect(first.message?.repeat).toBeUndefined();
    expect(verdict(again.reply)).toBe('ACK');
    expect(again.message).toMatchObject({ sequence: '0042', repeat: true });
    expect(again.message?.events).toEqual(first.message?.events);
  });

  it('recognises a repeat of an encrypted message', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, key: KEY, maxTimeSkewSeconds: 0 });
    const sent = unframe(hubMessage({ sequence: '0042', data: 'Nri1/BA001', key: KEY, at: NOW }));
    expect(receiver.receive(sent, NOW).message?.repeat).toBeUndefined();
    expect(receiver.receive(sent, later(5)).message?.repeat).toBe(true);
  });

  it('treats a different sequence number or different content as new', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    receiver.receive(frame('0042'), NOW);
    expect(receiver.receive(frame('0043'), later(1)).message?.repeat).toBeUndefined();
    expect(receiver.receive(frame('0042', 'Nri1/BR001'), later(2)).message?.repeat).toBeUndefined();
  });

  it('forgets a message after two minutes', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    receiver.receive(frame('0042'), NOW);
    expect(receiver.receive(frame('0042'), later(121)).message?.repeat).toBeUndefined();
  });

  it('never flags a link test', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    const test = unframe(hubMessage({ id: 'NULL', sequence: '0042' }));
    receiver.receive(test, NOW);
    expect(receiver.receive(test, later(1)).message?.repeat).toBeUndefined();
  });

  it('does not remember a message it refused', () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 60 });
    const stale = unframe(hubMessage({ sequence: '0042', data: 'Nri1/BA001', at: later(-3600) }));
    expect(receiver.receive(stale, NOW).problem).toMatch(/clock/);
    expect(receiver.receive(stale, later(1)).problem).toMatch(/clock/);
  });
});

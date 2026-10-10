import { createDecipheriv } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FrameError, buildFrame, crc16, decryptBody, encryptBody, formatTimestamp, parseFrame, parseTimestamp } from '../src/sia/frame.js';
import { ACCOUNT, KEY, hubMessage, unframe } from './helpers.js';

describe('crc16', () => {
  // Reference values computed with pysiaalarm, which is known to interoperate with Ajax hubs.
  it.each([
    ['"SIA-DCS"0000L0#3080[#3080|Nti19:44/id1/ri4/RP]', 'F9FF'],
    ['"SIA-DCS"6002L0#AAA[|Nri1/CL501]_14:12:04,09-25-2019', 'E5D5'],
    ['"ACK"0084L0#AAA[]', 'DD91'],
    ['"NAK"0000R0L0A0[]_08:38:13,01-07-2021', 'D369'],
  ])('%s', (input, expected) => {
    expect(crc16(input).toString(16).toUpperCase().padStart(4, '0')).toBe(expected);
  });
});

describe('parseFrame', () => {
  it('reads a plain event message', () => {
    const frame = parseFrame(unframe(hubMessage({ data: 'Nri1/CL501' })));
    expect(frame).toMatchObject({
      id: 'SIA-DCS',
      encrypted: false,
      sequence: '0001',
      receiver: 'R0001',
      line: 'L0001',
      account: ACCOUNT,
      body: '|Nri1/CL501]',
    });
  });

  it('flags encrypted messages', () => {
    expect(parseFrame(unframe(hubMessage({ data: 'Nri1/CL501', key: KEY }))).encrypted).toBe(true);
  });

  it('accepts a message without receiver or account', () => {
    const frame = parseFrame(unframe(buildFrame('"NULL"0000L0[]')));
    expect(frame).toMatchObject({ id: 'NULL', receiver: '', account: '' });
  });

  it('rejects a corrupted message', () => {
    const text = unframe(hubMessage({ data: 'Nri1/CL501' })).replace('CL501', 'OP501');
    expect(() => parseFrame(text)).toThrow(expect.objectContaining({ reason: 'crc' }));
  });

  it('rejects garbage', () => {
    expect(() => parseFrame('hello')).toThrow(FrameError);
  });
});

describe('encryption', () => {
  it('encrypts a reply the hub can read back', () => {
    const hex = encryptBody(']_14:12:04,09-25-2019', KEY);
    expect(hex).toMatch(/^[0-9A-F]+$/);
    expect(hex.length % 32).toBe(0);

    const decipher = createDecipheriv('aes-128-cbc', KEY, Buffer.alloc(16));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('latin1');
    expect(plain).toMatch(/^0+\]_14:12:04,09-25-2019$/);
  });

  it('decrypts a hub message and drops the padding', () => {
    const frame = parseFrame(unframe(hubMessage({ data: 'Nri1/NL4', key: KEY })));
    expect(decryptBody(frame.body, KEY)).toBe(`#${ACCOUNT}|Nri1/NL4]`);
  });

  it.each([16, 24, 32])('supports a %i byte key', (size) => {
    const key = Buffer.alloc(size, 'k');
    const frame = parseFrame(unframe(hubMessage({ data: 'Nri1/CL501', key })));
    expect(decryptBody(frame.body, key)).toContain('Nri1/CL501');
  });

  it('fails cleanly with the wrong key', () => {
    const frame = parseFrame(unframe(hubMessage({ data: 'Nri1/CL501', key: KEY })));
    expect(() => decryptBody(frame.body, Buffer.alloc(16, 'z'))).toThrow(FrameError);
  });

  it('rejects ciphertext that is not whole blocks', () => {
    expect(() => decryptBody('ABCD', KEY)).toThrow(/Malformed/);
  });
});

describe('timestamps', () => {
  it('round-trips', () => {
    const date = new Date(Date.UTC(2026, 9, 10, 14, 12, 4));
    expect(formatTimestamp(date)).toBe('_14:12:04,10-10-2026');
    expect(parseTimestamp('14:12:04,10-10-2026')).toEqual(date);
  });

  it('refuses nonsense', () => {
    expect(parseTimestamp('nope')).toBeUndefined();
  });
});

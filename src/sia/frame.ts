import { createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Wire format of SIA DC-09 (ANSI/SIA DC-09-2012) messages, as used by the Ajax hubs.
 *
 *   <LF> CRC(4h) LEN(4h) "ID" SEQ(4d) [Rrcvr] Lline [#acct] [ data ... ] [_timestamp] <CR>
 *
 * The CRC is a CRC-16/ARC over everything between the length field and the trailing <CR>.
 * Encrypted messages use the `*ID` form and carry the data block as AES-CBC (zero IV) hex.
 */

export class FrameError extends Error {
  constructor(message: string, readonly reason: 'format' | 'crc' | 'crypto') {
    super(message);
    this.name = 'FrameError';
  }
}

export interface Frame {
  /** Message identifier: `SIA-DCS`, `NULL`, ... */
  id: string;
  encrypted: boolean;
  sequence: string;
  /** Receiver tag as sent (`R0001`), empty when absent. Echoed back in the reply. */
  receiver: string;
  /** Line tag as sent (`L0001`). Echoed back in the reply. */
  line: string;
  /** Account from the header, upper-cased, empty when absent. */
  account: string;
  /** Everything after the opening bracket: plain data block, or hex ciphertext. */
  body: string;
}

const FRAME_PATTERN = /^([0-9A-F]{4})([0-9A-F]{4})"(\*?)([A-Z-]{3,7})"(\d{4})(R[0-9A-F]{1,6})?(L[0-9A-F]{1,6})(?:#([0-9A-F]{3,16}))?\[([\s\S]*)$/i;

const ZERO_IV = Buffer.alloc(16);

export function crc16(input: string): number {
  let crc = 0;
  for (const byte of Buffer.from(input, 'latin1')) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc;
}

const hex4 = (value: number): string => value.toString(16).toUpperCase().padStart(4, '0');

/** Parse one message, already stripped of its leading <LF> and trailing <CR>. */
export function parseFrame(text: string): Frame {
  const match = FRAME_PATTERN.exec(text);
  if (!match) {
    throw new FrameError('Not a SIA DC-09 message', 'format');
  }
  const [, crc, , star, id, sequence, receiver, line, account, body] = match as unknown as string[];

  const expected = hex4(crc16(text.slice(8)));
  if (expected !== crc!.toUpperCase()) {
    throw new FrameError(`CRC mismatch (got ${crc}, expected ${expected})`, 'crc');
  }

  return {
    id: id!.toUpperCase(),
    encrypted: star === '*',
    sequence: sequence!,
    receiver: receiver ?? '',
    line: line!,
    account: (account ?? '').toUpperCase(),
    body: body!,
  };
}

/** Wrap a CRC-protected region into a transmittable message. */
export function buildFrame(region: string): string {
  return `\n${hex4(crc16(region))}${hex4(region.length)}${region}\r`;
}

function cipherName(key: Buffer): string {
  switch (key.length) {
    case 16: return 'aes-128-cbc';
    case 24: return 'aes-192-cbc';
    case 32: return 'aes-256-cbc';
    default: throw new FrameError(`Unsupported AES key length: ${key.length} bytes`, 'crypto');
  }
}

/**
 * Decrypt the data block of an encrypted message. The plaintext is
 * `<random padding>|<data block>`; the padding is dropped.
 */
export function decryptBody(hex: string, key: Buffer): string {
  if (!/^(?:[0-9A-F]{32})+$/i.test(hex)) {
    throw new FrameError('Malformed ciphertext', 'crypto');
  }
  const decipher = createDecipheriv(cipherName(key), key, ZERO_IV);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('latin1');
  const separator = plain.indexOf('|');
  if (separator < 0) {
    throw new FrameError('Decryption failed (wrong key?)', 'crypto');
  }
  return plain.slice(separator + 1).replace(/\0+$/, '');
}

/** Encrypt a reply payload. Left-padded with zeros up to the AES block size, as hubs expect. */
export function encryptBody(plain: string, key: Buffer): string {
  const padded = plain.padStart(plain.length + 16 - (plain.length % 16), '0');
  const cipher = createCipheriv(cipherName(key), key, ZERO_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded, 'latin1'), cipher.final()]).toString('hex').toUpperCase();
}

/** `_HH:MM:SS,MM-DD-YYYY` in UTC, the timestamp format of DC-09. */
export function formatTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `_${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())},`
    + `${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}-${date.getUTCFullYear()}`;
}

export function parseTimestamp(text: string): Date | undefined {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (!m) {
    return undefined;
  }
  const [, hh, mm, ss, month, day, year] = m.map(Number) as [number, number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

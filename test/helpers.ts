import { createCipheriv } from 'node:crypto';

import { buildFrame, formatTimestamp } from '../src/sia/frame.js';

export const ACCOUNT = 'AB12';
export const KEY = Buffer.from('0123456789abcdef', 'latin1');

interface HubMessage {
  id?: string;
  sequence?: string;
  account?: string;
  /** Data block without brackets, e.g. `Nri1/CL501`. Empty for a link test. */
  data?: string;
  key?: Buffer;
  at?: Date;
}

/**
 * Builds a message the way a hub does. Written independently of the production
 * encryption helpers so the two are checked against each other.
 */
export function hubMessage({ id = 'SIA-DCS', sequence = '0001', account = ACCOUNT, data = '', key, at }: HubMessage = {}): string {
  const header = `${key ? '*' : ''}${id}"${sequence}R0001L0001#${account}[`;
  const timestamp = at ? formatTimestamp(at) : '';
  const block = data ? `#${account}|${data}]` : ']';

  if (!key) {
    return buildFrame(`"${header}${data ? `|${data}` : ''}]${timestamp}`);
  }

  const plain = `|${block}${timestamp}`;
  const padded = plain.padStart(Math.ceil((plain.length + 1) / 16) * 16, 'x');
  const cipher = createCipheriv(`aes-${key.length * 8}-cbc`, key, Buffer.alloc(16));
  cipher.setAutoPadding(false);
  const hex = Buffer.concat([cipher.update(padded, 'latin1'), cipher.final()]).toString('hex').toUpperCase();
  return buildFrame(`"${header}${hex}`);
}

/** Strips the <LF> / <CR> framing, as the transport does before handing a message over. */
export const unframe = (frame: string): string => frame.replace(/^\n/, '').replace(/\r$/, '');

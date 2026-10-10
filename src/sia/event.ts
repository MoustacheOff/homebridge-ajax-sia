import { parseTimestamp } from './frame.js';

/** A single SIA event: a two-letter code, optionally qualified by a zone, an area and a user. */
export interface SiaEvent {
  /** Two-letter SIA event code, upper-case (`CL`, `BA`, `TA`, ...). */
  code: string;
  /** Zone / device number that follows the code (`BA012` -> 12). */
  zone?: number;
  /** Area (partition / group) from the `ri` field. */
  area?: number;
  /** User from the `id` field. */
  user?: number;
  /** Free text after a `*`, when the hub sends one. */
  text?: string;
}

export interface DataBlock {
  account?: string;
  events: SiaEvent[];
  /** Timestamp carried inside the message, when present. */
  timestamp?: Date;
}

/**
 * Parses the part of a message that follows the opening bracket of a plain message,
 * or the decrypted plaintext of an encrypted one:
 *
 *   `#ACCT|Nri1/CL501][extended]_14:12:04,09-25-2019`
 *
 * The account and extended data are optional. An empty block (`]`) is a link test.
 */
export function parseDataBlock(block: string): DataBlock {
  const end = block.indexOf(']');
  if (end < 0) {
    throw new Error('Unterminated data block');
  }
  let head = block.slice(0, end);
  const tail = block.slice(end + 1);

  const result: DataBlock = { events: [] };

  const account = /^#([0-9A-F]{3,16})/i.exec(head);
  if (account) {
    result.account = account[1]!.toUpperCase();
    head = head.slice(account[0].length);
  }
  head = head.replace(/^\|/, '');

  const timestamp = /_(\d{2}:\d{2}:\d{2},\d{2}-\d{2}-\d{4})$/.exec(tail);
  if (timestamp) {
    result.timestamp = parseTimestamp(timestamp[1]!);
  }

  if (head.length === 0) {
    return result;
  }
  if (!head.startsWith('N')) {
    throw new Error(`Unsupported data block: ${head}`);
  }

  result.events = parseEvents(head.slice(1));
  return result;
}

const FIELD = /^(ti|id|pi|ri)(.*)$/;
const EVENT = /^([A-Z]{2})(\d*)(?:\*(.*))?$/;

function parseEvents(fields: string): SiaEvent[] {
  let area: number | undefined;
  let user: number | undefined;
  const events: SiaEvent[] = [];

  for (const token of fields.split('/')) {
    const field = FIELD.exec(token);
    if (field) {
      const value = /^\d+$/.test(field[2]!) ? Number(field[2]) : undefined;
      if (field[1] === 'ri') {
        area = value;
      } else if (field[1] === 'id') {
        user = value;
      }
      continue;
    }
    const event = EVENT.exec(token);
    if (!event) {
      throw new Error(`Unrecognised event token: ${token}`);
    }
    events.push({
      code: event[1]!,
      ...(event[2] ? { zone: Number(event[2]) } : {}),
      ...(area !== undefined ? { area } : {}),
      ...(user !== undefined ? { user } : {}),
      ...(event[3] ? { text: event[3] } : {}),
    });
  }
  return events;
}

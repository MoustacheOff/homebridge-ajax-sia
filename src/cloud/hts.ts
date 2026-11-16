import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

/**
 * Reads the firmware a hub is running from the second connection the Ajax mobile apps keep open to the hub
 * through Ajax's servers ("HTS"). The gRPC calls the rest of this plugin makes do not carry that value.
 *
 * Like the rest of the cloud client this speaks the protocol of the Ajax mobile apps; it is not an official API.
 * It only reads: one short connection, a request for the hub's status, then hang up.
 */

const HOST = 'hts.prod.ajax.systems';
const PORT = 443;

// The frames carry one AES-128-CBC block stream with a key and an IV that are the same for every client.
// They protect nothing; they are part of the format.
const KEY = Buffer.from('We@zEd;80Z1@pc2Y', 'latin1');
const IV = Buffer.from('V:e<*tMv6qVU#WRC', 'latin1');

const STX = 0x02;
const ETX = 0x03;
const ESC = 0x04;

/** What each byte that must not appear in a frame is sent as. */
const ESCAPES = new Map<number, number>([[STX, 0x32], [ETX, 0x33], [ESC, 0x34]]);
const UNESCAPES = new Map<number, number>([[0x32, STX], [0x33, ETX], [0x34, ESC]]);

export class HtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HtsError';
  }
}

/** CRC-16 of a frame body: polynomial 0x1021, most significant bit first, starting from 0xA001. */
export function crc16(data: Buffer): number {
  let crc = 0xa001;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** `STX`, the body and its CRC with the three reserved bytes escaped, then `ETX`. */
export function encodeFrame(body: Buffer): Buffer {
  const checksum = Buffer.alloc(2);
  checksum.writeUInt16BE(crc16(body));
  const bytes: number[] = [STX];
  for (const byte of Buffer.concat([body, checksum])) {
    const escaped = ESCAPES.get(byte);
    if (escaped === undefined) {
      bytes.push(byte);
    } else {
      bytes.push(ESC, escaped);
    }
  }
  bytes.push(ETX);
  return Buffer.from(bytes);
}

/** The body of a frame, once its framing and CRC are checked. */
export function decodeFrame(frame: Buffer): Buffer {
  if (frame.length < 4 || frame[0] !== STX || frame[frame.length - 1] !== ETX) {
    throw new HtsError('Not a frame');
  }
  const bytes: number[] = [];
  for (let i = 1; i < frame.length - 1; i++) {
    if (frame[i] !== ESC) {
      bytes.push(frame[i]!);
      continue;
    }
    const restored = UNESCAPES.get(frame[++i] ?? -1);
    if (restored === undefined) {
      throw new HtsError('Invalid escape sequence');
    }
    bytes.push(restored);
  }
  const payload = Buffer.from(bytes);
  if (payload.length < 3) {
    throw new HtsError('Frame too short');
  }
  const body = payload.subarray(0, -2);
  if (payload.readUInt16BE(payload.length - 2) !== crc16(body)) {
    throw new HtsError('CRC mismatch');
  }
  return body;
}

/** Fills the last block with random bytes, none below 10, then encrypts. */
export function encrypt(plain: Buffer): Buffer {
  const missing = (16 - (plain.length % 16)) % 16;
  const filler = randomBytes(missing).map((byte) => Math.max(byte, 10));
  const cipher = createCipheriv('aes-128-cbc', KEY, IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([plain, filler])), cipher.final()]);
}

export function decrypt(data: Buffer): Buffer {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new HtsError('Not a whole number of cipher blocks');
  }
  const decipher = createDecipheriv('aes-128-cbc', KEY, IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

const DELIMITER = 0x05;
const ESCAPE = 0x06;

/** Parameters, each introduced by a delimiter and the whole closed by one; the two special bytes are escaped. */
export function encodeParams(params: Buffer[]): Buffer {
  if (params.length === 0) {
    return Buffer.alloc(0);
  }
  const bytes: number[] = [];
  for (const param of params) {
    bytes.push(DELIMITER);
    for (const byte of param) {
      if (byte === DELIMITER) {
        bytes.push(ESCAPE, 0x35);
      } else if (byte === ESCAPE) {
        bytes.push(ESCAPE, 0x36);
      } else {
        bytes.push(byte);
      }
    }
  }
  bytes.push(DELIMITER);
  return Buffer.from(bytes);
}

/**
 * The parameters of a payload. Empty ones are left out, and so is whatever follows the last delimiter: that is
 * the filler that completes the last cipher block.
 */
export function decodeParams(payload: Buffer): Buffer[] {
  const params: Buffer[] = [];
  let current: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i]!;
    if (byte === DELIMITER) {
      if (current.length > 0) {
        params.push(Buffer.from(current));
      }
      current = [];
    } else if (byte === ESCAPE && i + 1 < payload.length) {
      const next = payload[++i]!;
      // An escape this client does not know is kept as it came rather than refused.
      current.push(...(next === 0x35 ? [DELIMITER] : next === 0x36 ? [ESCAPE] : [ESCAPE, next]));
    } else {
      current.push(byte);
    }
  }
  return params;
}

export interface HtsMessage {
  sender: number;
  receiver: number;
  seq: number;
  link: number;
  flags: number;
  type: number;
  payload: Buffer;
}

const HEADER = 14;
/** The sender asks for no acknowledgement. */
const FLAG_NO_ACK = 0x20;

export const TYPE = { userRegistration: 0x11, authentication: 0x15, ack: 0x16, updates: 0x19 } as const;

export function encodeMessage(message: HtsMessage): Buffer {
  const header = Buffer.alloc(HEADER);
  header.writeUInt32BE(message.sender >>> 0, 0);
  header.writeUInt32BE(message.receiver >>> 0, 4);
  header.writeUIntBE(message.seq & 0xffffff, 8, 3);
  header.writeUInt8(message.link & 0xff, 11);
  header.writeUInt8(message.flags & 0xff, 12);
  header.writeUInt8(message.type & 0xff, 13);
  return Buffer.concat([header, message.payload]);
}

export function decodeMessage(data: Buffer): HtsMessage {
  if (data.length < HEADER) {
    throw new HtsError('Message too short');
  }
  return {
    sender: data.readUInt32BE(0),
    receiver: data.readUInt32BE(4),
    seq: data.readUIntBE(8, 3),
    link: data.readUInt8(11),
    flags: data.readUInt8(12),
    type: data.readUInt8(13),
    payload: data.subarray(HEADER),
  };
}

/** The message as it travels: header and payload, encrypted, framed. */
const seal = (message: HtsMessage): Buffer => encodeFrame(encrypt(encodeMessage(message)));

/** Answer to the challenge of the handshake: two bytes computed from the two the server sent. */
export function solveChallenge(a: number, b: number): Buffer {
  return Buffer.from([(a ^ b) & 0xff, ((b & a) << 2) & 0xff]);
}

/**
 * The firmware version of a hub is four bytes, a big-endian integer whose decimal digits are the version:
 * 243121 is 2.43.121. Anything that cannot be a version is refused rather than guessed.
 */
export function decodeFirmware(value: Buffer): string | undefined {
  if (value.length !== 4) {
    return undefined;
  }
  const packed = value.readUInt32BE();
  if (packed < 100_000 || packed >= 10_000_000) {
    return undefined;
  }
  const major = Math.floor(packed / 100_000);
  const minor = Math.floor((packed % 100_000) / 1000);
  return `${major}.${minor}.${packed % 1000}`;
}

/** Key of the firmware version in the rows a hub reports. */
const KEY_FIRMWARE = 0x37;

/**
 * Splits the parameters of a status or settings report into rows: a four-byte id, then pairs of a one-byte key and
 * its value, until the next id. The first row is the hub's own.
 */
export function parseRows(params: Buffer[]): Map<string, Map<number, Buffer>> {
  const rows = new Map<string, Map<number, Buffer>>();
  let row: Map<number, Buffer> | undefined;
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (param.length === 4) {
      row = new Map();
      rows.set(param.toString('hex').toUpperCase(), row);
    } else if (row && param.length === 1 && i + 1 < params.length) {
      row.set(param[0]!, params[++i]!);
    } else if (row) {
      i++;
    }
  }
  return rows;
}

/** The kinds of report the hub sends back to a request: its settings, then its status. */
const SETTINGS_REQUEST = 3;
const STATUS_REQUEST = 7;
const REPORTS = new Set([5, 9]);

export interface HtsOptions {
  /** The session token of the Ajax login, as the gRPC client stores it. */
  token: string;
  /** The user id of the Ajax login, in hexadecimal. */
  userId: string;
  deviceId: string;
  clientVersion: string;
  deviceModel: string;
  deviceOs: string;
  /** A host name; `tcp://host:port` opens a plain connection and is only meant for tests. */
  host?: string;
  port?: number;
  /** For the whole exchange. */
  timeoutMs?: number;
  /** Replaces the TLS connection; for tests. */
  open?: () => Duplex;
}

const APP_LABEL = 'Ajax';

function open(host: string, port: number): Duplex {
  if (host.startsWith('tcp://')) {
    const url = new URL(host);
    return tcpConnect({ host: url.hostname, port: Number(url.port) });
  }
  return tlsConnect({ host, port, servername: host });
}

/** One connection: frames out, messages in. */
class Link {
  private inbox: HtsMessage[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private ended?: Error;
  private wake?: () => void;
  private seq = 1;

  constructor(private readonly socket: Duplex, readonly sender: number) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('error', (error) => this.end(error));
    socket.on('close', () => this.end(new HtsError('Connection closed')));
  }

  nextSeq(): number {
    const current = this.seq;
    this.seq = (this.seq + 1) & 0xffffff;
    return current;
  }

  adopt(seq: number): void {
    this.seq = seq & 0xffffff;
  }

  send(partial: Omit<HtsMessage, 'sender' | 'seq' | 'flags'> & { receiver: number }): void {
    this.socket.write(seal({ sender: this.sender, seq: this.nextSeq(), flags: 0, ...partial }));
  }

  ack(original: HtsMessage): void {
    const seq = Buffer.alloc(3);
    seq.writeUIntBE(original.seq, 0, 3);
    this.send({
      receiver: 0,
      link: original.link,
      type: TYPE.ack,
      payload: encodeParams([Buffer.from([0]), seq]),
    });
  }

  /** The next message, skipping acknowledgements when asked to. */
  async receive(deadline: number, skipAcks = false): Promise<HtsMessage> {
    for (;;) {
      const message = this.inbox.shift();
      if (message) {
        if (skipAcks && message.type === TYPE.ack) {
          continue;
        }
        return message;
      }
      if (this.ended) {
        throw this.ended;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HtsError('Timed out waiting for the hub');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Says goodbye, so that the last acknowledgement gets out, and drops the connection if the server does not. */
  close(): void {
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const start = this.buffer.indexOf(STX);
      const stop = start < 0 ? -1 : this.buffer.indexOf(ETX, start + 1);
      if (stop < 0) {
        // Nothing before the first STX belongs to a frame.
        this.buffer = start < 0 ? Buffer.alloc(0) : this.buffer.subarray(start);
        break;
      }
      const frame = this.buffer.subarray(start, stop + 1);
      this.buffer = this.buffer.subarray(stop + 1);
      try {
        this.inbox.push(decodeMessage(decrypt(decodeFrame(frame))));
      } catch {
        // One frame that does not decode does not spoil the next ones: each is encrypted on its own.
      }
    }
    this.wake?.();
  }

  private end(error: Error): void {
    this.ended ??= error;
    this.wake?.();
  }
}

/** Parameters of the request that names this client; same keys as the Ajax app sends. */
function connectRequest(options: HtsOptions): Buffer {
  const text = (value: string) => Buffer.from(value, 'utf8');
  return encodeParams([
    Buffer.from([0x3f]),
    Buffer.from([2]), Buffer.from(options.token, 'hex'),
    Buffer.from([5]), Buffer.from([0]),
    Buffer.from([7]), text(`${options.deviceId}_${APP_LABEL}`),
    Buffer.from([8]), text(APP_LABEL),
    Buffer.from([9]), Buffer.from([0]),
    Buffer.from([10]), text(options.clientVersion),
    Buffer.from([11]), Buffer.from([5]),
    Buffer.from([12]), text(options.deviceOs),
    Buffer.from([13]), text(options.deviceModel),
  ]);
}

interface Hub {
  id: string;
  master: boolean;
}

/** The answer to the connect request: the marker, a token, then each hub as its id and a flag. */
function parseConnected(payload: Buffer): Hub[] {
  const params = decodeParams(payload);
  if (params.length < 2 || params[0]!.length !== 1 || params[0]![0] !== 0x0f) {
    throw new HtsError('Unexpected answer to the connect request');
  }
  const hubs: Hub[] = [];
  for (let i = 2; i + 1 < params.length && params[i]!.length === 4 && params[i + 1]!.length === 1; i += 2) {
    hubs.push({ id: params[i]!.toString('hex').toUpperCase(), master: params[i + 1]![0] !== 0 });
  }
  return hubs;
}

/**
 * Asks the hubs of the account for their status and reads the firmware each one runs.
 * Resolves with the version by hub id (eight hexadecimal digits, upper case); a hub that did not say is left out.
 */
export async function readHubFirmware(options: HtsOptions): Promise<Map<string, string>> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const socket = options.open?.() ?? open(options.host ?? HOST, options.port ?? PORT);
  const sender = Number(BigInt(`0x${options.userId}`) & 0xffffffffn);
  const link = new Link(socket, sender);

  try {
    // 1. Introduce ourselves; the server answers with a challenge.
    link.send({ receiver: 0, link: 0, type: TYPE.userRegistration, payload: connectRequest(options) });
    const challenge = await link.receive(deadline, true);
    const asked = decodeParams(challenge.payload);
    if (challenge.type !== TYPE.authentication || asked[0]?.[0] !== 0 || (asked[1]?.length ?? 0) < 2) {
      throw new HtsError('Unexpected challenge');
    }
    link.ack(challenge);

    // 2. Answer it; the server then tells which hubs the account has.
    link.send({
      receiver: 0,
      link: 0,
      type: TYPE.authentication,
      payload: encodeParams([Buffer.from([1]), solveChallenge(asked[1]![0]!, asked[1]![1]!)]),
    });
    const connected = await link.receive(deadline, true);
    if (connected.type !== TYPE.userRegistration) {
      throw new HtsError('The server did not accept the login');
    }
    link.adopt(connected.seq + 2);
    link.ack(connected);
    const hubs = parseConnected(connected.payload);

    // 3. Ask each hub for its status, and its settings in case the status does not carry the version.
    for (const hub of hubs) {
      for (const kind of [STATUS_REQUEST, SETTINGS_REQUEST]) {
        link.send({
          receiver: parseInt(hub.id, 16),
          link: 10,
          type: TYPE.updates,
          payload: encodeParams([Buffer.from([kind]), Buffer.from([1]), Buffer.from([1])]),
        });
      }
    }

    const versions = new Map<string, string>();
    while (versions.size < hubs.length) {
      let message: HtsMessage;
      try {
        message = await link.receive(deadline);
      } catch (error) {
        if (versions.size > 0) {
          break;
        }
        throw error;
      }
      if (message.type !== TYPE.ack && !(message.flags & FLAG_NO_ACK)) {
        link.ack(message);
      }
      if (message.type !== TYPE.updates) {
        continue;
      }
      const params = decodeParams(message.payload);
      if (!REPORTS.has(params[0]?.[0] ?? -1)) {
        continue;
      }
      for (const [id, row] of parseRows(params.slice(1))) {
        const version = decodeFirmware(row.get(KEY_FIRMWARE) ?? Buffer.alloc(0));
        if (version && hubs.some((hub) => hub.id === id)) {
          versions.set(id, version);
        }
      }
    }
    return versions;
  } finally {
    link.close();
  }
}

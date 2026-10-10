/**
 * Just enough of the protobuf wire format for the handful of messages the cloud client exchanges:
 * varints and length-delimited fields. Anything else on the wire is skipped, not rejected, so
 * new fields added by the server do not break decoding.
 */

export class ProtobufError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufError';
  }
}

const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

export class Writer {
  private readonly chunks: Buffer[] = [];

  /** Writes a varint field. Like proto3, zero is the default and is left out unless `always` is set. */
  varint(field: number, value: number | bigint, always = false): this {
    if (value === 0 || value === 0n) {
      if (!always) {
        return this;
      }
    }
    this.chunks.push(encodeVarint(BigInt(field) << 3n | BigInt(VARINT)), encodeVarint(BigInt(value)));
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.varint(field, value ? 1 : 0);
  }

  /** Writes a string field. An empty string is the default and is left out unless `always` is set. */
  string(field: number, value: string, always = false): this {
    return this.bytes(field, Buffer.from(value, 'utf8'), always);
  }

  bytes(field: number, value: Buffer, always = false): this {
    if (value.length === 0 && !always) {
      return this;
    }
    this.chunks.push(encodeVarint(BigInt(field) << 3n | BigInt(LENGTH_DELIMITED)), encodeVarint(BigInt(value.length)), value);
    return this;
  }

  /** Writes a nested message, always, as proto3 does for a set message field. */
  message(field: number, value: Writer | Buffer): this {
    return this.bytes(field, value instanceof Writer ? value.finish() : value, true);
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** A decoded message: every occurrence of every field, by number. */
export class Message {
  private constructor(private readonly fields: Map<number, (bigint | Buffer)[]>) {}

  static decode(buffer: Buffer): Message {
    const fields = new Map<number, (bigint | Buffer)[]>();
    let offset = 0;

    const read = (): bigint => {
      const [value, next] = decodeVarint(buffer, offset);
      offset = next;
      return value;
    };

    while (offset < buffer.length) {
      const key = read();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      let value: bigint | Buffer;

      switch (wire) {
        case VARINT:
          value = read();
          break;
        case LENGTH_DELIMITED: {
          const length = Number(read());
          if (offset + length > buffer.length) {
            throw new ProtobufError('Truncated length-delimited field');
          }
          value = buffer.subarray(offset, offset + length);
          offset += length;
          break;
        }
        case FIXED64:
          offset += 8;
          continue;
        case FIXED32:
          offset += 4;
          continue;
        default:
          throw new ProtobufError(`Unsupported wire type ${wire}`);
      }
      if (offset > buffer.length) {
        throw new ProtobufError('Truncated field');
      }
      const values = fields.get(field);
      if (values) {
        values.push(value);
      } else {
        fields.set(field, [value]);
      }
    }
    return new Message(fields);
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  /** Field numbers present, in ascending order. Useful for a `oneof`. */
  get numbers(): number[] {
    return [...this.fields.keys()].sort((a, b) => a - b);
  }

  varint(field: number): number {
    const value = this.fields.get(field)?.[0];
    return typeof value === 'bigint' ? Number(value) : 0;
  }

  string(field: number): string {
    const value = this.fields.get(field)?.[0];
    return Buffer.isBuffer(value) ? value.toString('utf8') : '';
  }

  bytes(field: number): Buffer {
    const value = this.fields.get(field)?.[0];
    return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
  }

  message(field: number): Message | undefined {
    const value = this.fields.get(field)?.[0];
    return Buffer.isBuffer(value) ? Message.decode(value) : undefined;
  }

  messages(field: number): Message[] {
    return (this.fields.get(field) ?? []).filter(Buffer.isBuffer).map((value) => Message.decode(value));
  }
}

function encodeVarint(value: bigint): Buffer {
  if (value < 0n) {
    throw new ProtobufError('Negative varints are not supported');
  }
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

function decodeVarint(buffer: Buffer, start: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let offset = start;
  for (;;) {
    const byte = buffer[offset++];
    if (byte === undefined || shift > 63n) {
      throw new ProtobufError('Malformed varint');
    }
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [result, offset];
    }
    shift += 7n;
  }
}

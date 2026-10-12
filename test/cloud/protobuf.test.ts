import { describe, expect, it } from 'vitest';

import { Message, ProtobufError, Writer } from '../../src/cloud/protobuf.js';

const hex = (buffer: Buffer) => buffer.toString('hex');

describe('Writer', () => {
  // Examples from the protobuf encoding documentation.
  it('encodes a varint field', () => {
    expect(hex(new Writer().varint(1, 150).finish())).toBe('089601');
  });

  it('encodes a string field', () => {
    expect(hex(new Writer().string(2, 'testing').finish())).toBe('120774657374696e67');
  });

  it('encodes a nested message', () => {
    const inner = new Writer().varint(1, 150);
    expect(hex(new Writer().message(3, inner).finish())).toBe('1a03089601');
  });

  it('leaves out default values, like proto3', () => {
    expect(hex(new Writer().varint(1, 0).string(2, '').bool(3, false).finish())).toBe('');
  });

  it('keeps an empty nested message and an explicit empty string, which carry meaning', () => {
    expect(hex(new Writer().message(1, new Writer()).finish())).toBe('0a00');
    expect(hex(new Writer().string(1, '', true).finish())).toBe('0a00');
  });

  it('encodes large field numbers', () => {
    // Field 999 is used by the space list for the hub id.
    expect(hex(new Writer().string(999, 'a').finish())).toBe('ba3e0161');
  });

  it('encodes booleans', () => {
    expect(hex(new Writer().bool(2, true).finish())).toBe('1001');
  });
});

describe('Message.varints', () => {
  it('reads a repeated field that was packed into one block', () => {
    // field 8, wire type 2, three values: 9, 300, 1
    const packed = Buffer.from([0x42, 0x04, 0x09, 0xac, 0x02, 0x01]);
    expect(Message.decode(packed).varints(8)).toEqual([9, 300, 1]);
  });

  it('reads a repeated field that was sent one value at a time', () => {
    const unpacked = new Writer().varint(8, 9).varint(8, 300).varint(8, 1).finish();
    expect(Message.decode(unpacked).varints(8)).toEqual([9, 300, 1]);
  });

  it('is empty when the field is absent', () => {
    expect(Message.decode(new Writer().varint(1, 5).finish()).varints(8)).toEqual([]);
  });
});

describe('Message', () => {
  it('round-trips', () => {
    const buffer = new Writer()
      .string(1, 'hello')
      .varint(2, 300)
      .message(3, new Writer().string(1, 'inner'))
      .bytes(4, Buffer.from([1, 2, 3]))
      .finish();
    const message = Message.decode(buffer);
    expect(message.string(1)).toBe('hello');
    expect(message.varint(2)).toBe(300);
    expect(message.message(3)?.string(1)).toBe('inner');
    expect([...message.bytes(4)]).toEqual([1, 2, 3]);
  });

  it('returns defaults for absent fields', () => {
    const message = Message.decode(Buffer.alloc(0));
    expect(message.string(1)).toBe('');
    expect(message.varint(1)).toBe(0);
    expect(message.message(1)).toBeUndefined();
    expect(message.bytes(1)).toHaveLength(0);
  });

  it('collects repeated fields', () => {
    const buffer = Buffer.concat([
      new Writer().message(1, new Writer().string(1, 'a')).finish(),
      new Writer().message(1, new Writer().string(1, 'b')).finish(),
    ]);
    expect(Message.decode(buffer).messages(1).map((m) => m.string(1))).toEqual(['a', 'b']);
  });

  it('lists the fields present, for a oneof', () => {
    expect(Message.decode(new Writer().message(5, new Writer()).finish()).numbers).toEqual([5]);
  });

  it('skips fixed-width fields and unknown fields', () => {
    // field 1 fixed32, field 2 fixed64, field 3 varint
    const buffer = Buffer.from('0d01000000' + '110100000000000000' + '1807', 'hex');
    const message = Message.decode(buffer);
    expect(message.varint(3)).toBe(7);
    expect(message.has(1)).toBe(false);
  });

  it('decodes multi-byte varints', () => {
    expect(Message.decode(Buffer.from('089601', 'hex')).varint(1)).toBe(150);
  });

  it.each([
    ['a truncated length-delimited field', '0a05616263'],
    ['a truncated varint', '08ff'],
    ['an unsupported wire type', '0b'],
  ])('rejects %s', (_label, input) => {
    expect(() => Message.decode(Buffer.from(input, 'hex'))).toThrow(ProtobufError);
  });
});

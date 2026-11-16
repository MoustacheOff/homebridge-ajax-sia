import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  HtsError, TYPE, crc16, decodeFirmware, decodeFrame, decodeMessage, decodeParams, decrypt, encodeFrame, encodeMessage,
  encodeParams, encrypt, parseRows, readHubFirmware, solveChallenge, type HtsMessage, type HtsOptions,
} from '../../src/cloud/hts.js';
import { FIRMWARE, FakeHts, type Behaviour } from './fakeHts.js';

const bytes = (...values: number[]) => Buffer.from(values);
const range = (count: number) => Buffer.from(Array.from({ length: count }, (_, index) => index));

// The expected values of the codec below were computed with a separate implementation of the format.
describe('HTS frames', () => {
  it('checksums with CRC-16, polynomial 0x1021, starting from 0xA001', () => {
    expect(crc16(Buffer.alloc(0))).toBe(0xa001);
    expect(crc16(Buffer.from('123456789'))).toBe(0x6e5e);
    expect(crc16(range(32))).toBe(0x8393);
    expect(crc16(bytes(2, 3, 4, 5, 6, 0, 255))).toBe(0xb7bf);
  });

  it('wraps a body in STX, the body and its CRC, ETX, escaping the three reserved bytes', () => {
    expect(encodeFrame(range(16)).toString('hex')).toBe('02000104320433043405060708090a0b0c0d0e0fb1a403');
    expect(encodeFrame(bytes(2, 3, 4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12)).toString('hex'))
      .toBe('02043204330434000104320433043405060708090a0b0c3aa103');
  });

  it('gives the body back', () => {
    for (const body of [range(16), bytes(2, 3, 4), Buffer.from('plain text body')]) {
      expect(decodeFrame(encodeFrame(body))).toEqual(body);
    }
  });

  it('refuses what is not a frame, a frame whose CRC is wrong, and a bad escape', () => {
    const frame = encodeFrame(range(16));
    expect(() => decodeFrame(Buffer.alloc(0))).toThrow(HtsError);
    expect(() => decodeFrame(frame.subarray(1))).toThrow(/Not a frame/);
    expect(() => decodeFrame(frame.subarray(0, frame.length - 1))).toThrow(/Not a frame/);
    const corrupted = Buffer.from(frame);
    corrupted[5] = 0x77;
    expect(() => decodeFrame(corrupted)).toThrow(/CRC/);
    expect(() => decodeFrame(bytes(2, 4, 0x99, 1, 3))).toThrow(/escape/);
  });
});

describe('HTS encryption', () => {
  it('encrypts with AES-128-CBC and the fixed key and IV of the format', () => {
    expect(encrypt(range(32)).toString('hex'))
      .toBe('5785bb421c06945b90c654fb78a4700b103674c1d65c05962db4d49da3ead5ee');
  });

  it('decrypts what it encrypts', () => {
    expect(decrypt(encrypt(range(48)))).toEqual(range(48));
  });

  it('completes the last block with random bytes that are all 10 or more', () => {
    const plain = Buffer.from('seventeen bytes!!');
    expect(plain.length).toBe(17);
    const decrypted = decrypt(encrypt(plain));
    expect(decrypted.length).toBe(32);
    expect(decrypted.subarray(0, 17)).toEqual(plain);
    expect([...decrypted.subarray(17)].every((byte) => byte >= 10)).toBe(true);
  });

  it('refuses data that is not whole blocks', () => {
    expect(() => decrypt(Buffer.alloc(0))).toThrow(HtsError);
    expect(() => decrypt(Buffer.alloc(20))).toThrow(HtsError);
  });
});

describe('HTS parameters', () => {
  it('introduces each parameter with a delimiter, closes with one, and escapes the two special bytes', () => {
    expect(encodeParams([bytes(0x3f), bytes(5, 6, 0xaa), Buffer.from('ab')]).toString('hex')).toBe('053f0506350636aa05616205');
    expect(encodeParams([])).toEqual(Buffer.alloc(0));
  });

  it('gets the parameters back, special bytes included', () => {
    const params = [bytes(0x3f), bytes(5, 6, 0xaa), Buffer.from('ab'), bytes(6)];
    expect(decodeParams(encodeParams(params))).toEqual(params);
  });

  it('ignores the filler after the last delimiter, and empty parameters', () => {
    expect(decodeParams(Buffer.concat([encodeParams([bytes(1), bytes(2)]), bytes(0x7a, 0x7b)]))).toEqual([bytes(1), bytes(2)]);
    expect(decodeParams(bytes(5, 5, 9, 5))).toEqual([bytes(9)]);
  });

  it('keeps an escape it does not know as it came', () => {
    expect(decodeParams(bytes(5, 6, 0x6a, 5))).toEqual([bytes(6, 0x6a)]);
  });
});

describe('HTS messages', () => {
  const message: HtsMessage = {
    sender: 0xdeadbeef, receiver: 0x0a1b2c3d, seq: 0x010203, link: 10, flags: 0x20, type: TYPE.updates, payload: bytes(1, 2, 3),
  };

  it('has a header of 14 bytes, then the payload', () => {
    expect(encodeMessage(message).toString('hex')).toBe('deadbeef0a1b2c3d0102030a2019010203');
  });

  it('is read back as it was written', () => {
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
    expect(() => decodeMessage(Buffer.alloc(13))).toThrow(HtsError);
  });
});

describe('HTS handshake and firmware', () => {
  it('answers the challenge with two bytes', () => {
    expect(solveChallenge(0x0a, 0x0c)).toEqual(bytes(0x06, 0x20));
    expect(solveChallenge(0xff, 0xff)).toEqual(bytes(0x00, 0xfc));
  });

  it('reads the firmware as the decimal digits of a big-endian integer', () => {
    expect(decodeFirmware(bytes(0x00, 0x03, 0xb5, 0xb1))).toBe('2.43.121');
    expect(decodeFirmware(bytes(0x00, 0x03, 0xa9, 0xf9))).toBe('2.40.121');
    expect(decodeFirmware(bytes(0x00, 0x01, 0x86, 0xa0))).toBe('1.0.0');
  });

  it('refuses what cannot be a version', () => {
    expect(decodeFirmware(bytes(0x80, 0x00, 0x00, 0x00))).toBeUndefined();
    expect(decodeFirmware(bytes(0xde, 0xad, 0xbe, 0xef))).toBeUndefined();
    expect(decodeFirmware(bytes(0, 0, 0, 1))).toBeUndefined();
    expect(decodeFirmware(bytes(0x00, 0x03, 0xb4))).toBeUndefined();
    expect(decodeFirmware(Buffer.alloc(0))).toBeUndefined();
  });

  it('splits a report into rows, each starting with a four-byte id', () => {
    const rows = parseRows([
      bytes(0, 0, 0, 1), bytes(3), bytes(1), bytes(0x37), bytes(0, 3, 0xb5, 0xb1), bytes(0, 0, 0, 2), bytes(9), bytes(7),
    ]);
    expect([...rows.keys()]).toEqual(['00000001', '00000002']);
    expect(rows.get('00000001')!.get(0x37)).toEqual(bytes(0, 3, 0xb5, 0xb1));
    expect(rows.get('00000002')!.get(9)).toEqual(bytes(7));
  });

  it('skips a parameter that is neither an id nor a one-byte key without losing its place', () => {
    const rows = parseRows([bytes(9, 9), bytes(0, 0, 0, 1), bytes(1, 2), bytes(0xaa), bytes(3), bytes(5)]);
    expect(rows.get('00000001')!.get(3)).toEqual(bytes(5));
  });
});

describe('readHubFirmware', () => {
  const fake = new FakeHts();
  let seen: HtsMessage[];

  afterEach(async () => {
    await fake.stop();
  });

  async function serve(behaviour: Behaviour = {}): Promise<HtsOptions> {
    const port = await fake.start(behaviour);
    seen = fake.seen;
    return {
      token: 'a1b2c3d4',
      userId: 'DEADBEEF',
      deviceId: 'device-1',
      clientVersion: '3.60',
      deviceModel: 'Homebridge',
      deviceOs: 'Debian GNU/Linux 12 aarch64',
      timeoutMs: 2000,
      open: () => connect(port, '127.0.0.1'),
    };
  }

  it('introduces itself, answers the challenge, asks each hub for its status and reads the version', async () => {
    const options = await serve();
    expect(await readHubFirmware(options)).toEqual(new Map([['0A1B2C3D', '2.43.121']]));

    const [hello, ackOfChallenge, answer, ackOfConnected, request] = seen;
    expect(hello).toMatchObject({ type: TYPE.userRegistration, sender: 0xdeadbeef, receiver: 0 });
    const params = decodeParams(hello!.payload);
    expect(params[0]).toEqual(bytes(0x3f));
    expect(params[2]).toEqual(bytes(0xa1, 0xb2, 0xc3, 0xd4));
    expect(params.map(String)).toContain('device-1_Ajax');
    expect(params.map(String)).toContain('Homebridge');

    expect(ackOfChallenge).toMatchObject({ type: TYPE.ack });
    expect(decodeParams(ackOfChallenge!.payload)[1]).toEqual(bytes(0, 0, 100));
    expect(answer).toMatchObject({ type: TYPE.authentication });
    // The client numbers its messages from the server's own range once it has been accepted.
    expect(ackOfConnected).toMatchObject({ type: TYPE.ack, seq: 202 });
    expect(decodeParams(ackOfConnected!.payload)[1]).toEqual(bytes(0, 0, 200));
    expect(request).toMatchObject({ type: TYPE.updates, receiver: 0x0a1b2c3d, link: 10, seq: 203 });
    expect(decodeParams(request!.payload)).toEqual([bytes(7), bytes(1), bytes(1)]);
  });

  it('acknowledges what the hub sends, so that the server does not send it again', async () => {
    const options = await serve();
    await readHubFirmware(options);
    // The challenge, the answer to the login, and the report of the hub.
    await expect.poll(() => seen.filter((message) => message.type === TYPE.ack).length).toBeGreaterThanOrEqual(3);
  });

  it('finds the version in the settings when the status does not carry it', async () => {
    const options = await serve({ carriedBy: 'settings' });
    expect(await readHubFirmware(options)).toEqual(new Map([['0A1B2C3D', '2.43.121']]));
  });

  it('reads every hub of the account', async () => {
    const options = await serve({
      hubs: ['0A1B2C3D', '00000042'],
      firmware: { '0A1B2C3D': FIRMWARE, '00000042': bytes(0x00, 0x03, 0xa9, 0xf9) },
    });
    expect(await readHubFirmware(options)).toEqual(new Map([['0A1B2C3D', '2.43.121'], ['00000042', '2.40.121']]));
  });

  it('leaves out a hub that does not say, once the others have answered or time is up', async () => {
    const options = await serve({ hubs: ['0A1B2C3D', '00000042'], firmware: { '0A1B2C3D': FIRMWARE } });
    expect(await readHubFirmware({ ...options, timeoutMs: 400 })).toEqual(new Map([['0A1B2C3D', '2.43.121']]));
  });

  it('gives an empty answer when the hub reports a value that is not a version', async () => {
    const options = await serve({ firmware: { '0A1B2C3D': bytes(0xde, 0xad, 0xbe, 0xef) } });
    await expect(readHubFirmware({ ...options, timeoutMs: 400 })).rejects.toThrow(HtsError);
  });

  it('carries on past a frame that does not decode', async () => {
    const options = await serve({ noise: true });
    expect(await readHubFirmware(options)).toEqual(new Map([['0A1B2C3D', '2.43.121']]));
  });

  it('fails when the server never answers', async () => {
    const options = await serve({ silent: true });
    await expect(readHubFirmware({ ...options, timeoutMs: 200 })).rejects.toThrow(/Timed out/);
  });

  it('fails when the server hangs up', async () => {
    const options = await serve({ hangUp: true });
    await expect(readHubFirmware(options)).rejects.toThrow(HtsError);
  });

  it('fails when the challenge is not one', async () => {
    const options = await serve({ challenge: bytes(1) });
    await expect(readHubFirmware(options)).rejects.toThrow(/challenge/);
  });

  it('closes the connection when it is done', async () => {
    const options = await serve();
    let closed = false;
    const open = options.open!;
    await readHubFirmware({ ...options, open: () => open().on('close', () => void (closed = true)) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });
});

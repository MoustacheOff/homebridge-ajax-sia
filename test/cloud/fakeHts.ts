import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import {
  TYPE, decodeFrame, decodeMessage, decodeParams, decrypt, encodeFrame, encodeMessage, encodeParams, encrypt, solveChallenge,
  type HtsMessage,
} from '../../src/cloud/hts.js';

const bytes = (...values: number[]) => Buffer.from(values);

/** 243121, which is firmware 2.43.121. */
export const FIRMWARE = bytes(0x00, 0x03, 0xb5, 0xb1);

/** How the fake hub server behaves. */
export interface Behaviour {
  /** Hubs the account has, by id. */
  hubs?: string[];
  /** The report to send for a request of this kind (7: status, 3: settings), by hub id. */
  firmware?: Record<string, Buffer>;
  /** Which kind of report carries the firmware. */
  carriedBy?: 'status' | 'settings';
  challenge?: Buffer;
  /** Does not answer the introduction. */
  silent?: boolean;
  /** Hangs up after the introduction. */
  hangUp?: boolean;
  /** Sends a frame that does not decode before each message. */
  noise?: boolean;
}



/** A server that speaks the other side of the handshake, and answers the status requests of the hubs it knows. */
export class FakeHts {
  /** What the client sent, in order. */
  seen: HtsMessage[] = [];
  private server?: Server;

  /** Starts listening on a free port and returns it. */
  async start(behaviour: Behaviour = {}): Promise<number> {
    this.seen = [];
    const hubs = behaviour.hubs ?? ['0A1B2C3D'];
    const firmware = behaviour.firmware ?? Object.fromEntries(hubs.map((hub) => [hub, FIRMWARE]));
    const carrier = behaviour.carriedBy === 'settings' ? 3 : 7;

    this.server = createServer((socket: Socket) => {
      let buffer: Buffer = Buffer.alloc(0);
      socket.on('error', () => undefined);
      const reply = (message: Partial<HtsMessage> & Pick<HtsMessage, 'type' | 'payload'>) => {
        if (behaviour.noise) {
          socket.write(bytes(2, 0x11, 0x22, 3));
        }
        socket.write(encodeFrame(encrypt(encodeMessage({ sender: 0, receiver: 0, seq: 100, link: 0, flags: 0, ...message }))));
      };
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const start = buffer.indexOf(2);
          const stop = buffer.indexOf(3, start + 1);
          if (start < 0 || stop < 0) {
            return;
          }
          const message = decodeMessage(decrypt(decodeFrame(buffer.subarray(start, stop + 1))));
          buffer = buffer.subarray(stop + 1);
          this.seen.push(message);

          if (message.type === TYPE.userRegistration) {
            if (behaviour.hangUp) {
              socket.destroy();
              return;
            }
            if (!behaviour.silent) {
              reply({ type: TYPE.authentication, seq: 100, payload: encodeParams([bytes(0), behaviour.challenge ?? bytes(0x0a, 0x0c)]) });
            }
          } else if (message.type === TYPE.authentication) {
            const params = decodeParams(message.payload);
            if (params[0]?.[0] === 1 && params[1]?.equals(solveChallenge(0x0a, 0x0c))) {
              reply({
                type: TYPE.userRegistration,
                seq: 200,
                payload: encodeParams([
                  bytes(0x0f), bytes(9, 9, 9, 9, 9, 9),
                  ...hubs.flatMap((hub) => [Buffer.from(hub, 'hex'), bytes(1)]),
                ]),
              });
            }
          } else if (message.type === TYPE.updates) {
            const kind = decodeParams(message.payload)[0]![0]!;
            const hubId = message.receiver.toString(16).toUpperCase().padStart(8, '0');
            const body = kind === carrier && firmware[hubId]
              ? [bytes(0x03), bytes(1), bytes(0x37), firmware[hubId]!]
              : [bytes(0x03), bytes(1)];
            reply({
              type: TYPE.updates,
              seq: 300 + kind,
              sender: message.receiver,
              payload: encodeParams([bytes(kind === 3 ? 5 : 9), Buffer.from(hubId, 'hex'), ...body]),
            });
          }
        }
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}

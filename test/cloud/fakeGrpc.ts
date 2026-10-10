import { createServer, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface Call {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  message: Buffer;
}

export type Reply =
  | { message: Buffer }
  | { status: number; text?: string }
  /** Reply with a gRPC status but sent as trailers after a body, as a real service does. */
  | { message: Buffer; status: number; text?: string }
  | { raw: Buffer; encoding?: string }
  /** Never answer. */
  | { hang: true };

/** A cleartext HTTP/2 server speaking just enough gRPC to test the client. */
export class FakeGrpcServer {
  readonly calls: Call[] = [];
  private server?: Http2Server;
  handler: (call: Call) => Reply = () => ({ status: 12 });

  async start(): Promise<string> {
    this.server = createServer();
    this.server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const body = Buffer.concat(chunks);
        const call: Call = { path: String(headers[':path']), headers, message: body.subarray(5, 5 + body.readUInt32BE(1)) };
        this.calls.push(call);
        const reply = this.handler(call);

        if ('hang' in reply) {
          return;
        }

        if ('raw' in reply) {
          stream.respond(
            { ':status': 200, 'content-type': 'application/grpc', ...(reply.encoding ? { 'grpc-encoding': reply.encoding } : {}) },
            { waitForTrailers: true },
          );
          stream.write(reply.raw);
          stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
          stream.end();
          return;
        }
        if ('message' in reply) {
          const prefix = Buffer.alloc(5);
          prefix.writeUInt32BE(reply.message.length, 1);
          stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
          stream.write(Buffer.concat([prefix, reply.message]));
          stream.on('wantTrailers', () => stream.sendTrailers({
            'grpc-status': String('status' in reply ? reply.status : 0),
            ...('text' in reply && reply.text ? { 'grpc-message': encodeURIComponent(reply.text) } : {}),
          }));
          stream.end();
          return;
        }
        // Trailers-only response: the status travels in the headers.
        stream.respond({
          ':status': 200,
          'content-type': 'application/grpc',
          'grpc-status': String(reply.status),
          ...(reply.text ? { 'grpc-message': encodeURIComponent(reply.text) } : {}),
        }, { endStream: true });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

export const frame = (message: Buffer): Buffer => {
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(message.length, 1);
  return Buffer.concat([prefix, message]);
};

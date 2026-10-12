import { connect, constants } from 'node:http2';
import { gunzipSync } from 'node:zlib';

/** The gRPC status codes this client reacts to. */
export const GrpcStatus = {
  OK: 0,
  DEADLINE_EXCEEDED: 4,
  PERMISSION_DENIED: 7,
  UNIMPLEMENTED: 12,
  UNAVAILABLE: 14,
  UNAUTHENTICATED: 16,
} as const;

export class GrpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'GrpcError';
  }
}

export type Metadata = Record<string, string>;

/**
 * Minimal gRPC unary client over HTTP/2.
 *
 * A fresh connection is opened for every call. The calls are rare (a login, a command, an occasional
 * state read), so this trades a TLS handshake for not having to babysit a long-lived connection.
 */
export class GrpcChannel {
  /** @param origin e.g. `https://example.com:443`; plain `http://` is accepted for tests. */
  constructor(private readonly origin: string) {}

  unary(path: string, message: Buffer, metadata: Metadata, timeoutMs: number): Promise<Buffer> {
    return this.exchange(path, message, metadata, timeoutMs, false);
  }

  /** For a call that streams: returns the first message the server sends, then hangs up. */
  firstMessage(path: string, message: Buffer, metadata: Metadata, timeoutMs: number): Promise<Buffer> {
    return this.exchange(path, message, metadata, timeoutMs, true);
  }

  private exchange(path: string, message: Buffer, metadata: Metadata, timeoutMs: number, stopAtFirst: boolean): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const session = connect(this.origin);
      const state: { settled: boolean; timer?: NodeJS.Timeout } = { settled: false };

      const finish = (error: Error | undefined, result?: Buffer) => {
        if (state.settled) {
          return;
        }
        state.settled = true;
        clearTimeout(state.timer);
        session.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(result!);
        }
      };

      state.timer = setTimeout(() => finish(new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded')), timeoutMs);
      session.once('error', (error) => finish(new GrpcError(GrpcStatus.UNAVAILABLE, error.message)));

      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: path,
        'content-type': 'application/grpc',
        'te': 'trailers',
        'grpc-accept-encoding': 'identity,gzip',
        ...metadata,
      });

      let headers: Record<string, string | string[] | undefined> = {};
      let trailers: Record<string, string | string[] | undefined> = {};
      const body: Buffer[] = [];

      request.on('response', (received) => {
        headers = received;
      });
      request.on('trailers', (received) => {
        trailers = received;
      });
      request.on('data', (chunk: Buffer) => {
        body.push(chunk);
        if (!stopAtFirst) {
          return;
        }
        try {
          const payload = firstFrame(Buffer.concat(body), first(headers['grpc-encoding']));
          if (payload) {
            finish(undefined, payload);
          }
        } catch (error) {
          finish(error as Error);
        }
      });
      request.on('error', (error) => finish(new GrpcError(GrpcStatus.UNAVAILABLE, error.message)));
      request.on('close', () => {
        // Errors without a body arrive as "trailers-only" responses: the status is in the headers.
        const status = first(trailers['grpc-status'] ?? headers['grpc-status']);
        if (status === undefined) {
          finish(new GrpcError(GrpcStatus.UNAVAILABLE, 'Connection closed without a gRPC status'));
          return;
        }
        if (Number(status) !== GrpcStatus.OK) {
          const detail = first(trailers['grpc-message'] ?? headers['grpc-message']) ?? '';
          finish(new GrpcError(Number(status), decodeURIComponent(detail)));
          return;
        }
        try {
          finish(undefined, unframe(Buffer.concat(body), first(headers['grpc-encoding'])));
        } catch (error) {
          finish(error as Error);
        }
      });

      const prefix = Buffer.alloc(5);
      prefix.writeUInt32BE(message.length, 1);
      request.end(Buffer.concat([prefix, message]));
    });
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Extracts the single message of a unary response. */
function unframe(data: Buffer, encoding: string | undefined): Buffer {
  if (data.length < 5) {
    throw new GrpcError(GrpcStatus.UNAVAILABLE, 'Empty gRPC response');
  }
  const payload = firstFrame(data, encoding);
  if (!payload) {
    throw new GrpcError(GrpcStatus.UNAVAILABLE, 'Truncated gRPC response');
  }
  return payload;
}

/** The first complete message in `data`, or `undefined` while it has not fully arrived. */
function firstFrame(data: Buffer, encoding: string | undefined): Buffer | undefined {
  if (data.length < 5) {
    return undefined;
  }
  const length = data.readUInt32BE(1);
  if (data.length < 5 + length) {
    return undefined;
  }
  const payload = data.subarray(5, 5 + length);
  if (data[0] !== 1) {
    return payload;
  }
  if (encoding !== 'gzip') {
    throw new GrpcError(GrpcStatus.UNAVAILABLE, `Unsupported response encoding: ${encoding ?? 'none'}`);
  }
  return gunzipSync(payload);
}

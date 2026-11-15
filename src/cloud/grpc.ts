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

export interface StreamListener {
  /** One message of the stream. */
  message(payload: Buffer): void;
  /** The stream ended, for any reason but a call to `close()`. `error` is unset when the server ended it normally. */
  end(error?: GrpcError): void;
}

export interface Stream {
  /** Hangs up. `end()` is not called afterwards. */
  close(): void;
}

export interface StreamOptions {
  /** How long the server has to start answering. */
  connectTimeoutMs?: number;
  /** Interval of the HTTP/2 pings that tell a silent connection from a dead one. */
  keepaliveMs?: number;
}

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

  /**
   * A call that streams: stays open and hands every message to `listener` until the server ends it, the connection
   * is lost (a ping unanswered for a whole interval counts as lost), or `close()` is called.
   */
  stream(path: string, message: Buffer, metadata: Metadata, listener: StreamListener, options: StreamOptions = {}): Stream {
    const session = connect(this.origin);
    let settled = false;
    let awaitingPing = false;
    const timers: { connect?: NodeJS.Timeout; ping?: NodeJS.Timeout } = {};

    const stop = (): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timers.connect);
      clearInterval(timers.ping);
      session.destroy();
      return true;
    };
    const fail = (error: GrpcError | undefined) => {
      if (stop()) {
        listener.end(error);
      }
    };

    timers.connect = setTimeout(
      () => fail(new GrpcError(GrpcStatus.DEADLINE_EXCEEDED, 'Deadline exceeded')),
      options.connectTimeoutMs ?? 15_000,
    );
    session.once('error', (error) => fail(new GrpcError(GrpcStatus.UNAVAILABLE, error.message)));

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
    let pending: Buffer = Buffer.alloc(0);

    request.on('response', (received) => {
      headers = received;
      clearTimeout(timers.connect);
    });
    request.on('trailers', (received) => {
      trailers = received;
    });
    request.on('data', (chunk: Buffer) => {
      if (settled) {
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      try {
        const encoding = first(headers['grpc-encoding']);
        for (let frame = takeFrame(pending, encoding); frame; frame = takeFrame(pending, encoding)) {
          pending = pending.subarray(frame.size);
          listener.message(frame.payload);
        }
      } catch (error) {
        fail(error instanceof GrpcError ? error : new GrpcError(GrpcStatus.UNAVAILABLE, (error as Error).message));
      }
    });
    request.on('error', (error) => fail(new GrpcError(GrpcStatus.UNAVAILABLE, error.message)));
    request.on('close', () => {
      // Errors without a body arrive as "trailers-only" responses: the status is in the headers.
      const status = first(trailers['grpc-status'] ?? headers['grpc-status']);
      if (status === undefined) {
        fail(new GrpcError(GrpcStatus.UNAVAILABLE, 'Connection closed without a gRPC status'));
      } else if (Number(status) === GrpcStatus.OK) {
        fail(undefined);
      } else {
        const detail = first(trailers['grpc-message'] ?? headers['grpc-message']) ?? '';
        fail(new GrpcError(Number(status), decodeURIComponent(detail)));
      }
    });

    timers.ping = setInterval(() => {
      if (awaitingPing) {
        fail(new GrpcError(GrpcStatus.UNAVAILABLE, 'Connection lost: no answer to a keepalive ping'));
        return;
      }
      awaitingPing = true;
      const sent = session.ping((error) => {
        if (!error) {
          awaitingPing = false;
        }
      });
      if (!sent) {
        fail(new GrpcError(GrpcStatus.UNAVAILABLE, 'Connection lost'));
      }
    }, options.keepaliveMs ?? 30_000);
    timers.ping.unref();

    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(message.length, 1);
    request.end(Buffer.concat([prefix, message]));

    return { close: () => void stop() };
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
  return takeFrame(data, encoding)?.payload;
}

/** The first complete message in `data` and the number of bytes it took, or `undefined` while it has not fully arrived. */
function takeFrame(data: Buffer, encoding: string | undefined): { payload: Buffer; size: number } | undefined {
  if (data.length < 5) {
    return undefined;
  }
  const length = data.readUInt32BE(1);
  if (data.length < 5 + length) {
    return undefined;
  }
  const payload = data.subarray(5, 5 + length);
  if (data[0] !== 1) {
    return { payload, size: 5 + length };
  }
  if (encoding !== 'gzip') {
    throw new GrpcError(GrpcStatus.UNAVAILABLE, `Unsupported response encoding: ${encoding ?? 'none'}`);
  }
  return { payload: gunzipSync(payload), size: 5 + length };
}

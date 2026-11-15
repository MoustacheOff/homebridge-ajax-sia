import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GrpcChannel, GrpcError, GrpcStatus, type Stream } from '../../src/cloud/grpc.js';
import { FakeGrpcServer, frame } from './fakeGrpc.js';

const server = new FakeGrpcServer();
let channel: GrpcChannel;
let opened: Stream[];

const open = (listener: Parameters<GrpcChannel['stream']>[3], options?: Parameters<GrpcChannel['stream']>[4]) => {
  const stream = channel.stream('/svc/watch', Buffer.from('hello'), { 'client-session-token': 'abc' }, listener, options);
  opened.push(stream);
  return stream;
};

beforeEach(async () => {
  opened = [];
  server.calls.length = 0;
  server.open.length = 0;
  server.streamsClosedByClient = 0;
  server.handler = () => ({ stream: [Buffer.from('first')] });
  channel = new GrpcChannel(await server.start());
});

afterEach(async () => {
  opened.forEach((stream) => stream.close());
  await server.stop();
});

describe('GrpcChannel.stream', () => {
  it('sends the request with the metadata and hands over every message as it arrives', async () => {
    const messages: string[] = [];
    open({ message: (payload) => messages.push(payload.toString()), end: () => undefined });
    await expect.poll(() => messages).toEqual(['first']);

    server.push(Buffer.from('second'));
    server.push(Buffer.from('third'));
    await expect.poll(() => messages).toEqual(['first', 'second', 'third']);

    const call = server.calls[0]!;
    expect(call.path).toBe('/svc/watch');
    expect(call.message.toString()).toBe('hello');
    expect(call.headers['client-session-token']).toBe('abc');
  });

  it('puts back together a message that arrives in pieces, and splits two that arrive together', async () => {
    const messages: string[] = [];
    open({ message: (payload) => messages.push(payload.toString()), end: () => undefined });
    await expect.poll(() => messages).toEqual(['first']);

    const whole = frame(Buffer.from('in two pieces'));
    server.pushRaw(whole.subarray(0, 3));
    server.pushRaw(whole.subarray(3, 9));
    server.pushRaw(Buffer.concat([whole.subarray(9), frame(Buffer.from('next'))]));
    await expect.poll(() => messages).toEqual(['first', 'in two pieces', 'next']);
  });

  it('reports the end of a stream the server closes normally', async () => {
    const ends: (GrpcError | undefined)[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) });
    await expect.poll(() => server.open.length).toBe(1);
    server.endStreams();
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toBeUndefined();
  });

  it('reports the status when the server ends the stream with an error', async () => {
    const ends: (GrpcError | undefined)[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) });
    await expect.poll(() => server.open.length).toBe(1);
    server.endStreams(GrpcStatus.UNAUTHENTICATED, 'session expired');
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ code: GrpcStatus.UNAUTHENTICATED, message: 'session expired' });
  });

  it('reports a refusal sent as a trailers-only response', async () => {
    server.handler = () => ({ status: GrpcStatus.PERMISSION_DENIED, text: 'blacklisted' });
    const ends: (GrpcError | undefined)[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) });
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ code: GrpcStatus.PERMISSION_DENIED, message: 'blacklisted' });
  });

  it('reports a server that never answers once the connect timeout has passed', async () => {
    server.handler = () => ({ hang: true });
    const ends: (GrpcError | undefined)[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) }, { connectTimeoutMs: 50 });
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ code: GrpcStatus.DEADLINE_EXCEEDED });
  });

  it('reports a server that cannot be reached', async () => {
    const ends: (GrpcError | undefined)[] = [];
    const lost = new GrpcChannel('http://127.0.0.1:1');
    opened.push(lost.stream('/svc/watch', Buffer.alloc(0), {}, { message: () => undefined, end: (error) => ends.push(error) }));
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ code: GrpcStatus.UNAVAILABLE });
  });

  it('hangs up on close() and does not report it', async () => {
    const ends: unknown[] = [];
    const stream = open({ message: () => undefined, end: (error) => ends.push(error) });
    await expect.poll(() => server.open.length).toBe(1);
    stream.close();
    await expect.poll(() => server.streamsClosedByClient).toBe(1);
    expect(ends).toEqual([]);
  });

  it('ends with an error when a message uses an encoding it does not know', async () => {
    server.handler = () => ({ stream: [] });
    const ends: (GrpcError | undefined)[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) });
    await expect.poll(() => server.open.length).toBe(1);
    server.pushRaw(Buffer.concat([Buffer.from([1, 0, 0, 0, 2]), Buffer.from([1, 2])]));
    await expect.poll(() => ends.length).toBe(1);
    expect(ends[0]).toMatchObject({ code: GrpcStatus.UNAVAILABLE });
  });

  it('keeps a healthy connection open while it pings it', async () => {
    const ends: unknown[] = [];
    open({ message: () => undefined, end: (error) => ends.push(error) }, { keepaliveMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ends).toEqual([]);
  });
});

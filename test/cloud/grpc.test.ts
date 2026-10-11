import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { GrpcChannel, GrpcError, GrpcStatus } from '../../src/cloud/grpc.js';
import { FakeGrpcServer, frame } from './fakeGrpc.js';

const server = new FakeGrpcServer();
let channel: GrpcChannel;

afterEach(async () => {
  await server.stop();
});

async function start(): Promise<void> {
  channel = new GrpcChannel(await server.start());
}

describe('GrpcChannel', () => {
  it('sends a framed message with its metadata and returns the reply', async () => {
    await start();
    server.handler = () => ({ message: Buffer.from('pong') });

    const reply = await channel.unary('/pkg.Service/method', Buffer.from('ping'), { 'x-custom': 'value' }, 2000);

    expect(reply.toString()).toBe('pong');
    const [call] = server.calls;
    expect(call!.path).toBe('/pkg.Service/method');
    expect(call!.message.toString()).toBe('ping');
    expect(call!.headers['content-type']).toBe('application/grpc');
    expect(call!.headers.te).toBe('trailers');
    expect(call!.headers['x-custom']).toBe('value');
  });

  it('maps a trailers-only error to a GrpcError', async () => {
    await start();
    server.handler = () => ({ status: GrpcStatus.PERMISSION_DENIED, text: 'Request is blacklisted' });

    await expect(channel.unary('/a/b', Buffer.alloc(0), {}, 2000)).rejects.toMatchObject({
      code: GrpcStatus.PERMISSION_DENIED,
      message: 'Request is blacklisted',
    });
  });

  it('maps an error sent in the trailers', async () => {
    await start();
    server.handler = () => ({ message: Buffer.alloc(0), status: GrpcStatus.UNAUTHENTICATED, text: 'nope: \u00f8' });

    await expect(channel.unary('/a/b', Buffer.alloc(0), {}, 2000)).rejects.toMatchObject({
      code: GrpcStatus.UNAUTHENTICATED,
      message: 'nope: \u00f8',
    });
  });

  it('reads a gzip-compressed reply', async () => {
    await start();
    const compressed = gzipSync(Buffer.from('squeezed'));
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(compressed.length, 1);
    server.handler = () => ({ raw: Buffer.concat([prefix, compressed]), encoding: 'gzip' });

    expect((await channel.unary('/a/b', Buffer.alloc(0), {}, 2000)).toString()).toBe('squeezed');
  });

  it('refuses a compressed reply it cannot decode', async () => {
    await start();
    const prefix = Buffer.alloc(5);
    prefix[0] = 1;
    prefix.writeUInt32BE(1, 1);
    server.handler = () => ({ raw: Buffer.concat([prefix, Buffer.from('x')]), encoding: 'br' });

    await expect(channel.unary('/a/b', Buffer.alloc(0), {}, 2000)).rejects.toThrow(/encoding/);
  });

  it('refuses a truncated reply', async () => {
    await start();
    server.handler = () => ({ raw: frame(Buffer.from('hello')).subarray(0, 7) });

    await expect(channel.unary('/a/b', Buffer.alloc(0), {}, 2000)).rejects.toThrow(/Truncated/);
  });

  it('gives up after the deadline', async () => {
    await start();
    server.handler = () => ({ hang: true });

    await expect(channel.unary('/a/b', Buffer.alloc(0), {}, 100)).rejects.toMatchObject({ code: GrpcStatus.DEADLINE_EXCEEDED });
  });

  it('reports an unreachable server as UNAVAILABLE', async () => {
    const dead = new GrpcChannel('http://127.0.0.1:1');
    const error = await dead.unary('/a/b', Buffer.alloc(0), {}, 2000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrpcError);
    expect((error as GrpcError).code).toBe(GrpcStatus.UNAVAILABLE);
  });
});

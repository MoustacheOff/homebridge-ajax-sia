import { createSocket } from 'node:dgram';
import { connect, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFrame } from '../src/sia/frame.js';
import { SiaReceiver, type Message } from '../src/sia/receiver.js';
import { SiaServer, type Logger } from '../src/sia/server.js';
import { ACCOUNT, KEY, hubMessage, unframe } from './helpers.js';

const silent: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let server: SiaServer | undefined;
let socket: Socket | undefined;

afterEach(async () => {
  socket?.destroy();
  await server?.stop();
  server = undefined;
  socket = undefined;
});

async function start(options: { allowedAddresses?: string[]; key?: Buffer } = {}): Promise<{ server: SiaServer; messages: Message[] }> {
  const receiver = new SiaReceiver({ account: ACCOUNT, ...(options.key ? { key: options.key } : {}), maxTimeSkewSeconds: 0 });
  server = new SiaServer(
    { port: 0, host: '127.0.0.1', protocol: 'tcp', allowedAddresses: options.allowedAddresses ?? [] },
    receiver,
    silent,
  );
  const messages: Message[] = [];
  server.on('message', (message) => messages.push(message));
  await server.start();
  return { server, messages };
}

const connectTo = (port: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const client = connect(port, '127.0.0.1', () => resolve(client));
    client.once('error', reject);
  });

const nextData = (client: Socket): Promise<string> =>
  new Promise((resolve) => client.once('data', (chunk) => resolve(chunk.toString('latin1'))));

describe('SiaServer over TCP', () => {
  it('acknowledges messages and publishes them', async () => {
    const { server, messages } = await start();
    socket = await connectTo(server.tcpPort!);

    const reply = nextData(socket);
    socket.write(hubMessage({ sequence: '0003', data: 'Nri1/CL501' }), 'latin1');

    expect(parseFrame(unframe(await reply))).toMatchObject({ id: 'ACK', sequence: '0003' });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.events).toEqual([{ code: 'CL', zone: 501, area: 1 }]);
  });

  it('reassembles a message split across packets', async () => {
    const { server, messages } = await start();
    socket = await connectTo(server.tcpPort!);

    const frame = hubMessage({ data: 'Nri1/BA12' });
    const reply = nextData(socket);
    socket.write(frame.slice(0, 15), 'latin1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.write(frame.slice(15), 'latin1');

    await reply;
    expect(messages).toHaveLength(1);
  });

  it('handles several messages in one packet', async () => {
    const { server, messages } = await start();
    socket = await connectTo(server.tcpPort!);

    let received = '';
    socket.on('data', (chunk) => (received += chunk.toString('latin1')));
    socket.write(hubMessage({ sequence: '0001', data: 'Nri1/CL501' }) + hubMessage({ sequence: '0002', data: 'Nri1/BA12' }), 'latin1');

    await vi.waitFor(() => expect(received.split('\r')).toHaveLength(3));
    expect(messages.map((message) => message.sequence)).toEqual(['0001', '0002']);
  });

  it('works with encryption', async () => {
    const { server, messages } = await start({ key: KEY });
    socket = await connectTo(server.tcpPort!);

    const reply = nextData(socket);
    socket.write(hubMessage({ data: 'Nri1/NL4', key: KEY }), 'latin1');

    expect(parseFrame(unframe(await reply))).toMatchObject({ id: 'ACK', encrypted: true });
    expect(messages[0]!.events[0]).toMatchObject({ code: 'NL' });
  });

  it('drops a connection that sends endless garbage', async () => {
    const { server } = await start();
    socket = await connectTo(server.tcpPort!);
    const closed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
    socket.write('x'.repeat(8192));
    await closed;
  });

  it('ignores traffic from addresses that are not allowed', async () => {
    const { server, messages } = await start({ allowedAddresses: ['10.9.9.9'] });
    socket = await connectTo(server.tcpPort!);
    const closed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
    socket.on('error', () => undefined);
    socket.write(hubMessage({ data: 'Nri1/CL501' }), 'latin1');
    await closed;
    expect(messages).toHaveLength(0);
  });

  it('accepts traffic from an allowed address', async () => {
    const { server, messages } = await start({ allowedAddresses: ['127.0.0.1'] });
    socket = await connectTo(server.tcpPort!);
    const reply = nextData(socket);
    socket.write(hubMessage({ data: 'Nri1/CL501' }), 'latin1');
    await reply;
    expect(messages).toHaveLength(1);
  });
});

describe('SiaServer over UDP', () => {
  it('acknowledges a datagram', async () => {
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    server = new SiaServer({ port: 0, host: '127.0.0.1', protocol: 'udp', allowedAddresses: [] }, receiver, silent);
    const messages: Message[] = [];
    server.on('message', (message) => messages.push(message));
    await server.start();

    const client = createSocket('udp4');
    try {
      const reply = new Promise<string>((resolve) => client.once('message', (data) => resolve(data.toString('latin1'))));
      client.send(Buffer.from(hubMessage({ sequence: '0009', data: 'Nri1/OP001' }), 'latin1'), server.udpPort!, '127.0.0.1');

      expect(parseFrame(unframe(await reply))).toMatchObject({ id: 'ACK', sequence: '0009' });
      expect(messages[0]!.events[0]).toMatchObject({ code: 'OP' });
    } finally {
      client.close();
    }
  });
});

describe('SiaServer startup', () => {
  it('fails clearly when the port is taken', async () => {
    const first = await start();
    const receiver = new SiaReceiver({ account: ACCOUNT, maxTimeSkewSeconds: 0 });
    const second = new SiaServer(
      { port: first.server.tcpPort!, host: '127.0.0.1', protocol: 'tcp', allowedAddresses: [] },
      receiver,
      silent,
    );
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

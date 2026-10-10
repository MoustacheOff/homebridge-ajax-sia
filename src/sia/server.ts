import { EventEmitter } from 'node:events';
import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server as TcpServer, type Socket } from 'node:net';

import type { Message, SiaReceiver } from './receiver.js';

export type Protocol = 'tcp' | 'udp' | 'both';

export interface Logger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export interface ServerOptions {
  port: number;
  host: string;
  protocol: Protocol;
  /** When non-empty, traffic from any other address is dropped. */
  allowedAddresses: string[];
}

interface ServerEvents {
  message: [Message];
  error: [Error];
}

const MAX_CONNECTIONS = 16;
/** A DC-09 message is a few hundred bytes; anything past this without a terminator is garbage. */
const MAX_BUFFERED_CHARS = 4096;

/** Listens for SIA DC-09 traffic from the hub, over TCP and/or UDP. */
export class SiaServer extends EventEmitter<ServerEvents> {
  private tcp?: TcpServer;
  private udp?: UdpSocket;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly options: ServerOptions,
    private readonly receiver: SiaReceiver,
    private readonly log: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    const { protocol } = this.options;
    if (protocol === 'tcp' || protocol === 'both') {
      await this.startTcp();
    }
    if (protocol === 'udp' || protocol === 'both') {
      await this.startUdp();
    }
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await Promise.all([
      new Promise<void>((resolve) => (this.tcp ? this.tcp.close(() => resolve()) : resolve())),
      new Promise<void>((resolve) => (this.udp ? this.udp.close(() => resolve()) : resolve())),
    ]);
    this.tcp = undefined;
    this.udp = undefined;
  }

  /** Port the TCP listener is bound to (useful when started on port 0). */
  get tcpPort(): number | undefined {
    const address = this.tcp?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  get udpPort(): number | undefined {
    return this.udp?.address().port;
  }

  private isAllowed(address: string | undefined): boolean {
    const { allowedAddresses } = this.options;
    if (allowedAddresses.length === 0) {
      return true;
    }
    return address !== undefined && allowedAddresses.includes(address.replace(/^::ffff:/, ''));
  }

  private startTcp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket));
      server.maxConnections = MAX_CONNECTIONS;
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        server.on('error', (error) => this.emit('error', error));
        this.tcp = server;
        this.log.info(`Listening for the hub on tcp://${this.options.host}:${this.tcpPort}`);
        resolve();
      });
    });
  }

  private startUdp(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.on('message', (data, remote) => {
        if (!this.isAllowed(remote.address)) {
          this.log.debug(`Dropped datagram from ${remote.address}`);
          return;
        }
        const reply = this.handle(data.toString('latin1').replace(/^[\r\n]+|[\r\n]+$/g, ''), remote.address);
        if (reply) {
          socket.send(Buffer.from(reply, 'latin1'), remote.port, remote.address);
        }
      });
      socket.bind(this.options.port, this.options.host, () => {
        socket.off('error', reject);
        socket.on('error', (error) => this.emit('error', error));
        this.udp = socket;
        this.log.info(`Listening for the hub on udp://${this.options.host}:${this.udpPort}`);
        resolve();
      });
    });
  }

  private accept(socket: Socket): void {
    const remote = socket.remoteAddress;
    if (!this.isAllowed(remote)) {
      this.log.debug(`Refused connection from ${remote}`);
      socket.destroy();
      return;
    }

    this.log.debug(`Hub connected from ${remote}`);
    this.sockets.add(socket);
    socket.setKeepAlive(true, 60_000);
    socket.setNoDelay(true);
    socket.setEncoding('latin1');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r'); end >= 0; end = buffer.indexOf('\r')) {
        const line = buffer.slice(0, end).replace(/^\n+/, '');
        buffer = buffer.slice(end + 1);
        const reply = this.handle(line, remote);
        if (reply) {
          socket.write(reply, 'latin1');
        }
      }
      if (buffer.length > MAX_BUFFERED_CHARS) {
        this.log.warn(`Dropping connection from ${remote}: oversized message`);
        socket.destroy();
      }
    });
    socket.on('error', (error) => this.log.debug(`Socket error from ${remote}: ${error.message}`));
    socket.on('close', () => {
      this.sockets.delete(socket);
      this.log.debug(`Hub disconnected (${remote})`);
    });
  }

  /** Runs one message through the receiver, publishes it, and returns the reply to send. */
  private handle(line: string, remote: string | undefined): string | null {
    if (line.length === 0) {
      return null;
    }
    this.log.debug(`<- ${remote} ${JSON.stringify(line)}`);
    const { reply, message, problem } = this.receiver.receive(line);
    if (problem) {
      this.log.warn(`Rejected message from ${remote}: ${problem}`);
    }
    if (message) {
      this.emit('message', message);
    }
    return reply;
  }
}

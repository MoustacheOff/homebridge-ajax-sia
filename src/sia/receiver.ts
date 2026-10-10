import { FrameError, buildFrame, decryptBody, encryptBody, formatTimestamp, parseFrame, type Frame } from './frame.js';
import { parseDataBlock, type DataBlock, type SiaEvent } from './event.js';

export interface ReceiverOptions {
  /** Account (Ajax "object number") the hub reports with. Messages from other accounts are refused. */
  account: string;
  /** AES key. When set, only encrypted messages are accepted. */
  key?: Buffer;
  /** Maximum clock difference tolerated on timestamped messages, in seconds. 0 disables the check. */
  maxTimeSkewSeconds: number;
}

/** An accepted message: either a set of events, or a link test (no events). */
export interface Message {
  account: string;
  sequence: string;
  events: SiaEvent[];
  timestamp?: Date;
}

export interface Reception {
  /** Bytes to send back to the hub, `null` when the input was not worth answering. */
  reply: string | null;
  /** Set when the message was accepted. */
  message?: Message;
  /** Set when the message was rejected. */
  problem?: string;
}

type Verdict = 'ACK' | 'NAK' | 'DUH';

/**
 * Protocol logic of a SIA DC-09 receiver: validates a message and produces the
 * reply the hub expects. Pure and transport-agnostic.
 */
export class SiaReceiver {
  constructor(private readonly options: ReceiverOptions) {}

  receive(line: string, now: Date = new Date()): Reception {
    let frame: Frame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      // A corrupted message is worth a NAK; something that is not DC-09 at all is not.
      return error instanceof FrameError && error.reason === 'crc'
        ? { reply: this.nak(now), problem }
        : { reply: null, problem };
    }

    if (frame.account && frame.account !== this.options.account) {
      return { reply: this.nak(now), problem: `Unknown account ${frame.account}` };
    }

    const content = this.unwrap(frame);
    if (typeof content !== 'string') {
      return { reply: this.nak(now), problem: content.problem };
    }

    if (frame.id !== 'SIA-DCS' && frame.id !== 'NULL') {
      return { reply: this.respond('DUH', frame, now), problem: `Unsupported protocol ${frame.id} (select SIA-DCS on the hub)` };
    }

    let block: DataBlock;
    try {
      block = parseDataBlock(content);
    } catch (error) {
      return { reply: this.respond('DUH', frame, now), problem: error instanceof Error ? error.message : String(error) };
    }

    if (block.account && block.account !== this.options.account) {
      return { reply: this.nak(now), problem: `Unknown account ${block.account}` };
    }

    const { maxTimeSkewSeconds } = this.options;
    if (maxTimeSkewSeconds > 0 && block.timestamp) {
      const skew = Math.abs(now.getTime() - block.timestamp.getTime()) / 1000;
      if (skew > maxTimeSkewSeconds) {
        return {
          reply: this.nak(now),
          problem: `Timestamp off by ${Math.round(skew)}s (limit ${maxTimeSkewSeconds}s); check the hub and Homebridge clocks`,
        };
      }
    }

    return {
      reply: this.respond('ACK', frame, now),
      message: {
        account: this.options.account,
        sequence: frame.sequence,
        events: block.events,
        ...(block.timestamp ? { timestamp: block.timestamp } : {}),
      },
    };
  }

  /** Returns the plain data block, or the reason it cannot be read. */
  private unwrap(frame: Frame): string | { problem: string } {
    const { key } = this.options;
    if (frame.encrypted) {
      if (!key) {
        return { problem: 'Encrypted message received but no encryptionKey is configured' };
      }
      try {
        return decryptBody(frame.body, key);
      } catch (error) {
        return { problem: error instanceof Error ? error.message : String(error) };
      }
    }
    if (key) {
      return { problem: 'Unencrypted message refused: an encryptionKey is configured' };
    }
    return frame.body;
  }

  private respond(verdict: Verdict, frame: Frame, now: Date): string {
    const header = `"${frame.encrypted && verdict === 'ACK' ? '*' : ''}${verdict}"${frame.sequence}${frame.receiver}${frame.line}`
      + `#${frame.account || this.options.account}[`;
    if (frame.encrypted && verdict === 'ACK' && this.options.key) {
      return buildFrame(header + encryptBody(`]${formatTimestamp(now)}`, this.options.key));
    }
    return buildFrame(`${header}]`);
  }

  private nak(now: Date): string {
    return buildFrame(`"NAK"0000R0L0A0[]${formatTimestamp(now)}`);
  }
}

import type { CloudDevice, DeviceListener } from './ajax.js';
import type { Stream } from './grpc.js';

export interface LiveHandlers {
  /** The devices, whole, each time something about them changed. */
  devices(devices: CloudDevice[]): void;
  /** The link came up, for the first time or after a loss. */
  up(): void;
  /** The link is down and will be tried again in `retryInMs`. `error` is unset when Ajax closed the stream normally. */
  down(error: Error | undefined, retryInMs: number): void;
  /** Whether this failure is one that trying again cannot fix. When it is, the link stays down. */
  fatal(error: Error): boolean;
  /** An attempt failed again while the link was already down. */
  retryFailed?(error: Error): void;
}

export interface LiveOptions {
  /** First wait before trying again, which doubles on each failure. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** A link that held this long is considered healthy, so the next wait starts again from the minimum. */
  stableMs?: number;
}

/**
 * Keeps the stream of devices open: opens it, hands over what it says, and opens it again after a loss, waiting
 * longer after each failure so that a refusal does not turn into a flood.
 */
export class LiveDevices {
  private stream?: Stream;
  private timer?: NodeJS.Timeout;
  private delay: number;
  private upSince?: number;
  private stopped = true;
  private wasDown = false;
  private generation = 0;

  constructor(
    private readonly open: (listener: DeviceListener) => Promise<Stream>,
    private readonly handlers: LiveHandlers,
    private readonly options: LiveOptions = {},
  ) {
    this.delay = this.minDelay;
  }

  /** The stream is open and has delivered the devices. */
  get connected(): boolean {
    return this.upSince !== undefined;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.stream?.close();
    this.stream = undefined;
    this.upSince = undefined;
  }

  private get minDelay(): number {
    return this.options.minDelayMs ?? 5_000;
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const current = () => !this.stopped && generation === this.generation;
    try {
      const stream = await this.open({
        devices: (devices) => {
          if (!current()) {
            return;
          }
          if (this.upSince === undefined) {
            this.upSince = Date.now();
            this.wasDown = false;
            this.handlers.up();
          }
          this.handlers.devices(devices);
        },
        end: (error) => {
          if (current()) {
            this.lost(error);
          }
        },
        skipped: () => undefined,
      });
      if (current()) {
        this.stream = stream;
      } else {
        stream.close();
      }
    } catch (error) {
      if (current()) {
        this.lost(error as Error);
      }
    }
  }

  private lost(error: Error | undefined): void {
    const stable = this.options.stableMs ?? 60_000;
    if (this.upSince !== undefined && Date.now() - this.upSince >= stable) {
      this.delay = this.minDelay;
    }
    const wasUp = this.upSince !== undefined || !this.wasDown;
    this.upSince = undefined;
    this.stream?.close();
    this.stream = undefined;

    if (error && this.handlers.fatal(error)) {
      this.stopped = true;
      this.handlers.down(error, Infinity);
      return;
    }

    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, this.options.maxDelayMs ?? 60_000);
    this.wasDown = true;
    if (wasUp) {
      this.handlers.down(error, wait);
    } else if (error) {
      this.handlers.retryFailed?.(error);
    }
    this.timer = setTimeout(() => void this.connect(), wait);
    this.timer.unref();
  }
}

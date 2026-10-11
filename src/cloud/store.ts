import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Session } from './ajax.js';

interface Stored {
  deviceId: string;
  session?: Session;
  /** How the client was named when the session was opened. */
  identity?: string;
}

/**
 * Keeps the identity announced to Ajax across restarts. Reusing the same device id and session avoids
 * registering a new device and opening a new session in the account every time Homebridge restarts.
 */
export class CloudStore {
  private readonly file: string;
  private data: Stored;

  constructor(directory: string) {
    this.file = join(directory, 'homebridge-ajax-sia-cloud.json');
    this.data = this.read() ?? { deviceId: randomUUID() };
    this.write();
  }

  get deviceId(): string {
    return this.data.deviceId;
  }

  get session(): Session | undefined {
    return this.data.session;
  }

  get identity(): string | undefined {
    return this.data.identity;
  }

  /** Remembers the session, and the identity it was opened under. */
  save(session: Session | undefined, identity?: string): void {
    if (session) {
      this.data.session = session;
    } else {
      delete this.data.session;
    }
    if (identity !== undefined) {
      this.data.identity = identity;
    }
    this.write();
  }

  private read(): Stored | undefined {
    try {
      if (!existsSync(this.file)) {
        return undefined;
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>;
      if (typeof parsed.deviceId !== 'string' || !parsed.deviceId) {
        return undefined;
      }
      return {
        deviceId: parsed.deviceId,
        ...(parsed.session ? { session: parsed.session } : {}),
        ...(typeof parsed.identity === 'string' ? { identity: parsed.identity } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private write(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
      chmodSync(this.file, 0o600);
    } catch {
      // Not being able to persist only costs a new login after the next restart.
    }
  }
}

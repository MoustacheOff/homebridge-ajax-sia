import type { ArmState } from '../ajax/model.js';
import type { AjaxCloud, Space, SpaceState } from './ajax.js';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface ControllerOptions {
  spaceId?: string;
  spaceName?: string;
}

/** The commands HomeKit can send. "Home" has no Ajax equivalent without groups, so it is not offered. */
export type Target = 'away' | 'night' | 'disarmed';

const STATES: Partial<Record<SpaceState, ArmState>> = {
  armed: 'away',
  night: 'night',
  partial: 'stay',
  disarmed: 'disarmed',
};

/**
 * Turns "go to this state" into the right sequence of Ajax commands, and reads the state back.
 * Commands are serialised: the hub cannot take two transitions at once.
 */
export class CloudController {
  private spaceId?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cloud: AjaxCloud,
    private readonly options: ControllerOptions,
    private readonly log: Logger,
  ) {
    this.spaceId = options.spaceId;
  }

  /** Reads the current arming state. `undefined` while the hub is in a transitional state. */
  async read(): Promise<ArmState | undefined> {
    const space = await this.space();
    return STATES[space.state];
  }

  /** Moves the space to `target`, from the state it is believed to be in. */
  command(target: Target, current: ArmState): Promise<void> {
    return this.enqueue(async () => {
      const id = this.spaceId ?? (await this.space()).id;
      const run = async (command: Parameters<AjaxCloud['command']>[1]) => {
        this.log.debug(`Sending "${command}"`);
        await this.cloud.command(id, command);
      };

      switch (target) {
        case 'disarmed':
          await run(current === 'night' ? 'disarmFromNightMode' : 'disarm');
          return;
        case 'away':
          if (current === 'night') {
            await run('disarmFromNightMode');
          }
          await run('arm');
          return;
        case 'night':
          if (current === 'away' || current === 'stay') {
            await run('disarm');
          }
          await run('armToNightMode');
          return;
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async space(): Promise<Space> {
    const spaces = await this.cloud.spaces();
    const wanted = this.spaceId
      ? spaces.find((space) => space.id === this.spaceId)
      : this.options.spaceName
        ? spaces.find((space) => space.name === this.options.spaceName)
        : spaces.length === 1 ? spaces[0] : undefined;

    if (!wanted) {
      const list = spaces.map((space) => `"${space.name}" (${space.id})`).join(', ') || 'none';
      throw new Error(
        this.spaceId || this.options.spaceName
          ? `Ajax space not found. Spaces on this account: ${list}`
          : `Several Ajax spaces on this account, set "cloud.spaceName": ${list}`,
      );
    }
    if (!this.spaceId) {
      this.spaceId = wanted.id;
      this.log.info(`Using Ajax space "${wanted.name}" (${wanted.id})`);
    }
    return wanted;
  }
}

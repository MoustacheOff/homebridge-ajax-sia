import { describe, expect, it, vi } from 'vitest';

import { CloudError, type AjaxCloud, type Space } from '../../src/cloud/ajax.js';
import { CloudController } from '../../src/cloud/controller.js';

const space = (id: string, name: string, state: Space['state'] = 'disarmed'): Space => ({ id, hubId: '', name, state, online: true });
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

function make(spaces: Space[], options: { spaceId?: string; spaceName?: string } = {}) {
  const sent: string[] = [];
  const cloud = {
    spaces: vi.fn(async () => spaces),
    command: vi.fn(async (_id: string, command: string) => void sent.push(command)),
  } as unknown as AjaxCloud;
  return { controller: new CloudController(cloud, options, log), cloud, sent };
}

describe('CloudController commands', () => {
  it.each([
    ['disarmed', 'away', ['disarm']],
    ['disarmed', 'stay', ['disarm']],
    ['disarmed', 'night', ['disarm']],
    ['disarmed', 'disarmed', ['disarm']],
    ['away', 'disarmed', ['arm']],
    ['away', 'away', ['arm']],
    ['away', 'night', ['disarm', 'arm']],
    ['night', 'disarmed', ['armToNightMode']],
    ['night', 'away', ['disarm', 'armToNightMode']],
    ['night', 'night', ['armToNightMode']],
  ] as const)('to %s from %s sends %j', async (target, current, expected) => {
    const { controller, sent } = make([space('s1', 'Home')]);
    await controller.command(target, current);
    expect(sent).toEqual(expected);
  });

  describe('leaving night mode', () => {
    const refused = (detail: string) => new CloudError('rejected', `Ajax refused: ${detail}`, detail);

    it('uses a plain disarm: that is what a space without groups accepts', async () => {
      const { controller, sent } = make([space('s1', 'Home')]);
      await controller.command('disarmed', 'night');
      expect(sent).toEqual(['disarm']);
    });

    it('falls back to the night mode command when Ajax says the space uses groups', async () => {
      const { controller, cloud, sent } = make([space('s1', 'Home')]);
      (cloud.command as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        throw refused('illegal_space_security_mode');
      });

      await controller.command('disarmed', 'night');
      expect(sent).toEqual(['disarmFromNightMode']);
    });

    it('does not fall back on other refusals', async () => {
      const { controller, cloud, sent } = make([space('s1', 'Home')]);
      (cloud.command as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
        throw refused('hub_busy');
      });

      await expect(controller.command('disarmed', 'night')).rejects.toThrow('hub_busy');
      expect(sent).toEqual([]);
    });

    it('does not fall back when the failure is not a refusal from Ajax', async () => {
      const { controller, cloud, sent } = make([space('s1', 'Home')]);
      (cloud.command as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

      await expect(controller.command('disarmed', 'night')).rejects.toThrow('network down');
      expect(sent).toEqual([]);
    });
  });

  it('serialises commands: the hub takes one transition at a time', async () => {
    const order: string[] = [];
    const cloud = {
      spaces: vi.fn(async () => [space('s1', 'Home')]),
      command: vi.fn(async (_id: string, command: string) => {
        order.push(`start ${command}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push(`end ${command}`);
      }),
    } as unknown as AjaxCloud;
    const controller = new CloudController(cloud, {}, log);

    await Promise.all([controller.command('away', 'disarmed'), controller.command('disarmed', 'away')]);
    expect(order).toEqual(['start arm', 'end arm', 'start disarm', 'end disarm']);
  });

  it('keeps going after a failed command', async () => {
    const { controller, cloud, sent } = make([space('s1', 'Home')]);
    (cloud.command as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('hub busy'));

    await expect(controller.command('away', 'disarmed')).rejects.toThrow('hub busy');
    await controller.command('away', 'disarmed');
    expect(sent).toEqual(['arm']);
  });

  it('only lists the spaces once', async () => {
    const { controller, cloud } = make([space('s1', 'Home')]);
    await controller.command('away', 'disarmed');
    await controller.command('disarmed', 'away');
    expect(cloud.spaces).toHaveBeenCalledTimes(1);
  });
});

describe('CloudController space selection', () => {
  const two = [space('s1', 'Home'), space('s2', 'Garage')];

  it('uses the only space', async () => {
    const { controller, cloud } = make([space('s1', 'Home')]);
    await controller.command('away', 'disarmed');
    expect(cloud.command).toHaveBeenCalledWith('s1', 'arm');
  });

  it('asks for a name when there are several', async () => {
    const { controller } = make(two);
    await expect(controller.command('away', 'disarmed')).rejects.toThrow(/Several Ajax spaces.*"Home" \(s1\).*"Garage" \(s2\)/);
  });

  it('picks a space by name', async () => {
    const { controller, cloud } = make(two, { spaceName: 'Garage' });
    await controller.command('away', 'disarmed');
    expect(cloud.command).toHaveBeenCalledWith('s2', 'arm');
  });

  it('picks a space by id, without listing for commands', async () => {
    const { controller, cloud } = make(two, { spaceId: 's2' });
    await controller.command('away', 'disarmed');
    expect(cloud.spaces).not.toHaveBeenCalled();
    expect(cloud.command).toHaveBeenCalledWith('s2', 'arm');
  });

  it('says which spaces exist when the wanted one does not', async () => {
    const { controller } = make(two, { spaceName: 'Cellar' });
    await expect(controller.read()).rejects.toThrow(/not found.*"Home"/);
  });
});

describe('CloudController.read', () => {
  it.each([
    ['armed', 'away'], ['night', 'night'], ['partial', 'stay'], ['disarmed', 'disarmed'],
  ] as const)('reads %s as %s', async (state, expected) => {
    const { controller } = make([space('s1', 'Home', state)]);
    expect(await controller.read()).toBe(expected);
  });

  it.each(['exit-delay', 'none', 'unknown'] as const)('reports nothing while the hub is %s', async (state) => {
    const { controller } = make([space('s1', 'Home', state)]);
    expect(await controller.read()).toBeUndefined();
  });
});

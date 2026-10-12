import { beforeEach, describe, expect, it } from 'vitest';

import { AjaxModel, isZoneCode, type HubState, type ZoneState } from '../src/ajax/model.js';
import type { SiaEvent } from '../src/sia/event.js';

const ev = (code: string, zone?: number, area?: number): SiaEvent => ({
  code,
  ...(zone !== undefined ? { zone } : {}),
  ...(area !== undefined ? { area } : {}),
});

describe('AjaxModel', () => {
  let model: AjaxModel;
  let hubUpdates: HubState[];
  let zoneUpdates: [number, ZoneState][];

  beforeEach(() => {
    model = new AjaxModel();
    hubUpdates = [];
    zoneUpdates = [];
    model.on('hub', (hub) => hubUpdates.push(hub));
    model.on('zone', (zone, state) => zoneUpdates.push([zone, state]));
  });

  describe('arming', () => {
    it('starts disarmed', () => {
      expect(model.hub).toEqual({ arm: 'disarmed', alarm: false, tampered: false, fault: false });
    });

    it('arms and disarms', () => {
      model.apply(ev('CL', 501, 1));
      expect(model.hub.arm).toBe('away');
      model.apply(ev('OP', 501, 1));
      expect(model.hub.arm).toBe('disarmed');
    });

    it('enters and leaves night mode', () => {
      model.apply(ev('NL', 4, 1));
      expect(model.hub.arm).toBe('night');
      model.apply(ev('NP'));
      expect(model.hub.arm).toBe('disarmed');
    });

    it('prefers night mode over a plain armed state', () => {
      model.apply(ev('CG', undefined, 1));
      model.apply(ev('NL', undefined, 1));
      expect(model.hub.arm).toBe('night');
    });

    it('a disarm cancels night mode', () => {
      model.apply(ev('NL', undefined, 1));
      model.apply(ev('OP', 501, 1));
      expect(model.hub.arm).toBe('disarmed');
    });

    it.each(['CL', 'CA', 'CP', 'CF', 'CG'])('%s arms', (code) => {
      model.apply(ev(code, undefined, 1));
      expect(model.hub.arm).toBe('away');
    });

    it.each(['OP', 'OA', 'OK', 'OR', 'OS', 'OG'])('%s disarms', (code) => {
      model.apply(ev('CL', undefined, 1));
      model.apply(ev(code, undefined, 1));
      expect(model.hub.arm).toBe('disarmed');
    });

    it('reports a partial arm as "stay" until every area is armed', () => {
      const groups = new AjaxModel(2);
      groups.apply(ev('CG', undefined, 1));
      expect(groups.hub.arm).toBe('stay');
      groups.apply(ev('CG', undefined, 2));
      expect(groups.hub.arm).toBe('away');
      groups.apply(ev('OG', undefined, 1));
      expect(groups.hub.arm).toBe('stay');
      groups.apply(ev('OP'));
      expect(groups.hub.arm).toBe('disarmed');
    });

    it('only emits when something changed', () => {
      model.apply(ev('CL', 1, 1));
      model.apply(ev('CL', 1, 1));
      expect(hubUpdates.map((hub) => hub.arm)).toEqual(['away']);
    });

    it('survives a restart through a snapshot', () => {
      model.apply(ev('NL', undefined, 1));
      const restored = new AjaxModel();
      restored.restore(model.snapshot());
      expect(restored.hub.arm).toBe('night');
    });
  });

  describe('alarms', () => {
    it('raises the hub alarm on an intrusion and tracks the zone', () => {
      model.apply(ev('CL', undefined, 1));
      model.apply(ev('BA', 12, 1));
      expect(model.hub.alarm).toBe(true);
      expect(model.zone(12).intrusion).toBe(true);
    });

    it('clears an intrusion on restore', () => {
      model.apply(ev('BA', 12));
      model.apply(ev('BR', 12));
      expect(model.hub.alarm).toBe(false);
      expect(model.zone(12).intrusion).toBe(false);
    });

    it('treats a verified burglary as an alarm of the hub, whose number is an area and not a detector', () => {
      model.apply(ev('BV', 3, 1));
      expect(model.hub.alarm).toBe(true);
      expect(model.zone(3).intrusion).toBe(false);
      expect(zoneUpdates).toEqual([]);

      model.apply(ev('OP', 501, 1));
      expect(model.hub.alarm).toBe(false);
    });

    it('keeps the alarm while another zone is still tripped', () => {
      model.apply(ev('BA', 1));
      model.apply(ev('BA', 2));
      model.apply(ev('BR', 1));
      expect(model.hub.alarm).toBe(true);
    });

    it('a disarm acknowledges intrusions and panics', () => {
      model.apply(ev('CL', undefined, 1));
      model.apply(ev('BA', 12));
      model.apply(ev('PA'));
      model.apply(ev('OP', 501, 1));
      expect(model.hub.alarm).toBe(false);
      expect(model.zone(12).intrusion).toBe(false);
    });

    it('a disarm does not silence a fire alarm', () => {
      model.apply(ev('FA', 7));
      model.apply(ev('OP', 501, 1));
      expect(model.hub.alarm).toBe(true);
      expect(model.zone(7).fire).toBe(true);
      model.apply(ev('FR', 7));
      expect(model.hub.alarm).toBe(false);
    });

    it('shows a leak on the sensor without triggering the hub', () => {
      model.apply(ev('WA', 9));
      expect(model.zone(9).water).toBe(true);
      expect(model.hub.alarm).toBe(false);
    });

    it('raises on gas and heat', () => {
      model.apply(ev('GA', 3));
      expect(model.zone(3).gas).toBe(true);
      model.apply(ev('KA', 4));
      expect(model.zone(4).fire).toBe(true);
      expect(model.hub.alarm).toBe(true);
    });

    it('a panic button raises the hub alarm', () => {
      model.apply(ev('PA'));
      expect(model.hub.alarm).toBe(true);
      model.apply(ev('PR'));
      expect(model.hub.alarm).toBe(false);
    });

    it('announces every alarm, even a repeat', () => {
      const seen: number[] = [];
      model.on('alarm', (zone) => seen.push(zone));
      model.apply(ev('BA', 5));
      model.apply(ev('BA', 5));
      expect(seen).toEqual([5, 5]);
      expect(zoneUpdates).toHaveLength(1);
    });
  });

  describe('tamper, battery and faults', () => {
    it('tracks tamper per zone', () => {
      model.apply(ev('TA', 3));
      expect(model.zone(3).tampered).toBe(true);
      expect(model.hub.tampered).toBe(false);
      model.apply(ev('TR', 3));
      expect(model.zone(3).tampered).toBe(false);
    });

    it('treats a tamper without zone as the hub', () => {
      model.apply(ev('TA'));
      expect(model.hub.tampered).toBe(true);
      model.apply(ev('TR', 0));
      expect(model.hub.tampered).toBe(false);
    });

    it('tracks the battery of a detector', () => {
      model.apply(ev('XT', 3));
      expect(model.zone(3).lowBattery).toBe(true);
      model.apply(ev('XR', 3));
      expect(model.zone(3).lowBattery).toBe(false);
    });

    it('reports hub power troubles as a fault until all are restored', () => {
      model.apply(ev('AT'));
      model.apply(ev('YT'));
      expect(model.hub.fault).toBe(true);
      model.apply(ev('AR'));
      expect(model.hub.fault).toBe(true);
      model.apply(ev('YR'));
      expect(model.hub.fault).toBe(false);
    });

    it('reports a silent hub as a fault', () => {
      model.setOffline(true);
      expect(model.hub.fault).toBe(true);
      model.setOffline(false);
      expect(model.hub.fault).toBe(false);
    });
  });

  it('reports events it does not understand', () => {
    const ignored: string[] = [];
    model.on('ignored', (event) => ignored.push(event.code));
    model.apply(ev('RP'));
    expect(ignored).toEqual(['RP']);
  });

  it('knows which codes carry a zone', () => {
    expect(isZoneCode('BA')).toBe(true);
    expect(isZoneCode('XT')).toBe(true);
    expect(isZoneCode('CL')).toBe(false);
    // "Burglary verified" carries an area, not a detector.
    expect(isZoneCode('BV')).toBe(false);
  });
});

describe('AjaxModel.reconcile', () => {
  it.each([
    ['away', 'away'], ['night', 'night'], ['disarmed', 'disarmed'], ['stay', 'stay'],
  ] as const)('adopts %s', (arm, expected) => {
    const model = new AjaxModel(2);
    model.reconcile(arm);
    expect(model.hub.arm).toBe(expected);
  });

  it('replaces what the events had said', () => {
    const model = new AjaxModel();
    model.apply({ code: 'NL', area: 1 });
    model.reconcile('disarmed');
    expect(model.hub.arm).toBe('disarmed');
  });

  it('leaves alarms alone and announces the change', () => {
    const model = new AjaxModel();
    const seen: string[] = [];
    model.on('hub', (hub) => seen.push(hub.arm));
    model.apply({ code: 'BA', zone: 3 });
    model.reconcile('away');
    expect(model.hub.alarm).toBe(true);
    expect(seen.at(-1)).toBe('away');
  });
});

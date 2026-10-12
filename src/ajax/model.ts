import { EventEmitter } from 'node:events';

import type { SiaEvent } from '../sia/event.js';

export type ArmState = 'disarmed' | 'stay' | 'away' | 'night';

export interface HubState {
  arm: ArmState;
  /** An alarm is active (intrusion, panic, fire, ...) and has not been cleared yet. */
  alarm: boolean;
  tampered: boolean;
  /** Mains/battery trouble on the hub, or the hub went silent. */
  fault: boolean;
}

export interface ZoneState {
  intrusion: boolean;
  fire: boolean;
  water: boolean;
  gas: boolean;
  tampered: boolean;
  lowBattery: boolean;
}

/** What a persisted snapshot of the arming state looks like. */
export interface ArmSnapshot {
  armedAreas: number[];
  night: boolean;
}

export type AlarmKind = 'intrusion' | 'fire' | 'water' | 'gas' | 'panic';

interface ModelEvents {
  hub: [HubState];
  zone: [number, ZoneState];
  /** Fired for every alarm event on a zone, even a repeat that leaves the state unchanged (a motion detector re-triggering). */
  alarm: [number, AlarmKind];
  /** Fired for every event the model has no use for, so it can be logged for troubleshooting. */
  ignored: [SiaEvent];
}

/** Zone reserved for the hub itself: tamper, battery and mains events carry no zone, or zone 0. */
const HUB_ZONE = 0;

const ARMED_CODES = new Set(['CL', 'CA', 'CP', 'CF', 'CG']);
const DISARMED_CODES = new Set(['OP', 'OA', 'OK', 'OR', 'OS', 'OG']);

/** Alarm code -> what it raises. The matching restore codes clear it. */
const ALARMS: Record<string, AlarmKind> = {
  BA: 'intrusion', BV: 'intrusion',
  FA: 'fire', KA: 'fire',
  WA: 'water',
  GA: 'gas',
  PA: 'panic', HA: 'panic',
};
const RESTORES: Record<string, AlarmKind> = {
  BR: 'intrusion', BH: 'intrusion',
  FR: 'fire', FH: 'fire', KR: 'fire', KH: 'fire',
  WR: 'water', WH: 'water',
  GR: 'gas', GH: 'gas',
  PR: 'panic', HR: 'panic',
};

/** Alarms that a disarm acknowledges. Fire, water and gas stay until the detector reports a restore. */
const CLEARED_BY_DISARM = new Set<AlarmKind>(['intrusion', 'panic']);

/** Alarm kinds that make the hub itself report "alarm triggered". Leaks are shown on the leak sensor only. */
const HUB_ALARMS = new Set<AlarmKind>(['intrusion', 'fire', 'gas', 'panic']);

/**
 * Alarm codes that are about an area, not a detector: SIA says the zone is "not sent", so a number after
 * the code is the area, and the alarm belongs to the hub alone.
 */
const AREA_ALARMS: ReadonlySet<string> = new Set(['BV']);

const ZONE_CODES = new Set([
  ...Object.keys(ALARMS).filter((code) => !AREA_ALARMS.has(code)),
  ...Object.keys(RESTORES),
  'TA', 'TR', 'XT', 'XR',
]);

/** Whether the number that follows this code is a zone (as opposed to a user, for instance). */
export const isZoneCode = (code: string): boolean => ZONE_CODES.has(code);

const emptyZone =(): ZoneState => ({ intrusion: false, fire: false, water: false, gas: false, tampered: false, lowBattery: false });

/**
 * The Ajax system as seen through its SIA events. Pure state machine: feed it events, listen for changes.
 *
 * SIA only reports transitions, so the model is only as good as the events it has seen. It can be seeded
 * with a snapshot (see {@link restore}) to survive restarts.
 */
export class AjaxModel extends EventEmitter<ModelEvents> {
  private readonly armedAreas = new Set<number>();
  private night = false;
  private offline = false;
  private hubTampered = false;
  private readonly hubFaults = new Set<string>();
  private readonly alarms = new Map<string, AlarmKind>();
  private readonly zones = new Map<number, ZoneState>();
  private last?: HubState;

  /** @param areaCount number of areas (Ajax groups) that must all be armed to count as "away". */
  constructor(private readonly areaCount = 1) {
    super();
  }

  get hub(): HubState {
    const armed = this.armedAreas.size;
    let arm: ArmState = 'disarmed';
    if (this.night) {
      arm = 'night';
    } else if (armed >= this.areaCount) {
      arm = 'away';
    } else if (armed > 0) {
      arm = 'stay';
    }
    return {
      arm,
      alarm: [...this.alarms.values()].some((kind) => HUB_ALARMS.has(kind)),
      tampered: this.hubTampered,
      fault: this.offline || this.hubFaults.size > 0,
    };
  }

  zone(zone: number): ZoneState {
    return { ...(this.zones.get(zone) ?? emptyZone()) };
  }

  snapshot(): ArmSnapshot {
    return { armedAreas: [...this.armedAreas], night: this.night };
  }

  restore(snapshot: Partial<ArmSnapshot>): void {
    this.armedAreas.clear();
    snapshot.armedAreas?.forEach((area) => this.armedAreas.add(area));
    this.night = snapshot.night ?? false;
    this.last = this.hub;
  }

  /** Aligns the arming state with one read from elsewhere (the cloud), without touching alarms. */
  reconcile(arm: ArmState): void {
    this.armedAreas.clear();
    this.night = arm === 'night';
    if (arm === 'away' || arm === 'night') {
      for (let area = 1; area <= this.areaCount; area++) {
        this.armedAreas.add(area);
      }
    } else if (arm === 'stay') {
      this.armedAreas.add(1);
    }
    this.publishHub();
  }

  /** Mark the hub as silent (or back). Surfaced as a fault. */
  setOffline(offline: boolean): void {
    if (this.offline !== offline) {
      this.offline = offline;
      this.publishHub();
    }
  }

  apply(event: SiaEvent): void {
    const { code } = event;

    if (ARMED_CODES.has(code)) {
      this.armedAreas.add(event.area ?? 0);
      this.publishHub();
    } else if (code === 'NL') {
      this.night = true;
      this.publishHub();
    } else if (DISARMED_CODES.has(code)) {
      this.disarm(event.area);
    } else if (code === 'NP') {
      this.night = false;
      this.publishHub();
    } else if (code in ALARMS) {
      this.raise(ALARMS[code]!, event);
    } else if (code in RESTORES) {
      this.restoreAlarm(RESTORES[code]!, event);
    } else if (code === 'TA' || code === 'TR') {
      this.setTamper(event.zone, code === 'TA');
    } else if (code === 'XT' || code === 'XR') {
      this.setBattery(event.zone, code === 'XT');
    } else if (code === 'AT' || code === 'AR') {
      this.setHubFault('mains', code === 'AT');
    } else if (code === 'YT' || code === 'YR') {
      this.setHubFault('battery', code === 'YT');
    } else {
      this.emit('ignored', event);
    }
  }

  private disarm(area: number | undefined): void {
    if (area === undefined || area === 0) {
      this.armedAreas.clear();
    } else {
      this.armedAreas.delete(area);
    }
    this.night = false;

    for (const [key, kind] of this.alarms) {
      if (CLEARED_BY_DISARM.has(kind)) {
        this.alarms.delete(key);
      }
    }
    for (const [zone, state] of this.zones) {
      if (state.intrusion) {
        this.updateZone(zone, { intrusion: false });
      }
    }
    this.publishHub();
  }

  private raise(kind: AlarmKind, event: SiaEvent): void {
    const zone = AREA_ALARMS.has(event.code) ? undefined : event.zone;
    this.alarms.set(`${kind}:${zone ?? HUB_ZONE}`, kind);
    if (zone !== undefined && zone !== HUB_ZONE && kind !== 'panic') {
      this.updateZone(zone, { [kind]: true });
      this.emit('alarm', zone, kind);
    }
    this.publishHub();
  }

  private restoreAlarm(kind: AlarmKind, event: SiaEvent): void {
    this.alarms.delete(`${kind}:${event.zone ?? HUB_ZONE}`);
    if (event.zone !== undefined && event.zone !== HUB_ZONE && kind !== 'panic') {
      this.updateZone(event.zone, { [kind]: false });
    }
    this.publishHub();
  }

  private setTamper(zone: number | undefined, tampered: boolean): void {
    if (zone === undefined || zone === HUB_ZONE) {
      this.hubTampered = tampered;
      this.publishHub();
    } else {
      this.updateZone(zone, { tampered });
    }
  }

  private setBattery(zone: number | undefined, low: boolean): void {
    if (zone === undefined || zone === HUB_ZONE) {
      this.setHubFault('battery', low);
    } else {
      this.updateZone(zone, { lowBattery: low });
    }
  }

  private setHubFault(name: string, active: boolean): void {
    if (active) {
      this.hubFaults.add(name);
    } else {
      this.hubFaults.delete(name);
    }
    this.publishHub();
  }

  private updateZone(zone: number, patch: Partial<ZoneState>): void {
    const before = this.zones.get(zone) ?? emptyZone();
    const after = { ...before, ...patch };
    this.zones.set(zone, after);
    if ((Object.keys(after) as (keyof ZoneState)[]).some((key) => before[key] !== after[key])) {
      this.emit('zone', zone, { ...after });
    }
  }

  private publishHub(): void {
    const now = this.hub;
    const before = this.last;
    this.last = now;
    if (!before || (Object.keys(now) as (keyof HubState)[]).some((key) => before[key] !== now[key])) {
      this.emit('hub', now);
    }
  }
}

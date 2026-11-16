import { EventEmitter } from 'node:events';

import type { SiaEvent } from '../sia/event.js';

export type ArmState = 'disarmed' | 'stay' | 'away' | 'night';

export interface HubState {
  arm: ArmState;
  /** An alarm is active (intrusion, panic, fire, ...) and has not been cleared yet. */
  alarm: boolean;
  tampered: boolean;
  /** Mains/battery trouble or radio interference on the hub, or the hub went silent. */
  fault: boolean;
}

export interface ZoneState {
  intrusion: boolean;
  fire: boolean;
  water: boolean;
  gas: boolean;
  tampered: boolean;
  lowBattery: boolean;
  /** The detector lost contact with the hub (`XL`), until it reports back (`XC`). */
  offline: boolean;
  /** The detector reports a failure (`FT`), a dirty smoke chamber (`FS`) or a faulty CO sensor (`GS`), until it clears. */
  malfunction: boolean;
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

/**
 * Ajax reports an arming as a "restore" and a disarming as an event, whatever the SIA standard calls the code:
 * `OS` is armed with a key switch and `CS` disarmed with one. `AF` and `CB` are the scenario (automatic) variants.
 */
const ARMED_CODES = new Set(['CL', 'CA', 'CP', 'CF', 'CG', 'OS', 'AF', 'CB']);
const DISARMED_CODES = new Set(['OP', 'OA', 'OK', 'OG', 'OB', 'CS']);
/** Night mode entered: by a user (`NL`), by a scenario (`NC`), or with malfunctions present (`NF`, `NB`). */
const NIGHT_CODES = new Set(['NL', 'NC', 'NF', 'NB']);
/** Night mode left: from a device (`NP`), by its schedule (`NO`) or with a duress code (`ND`). */
const NIGHT_OFF_CODES = new Set(['NP', 'NO', 'ND']);

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
 * Detector failures. They raise a fault on the zone, never an alarm. `FJ` (failure over, or smoke chamber clean)
 * clears both `FT` and `FS`; `GX` clears `GS`. `FX` (smoke chamber test passed) says nothing about a fault, so it clears none.
 */
const MALFUNCTIONS: Record<string, string> = { FT: 'FT', FS: 'FS', GS: 'GS' };
const MALFUNCTION_CLEARS = new Map<string, string[]>([['FJ', ['FT', 'FS']], ['GX', ['GS']]]);

const ZONE_CODES = new Set([
  ...Object.keys(ALARMS), ...Object.keys(RESTORES), 'TA', 'TR', 'XT', 'XR', 'XL', 'XC',
  ...Object.keys(MALFUNCTIONS), ...MALFUNCTION_CLEARS.keys(),
]);

/** Whether the number that follows this code is a zone (as opposed to a user, for instance). */
export const isZoneCode = (code: string): boolean => ZONE_CODES.has(code);

const emptyZone = (): ZoneState => ({
  intrusion: false, fire: false, water: false, gas: false, tampered: false, lowBattery: false, offline: false, malfunction: false,
});

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
  private readonly malfunctions = new Map<number, Set<string>>();
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
    } else if (NIGHT_CODES.has(code)) {
      this.night = true;
      this.publishHub();
    } else if (DISARMED_CODES.has(code)) {
      this.disarm(event.area);
    } else if (NIGHT_OFF_CODES.has(code)) {
      this.night = false;
      this.publishHub();
    } else if (code === 'OR') {
      this.acknowledgeAlarms();
    } else if (code === 'FC') {
      this.clearFire();
    } else if (code in ALARMS) {
      this.raise(ALARMS[code]!, event);
    } else if (code in RESTORES) {
      this.restoreAlarm(RESTORES[code]!, event);
    } else if (code === 'TA' || code === 'TR') {
      this.setTamper(event.zone, code === 'TA');
    } else if (code === 'XT' || code === 'XR' || code === 'YT' || code === 'YR') {
      // `YT`/`YR` are the hub's own battery without a zone, and a device's reserve battery with one.
      this.setBattery(event.zone, code === 'XT' || code === 'YT');
    } else if (code === 'XL' || code === 'XC') {
      this.setOfflineZone(event.zone, code === 'XL');
    } else if (code in MALFUNCTIONS || MALFUNCTION_CLEARS.has(code)) {
      this.setMalfunction(event);
    } else if (code === 'XQ' || code === 'XH') {
      // Radio interference: only the hub's own report counts.
      this.setHubOnly('interference', event, code === 'XQ');
    } else if (code === 'AT' || code === 'AR') {
      this.setHubOnly('mains', event, code === 'AT');
    } else if (code === 'YM' || code === 'YA') {
      this.setHubOnly('batteryMissing', event, code === 'YM');
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
    this.acknowledgeAlarms();
  }

  /** Clears the alarms a disarm, or a restore after alarm (`OR`), acknowledges. Arming is left as it is. */
  private acknowledgeAlarms(): void {
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

  /** A user reset the fire alarm state (`FC`): the keypad's fire button and an evacuation send no restore of their own. */
  private clearFire(): void {
    for (const [key, kind] of this.alarms) {
      if (kind === 'fire') {
        this.alarms.delete(key);
      }
    }
    for (const [zone, state] of this.zones) {
      if (state.fire) {
        this.updateZone(zone, { fire: false });
      }
    }
    this.publishHub();
  }

  private raise(kind: AlarmKind, event: SiaEvent): void {
    this.alarms.set(`${kind}:${event.zone ?? HUB_ZONE}`, kind);
    if (event.zone !== undefined && event.zone !== HUB_ZONE && kind !== 'panic') {
      this.updateZone(event.zone, { [kind]: true });
      this.emit('alarm', event.zone, kind);
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

  private setOfflineZone(zone: number | undefined, offline: boolean): void {
    if (zone !== undefined && zone !== HUB_ZONE) {
      this.updateZone(zone, { offline });
    }
  }

  private setMalfunction(event: SiaEvent): void {
    const { code, zone } = event;
    if (zone === undefined || zone === HUB_ZONE) {
      this.emit('ignored', event);
      return;
    }
    const active = this.malfunctions.get(zone) ?? new Set<string>();
    const cleared = MALFUNCTION_CLEARS.get(code);
    if (cleared) {
      cleared.forEach((name) => active.delete(name));
    } else {
      active.add(MALFUNCTIONS[code]!);
    }
    this.malfunctions.set(zone, active);
    this.updateZone(zone, { malfunction: active.size > 0 });
  }

  /**
   * Mains and battery codes are reported by the hub without a zone, and by devices (range extenders, keypads,
   * power supplies) with theirs. Only the hub's own count as a hub fault.
   */
  private setHubOnly(name: string, event: SiaEvent, active: boolean): void {
    if (event.zone === undefined || event.zone === HUB_ZONE) {
      this.setHubFault(name, active);
    } else {
      this.emit('ignored', event);
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

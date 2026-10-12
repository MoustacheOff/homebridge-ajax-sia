import type { API, PlatformAccessory, Service } from 'homebridge';

import type { AjaxModel, ArmState, HubState } from '../ajax/model.js';
import type { AccessoryInfo } from '../config.js';
import { PLUGIN_VERSION } from '../settings.js';

export type HubContext = {
  accountId: string;
  /** Last known arming state, so HomeKit has something to show right after a restart. */
  arm?: ReturnType<AjaxModel['snapshot']>;
};

export type Target = 'away' | 'night' | 'disarmed';

/** Carries out a command from HomeKit. Rejects when the system could not be moved. */
export type Commander = (target: Target, current: ArmState) => Promise<void>;

/** How long the target state may differ from the real one before HomeKit falls back to the real one. */
const PENDING_TIMEOUT_MS = 45_000;

/** The alarm panel, exposed as a HomeKit security system. */
export class HubAccessory {
  private readonly service: Service;
  private hub: HubState;
  private pending?: ArmState;
  private pendingTimer?: NodeJS.Timeout;

  /**
   * @param commander when given, arming and disarming from HomeKit is enabled; otherwise the tile is read-only.
   * @param info what HomeKit shows on the accessory's information page.
   */
  constructor(
    private readonly api: API,
    accessory: PlatformAccessory<HubContext>,
    model: AjaxModel,
    private readonly commander?: Commander,
    info: AccessoryInfo = {},
  ) {
    const { Service, Characteristic, Perms } = api.hap;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Ajax Systems')
      .setCharacteristic(Characteristic.Model, info.model ?? 'Hub')
      .setCharacteristic(Characteristic.SerialNumber, info.serial ?? 'Ajax hub')
      .setCharacteristic(Characteristic.FirmwareRevision, info.firmware ?? PLUGIN_VERSION);

    this.service = accessory.getService(Service.SecuritySystem) ?? accessory.addService(Service.SecuritySystem, accessory.displayName);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.hub = model.hub;

    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState());

    const target = this.service.getCharacteristic(Characteristic.SecuritySystemTargetState).onGet(() => this.targetState());
    if (commander) {
      const { STAY_ARM, AWAY_ARM, NIGHT_ARM, DISARM } = Characteristic.SecuritySystemTargetState;
      // "Home" has no Ajax equivalent without groups, so it is not offered; it can still be read.
      // Set a reachable value first, so narrowing the valid values does not trip over the default of 0.
      target.updateValue(this.targetState());
      target
        .setProps({ perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY], validValues: [AWAY_ARM, NIGHT_ARM, DISARM] })
        .onSet((value) => this.onSetTarget(value as number, { STAY_ARM }));
    } else {
      // SIA is receive-only: without cloud commands the tile just reports the state.
      target.setProps({ perms: [Perms.PAIRED_READ, Perms.NOTIFY] });
    }

    this.service.getCharacteristic(Characteristic.StatusFault)
      .onGet(() => (this.hub.fault ? 1 : 0));
    this.service.getCharacteristic(Characteristic.StatusTampered)
      .onGet(() => (this.hub.tampered ? 1 : 0));

    this.render();
    model.on('hub', (hub) => {
      this.hub = hub;
      accessory.context.arm = model.snapshot();
      this.render();
    });
  }

  dispose(): void {
    clearTimeout(this.pendingTimer);
  }

  private async onSetTarget(value: number, unsupported: { STAY_ARM: number }): Promise<void> {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const { AWAY_ARM, NIGHT_ARM, DISARM } = Characteristic.SecuritySystemTargetState;

    const requested: Record<number, [Target, ArmState]> = {
      [AWAY_ARM]: ['away', 'away'],
      [NIGHT_ARM]: ['night', 'night'],
      [DISARM]: ['disarmed', 'disarmed'],
    };
    const mapped = requested[value];
    if (!mapped || value === unsupported.STAY_ARM) {
      throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
    }

    const [target, expected] = mapped;
    this.setPending(expected);
    try {
      await this.commander!(target, this.hub.arm);
    } catch {
      this.clearPending();
      this.render();
      throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private setPending(arm: ArmState): void {
    clearTimeout(this.pendingTimer);
    this.pending = arm;
    this.pendingTimer = setTimeout(() => {
      this.pending = undefined;
      this.render();
    }, PENDING_TIMEOUT_MS);
  }

  private clearPending(): void {
    clearTimeout(this.pendingTimer);
    this.pending = undefined;
  }

  private currentState(): number {
    const { SecuritySystemCurrentState: State } = this.api.hap.Characteristic;
    if (this.hub.alarm) {
      return State.ALARM_TRIGGERED;
    }
    return this.armValue(this.hub.arm);
  }

  private targetState(): number {
    const { SecuritySystemTargetState: Target } = this.api.hap.Characteristic;
    const value = this.armValue(this.pending ?? this.hub.arm);
    // A partial arm (some Ajax groups) is not a target HomeKit can be told to reach.
    return this.commander && value === Target.STAY_ARM ? Target.AWAY_ARM : value;
  }

  private armValue(arm: ArmState): number {
    const { SecuritySystemCurrentState: State } = this.api.hap.Characteristic;
    switch (arm) {
      case 'stay': return State.STAY_ARM;
      case 'away': return State.AWAY_ARM;
      case 'night': return State.NIGHT_ARM;
      default: return State.DISARMED;
    }
  }

  private render(): void {
    if (this.pending === this.hub.arm) {
      this.clearPending();
    }
    const { Characteristic } = this.api.hap;
    this.service.updateCharacteristic(Characteristic.SecuritySystemCurrentState, this.currentState());
    this.service.updateCharacteristic(Characteristic.SecuritySystemTargetState, this.targetState());
    this.service.updateCharacteristic(Characteristic.StatusFault, this.hub.fault ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.StatusTampered, this.hub.tampered ? 1 : 0);
  }
}

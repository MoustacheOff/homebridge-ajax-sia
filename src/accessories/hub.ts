import type { API, PlatformAccessory, Service } from 'homebridge';

import type { AjaxModel, ArmState, HubState } from '../ajax/model.js';

export type HubContext = {
  accountId: string;
  /** Last known arming state, so HomeKit has something to show right after a restart. */
  arm?: ReturnType<AjaxModel['snapshot']>;
};

/** The alarm panel, exposed as a HomeKit security system. */
export class HubAccessory {
  private readonly service: Service;
  private hub: HubState;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory<HubContext>,
    private readonly model: AjaxModel,
  ) {
    const { Service, Characteristic } = api.hap;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Ajax Systems')
      .setCharacteristic(Characteristic.Model, 'Hub (SIA DC-09)')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.accountId);

    this.service = accessory.getService(Service.SecuritySystem) ?? accessory.addService(Service.SecuritySystem, accessory.displayName);
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.hub = model.hub;

    this.service.getCharacteristic(Characteristic.SecuritySystemCurrentState)
      .onGet(() => this.currentState());
    // SIA is receive-only: the hub reports its state, it cannot be commanded. Arming is done from the Ajax app.
    this.service.getCharacteristic(Characteristic.SecuritySystemTargetState)
      .setProps({ perms: [api.hap.Perms.PAIRED_READ, api.hap.Perms.NOTIFY] })
      .onGet(() => this.targetState());
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

  private currentState(): number {
    const { SecuritySystemCurrentState: State } = this.api.hap.Characteristic;
    if (this.hub.alarm) {
      return State.ALARM_TRIGGERED;
    }
    return this.armValue(this.hub.arm);
  }

  private targetState(): number {
    return this.armValue(this.hub.arm);
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
    const { Characteristic } = this.api.hap;
    this.service.updateCharacteristic(Characteristic.SecuritySystemCurrentState, this.currentState());
    this.service.updateCharacteristic(Characteristic.SecuritySystemTargetState, this.targetState());
    this.service.updateCharacteristic(Characteristic.StatusFault, this.hub.fault ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.StatusTampered, this.hub.tampered ? 1 : 0);
  }
}

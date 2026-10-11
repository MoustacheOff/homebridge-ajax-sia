import type { API, Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { AjaxModel, AlarmKind, ZoneState } from '../ajax/model.js';
import type { DeviceConfig, ZoneType } from '../config.js';
import { PLUGIN_VERSION } from '../settings.js';

export type ZoneContext = {
  zone: number;
  type: ZoneType;
};

type ServiceClass = WithUUID<new (displayName?: string, subtype?: string) => Service>;
type CharacteristicClass = WithUUID<{ new (): Characteristic }>;

interface Binding {
  service: ServiceClass;
  characteristic: CharacteristicClass;
  /** Which alarm family of the model drives this sensor. */
  source: 'intrusion' | 'fire' | 'water' | 'gas';
  /** Value of the characteristic for (triggered, idle). */
  values: [triggered: number, idle: number];
}

const DEFAULT_MODEL: Record<ZoneType, string> = {
  motion: 'Motion detector',
  contact: 'Door/window contact',
  smoke: 'Smoke detector',
  leak: 'Leak detector',
  co: 'Carbon monoxide detector',
};

/** A detector, exposed as the closest HomeKit sensor. */
export class ZoneAccessory {
  private readonly service: Service;
  private readonly binding: Binding;
  private state: ZoneState;
  private resetTimer?: NodeJS.Timeout;
  /** Motion is momentary: it clears on its own after a delay instead of waiting for a restore event. */
  private motionExpired = false;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory<ZoneContext>,
    private readonly device: DeviceConfig,
    private readonly model: AjaxModel,
    private readonly motionResetSeconds: number,
  ) {
    const { Service, Characteristic } = api.hap;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Ajax Systems')
      .setCharacteristic(Characteristic.Model, device.model ?? DEFAULT_MODEL[device.type])
      .setCharacteristic(Characteristic.SerialNumber, device.serial ?? `Device ${device.zone}`)
      .setCharacteristic(Characteristic.FirmwareRevision, device.firmware ?? PLUGIN_VERSION);

    this.binding = this.bindingFor(device.type);
    this.service = accessory.services.find((existing) => existing.UUID === this.binding.service.UUID)
      ?? accessory.addService(new this.binding.service(accessory.displayName));
    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.state = model.zone(device.zone);

    this.service.getCharacteristic(this.binding.characteristic).onGet(() => this.detection());
    this.service.getCharacteristic(Characteristic.StatusTampered).onGet(() => (this.state.tampered ? 1 : 0));
    this.service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (this.state.lowBattery ? 1 : 0));

    this.render();
    model.on('zone', (zone, state) => {
      if (zone === device.zone) {
        this.onChange(state);
      }
    });
    model.on('alarm', (zone, kind) => {
      if (zone === device.zone) {
        this.onAlarm(kind);
      }
    });
  }

  dispose(): void {
    clearTimeout(this.resetTimer);
  }

  private bindingFor(type: ZoneType): Binding {
    const { Service: S, Characteristic: C } = this.api.hap;
    switch (type) {
      case 'motion':
        return { service: S.MotionSensor, characteristic: C.MotionDetected, source: 'intrusion', values: [1, 0] };
      case 'contact':
        return {
          service: S.ContactSensor,
          characteristic: C.ContactSensorState,
          source: 'intrusion',
          values: [C.ContactSensorState.CONTACT_NOT_DETECTED, C.ContactSensorState.CONTACT_DETECTED],
        };
      case 'smoke':
        return { service: S.SmokeSensor, characteristic: C.SmokeDetected, source: 'fire', values: [1, 0] };
      case 'leak':
        return { service: S.LeakSensor, characteristic: C.LeakDetected, source: 'water', values: [1, 0] };
      case 'co':
        return { service: S.CarbonMonoxideSensor, characteristic: C.CarbonMonoxideDetected, source: 'gas', values: [1, 0] };
    }
  }

  private onChange(state: ZoneState): void {
    this.state = state;
    if (!state[this.binding.source]) {
      clearTimeout(this.resetTimer);
      this.motionExpired = false;
    }
    this.render();
  }

  /** Every alarm event, including repeats the model does not see as a state change. */
  private onAlarm(kind: AlarmKind): void {
    if (this.device.type !== 'motion' || kind !== this.binding.source) {
      return;
    }
    clearTimeout(this.resetTimer);
    this.motionExpired = false;
    this.resetTimer = setTimeout(() => {
      this.motionExpired = true;
      this.render();
    }, this.motionResetSeconds * 1000);
    this.render();
  }

  private detection(): number {
    const [triggered, idle] = this.binding.values;
    const active = this.state[this.binding.source] && !this.motionExpired;
    return active ? triggered : idle;
  }

  private render(): void {
    const { Characteristic } = this.api.hap;
    this.service.updateCharacteristic(this.binding.characteristic, this.detection());
    this.service.updateCharacteristic(Characteristic.StatusTampered, this.state.tampered ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.StatusLowBattery, this.state.lowBattery ? 1 : 0);
  }
}

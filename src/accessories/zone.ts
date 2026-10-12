import type { API, Characteristic, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { AjaxModel, AlarmKind, ZoneState } from '../ajax/model.js';
import type { CloudDevice } from '../cloud/ajax.js';
import { displayFamily } from '../cloud/deviceTypes.js';
import type { DeviceConfig, ZoneType } from '../config.js';
import { PLUGIN_VERSION } from '../settings.js';

export type ZoneContext = {
  zone: number;
  type: ZoneType;
  /** Created from the Ajax account rather than from the configuration. */
  discovered?: boolean;
};

export interface ZoneOptions {
  /** Add a temperature sensor when the Ajax account reports a temperature for the detector. */
  temperature?: boolean;
}

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
  /** What the Ajax account says about the detector, when the cloud connection is on. */
  private cloud?: CloudDevice;
  /** Motion is momentary: it clears on its own after a delay instead of waiting for a restore event. */
  private motionExpired = false;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory<ZoneContext>,
    private readonly device: DeviceConfig,
    model: AjaxModel,
    private readonly motionResetSeconds: number,
    private readonly options: ZoneOptions = {},
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
    this.service.getCharacteristic(Characteristic.StatusTampered).onGet(() => (this.tampered() ? 1 : 0));
    this.service.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => (this.lowBattery() ? 1 : 0));
    this.service.getCharacteristic(Characteristic.StatusFault).onGet(() => (this.fault() ? 1 : 0));

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

  get zone(): number {
    return this.device.zone;
  }

  dispose(): void {
    clearTimeout(this.resetTimer);
  }

  /** Takes in what the Ajax account says about this detector: how it is, its battery, its temperature, what it is. */
  applyCloud(info: CloudDevice): void {
    const { Service, Characteristic } = this.api.hap;
    this.cloud = info;

    const details = this.accessory.getService(Service.AccessoryInformation)!;
    if (!this.device.model && info.family) {
      details.setCharacteristic(Characteristic.Model, displayFamily(info.family));
    }
    if (!this.device.serial && info.id) {
      details.setCharacteristic(Characteristic.SerialNumber, info.id);
    }

    const before = this.accessory.services.length;
    this.syncBattery(info);
    this.syncTemperature(info);
    if (this.accessory.services.length !== before) {
      // Homebridge only writes its cache now and then: have it keep the services that came or went.
      this.api.updatePlatformAccessories([this.accessory]);
    }
    this.render();
  }

  private syncBattery(info: CloudDevice): void {
    const { Service, Characteristic } = this.api.hap;
    const existing = this.accessory.getService(Service.Battery);
    if (info.batteryPercent === undefined) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    const battery = existing ?? this.accessory.addService(Service.Battery, `${this.accessory.displayName} battery`);
    battery.updateCharacteristic(Characteristic.BatteryLevel, Math.min(100, info.batteryPercent));
    battery.updateCharacteristic(Characteristic.ChargingState, Characteristic.ChargingState.NOT_CHARGEABLE);
    battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery() ? 1 : 0);
  }

  private syncTemperature(info: CloudDevice): void {
    const { Service, Characteristic } = this.api.hap;
    const existing = this.accessory.getServiceById(Service.TemperatureSensor, 'temperature');
    if (!this.options.temperature || info.temperature === undefined) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return;
    }
    const name = `${this.accessory.displayName} temperature`;
    const sensor = existing ?? this.accessory.addService(Service.TemperatureSensor, name, 'temperature');
    sensor.updateCharacteristic(Characteristic.CurrentTemperature, info.temperature);
  }

  /** Reported by the detector itself over SIA, or seen as such by the Ajax account. */
  private tampered(): boolean {
    return this.state.tampered || this.cloud?.tampered === true;
  }

  private lowBattery(): boolean {
    return this.state.lowBattery || this.cloud?.batteryLow === true;
  }

  /** The detector lost contact with the hub, was deactivated, or reports a malfunction. */
  private fault(): boolean {
    return this.cloud !== undefined && (!this.cloud.online || this.cloud.malfunction);
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
    this.service.updateCharacteristic(Characteristic.StatusTampered, this.tampered() ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery() ? 1 : 0);
    this.service.updateCharacteristic(Characteristic.StatusFault, this.fault() ? 1 : 0);
  }
}

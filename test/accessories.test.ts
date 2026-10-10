import hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAccessory, Service as HbService } from 'homebridge';

import { HubAccessory, type HubContext } from '../src/accessories/hub.js';
import { ZoneAccessory, type ZoneContext } from '../src/accessories/zone.js';
import { AjaxModel } from '../src/ajax/model.js';
import type { DeviceConfig, ZoneType } from '../src/config.js';
import { createApi } from './fakeHomebridge.js';

const { Service, Characteristic, Perms } = hap;
type ServiceRef = Parameters<PlatformAccessory['getService']>[0];
type CharacteristicRef = Parameters<HbService['getCharacteristic']>[0];
const State = Characteristic.SecuritySystemCurrentState;

function setup() {
  const { api, FakeAccessory } = createApi();
  const model = new AjaxModel();

  const hubAccessory = new FakeAccessory('Ajax', hap.uuid.generate('hub')) as unknown as PlatformAccessory<HubContext>;
  hubAccessory.context = { accountId: 'AB12' };
  new HubAccessory(api, hubAccessory, model);

  const zone = (device: DeviceConfig, motionResetSeconds = 30) => {
    const accessory = new FakeAccessory(device.name, hap.uuid.generate(`zone${device.zone}`)) as unknown as PlatformAccessory<ZoneContext>;
    accessory.context = { zone: device.zone, type: device.type };
    return { accessory, zone: new ZoneAccessory(api, accessory, device, model, motionResetSeconds) };
  };

  return { api, model, hubAccessory, zone };
}

const value = (accessory: PlatformAccessory, service: ServiceRef, characteristic: CharacteristicRef) =>
  accessory.getService(service)!.getCharacteristic(characteristic)!.value;

describe('HubAccessory', () => {
  it('shows the model in HomeKit', () => {
    const { model, hubAccessory } = setup();
    const current = () => value(hubAccessory, Service.SecuritySystem, Characteristic.SecuritySystemCurrentState);
    const target = () => value(hubAccessory, Service.SecuritySystem, Characteristic.SecuritySystemTargetState);

    expect(current()).toBe(State.DISARMED);

    model.apply({ code: 'CL', area: 1 });
    expect([current(), target()]).toEqual([State.AWAY_ARM, State.AWAY_ARM]);

    model.apply({ code: 'NL', area: 1 });
    expect(current()).toBe(State.NIGHT_ARM);

    model.apply({ code: 'BA', zone: 3 });
    expect(current()).toBe(State.ALARM_TRIGGERED);
    // The target never reads "triggered": HomeKit only knows four targets.
    expect(target()).toBe(State.NIGHT_ARM);

    model.apply({ code: 'OP', area: 1 });
    expect(current()).toBe(State.DISARMED);
  });

  it('cannot be commanded from HomeKit', () => {
    const { hubAccessory } = setup();
    const { perms } = hubAccessory.getService(Service.SecuritySystem)!.getCharacteristic(Characteristic.SecuritySystemTargetState).props;
    expect(perms).not.toContain(Perms.PAIRED_WRITE);
    expect(perms).toContain(Perms.PAIRED_READ);
  });

  it('reports tamper and fault', () => {
    const { model, hubAccessory } = setup();
    model.apply({ code: 'TA' });
    model.apply({ code: 'AT' });
    expect(value(hubAccessory, Service.SecuritySystem, Characteristic.StatusTampered)).toBe(1);
    expect(value(hubAccessory, Service.SecuritySystem, Characteristic.StatusFault)).toBe(1);
  });

  it('identifies itself', () => {
    const { hubAccessory } = setup();
    const info = hubAccessory.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('AB12');
  });
});

describe('ZoneAccessory', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // HAP stores booleans for some characteristics (MotionDetected) and 0/1 for others; compare as numbers.
  const read = (accessory: PlatformAccessory, service: ServiceRef, characteristic: CharacteristicRef) =>
    Number(accessory.getService(service)!.getCharacteristic(characteristic)!.value);

  it.each<[ZoneType, string, string, string, string]>([
    ['motion', 'MotionSensor', 'MotionDetected', 'BA', 'BR'],
    ['smoke', 'SmokeSensor', 'SmokeDetected', 'FA', 'FR'],
    ['leak', 'LeakSensor', 'LeakDetected', 'WA', 'WR'],
    ['co', 'CarbonMonoxideSensor', 'CarbonMonoxideDetected', 'GA', 'GR'],
  ])('%s sensor follows its alarm', (type, serviceName, characteristicName, alarm, restore) => {
    const { model, zone } = setup();
    const { accessory } = zone({ zone: 5, name: 'Sensor', type });
    const service = (Service as unknown as Record<string, ServiceRef>)[serviceName]!;
    const characteristic = (Characteristic as unknown as Record<string, CharacteristicRef>)[characteristicName]!;

    expect(read(accessory, service, characteristic)).toBe(0);
    model.apply({ code: alarm, zone: 5 });
    expect(read(accessory, service, characteristic)).toBe(1);
    model.apply({ code: restore, zone: 5 });
    expect(read(accessory, service, characteristic)).toBe(0);
  });

  it('contact sensor reads open on alarm', () => {
    const { model, zone } = setup();
    const { accessory } = zone({ zone: 2, name: 'Door', type: 'contact' });
    const state = () => read(accessory, Service.ContactSensor, Characteristic.ContactSensorState);

    expect(state()).toBe(Characteristic.ContactSensorState.CONTACT_DETECTED);
    model.apply({ code: 'BA', zone: 2 });
    expect(state()).toBe(Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
  });

  it('ignores events for other zones', () => {
    const { model, zone } = setup();
    const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' });
    model.apply({ code: 'BA', zone: 6 });
    expect(read(accessory, Service.MotionSensor, Characteristic.MotionDetected)).toBe(0);
  });

  it('reports tamper and low battery', () => {
    const { model, zone } = setup();
    const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' });
    model.apply({ code: 'TA', zone: 5 });
    model.apply({ code: 'XT', zone: 5 });
    expect(read(accessory, Service.MotionSensor, Characteristic.StatusTampered)).toBe(1);
    expect(read(accessory, Service.MotionSensor, Characteristic.StatusLowBattery)).toBe(1);
  });

  describe('motion reset', () => {
    const motion = (accessory: PlatformAccessory) => read(accessory, Service.MotionSensor, Characteristic.MotionDetected);

    it('clears by itself after the delay', () => {
      const { model, zone } = setup();
      const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' }, 30);

      model.apply({ code: 'BA', zone: 5 });
      expect(motion(accessory)).toBe(1);
      vi.advanceTimersByTime(29_000);
      expect(motion(accessory)).toBe(1);
      vi.advanceTimersByTime(1_500);
      expect(motion(accessory)).toBe(0);
    });

    it('triggers again on the next alarm, even though the hub never sent a restore', () => {
      const { model, zone } = setup();
      const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' }, 30);

      model.apply({ code: 'BA', zone: 5 });
      vi.advanceTimersByTime(31_000);
      expect(motion(accessory)).toBe(0);
      model.apply({ code: 'BA', zone: 5 });
      expect(motion(accessory)).toBe(1);
    });

    it('stays detected while it keeps re-triggering', () => {
      const { model, zone } = setup();
      const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' }, 30);

      model.apply({ code: 'BA', zone: 5 });
      vi.advanceTimersByTime(20_000);
      model.apply({ code: 'BA', zone: 5 });
      vi.advanceTimersByTime(20_000);
      expect(motion(accessory)).toBe(1);
    });

    it('is not revived by an unrelated change after it expired', () => {
      const { model, zone } = setup();
      const { accessory } = zone({ zone: 5, name: 'Hall', type: 'motion' }, 30);

      model.apply({ code: 'BA', zone: 5 });
      vi.advanceTimersByTime(31_000);
      model.apply({ code: 'XT', zone: 5 });
      expect(motion(accessory)).toBe(0);
    });

    it('stops its timer when disposed', () => {
      const { model, zone } = setup();
      const handle = zone({ zone: 5, name: 'Hall', type: 'motion' }, 30);
      model.apply({ code: 'BA', zone: 5 });
      handle.zone.dispose();
      vi.advanceTimersByTime(60_000);
      expect(motion(handle.accessory)).toBe(1);
    });
  });
});

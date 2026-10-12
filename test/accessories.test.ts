import hap from '@homebridge/hap-nodejs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformAccessory, Service as HbService } from 'homebridge';

import { HubAccessory, type HubContext } from '../src/accessories/hub.js';
import { ZoneAccessory, type ZoneContext } from '../src/accessories/zone.js';
import { AjaxModel } from '../src/ajax/model.js';
import type { CloudDevice } from '../src/cloud/ajax.js';
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

  it('identifies itself without leaking the internal account', () => {
    const { hubAccessory } = setup();
    const info = hubAccessory.getService(Service.AccessoryInformation)!;
    expect(info.getCharacteristic(Characteristic.SerialNumber).value).toBe('Ajax hub');
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

describe('ZoneAccessory with what the Ajax account says', () => {
  const info = (extra: Partial<CloudDevice> = {}): CloudDevice => ({
    id: '30E2CDA8',
    hubId: 'hub-1',
    name: 'MotionProtect Plus',
    index: 3,
    family: 'motion_protect_plus',
    online: true,
    bypassed: false,
    malfunction: false,
    tampered: false,
    batteryPercent: 87,
    batteryLow: false,
    temperature: 21,
    ...extra,
  });

  function sensor(device: Partial<DeviceConfig> = {}, options: { temperature?: boolean } = { temperature: true }) {
    const { api, FakeAccessory } = createApi();
    const model = new AjaxModel();
    const accessory = new FakeAccessory('Salon', hap.uuid.generate('zone3')) as unknown as PlatformAccessory<ZoneContext>;
    accessory.context = { zone: 3, type: 'motion' };
    const zone = new ZoneAccessory(api, accessory, { zone: 3, name: 'Salon', type: 'motion', ...device }, model, 30, options);
    const read = (service: ServiceRef, characteristic: CharacteristicRef, subtype?: string) =>
      (subtype ? accessory.getServiceById(service, subtype) : accessory.getService(service))?.getCharacteristic(characteristic)?.value;
    return { zone, accessory, model, read };
  }

  it('is not at fault until the account says so', () => {
    const { read } = sensor();
    expect(read(Service.MotionSensor, Characteristic.StatusFault)).toBe(0);
  });

  it.each([
    ['offline', { online: false }],
    ['in malfunction', { malfunction: true }],
  ])('reports a detector that is %s as at fault', (_label, extra) => {
    const { zone, read } = sensor();
    zone.applyCloud(info(extra));
    expect(read(Service.MotionSensor, Characteristic.StatusFault)).toBe(1);
    zone.applyCloud(info());
    expect(read(Service.MotionSensor, Characteristic.StatusFault)).toBe(0);
  });

  it('shows the battery level of the account, and a low battery from either source', () => {
    const { zone, model, read } = sensor();
    zone.applyCloud(info({ batteryPercent: 87 }));
    expect(read(Service.Battery, Characteristic.BatteryLevel)).toBe(87);
    expect(read(Service.Battery, Characteristic.ChargingState)).toBe(Characteristic.ChargingState.NOT_CHARGEABLE);
    expect(read(Service.MotionSensor, Characteristic.StatusLowBattery)).toBe(0);

    zone.applyCloud(info({ batteryPercent: 9, batteryLow: true }));
    expect(read(Service.Battery, Characteristic.StatusLowBattery)).toBe(1);
    expect(read(Service.MotionSensor, Characteristic.StatusLowBattery)).toBe(1);

    zone.applyCloud(info({ batteryPercent: 80, batteryLow: false }));
    model.apply({ code: 'XT', zone: 3 });
    expect(read(Service.MotionSensor, Characteristic.StatusLowBattery)).toBe(1);
  });

  it('shows a detector that the account sees opened as tampered', () => {
    const { zone, read } = sensor();
    zone.applyCloud(info({ tampered: true }));
    expect(read(Service.MotionSensor, Characteristic.StatusTampered)).toBe(1);
  });

  it('adds a temperature sensor, which Apple Home shows as a tile', () => {
    const { zone, read } = sensor();
    zone.applyCloud(info({ temperature: 21 }));
    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature, 'temperature')).toBe(21);
    zone.applyCloud(info({ temperature: -4 }));
    expect(read(Service.TemperatureSensor, Characteristic.CurrentTemperature, 'temperature')).toBe(-4);
  });

  it('adds no temperature sensor when the user does not want one, or the detector has none', () => {
    const off = sensor({}, { temperature: false });
    off.zone.applyCloud(info());
    expect(off.accessory.getServiceById(Service.TemperatureSensor, 'temperature')).toBeUndefined();

    const none = sensor();
    none.zone.applyCloud(info({ temperature: undefined }));
    expect(none.accessory.getServiceById(Service.TemperatureSensor, 'temperature')).toBeUndefined();
  });

  it('removes the temperature sensor and the battery that the account stops reporting', () => {
    const { zone, accessory } = sensor();
    zone.applyCloud(info());
    expect(accessory.getService(Service.Battery)).toBeDefined();
    zone.applyCloud(info({ temperature: undefined, batteryPercent: undefined }));
    expect(accessory.getServiceById(Service.TemperatureSensor, 'temperature')).toBeUndefined();
    expect(accessory.getService(Service.Battery)).toBeUndefined();
  });

  it('shows what the detector really is, unless the user said otherwise', () => {
    const plain = sensor();
    plain.zone.applyCloud(info());
    expect(value(plain.accessory, Service.AccessoryInformation, Characteristic.Model)).toBe('Motion Protect Plus');
    expect(value(plain.accessory, Service.AccessoryInformation, Characteristic.SerialNumber)).toBe('30E2CDA8');

    const custom = sensor({ model: 'My model', serial: 'MY-1' });
    custom.zone.applyCloud(info());
    expect(value(custom.accessory, Service.AccessoryInformation, Characteristic.Model)).toBe('My model');
    expect(value(custom.accessory, Service.AccessoryInformation, Characteristic.SerialNumber)).toBe('MY-1');
  });
});

describe('HubAccessory with commands', () => {
  const Target = Characteristic.SecuritySystemTargetState;

  function commandable(commander: (target: string, current: string) => Promise<void>, areas = 1) {
    const { api, FakeAccessory } = createApi();
    const model = new AjaxModel(areas);
    const accessory = new FakeAccessory('Ajax', hap.uuid.generate('hub')) as unknown as PlatformAccessory<HubContext>;
    accessory.context = { accountId: 'AB12' };
    const hub = new HubAccessory(api, accessory, model, commander as never);
    const target = accessory.getService(Service.SecuritySystem)!.getCharacteristic(Target)!;
    const current = accessory.getService(Service.SecuritySystem)!.getCharacteristic(Characteristic.SecuritySystemCurrentState)!;
    return { model, hub, target, current };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('can be written, and only to the targets Ajax can reach', () => {
    const { target } = commandable(async () => undefined);
    expect(target.props.perms).toContain(Perms.PAIRED_WRITE);
    expect(target.props.validValues).toEqual([Target.AWAY_ARM, Target.NIGHT_ARM, Target.DISARM]);
  });

  it.each([
    [Target.AWAY_ARM, 'away'],
    [Target.NIGHT_ARM, 'night'],
    [Target.DISARM, 'disarmed'],
  ])('target %i commands %s, from the state the hub is in', async (value, expected) => {
    const calls: [string, string][] = [];
    const { model, target } = commandable(async (command, current) => void calls.push([command, current]));
    model.apply({ code: 'NL', area: 1 });

    await target.handleSetRequest(value);
    expect(calls).toEqual([[expected, 'night']]);
  });

  it('shows the requested target right away, and settles when the hub confirms', async () => {
    const { model, target, current } = commandable(async () => undefined);
    await target.handleSetRequest(Target.AWAY_ARM);
    expect(target.value).toBe(Target.AWAY_ARM);
    expect(current.value).toBe(Characteristic.SecuritySystemCurrentState.DISARMED);

    model.apply({ code: 'CL', area: 1 });
    expect(current.value).toBe(Characteristic.SecuritySystemCurrentState.AWAY_ARM);
    expect(target.value).toBe(Target.AWAY_ARM);
  });

  it('gives the target back to the real state when the hub never follows', async () => {
    const { target } = commandable(async () => undefined);
    await target.handleSetRequest(Target.AWAY_ARM);
    expect(target.value).toBe(Target.AWAY_ARM);

    vi.advanceTimersByTime(46_000);
    expect(target.value).toBe(Target.DISARM);
  });

  it('reports a failed command to HomeKit and restores the target', async () => {
    const { target } = commandable(async () => {
      throw new Error('hub busy');
    });

    await expect(target.handleSetRequest(Target.AWAY_ARM)).rejects.toBeDefined();
    expect(target.value).toBe(Target.DISARM);
  });

  it('refuses the "Home" target', async () => {
    const calls: string[] = [];
    const { target } = commandable(async (command) => void calls.push(command));
    await expect(target.handleSetRequest(Target.STAY_ARM)).rejects.toBeDefined();
    expect(calls).toEqual([]);
  });

  it('shows a partial arm as Away, which is as close as HomeKit goes', () => {
    const { model, target, current } = commandable(async () => undefined, 2);
    model.reconcile('stay');
    expect(current.value).toBe(Characteristic.SecuritySystemCurrentState.STAY_ARM);
    expect(target.value).toBe(Target.AWAY_ARM);
  });

  it('stops its timer when disposed', async () => {
    const { target, hub } = commandable(async () => undefined);
    await target.handleSetRequest(Target.AWAY_ARM);
    hub.dispose();
    vi.advanceTimersByTime(60_000);
    expect(target.value).toBe(Target.AWAY_ARM);
  });
});

describe('accessory information', () => {
  const info = (accessory: PlatformAccessory) => {
    const service = accessory.getService(Service.AccessoryInformation)!;
    const read = (characteristic: typeof Characteristic.Model) => service.getCharacteristic(characteristic)!.value;
    return {
      model: read(Characteristic.Model),
      serial: read(Characteristic.SerialNumber),
      firmware: read(Characteristic.FirmwareRevision),
      manufacturer: read(Characteristic.Manufacturer),
    };
  };

  it('shows what the user configured', () => {
    const { api, FakeAccessory } = createApi();
    const hub = new FakeAccessory('Ajax', hap.uuid.generate('hub')) as unknown as PlatformAccessory<HubContext>;
    hub.context = { accountId: 'AB12' };
    new HubAccessory(api, hub, new AjaxModel(), undefined, { model: 'Hub 2 (4G)', serial: '003171A3', firmware: 'OS Malevich 2.30' });
    expect(info(hub)).toEqual({ model: 'Hub 2 (4G)', serial: '003171A3', firmware: 'OS Malevich 2.30', manufacturer: 'Ajax Systems' });
  });

  it('falls back to something meaningful, never to the internal account', () => {
    const { api, FakeAccessory } = createApi();
    const hub = new FakeAccessory('Ajax', hap.uuid.generate('hub')) as unknown as PlatformAccessory<HubContext>;
    hub.context = { accountId: 'AB12' };
    new HubAccessory(api, hub, new AjaxModel());

    const shown = info(hub);
    expect(shown.serial).toBe('Ajax hub');
    expect(shown.model).toBe('Hub');
    expect(shown.firmware).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(shown)).not.toContain('AB12');
  });

  it('describes a detector', () => {
    const { api, FakeAccessory } = createApi();
    const accessory = new FakeAccessory('Hall', hap.uuid.generate('z1')) as unknown as PlatformAccessory<ZoneContext>;
    accessory.context = { zone: 1, type: 'motion' };
    const detail = { model: 'MotionProtect Plus', serial: '30E2BB490E1', firmware: '5.59.3.3' };
    new ZoneAccessory(api, accessory, { zone: 1, name: 'Hall', type: 'motion', ...detail }, new AjaxModel(), 30);
    expect(info(accessory)).toEqual({ ...detail, manufacturer: 'Ajax Systems' });
  });

  it('names a detector by its kind and number when nothing is configured', () => {
    const { api, FakeAccessory } = createApi();
    const accessory = new FakeAccessory('Door', hap.uuid.generate('z2')) as unknown as PlatformAccessory<ZoneContext>;
    accessory.context = { zone: 2, type: 'contact' };
    new ZoneAccessory(api, accessory, { zone: 2, name: 'Door', type: 'contact' }, new AjaxModel(), 30);

    const shown = info(accessory);
    expect(shown.model).toBe('Door/window contact');
    expect(shown.serial).toBe('Device 2');
    expect(shown.serial).not.toMatch(/zone/i);
  });
});

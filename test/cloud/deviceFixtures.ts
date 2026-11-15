import { Writer } from '../../src/cloud/protobuf.js';

// The shapes below are those of the `.proto` files of the Ajax mobile apps.
export const battery = (state: number, percent: number) => new Writer().message(9, new Writer().varint(1, state).varint(2, percent));
export const signal = (level: number) => new Writer().message(2, new Writer().varint(1, level));
export const temperature = (degrees: number) => {
  // A negative int32 travels as a 64-bit varint.
  const value = degrees < 0 ? BigInt.asUintN(64, BigInt(degrees)) : BigInt(degrees);
  return new Writer().message(73, new Writer().varint(1, value));
};
export const flag = (field: number) => new Writer().message(field, new Writer());

export interface Spec {
  id?: string;
  name?: string;
  index?: number;
  /** Case of the `ObjectType` oneof, i.e. the family. */
  type?: number;
  states?: number[];
  statuses?: Writer[];
  bypassed?: boolean;
  malfunctions?: number;
}

let counter = 0;

export function hubDevice(spec: Spec): Writer {
  // Ids are unique on a hub, so two devices that were given none get different ones.
  const id = spec.id ?? `AAAA${(++counter).toString(16).toUpperCase().padStart(4, '0')}`;
  const profile = new Writer().string(1, id).string(2, spec.name ?? 'Device');
  if (spec.malfunctions) {
    profile.varint(7, spec.malfunctions);
  }
  for (const state of spec.states ?? []) {
    profile.varint(8, state);
  }
  for (const status of spec.statuses ?? []) {
    profile.message(9, status);
  }
  profile.varint(11, spec.index ?? 0);
  if (spec.bypassed) {
    profile.varint(12, 1);
  }
  const common = new Writer().message(1, profile).string(2, 'hub-1');
  if (spec.type !== undefined) {
    common.message(3, new Writer().message(spec.type, new Writer()));
  }
  return new Writer().message(1, new Writer().message(1, common));
}

export const snapshot = (...devices: Writer[]) => {
  const list = new Writer();
  for (const device of devices) {
    list.message(1, device);
  }
  return new Writer().message(1, new Writer().message(1, list)).finish();
};


// Updates of the stream: `Success.updates` holds `Update`s, each for one device (`LightDeviceId.hub_light_device_id`).
export const UPDATE = { add: 1, update: 2, remove: 3 } as const;

const deviceId = (id: string, hub = 'hub-1') => new Writer().message(1, new Writer().string(1, id).string(2, hub));

const updates = (...list: Writer[]) => {
  const body = new Writer();
  for (const update of list) {
    body.message(1, update);
  }
  return new Writer().message(1, new Writer().message(2, body)).finish();
};

/** A status that appears, changes (`UPDATE.update`) or goes away (`UPDATE.remove`). */
export const statusUpdate = (id: string, status: Writer, type: number = UPDATE.update, hub?: string) =>
  new Writer().message(1, deviceId(id, hub)).message(3, new Writer().message(1, status).varint(2, type));

export const malfunctionsUpdate = (id: string, count: number) =>
  new Writer().message(1, deviceId(id)).varint(4, count, true);

export const stateUpdate = (id: string, state: number, type: number = UPDATE.add) =>
  new Writer().message(1, deviceId(id)).message(5, new Writer().varint(1, state).varint(2, type));

export const deviceUpdate = (id: string, device: Writer, type: number = UPDATE.update) =>
  new Writer().message(1, deviceId(id)).message(2, new Writer().message(1, device).varint(2, type));

export const removal = (id: string) =>
  new Writer().message(1, deviceId(id)).message(2, new Writer().varint(2, UPDATE.remove));

export const updatesMessage = updates;

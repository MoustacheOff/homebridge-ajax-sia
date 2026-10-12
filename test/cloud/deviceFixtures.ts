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

export function hubDevice(spec: Spec): Writer {
  const profile = new Writer().string(1, spec.id ?? 'AAAA0001').string(2, spec.name ?? 'Device');
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


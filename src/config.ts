import { DEFAULT_DEVICE_MODEL, DEFAULT_DEVICE_OS } from './cloud/ajax.js';
import type { Protocol } from './sia/server.js';

export { DEFAULT_DEVICE_MODEL, DEFAULT_DEVICE_OS };

export const ZONE_TYPES = ['motion', 'contact', 'smoke', 'leak', 'co'] as const;
export type ZoneType = typeof ZONE_TYPES[number];

/** What HomeKit shows in an accessory's information page. All optional: the Ajax app has the real values. */
export interface AccessoryInfo {
  /** Marketing name, for example "MotionProtect Plus". */
  model?: string;
  /** Serial number, for example the "device ID" shown at the bottom of the device page in the Ajax app. */
  serial?: string;
  /** Firmware version, as shown in the Ajax app. Defaults to the version of this plugin. */
  firmware?: string;
}

export interface DeviceConfig extends AccessoryInfo {
  zone: number;
  name: string;
  type: ZoneType;
}

export interface CloudConfig {
  email: string;
  password: string;
  totpSecret?: string;
  spaceId?: string;
  spaceName?: string;
  host: string;
  clientVersion: string;
  deviceModel: string;
  deviceOs: string;
  syncIntervalMinutes: number;
  /** Expose the detectors of the Ajax account that are not in `devices`. */
  discoverDevices: boolean;
  /** Add a temperature sensor to the detectors that measure it. */
  temperatureSensors: boolean;
}

export interface Config {
  name: string;
  accountId: string;
  /** Decoded AES key, when encryption is enabled. */
  key?: Buffer;
  port: number;
  listenAddress: string;
  protocol: Protocol;
  areas: number;
  devices: DeviceConfig[];
  hub: AccessoryInfo;
  motionResetSeconds: number;
  maxTimeSkewSeconds: number;
  heartbeatTimeoutMinutes: number;
  allowedAddresses: string[];
  /** Present only when commands from HomeKit are enabled. */
  cloud?: CloudConfig;
}

export type ConfigResult = { config: Config; errors?: undefined } | { config?: undefined; errors: string[] };

type Raw = Record<string, unknown>;

/** Validates the user's platform config. Never throws: problems are returned for the caller to log. */
export function parseConfig(raw: Raw): ConfigResult {
  const errors: string[] = [];

  const integer = (field: string, fallback: number, min: number, max: number): number => {
    const value = raw[field] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      errors.push(`"${field}" must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };

  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim().toUpperCase() : '';
  if (!/^[0-9A-F]{3,16}$/.test(accountId)) {
    errors.push('"accountId" is required: 3 to 16 hexadecimal characters, the "Object number" set on the hub');
  }

  const protocol = raw.protocol ?? 'both';
  if (protocol !== 'tcp' && protocol !== 'udp' && protocol !== 'both') {
    errors.push('"protocol" must be "tcp", "udp" or "both"');
  }

  const key = parseKey(raw.encryptionKey, raw.encryptionKeyFormat, errors);

  const allowedAddresses = raw.allowedAddresses ?? [];
  if (!Array.isArray(allowedAddresses) || allowedAddresses.some((address) => typeof address !== 'string')) {
    errors.push('"allowedAddresses" must be a list of IP addresses');
  }

  const devices = parseDevices(raw.devices ?? [], errors);
  const cloud = parseCloud(raw.cloud, errors);

  const config: Config = {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Ajax',
    accountId,
    ...(key ? { key } : {}),
    port: integer('port', 7777, 1, 65535),
    listenAddress: typeof raw.listenAddress === 'string' && raw.listenAddress ? raw.listenAddress : '0.0.0.0',
    protocol: protocol as Protocol,
    areas: integer('areas', 1, 1, 9),
    devices,
    hub: parseInfo(raw.hub, 'hub', errors),
    motionResetSeconds: integer('motionResetSeconds', 30, 1, 3600),
    maxTimeSkewSeconds: integer('maxTimeSkewSeconds', 60, 0, 86400),
    heartbeatTimeoutMinutes: integer('heartbeatTimeoutMinutes', 0, 0, 1440),
    allowedAddresses: (allowedAddresses as string[]).map((address) => address.trim()),
    ...(cloud ? { cloud } : {}),
  };

  return errors.length > 0 ? { errors } : { config };
}

function parseKey(value: unknown, format: unknown, errors: string[]): Buffer | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push('"encryptionKey" must be a string');
    return undefined;
  }
  const key = value.trim();
  if (format === 'hex') {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})$/i.test(key)) {
      errors.push('"encryptionKey" in hex format must be 32, 48 or 64 hexadecimal characters');
      return undefined;
    }
    return Buffer.from(key, 'hex');
  }
  if (format !== undefined && format !== 'ascii') {
    errors.push('"encryptionKeyFormat" must be "ascii" or "hex"');
    return undefined;
  }
  if (![16, 24, 32].includes(Buffer.byteLength(key, 'latin1'))) {
    errors.push('"encryptionKey" must be 16, 24 or 32 characters long');
    return undefined;
  }
  return Buffer.from(key, 'latin1');
}

function parseDevices(value: unknown, errors: string[]): DeviceConfig[] {
  if (!Array.isArray(value)) {
    errors.push('"devices" must be a list');
    return [];
  }
  const seen = new Set<number>();
  const devices: DeviceConfig[] = [];

  value.forEach((entry: Raw, index) => {
    const label = `devices[${index}]`;
    const { zone, name, type } = entry ?? {};
    // The Homebridge UI saves a row for a detector the user has not filled in yet (only the default type set).
    if (zone === undefined && (name === undefined || name === '')) {
      return;
    }
    if (typeof zone !== 'number' || !Number.isInteger(zone) || zone < 1 || zone > 9999) {
      errors.push(`${label}.zone must be an integer between 1 and 9999 (zone 0 is the hub itself)`);
      return;
    }
    if (seen.has(zone)) {
      errors.push(`${label}.zone ${zone} is declared twice`);
      return;
    }
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push(`${label}.name is required`);
      return;
    }
    if (!ZONE_TYPES.includes(type as ZoneType)) {
      errors.push(`${label}.type must be one of: ${ZONE_TYPES.join(', ')}`);
      return;
    }
    seen.add(zone);
    devices.push({ zone, name: name.trim(), type: type as ZoneType, ...parseInfo(entry, label, errors) });
  });

  return devices;
}

const MAX_INFO_LENGTH = 64;

/** Reads the optional model, serial and firmware of an accessory. HomeKit limits each of them to 64 characters. */
function parseInfo(value: unknown, label: string, errors: string[]): AccessoryInfo {
  if (value === undefined || value === null) {
    return {};
  }
  const raw = value as Raw;
  const info: AccessoryInfo = {};
  for (const field of ['model', 'serial', 'firmware'] as const) {
    const entry = raw[field];
    if (entry === undefined || entry === '') {
      continue;
    }
    if (typeof entry !== 'string' || entry.trim().length > MAX_INFO_LENGTH) {
      errors.push(`${label}.${field} must be text of at most ${MAX_INFO_LENGTH} characters`);
    } else {
      info[field] = entry.trim();
    }
  }
  return info;
}

/**
 * Version of the Ajax app announced to the server. Kept at the latest release on the App Store by
 * scripts/update-client-version.mjs, which a daily workflow runs; do not edit the number by hand.
 */
export const DEFAULT_CLIENT_VERSION = '3.59';

/** SIA already delivers events as they happen, so the cloud is only asked now and then, to keep the load on it low. */
const DEFAULT_SYNC_MINUTES = 60;


function parseCloud(value: unknown, errors: string[]): CloudConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push('"cloud" must be an object');
    return undefined;
  }
  const raw = value as Raw;
  if (raw.enabled === false) {
    return undefined;
  }

  const text = (field: string): string | undefined => {
    const entry = raw[field];
    if (entry === undefined || entry === '') {
      return undefined;
    }
    if (typeof entry !== 'string') {
      errors.push(`"cloud.${field}" must be a string`);
      return undefined;
    }
    return entry.trim();
  };

  const email = text('email');
  const password = typeof raw.password === 'string' && raw.password !== '' ? raw.password : undefined;
  if (!email) {
    errors.push('"cloud.email" is required to send commands');
  }
  if (!password) {
    errors.push('"cloud.password" is required to send commands');
  }

  const syncInterval = raw.syncIntervalMinutes ?? DEFAULT_SYNC_MINUTES;
  const validInterval = typeof syncInterval === 'number' && Number.isInteger(syncInterval) && syncInterval >= 0 && syncInterval <= 1440;
  if (!validInterval) {
    errors.push('"cloud.syncIntervalMinutes" must be an integer between 0 and 1440');
  }

  for (const field of ['deviceModel', 'deviceOs']) {
    const entry = raw[field];
    if (typeof entry === 'string' && !/^[\x20-\x7e]{1,64}$/.test(entry.trim())) {
      errors.push(`"cloud.${field}" must be 1 to 64 printable ASCII characters`);
    }
  }

  const flag = (field: string): boolean => {
    const entry = raw[field];
    if (entry === undefined) {
      return true;
    }
    if (typeof entry !== 'boolean') {
      errors.push(`"cloud.${field}" must be true or false`);
      return true;
    }
    return entry;
  };

  const totpSecret = text('totpSecret');
  const spaceId = text('spaceId');
  const spaceName = text('spaceName');
  if (!email || !password) {
    return undefined;
  }
  return {
    email,
    password,
    ...(totpSecret ? { totpSecret } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(spaceName ? { spaceName } : {}),
    host: text('host') ?? 'mobile-gw.prod.ajax.systems',
    clientVersion: text('clientVersion') ?? DEFAULT_CLIENT_VERSION,
    deviceModel: text('deviceModel') ?? DEFAULT_DEVICE_MODEL,
    deviceOs: text('deviceOs') ?? DEFAULT_DEVICE_OS,
    syncIntervalMinutes: validInterval ? (syncInterval as number) : DEFAULT_SYNC_MINUTES,
    discoverDevices: flag('discoverDevices'),
    temperatureSensors: flag('temperatureSensors'),
  };
}

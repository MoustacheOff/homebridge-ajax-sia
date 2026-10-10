import type { Protocol } from './sia/server.js';

export const ZONE_TYPES = ['motion', 'contact', 'smoke', 'leak', 'co'] as const;
export type ZoneType = typeof ZONE_TYPES[number];

export interface DeviceConfig {
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
  syncIntervalMinutes: number;
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
    devices.push({ zone, name: name.trim(), type: type as ZoneType });
  });

  return devices;
}

/** Version of the Ajax Android app announced to the server, known to be accepted at the time of writing. */
export const DEFAULT_CLIENT_VERSION = '3.57';

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

  const syncInterval = raw.syncIntervalMinutes ?? 15;
  const validInterval = typeof syncInterval === 'number' && Number.isInteger(syncInterval) && syncInterval >= 0 && syncInterval <= 1440;
  if (!validInterval) {
    errors.push('"cloud.syncIntervalMinutes" must be an integer between 0 and 1440');
  }

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
    syncIntervalMinutes: validInterval ? (syncInterval as number) : 15,
  };
}

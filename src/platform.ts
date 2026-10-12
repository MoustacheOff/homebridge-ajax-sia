import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { HubAccessory, type Commander, type HubContext } from './accessories/hub.js';
import { ZoneAccessory, type ZoneContext } from './accessories/zone.js';
import { AjaxModel, isZoneCode } from './ajax/model.js';
import { AjaxCloud, CloudError, sha256, type CloudDevice, type FailureReason } from './cloud/ajax.js';
import { CloudController } from './cloud/controller.js';
import { sensorKind } from './cloud/deviceTypes.js';
import { GrpcChannel } from './cloud/grpc.js';
import { CloudStore } from './cloud/store.js';
import { parseConfig, type Config } from './config.js';
import { SiaReceiver } from './sia/receiver.js';
import { SiaServer } from './sia/server.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

const WATCHDOG_INTERVAL_MS = 15_000;
/**
 * Failures that trying again cannot fix. Repeating them would hammer the account and risk a lockout, so
 * the plugin stops talking to Ajax until Homebridge is restarted.
 */
const FATAL: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'invalid-credentials', 'account-locked', 'account-not-confirmed', 'two-factor-required', 'client-rejected',
]);

/** What the cloud connection gives the rest of the plugin. */
interface CloudLink {
  commander: Commander;
  /** Reads the devices of the account and hands them to the accessories. */
  readDevices: () => Promise<void>;
}

/** After a command, check what the hub actually did, in case the SIA event is late or not configured. */
const VERIFY_DELAY_MS = 6_000;

/**
 * Wires the pieces together: the SIA server feeds the Ajax model, and the model drives HomeKit accessories.
 */
export class AjaxSiaPlatform implements DynamicPlatformPlugin {
  private readonly config?: Config;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly zones: ZoneAccessory[] = [];
  private readonly zoneByNumber = new Map<number, ZoneAccessory>();
  private devicesRead = false;
  private readonly announcedZones = new Set<number>();
  private server?: SiaServer;
  private hub?: HubAccessory;
  private watchdog?: NodeJS.Timeout;
  private cloudSync?: NodeJS.Timeout;
  private verify?: NodeJS.Timeout;
  private lastSeen = Date.now();

  constructor(
    private readonly log: Logging,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    const parsed = parseConfig(config);
    if (parsed.errors) {
      parsed.errors.forEach((error) => this.log.error(`Invalid configuration: ${error}`));
      this.log.error('The plugin is disabled until the configuration is fixed.');
      return;
    }
    this.config = parsed.config;

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private start(): void {
    const config = this.config!;
    const model = new AjaxModel(config.areas);

    const cloud = this.setupCloud(config, model);
    this.setupAccessories(config, model, cloud?.commander);
    void cloud?.readDevices();
    this.observe(model);

    const receiver = new SiaReceiver({
      account: config.accountId,
      ...(config.key ? { key: config.key } : {}),
      maxTimeSkewSeconds: config.maxTimeSkewSeconds,
    });
    const server = new SiaServer(
      { port: config.port, host: config.listenAddress, protocol: config.protocol, allowedAddresses: config.allowedAddresses },
      receiver,
      this.log,
    );
    this.server = server;

    server.on('message', (message) => {
      this.lastSeen = Date.now();
      model.setOffline(false);
      if (message.events.length === 0) {
        this.log.debug('Link test received from the hub');
      }
      for (const event of message.events) {
        this.log.debug(`Event ${JSON.stringify(event)}`);
        this.announceUnknownZone(config, event.code, event.zone);
        model.apply(event);
      }
    });
    server.on('error', (error) => this.log.error(`SIA server error: ${error.message}`));
    server.start().catch((error: NodeJS.ErrnoException) => {
      const hint = error.code === 'EADDRINUSE' ? ` Port ${config.port} is already in use; pick another one.` : '';
      this.log.error(`Could not start the SIA server: ${error.message}.${hint}`);
    });

    if (config.heartbeatTimeoutMinutes > 0) {
      this.watchdog = setInterval(() => this.checkHeartbeat(config, model), WATCHDOG_INTERVAL_MS);
    }
  }

  private stop(): void {
    clearInterval(this.watchdog);
    clearInterval(this.cloudSync);
    clearTimeout(this.verify);
    this.hub?.dispose();
    this.zones.forEach((zone) => zone.dispose());
    void this.server?.stop();
  }

  /**
   * Enables commands from HomeKit when the Ajax account is configured. Returns the function that carries
   * them out and the one that reads the devices, or `undefined` when the plugin stays receive-only.
   */
  private setupCloud(config: Config, model: AjaxModel): CloudLink | undefined {
    const settings = config.cloud;
    if (!settings) {
      return undefined;
    }

    const store = new CloudStore(this.api.user.storagePath());
    // `host` is a plain host name; a full origin (http://...) is only meant for tests.
    const origin = settings.host.includes('://') ? settings.host : `https://${settings.host}:443`;
    const client = new AjaxCloud({
      channel: new GrpcChannel(origin),
      host: settings.host,
      port: 443,
      email: settings.email,
      passwordHash: sha256(settings.password),
      ...(settings.totpSecret ? { totpSecret: settings.totpSecret } : {}),
      deviceId: store.deviceId,
      clientVersion: settings.clientVersion,
      deviceModel: settings.deviceModel,
      deviceOs: settings.deviceOs,
    });
    client.restore(store.session);
    const identity = `${settings.deviceModel}|${settings.deviceOs}`;
    // A session opened under another name would keep that name in the account's list of sessions: end it,
    // and log in again under the current one.
    const migrated = (async () => {
      if (store.session && store.identity !== identity) {
        this.log.info(`The Ajax session was opened under another name: ending it and logging in again as "${settings.deviceModel}"`);
        await client.logout();
        store.save(undefined, identity);
      }
    })();
    const controller = new CloudController(
      client,
      { ...(settings.spaceId ? { spaceId: settings.spaceId } : {}), ...(settings.spaceName ? { spaceName: settings.spaceName } : {}) },
      this.log,
    );

    this.log.warn('Commands from HomeKit are enabled. They use the protocol of the Ajax mobile apps, which is not an official API.');

    let stopped: string | undefined;
    const run = async <T>(task: () => Promise<T>): Promise<T> => {
      await migrated;
      if (stopped) {
        throw new Error(stopped);
      }
      try {
        return await task();
      } catch (error) {
        if (error instanceof CloudError && FATAL.has(error.reason)) {
          stopped = `Calls to Ajax are stopped to protect your account (${error.message}). Fix it, then restart Homebridge.`;
          this.log.error(stopped);
        }
        throw error;
      }
    };
    // One call at a time: two at once, with no session yet, would both log in and leave two sessions in the account.
    let queue: Promise<unknown> = Promise.resolve();
    const attempt = <T>(task: () => Promise<T>): Promise<T> => {
      const result = queue.then(() => run(task));
      queue = result.catch(() => undefined);
      return result;
    };

    const sync = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      try {
        const arm = await attempt(() => controller.read());
        store.save(client.current, identity);
        if (arm) {
          model.reconcile(arm);
        }
      } catch (error) {
        this.log.warn(`Could not read the state from Ajax: ${describe(error)}`);
      }
    };

    const readDevices = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      try {
        const devices = await attempt(() => controller.devices());
        store.save(client.current, identity);
        this.applyDevices(config, model, devices);
      } catch (error) {
        if (!stopped) {
          this.log.warn(`Could not read the devices from Ajax: ${describe(error)}`);
        }
      }
    };

    void sync();
    if (settings.syncIntervalMinutes > 0) {
      this.cloudSync = setInterval(() => void sync().then(readDevices), settings.syncIntervalMinutes * 60_000);
    }

    const commander: Commander = async (target, current) => {
      try {
        await attempt(() => controller.command(target, current));
        store.save(client.current, identity);
      } catch (error) {
        this.log.error(`Could not ${target === 'disarmed' ? 'disarm' : `arm (${target})`}: ${describe(error)}`);
        throw error;
      }
      this.log.info(`Command sent: ${target}`);
      clearTimeout(this.verify);
      this.verify = setTimeout(() => void sync(), VERIFY_DELAY_MS);
    };
    return { commander, readDevices };
  }

  private setupAccessories(config: Config, model: AjaxModel, commander?: Commander): void {
    const { hap } = this.api;
    const wanted = new Set<string>();

    const hubUuid = hap.uuid.generate(`ajax-sia:hub:${config.accountId}`);
    wanted.add(hubUuid);
    const hub = this.obtain<HubContext>(hubUuid, config.name, hap.Categories.SECURITY_SYSTEM, { accountId: config.accountId });
    if (hub.context.arm) {
      model.restore(hub.context.arm);
    }
    this.hub = new HubAccessory(this.api, hub, model, commander, config.hub);

    const temperature = config.cloud?.temperatureSensors ?? false;
    for (const device of config.devices) {
      const uuid = hap.uuid.generate(`ajax-sia:zone:${config.accountId}:${device.zone}`);
      wanted.add(uuid);

      const previous = this.cached.get(uuid) as PlatformAccessory<ZoneContext> | undefined;
      if (previous && previous.context.type !== device.type) {
        // The HomeKit service differs by type, so the accessory has to be rebuilt.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [previous]);
        this.cached.delete(uuid);
      }
      const accessory = this.obtain<ZoneContext>(
        uuid,
        device.name,
        hap.Categories.SENSOR,
        { zone: device.zone, type: device.type, discovered: false },
      );
      this.addZone(new ZoneAccessory(this.api, accessory, device, model, config.motionResetSeconds, { temperature }));
    }

    // Detectors found in the Ajax account earlier stay where they were while the account is not asked again:
    // removing and re-adding them at every restart would lose their room and their automations in Apple Home.
    if (config.cloud?.discoverDevices) {
      for (const accessory of this.cached.values() as IterableIterator<PlatformAccessory<ZoneContext>>) {
        const { zone, type, discovered } = accessory.context;
        if (!discovered || wanted.has(accessory.UUID) || !zone || !type) {
          continue;
        }
        wanted.add(accessory.UUID);
        const device = { zone, type, name: accessory.displayName };
        this.addZone(new ZoneAccessory(this.api, accessory, device, model, config.motionResetSeconds, { temperature }));
      }
    }

    const stale = [...this.cached.values()].filter((accessory) => !wanted.has(accessory.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer configured`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private addZone(zone: ZoneAccessory): void {
    this.zones.push(zone);
    this.zoneByNumber.set(zone.zone, zone);
  }

  /**
   * Hands what the Ajax account says about each detector to the matching accessory. The number of a device on
   * the hub is the zone SIA reports it with, so that is how they are matched. Detectors the user did not list
   * are exposed too, when asked to, and forgotten when they leave the account.
   */
  private applyDevices(config: Config, model: AjaxModel, devices: CloudDevice[]): void {
    const settings = config.cloud;
    const { hap } = this.api;
    if (!this.devicesRead) {
      this.devicesRead = true;
      const sensors = devices.filter((device) => sensorKind(device.family)).length;
      this.log.info(`Read ${devices.length} devices from your Ajax account (${sensors} detectors)`);
    }
    const listed = new Set<number>();
    const names = new Map<string, number>();
    for (const device of devices) {
      names.set(device.name, (names.get(device.name) ?? 0) + 1);
    }

    for (const device of devices) {
      if (device.index <= 0) {
        continue;
      }
      listed.add(device.index);

      const known = this.zoneByNumber.get(device.index);
      if (known) {
        known.applyCloud(device);
        continue;
      }
      const type = sensorKind(device.family);
      if (!settings?.discoverDevices || !type) {
        continue;
      }

      // Two detectors of the same kind have the same name in the Ajax app: their number tells them apart.
      const name = (names.get(device.name) ?? 0) > 1 ? `${device.name} ${device.index}` : device.name;
      const uuid = hap.uuid.generate(`ajax-sia:zone:${config.accountId}:${device.index}`);
      const accessory = this.obtain<ZoneContext>(uuid, name, hap.Categories.SENSOR, { zone: device.index, type, discovered: true });
      const options = { temperature: settings.temperatureSensors };
      const zone = new ZoneAccessory(this.api, accessory, { zone: device.index, name, type }, model, config.motionResetSeconds, options);
      this.addZone(zone);
      zone.applyCloud(device);
      this.log.info(`Found ${device.name} (zone ${device.index}) in your Ajax account: exposed as "${name}"`);
    }

    if (!settings?.discoverDevices) {
      return;
    }
    const gone = [...this.zoneByNumber.values()].filter((zone) => {
      const accessory = this.cached.get(this.api.hap.uuid.generate(`ajax-sia:zone:${config.accountId}:${zone.zone}`));
      return (accessory?.context as ZoneContext | undefined)?.discovered === true && !listed.has(zone.zone);
    });
    for (const zone of gone) {
      const uuid = hap.uuid.generate(`ajax-sia:zone:${config.accountId}:${zone.zone}`);
      const accessory = this.cached.get(uuid)!;
      this.log.info(`${accessory.displayName} (zone ${zone.zone}) is no longer in your Ajax account: removing it`);
      zone.dispose();
      this.zones.splice(this.zones.indexOf(zone), 1);
      this.zoneByNumber.delete(zone.zone);
      this.cached.delete(uuid);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  /** Returns the cached accessory for `uuid`, or registers a new one. */
  private obtain<C extends Record<string, unknown>>(
    uuid: string,
    name: string,
    category: number,
    context: C,
  ): PlatformAccessory<C> {
    const existing = this.cached.get(uuid) as PlatformAccessory<C> | undefined;
    if (existing) {
      existing.displayName = name;
      existing.context = { ...existing.context, ...context };
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory<C>(name, uuid, category);
    accessory.context = context;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cached.set(uuid, accessory);
    return accessory;
  }

  private observe(model: AjaxModel): void {
    model.on('hub', (hub) => {
      const alarm = hub.alarm ? ' ALARM' : '';
      this.log.info(`Hub: ${hub.arm}${alarm}${hub.tampered ? ', tampered' : ''}${hub.fault ? ', fault' : ''}`);
    });
    model.on('ignored', (event) => this.log.debug(`Ignored event ${event.code}${event.zone !== undefined ? ` (zone ${event.zone})` : ''}`));
    model.on('hubWarning', (message) => this.log.warn(message));
  }

  private announceUnknownZone(config: Config, code: string, zone: number | undefined): void {
    if (zone === undefined || zone === 0 || !isZoneCode(code)) {
      return;
    }
    if (config.devices.some((device) => device.zone === zone) || this.announcedZones.has(zone)) {
      return;
    }
    this.announcedZones.add(zone);
    this.log.info(
      `Zone ${zone} reported ${code} but is not configured. To expose it, add `
      + `{ "zone": ${zone}, "name": "...", "type": "motion" } to "devices".`,
    );
  }

  private checkHeartbeat(config: Config, model: AjaxModel): void {
    const silentMs = Date.now() - this.lastSeen;
    const silent = silentMs > config.heartbeatTimeoutMinutes * 60_000;
    if (silent && !model.hub.fault) {
      this.log.warn(`No message from the hub for ${Math.round(silentMs / 60_000)} minute(s); reporting a fault`);
    }
    model.setOffline(silent);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

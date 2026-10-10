import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';

import { HubAccessory, type HubContext } from './accessories/hub.js';
import { ZoneAccessory, type ZoneContext } from './accessories/zone.js';
import { AjaxModel, isZoneCode } from './ajax/model.js';
import { parseConfig, type Config } from './config.js';
import { SiaReceiver } from './sia/receiver.js';
import { SiaServer } from './sia/server.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Wires the pieces together: the SIA server feeds the Ajax model, and the model drives HomeKit accessories.
 */
export class AjaxSiaPlatform implements DynamicPlatformPlugin {
  private readonly config?: Config;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly zones: ZoneAccessory[] = [];
  private readonly announcedZones = new Set<number>();
  private server?: SiaServer;
  private watchdog?: NodeJS.Timeout;
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

    this.setupAccessories(config, model);
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
    this.zones.forEach((zone) => zone.dispose());
    void this.server?.stop();
  }

  private setupAccessories(config: Config, model: AjaxModel): void {
    const { hap } = this.api;
    const wanted = new Set<string>();

    const hubUuid = hap.uuid.generate(`ajax-sia:hub:${config.accountId}`);
    wanted.add(hubUuid);
    const hub = this.obtain<HubContext>(hubUuid, config.name, hap.Categories.SECURITY_SYSTEM, { accountId: config.accountId });
    if (hub.context.arm) {
      model.restore(hub.context.arm);
    }
    new HubAccessory(this.api, hub, model);

    for (const device of config.devices) {
      const uuid = hap.uuid.generate(`ajax-sia:zone:${config.accountId}:${device.zone}`);
      wanted.add(uuid);

      const previous = this.cached.get(uuid) as PlatformAccessory<ZoneContext> | undefined;
      if (previous && previous.context.type !== device.type) {
        // The HomeKit service differs by type, so the accessory has to be rebuilt.
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [previous]);
        this.cached.delete(uuid);
      }
      const accessory = this.obtain<ZoneContext>(uuid, device.name, hap.Categories.SENSOR, { zone: device.zone, type: device.type });
      this.zones.push(new ZoneAccessory(this.api, accessory, device, model, config.motionResetSeconds));
    }

    const stale = [...this.cached.values()].filter((accessory) => !wanted.has(accessory.UUID));
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} accessory(ies) no longer configured`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
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

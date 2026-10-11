import { readFileSync } from 'node:fs';

/** Name users give the platform in their Homebridge config.json. */
export const PLATFORM_NAME = 'AjaxSia';

/** Must match the `name` in package.json. */
export const PLUGIN_NAME = 'homebridge-ajax-sia';

/** Version of this plugin, reported to HomeKit as the firmware revision of the accessories it drives. */
export const PLUGIN_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

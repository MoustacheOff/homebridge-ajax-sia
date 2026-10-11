import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';
import { PLATFORM_NAME } from '../src/settings.js';

interface Node {
  type?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  properties?: Record<string, Node>;
  items?: Node;
}

const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8')) as {
  pluginAlias: string;
  schema: Node & { required: string[] };
  layout: unknown[];
};

/** Every property of the form, with the path it is addressed by in the layout. */
function fields(node: Node, prefix = ''): [string, Node][] {
  return Object.entries(node.properties ?? {}).flatMap(([name, child]) => {
    const path = `${prefix}${name}`;
    const nested = child.items ? fields(child.items, `${path}[].`) : fields(child, `${path}.`);
    return [[path, child] as [string, Node], ...nested];
  });
}

/** Every field the layout points at. */
function layoutKeys(items: unknown[]): string[] {
  return items.flatMap((item) => {
    if (typeof item === 'string') {
      return [item];
    }
    const entry = item as { key?: string; items?: unknown[] };
    return [...(entry.key ? [entry.key] : []), ...layoutKeys(entry.items ?? [])];
  });
}

describe('config.schema.json', () => {
  it('registers the platform under the name the plugin uses', () => {
    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
  });

  it('shows numbers as number fields, not sliders', () => {
    // The Homebridge UI draws an integer that has both a minimum and a maximum as a slider.
    const sliders = fields(schema.schema)
      .filter(([, node]) => (node.type === 'integer' || node.type === 'number') && 'minimum' in node && 'maximum' in node)
      .map(([path]) => path);
    expect(sliders).toEqual([]);
  });

  it('has a form field for every setting it lists, and only those', () => {
    const known = new Set(fields(schema.schema).map(([path]) => path));
    const unknown = layoutKeys(schema.layout).filter((key) => !known.has(key));
    expect(unknown).toEqual([]);
  });

  it('only proposes defaults the plugin accepts', () => {
    const defaults = Object.fromEntries(
      Object.entries(schema.schema.properties ?? {}).filter(([, node]) => 'default' in node).map(([name, node]) => [name, node.default]),
    );
    expect(parseConfig({ accountId: 'AB12', ...defaults }).errors).toBeUndefined();
  });

  it('asks for the object number', () => {
    expect(schema.schema.required).toContain('accountId');
  });
});

import { describe, expect, it } from 'vitest';

import { parseConfig } from '../src/config.js';

const valid = { platform: 'AjaxSia', name: 'Ajax', accountId: 'ab12' };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(valid).config).toMatchObject({
      name: 'Ajax',
      accountId: 'AB12',
      port: 7777,
      listenAddress: '0.0.0.0',
      protocol: 'both',
      areas: 1,
      devices: [],
      motionResetSeconds: 30,
      maxTimeSkewSeconds: 60,
      heartbeatTimeoutMinutes: 0,
      allowedAddresses: [],
    });
  });

  it('requires a valid account', () => {
    expect(parseConfig({}).errors).toEqual([expect.stringContaining('accountId')]);
    expect(parseConfig({ accountId: 'xyz' }).errors).toEqual([expect.stringContaining('accountId')]);
    expect(parseConfig({ accountId: 'AB' }).errors).toEqual([expect.stringContaining('accountId')]);
  });

  describe('encryption key', () => {
    it('accepts an ASCII key', () => {
      expect(parseConfig({ ...valid, encryptionKey: '0123456789abcdef' }).config?.key).toEqual(Buffer.from('0123456789abcdef'));
    });

    it('accepts a hex key', () => {
      const hex = '00112233445566778899aabbccddeeff';
      expect(parseConfig({ ...valid, encryptionKey: hex, encryptionKeyFormat: 'hex' }).config?.key).toEqual(Buffer.from(hex, 'hex'));
    });

    it('treats an empty key as no encryption', () => {
      expect(parseConfig({ ...valid, encryptionKey: '' }).config?.key).toBeUndefined();
    });

    it.each([
      [{ encryptionKey: 'short' }],
      [{ encryptionKey: 'x'.repeat(20) }],
      [{ encryptionKey: 'zz'.repeat(16), encryptionKeyFormat: 'hex' }],
      [{ encryptionKey: 'a'.repeat(16), encryptionKeyFormat: 'base64' }],
      [{ encryptionKey: 42 }],
    ])('rejects %j', (extra) => {
      expect(parseConfig({ ...valid, ...extra }).errors).toEqual([expect.stringContaining('ncryptionKey')]);
    });
  });

  describe('devices', () => {
    it('parses them', () => {
      const devices = [{ zone: 1, name: ' Living room ', type: 'motion' }, { zone: 2, name: 'Door', type: 'contact' }];
      expect(parseConfig({ ...valid, devices }).config?.devices).toEqual([
        { zone: 1, name: 'Living room', type: 'motion' },
        { zone: 2, name: 'Door', type: 'contact' },
      ]);
    });

    it.each([
      [{ zone: 0, name: 'Hub', type: 'motion' }, /zone/],
      [{ zone: 1.5, name: 'x', type: 'motion' }, /zone/],
      [{ zone: 1, name: '', type: 'motion' }, /name/],
      [{ zone: 1, name: 'x', type: 'siren' }, /type/],
    ])('rejects %j', (device, message) => {
      expect(parseConfig({ ...valid, devices: [device] }).errors).toEqual([expect.stringMatching(message)]);
    });

    it('rejects a duplicated zone', () => {
      const device = { zone: 1, name: 'x', type: 'motion' };
      expect(parseConfig({ ...valid, devices: [device, device] }).errors).toEqual([expect.stringContaining('twice')]);
    });
  });

  it('reports every problem at once', () => {
    const { errors } = parseConfig({ port: 0, protocol: 'carrier-pigeon', areas: 'many' });
    expect(errors).toHaveLength(4);
  });
});

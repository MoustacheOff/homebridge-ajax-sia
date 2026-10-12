#!/usr/bin/env node
// Read-only check of an Ajax account: logs in and lists the spaces with their state and devices. Sends no command.
//
//   npm run build
//   read -rs AJAX_PASSWORD && export AJAX_PASSWORD && AJAX_EMAIL=you@example.com node scripts/probe.mjs
//
// Optional: AJAX_TOTP_SECRET (authenticator secret), AJAX_CLIENT_VERSION,
// AJAX_DEVICE_MODEL and AJAX_DEVICE_OS (how the session is named in the Ajax app).
//
// The session is ended before the script exits, so it does not stay in the account's list of sessions.

import { randomUUID } from 'node:crypto';

import { AjaxCloud, CloudError, sha256 } from '../dist/cloud/ajax.js';
import { DEFAULT_CLIENT_VERSION } from '../dist/config.js';

const {
  AJAX_EMAIL: email,
  AJAX_PASSWORD: password,
  AJAX_TOTP_SECRET: totpSecret,
  AJAX_CLIENT_VERSION: clientVersion,
  AJAX_DEVICE_MODEL: deviceModel,
  AJAX_DEVICE_OS: deviceOs,
} = process.env;

if (!email || !password) {
  console.error('Set AJAX_EMAIL and AJAX_PASSWORD (see the header of this file).');
  process.exit(2);
}

const cloud = new AjaxCloud({
  host: 'mobile-gw.prod.ajax.systems',
  port: 443,
  email,
  passwordHash: sha256(password),
  ...(totpSecret ? { totpSecret } : {}),
  deviceId: randomUUID(),
  clientVersion: clientVersion ?? DEFAULT_CLIENT_VERSION,
  ...(deviceModel ? { deviceModel } : {}),
  ...(deviceOs ? { deviceOs } : {}),
});

try {
  await cloud.login();
  console.log('Login: ok');
  const spaces = await cloud.spaces();
  console.log(`Spaces: ${spaces.length}`);
  for (const space of spaces) {
    console.log(`  - "${space.name}"  id=${space.id}  state=${space.state}  hub=${space.online ? 'online' : 'offline'}`);
    for (const device of await cloud.devices(space.id)) {
      const extras = [
        device.batteryPercent !== undefined ? `battery=${device.batteryPercent}%${device.batteryLow ? ' (low)' : ''}` : '',
        device.signal ? `signal=${device.signal}` : '',
        device.temperature !== undefined ? `temperature=${device.temperature}` : '',
        device.tampered ? 'tampered' : '',
        device.malfunction ? 'malfunction' : '',
        device.bypassed ? 'deactivated' : '',
      ].filter(Boolean).join('  ');
      const state = device.online ? 'online' : 'OFFLINE';
      console.log(`      #${device.index}  "${device.name}"  ${device.family ?? 'unknown family'}  ${state}  ${extras}`);
    }
  }
} catch (error) {
  console.error(`Failed: ${error instanceof CloudError ? `[${error.reason}] ` : ''}${error.message}`);
  process.exitCode = 1;
} finally {
  await cloud.logout();
}

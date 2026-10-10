#!/usr/bin/env node
// Read-only check of an Ajax account: logs in and lists the spaces with their state. Sends no command.
//
//   npm run build
//   read -rs AJAX_PASSWORD && export AJAX_PASSWORD && AJAX_EMAIL=you@example.com node scripts/probe.mjs
//
// Optional: AJAX_TOTP_SECRET (authenticator secret), AJAX_CLIENT_VERSION.

import { randomUUID } from 'node:crypto';

import { AjaxCloud, CloudError, sha256 } from '../dist/cloud/ajax.js';

const { AJAX_EMAIL: email, AJAX_PASSWORD: password, AJAX_TOTP_SECRET: totpSecret, AJAX_CLIENT_VERSION: clientVersion } = process.env;

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
  clientVersion: clientVersion ?? '3.57',
});

try {
  await cloud.login();
  console.log('Login: ok');
  const spaces = await cloud.spaces();
  console.log(`Spaces: ${spaces.length}`);
  for (const space of spaces) {
    console.log(`  - "${space.name}"  id=${space.id}  state=${space.state}  hub=${space.online ? 'online' : 'offline'}`);
  }
} catch (error) {
  console.error(`Failed: ${error instanceof CloudError ? `[${error.reason}] ` : ''}${error.message}`);
  process.exit(1);
}

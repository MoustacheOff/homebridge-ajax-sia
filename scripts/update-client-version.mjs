#!/usr/bin/env node
// Keeps the default Ajax app version current. Asks the App Store for the latest release of the Ajax app
// and, when it is newer than the default of the plugin, rewrites that default everywhere it is written.
// It never lowers the version, and it changes nothing at all if any of the places cannot be updated.
//
//   node scripts/update-client-version.mjs [--dry-run] [--root <dir>]
//
// Run daily by .github/workflows/ajax-version.yml, which proposes the change as a pull request.
// ITUNES_LOOKUP_URL replaces the App Store address, for tests.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const BUNDLE_ID = 'systems.ajax.iosapp';
const LOOKUP_URL = process.env.ITUNES_LOOKUP_URL ?? `https://itunes.apple.com/lookup?bundleId=${BUNDLE_ID}`;

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '.' : '.');
const dryRun = args.includes('--dry-run');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const parts = (version) => version.split('.').map(Number);
const isNewer = (candidate, current) => {
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) {
      return x > y;
    }
  }
  return false;
};

async function latestVersion() {
  let body;
  try {
    const response = await fetch(LOOKUP_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) {
      fail(`The App Store answered ${response.status}.`);
    }
    body = await response.json();
  } catch (error) {
    fail(`Could not read the App Store: ${error instanceof Error ? error.message : error}`);
  }

  const app = Array.isArray(body?.results) ? body.results.find((result) => result?.bundleId === BUNDLE_ID) : undefined;
  const match = typeof app?.version === 'string' ? /^(\d{1,3})\.(\d{1,3})(\.\d+)*$/.exec(app.version) : null;
  if (!match) {
    fail(`The App Store did not return a version of ${BUNDLE_ID} that this script understands.`);
  }
  // Ajax announces its apps as major.minor.
  return `${match[1]}.${match[2]}`;
}

const read = (file) => readFileSync(join(root, file), 'utf8');

/** Replaces exactly one match, or stops: a pattern that no longer matches means the layout changed. */
function replaceOnce(text, pattern, replacement, where) {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags}g`)) ?? [];
  if (matches.length !== 1) {
    fail(`Expected one place to update in ${where}, found ${matches.length}. Nothing was changed.`);
  }
  return text.replace(pattern, replacement);
}

function addChangelogEntry(text, version) {
  const entry = `- The default Ajax app version announced to Ajax is now ${version}, the latest on the App Store.`;
  const start = text.indexOf('## [Unreleased]');
  if (start < 0) {
    fail('No "Unreleased" section in CHANGELOG.md. Nothing was changed.');
  }
  // The section runs up to the blank line before the next release heading.
  const next = text.indexOf('\n## [', start + 1);
  const end = next < 0 ? text.length : next;
  const section = text.slice(start, end);
  const changed = section.match(/### Changed\n\n(?:- .*\n)+/);
  const updated = changed
    ? section.replace(changed[0], `${changed[0]}${entry}\n`)
    : `${section.replace(/\n*$/, '\n')}\n### Changed\n\n${entry}\n`;
  return text.slice(0, start) + updated + text.slice(end);
}

const config = read('src/config.ts');
const current = /DEFAULT_CLIENT_VERSION = '(\d+\.\d+)'/.exec(config)?.[1];
if (!current) {
  fail('Could not find DEFAULT_CLIENT_VERSION in src/config.ts.');
}

const latest = await latestVersion();
const output = (values) => {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
};

if (!isNewer(latest, current)) {
  console.log(`The default ${current} is current (App Store: ${latest}).`);
  output({ changed: 'false', version: current });
  process.exit(0);
}

const files = {
  'src/config.ts': replaceOnce(config, /(DEFAULT_CLIENT_VERSION = ')\d+\.\d+(')/, `$1${latest}$2`, 'src/config.ts'),
  'config.schema.json': replaceOnce(
    read('config.schema.json'),
    /("clientVersion": \{[^}]*?"default": ")\d+\.\d+(")/,
    `$1${latest}$2`,
    'config.schema.json',
  ),
  'README.md': replaceOnce(read('README.md'), /(\| `clientVersion` \| `)\d+\.\d+(` \|)/, `$1${latest}$2`, 'README.md'),
  'CHANGELOG.md': addChangelogEntry(read('CHANGELOG.md'), latest),
};

console.log(`New Ajax app version: ${current} -> ${latest}${dryRun ? ' (dry run, nothing written)' : ''}`);
if (!dryRun) {
  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(root, file), text);
  }
}
output({ changed: dryRun ? 'false' : 'true', version: latest });

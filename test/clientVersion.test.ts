import { execFile } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CLIENT_VERSION } from '../src/config.js';

const run = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'update-client-version.mjs');
const FILES = ['src/config.ts', 'config.schema.json', 'README.md', 'CHANGELOG.md'];
const BUNDLE_ID = 'systems.ajax.iosapp';

describe('the default Ajax app version', () => {
  it('is the same in the code, the settings form and the README', () => {
    const schema = JSON.parse(readFileSync(join(repo, 'config.schema.json'), 'utf8')) as {
      schema: { properties: { cloud: { properties: { clientVersion: { default: string } } } } };
    };
    expect(schema.schema.properties.cloud.properties.clientVersion.default).toBe(DEFAULT_CLIENT_VERSION);
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain(`| \`clientVersion\` | \`${DEFAULT_CLIENT_VERSION}\` |`);
    expect(DEFAULT_CLIENT_VERSION).toMatch(/^\d+\.\d+$/);
  });
});

describe('scripts/update-client-version.mjs', () => {
  let appStore: Server;
  let reply: { status?: number; body: unknown };
  let url: string;
  let root: string;

  beforeEach(async () => {
    reply = { body: { resultCount: 1, results: [{ bundleId: BUNDLE_ID, version: '99.1' }] } };
    appStore = createServer((_request, response) => {
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => appStore.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(appStore.address() as AddressInfo).port}/lookup`;

    // A copy of the real files, so that the test breaks when their layout stops matching what the script expects.
    root = mkdtempSync(join(tmpdir(), 'ajax-version-'));
    for (const file of FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      copyFileSync(join(repo, file), join(root, file));
    }
  });

  afterEach(() => new Promise<void>((resolve) => appStore.close(() => resolve())));

  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const snapshot = () => FILES.map(read);
  const execute = (...flags: string[]) =>
    run(process.execPath, [script, '--root', root, ...flags], { env: { ...process.env, ITUNES_LOOKUP_URL: url, GITHUB_OUTPUT: '' } });

  it('rewrites the default in the code, the form, the README and the changelog when the App Store has a newer version', async () => {
    const { stdout } = await execute();
    expect(stdout).toContain(`${DEFAULT_CLIENT_VERSION} -> 99.1`);

    expect(read('src/config.ts')).toContain("DEFAULT_CLIENT_VERSION = '99.1'");
    expect(JSON.parse(read('config.schema.json')).schema.properties.cloud.properties.clientVersion.default).toBe('99.1');
    expect(read('README.md')).toContain('| `clientVersion` | `99.1` |');
    expect(read('CHANGELOG.md')).toMatch(/## \[Unreleased\]\n\n### Changed\n\n[\s\S]*now 99\.1, the latest on the App Store\./);
    // Only the default changed: the old number is still the one announced by the tests and the examples.
    expect(read('README.md').replace('99.1', DEFAULT_CLIENT_VERSION)).toBe(readFileSync(join(repo, 'README.md'), 'utf8'));
  });

  it('adds the entry to the existing "Changed" list of the unreleased section', async () => {
    writeFileSync(
      join(root, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Something else.\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- A thing.\n',
    );
    await execute();
    expect(read('CHANGELOG.md')).toBe(
      '# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Something else.\n'
      + '- The default Ajax app version announced to Ajax is now 99.1, the latest on the App Store.\n\n'
      + '## [1.0.0] - 2026-01-01\n\n### Added\n\n- A thing.\n',
    );
  });

  const setDefault = (version: string) =>
    writeFileSync(
      join(root, 'src/config.ts'),
      read('src/config.ts').replace(`DEFAULT_CLIENT_VERSION = '${DEFAULT_CLIENT_VERSION}'`, `DEFAULT_CLIENT_VERSION = '${version}'`),
    );

  it.each([
    ['the same version', '99.1'],
    ['an older version', '1.2'],
  ])('changes nothing when the App Store has %s', async (_label, version) => {
    setDefault('99.1');
    const before = snapshot();
    reply = { body: { resultCount: 1, results: [{ bundleId: BUNDLE_ID, version }] } };

    const { stdout } = await execute();
    expect(stdout).toContain('is current');
    expect(snapshot()).toEqual(before);
  });

  it('compares versions as numbers, not as text', async () => {
    reply = { body: { resultCount: 1, results: [{ bundleId: BUNDLE_ID, version: '3.100' }] } };
    setDefault('3.99');
    await execute();
    expect(read('src/config.ts')).toContain("DEFAULT_CLIENT_VERSION = '3.100'");
  });

  it('keeps major.minor when the App Store adds a patch number', async () => {
    reply = { body: { resultCount: 1, results: [{ bundleId: BUNDLE_ID, version: '99.2.1' }] } };
    await execute();
    expect(read('src/config.ts')).toContain("DEFAULT_CLIENT_VERSION = '99.2'");
  });

  it('only writes with --dry-run when told to', async () => {
    const before = snapshot();
    const { stdout } = await execute('--dry-run');
    expect(stdout).toContain('dry run');
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['an error from the App Store', { status: 500, body: {} }],
    ['an answer that is not JSON', { body: 'nope' }],
    ['no app in the answer', { body: { resultCount: 0, results: [] } }],
    ['another app in the answer', { body: { results: [{ bundleId: 'other.app', version: '99.1' }] } }],
    ['a version it does not understand', { body: { results: [{ bundleId: BUNDLE_ID, version: 'beta' }] } }],
  ])('fails, and changes nothing, on %s', async (_label, answer) => {
    reply = answer;
    const before = snapshot();
    await expect(execute()).rejects.toMatchObject({ code: 1 });
    expect(snapshot()).toEqual(before);
  });

  it('fails, and changes nothing, when one of the places to update has moved', async () => {
    writeFileSync(join(root, 'README.md'), read('README.md').replace('| `clientVersion` |', '| `client_version` |'));
    const before = snapshot();
    await expect(execute()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('README.md') });
    expect(snapshot()).toEqual(before);
  });
});

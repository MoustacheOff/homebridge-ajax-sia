import { machine } from 'node:os';

import { describe, expect, it } from 'vitest';

import { describeHost, readHost } from '../../src/cloud/host.js';

const DEBIAN = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
`;

const UBUNTU = `NAME="Ubuntu"
VERSION_ID="24.04"
VERSION_CODENAME=noble
ID=ubuntu
ID_LIKE=debian
`;

const ALPINE = `NAME="Alpine Linux"
ID=alpine
VERSION_ID=3.20.3
`;

describe('describeHost', () => {
  it('names a Raspberry Pi the way fastfetch does', () => {
    const pi = { platform: 'linux', machine: 'aarch64', release: '6.12.109+rpt-rpi-v8', osRelease: DEBIAN, debianVersion: '12.15\n' };
    expect(describeHost(pi)).toBe('Debian GNU/Linux bookworm 12.15 aarch64');
  });

  it('falls back to the major version when the point release is unknown', () => {
    expect(describeHost({ platform: 'linux', machine: 'x86_64', release: '6.1.0', osRelease: DEBIAN }))
      .toBe('Debian GNU/Linux bookworm 12 x86_64');
  });

  it('ignores a Debian version file that is not a number, as on Ubuntu', () => {
    expect(describeHost({ platform: 'linux', machine: 'x86_64', release: '6.8.0', osRelease: UBUNTU, debianVersion: 'trixie/sid\n' }))
      .toBe('Ubuntu noble 24.04 x86_64');
  });

  it('copes with a distribution that has no codename', () => {
    expect(describeHost({ platform: 'linux', machine: 'x86_64', release: '6.6.0', osRelease: ALPINE })).toBe('Alpine Linux 3.20.3 x86_64');
  });

  it('copes with a Linux that has no os-release', () => {
    expect(describeHost({ platform: 'linux', machine: 'aarch64', release: '6.1.0' })).toBe('Linux 6.1.0 aarch64');
  });

  it('names macOS with its version', () => {
    expect(describeHost({ platform: 'darwin', machine: 'arm64', release: '27.0.0', macVersion: '27.0.1' })).toBe('macOS 27.0.1');
  });

  it('does not add the architecture to macOS, on Apple silicon or Intel', () => {
    expect(describeHost({ platform: 'darwin', machine: 'arm64', release: '27.0.0', macVersion: '27.0' })).toBe('macOS 27.0');
    expect(describeHost({ platform: 'darwin', machine: 'x86_64', release: '24.0.0', macVersion: '15.1' })).toBe('macOS 15.1');
  });

  it('names macOS without a version when it cannot be read', () => {
    expect(describeHost({ platform: 'darwin', machine: 'arm64', release: '27.0.0' })).toBe('macOS');
  });

  it('names Windows', () => {
    expect(describeHost({ platform: 'win32', machine: 'x86_64', release: '10.0.26100', windowsVersion: 'Windows 11 Pro' }))
      .toBe('Windows 11 Pro x86_64');
  });

  it('names any other system from what Node knows', () => {
    expect(describeHost({ platform: 'freebsd', machine: 'amd64', release: '14.1-RELEASE' })).toBe('freebsd 14.1-RELEASE amd64');
  });

  it('only ever produces a safe HTTP header value', () => {
    const longName = `Distro \u00f8\u00e5 ${'with a very long name '.repeat(4)}`;
    const osRelease = `NAME="${longName}"\nVERSION_ID=1\n`;
    const shown = describeHost({ platform: 'linux', machine: 'x86_64', release: '6', osRelease });
    expect(shown).toMatch(/^[\x20-\x7e]{1,64}$/);
    expect(shown.length).toBeLessThanOrEqual(64);
  });

  it('describes the machine the tests run on', () => {
    const shown = describeHost(readHost());
    expect(shown).toMatch(/^[\x20-\x7e]{1,64}$/);
    // macOS is named by its version alone; everywhere else the architecture comes last.
    if (process.platform === 'darwin') {
      expect(shown).toMatch(/^macOS( \d+(\.\d+)*)?$/);
    } else {
      expect(shown).toContain(machine());
    }
  });
});

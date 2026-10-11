import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { machine, release, version } from 'node:os';

/** What is known about the machine the plugin runs on. */
export interface HostFacts {
  platform: string;
  /** Hardware architecture as `uname -m` says it (`aarch64`, `x86_64`, `arm64`). */
  machine: string;
  /** Kernel release, as a last resort. */
  release: string;
  /** Contents of `/etc/os-release`, on Linux. */
  osRelease?: string;
  /** Contents of `/etc/debian_version`, on Debian and Raspberry Pi OS. */
  debianVersion?: string;
  /** Output of `sw_vers -productVersion`, on macOS. */
  macVersion?: string;
  /** What `os.version()` says, on Windows. */
  windowsVersion?: string;
}

const MAX_LENGTH = 64;

function parseOsRelease(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) {
      values[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
    }
  }
  return values;
}

/**
 * Names the operating system the way fastfetch does, for example `Debian GNU/Linux bookworm 12.15 aarch64`
 * or `macOS 27.0.1`. The result is safe to send in an HTTP header: printable ASCII, at most 64 characters.
 */
export function describeHost(facts: HostFacts): string {
  let parts: (string | undefined)[];

  switch (facts.platform) {
    case 'linux': {
      const os = facts.osRelease ? parseOsRelease(facts.osRelease) : {};
      if (!os.NAME) {
        parts = ['Linux', facts.release, facts.machine];
        break;
      }
      // Debian only puts its major version in os-release; the point release is in /etc/debian_version.
      const point = facts.debianVersion?.trim();
      const debian = (os.ID === 'debian' || os.ID === 'raspbian') && point && /^\d+(\.\d+)*$/.test(point);
      parts = [os.NAME, os.VERSION_CODENAME, debian ? point : os.VERSION_ID, facts.machine];
      break;
    }
    case 'darwin':
      // macOS is named by its version alone, like `macOS 27.0.1`.
      parts = ['macOS', facts.macVersion];
      break;
    case 'win32':
      parts = [facts.windowsVersion ?? 'Windows', facts.machine];
      break;
    default:
      parts = [facts.platform, facts.release, facts.machine];
  }

  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, MAX_LENGTH)
    .trim();
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Collects the facts from the machine the plugin is running on. */
export function readHost(): HostFacts {
  const facts: HostFacts = { platform: process.platform, machine: machine(), release: release() };

  if (process.platform === 'linux') {
    const osRelease = read('/etc/os-release');
    const debianVersion = read('/etc/debian_version');
    if (osRelease) {
      facts.osRelease = osRelease;
    }
    if (debianVersion) {
      facts.debianVersion = debianVersion;
    }
  } else if (process.platform === 'darwin') {
    try {
      facts.macVersion = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim();
    } catch {
      // The name just loses its version.
    }
  } else if (process.platform === 'win32') {
    facts.windowsVersion = version();
  }
  return facts;
}

/** The operating system of this machine, named as described above. */
export const hostDescription = (): string => describeHost(readHost());

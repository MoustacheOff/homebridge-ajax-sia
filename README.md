# homebridge-ajax-sia

[![CI](https://github.com/MoustacheOff/homebridge-ajax-sia/actions/workflows/ci.yml/badge.svg)](https://github.com/MoustacheOff/homebridge-ajax-sia/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/homebridge-ajax-sia)](https://www.npmjs.com/package/homebridge-ajax-sia)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Bring an [Ajax Systems](https://ajax.systems) alarm into Apple Home, **locally**, with no cloud account, no API key and no extra hardware.

The hub reports its events straight to Homebridge over **SIA DC-09**, the same protocol it uses to talk to a monitoring station. The plugin turns them into a HomeKit security system and sensors, so you can see the alarm state on your iPhone, Apple Watch and Mac, get notified, and use it in automations.

> **Status: early release (0.1).** The protocol layer is covered by tests against independently built hub traffic, and the plugin has been run end to end inside Homebridge 2. Reports from real hubs are very welcome, see [Reporting problems](#reporting-problems).

## What you get

| In HomeKit | From the Ajax system |
| --- | --- |
| Security system: **Home**, **Away**, **Night**, **Off**, **Alarm triggered** | Arming, night mode, disarming, intrusion / fire / gas / panic alarms |
| Tampered and fault indicators on the security system | Hub tamper, mains or battery trouble, hub gone silent |
| Motion, contact, smoke, leak and carbon monoxide sensors | Detectors you declare in the config |
| Tamper and low battery on each sensor | Detector tamper and battery events |

### What it cannot do

Be clear-eyed about this before installing:

- **It cannot arm or disarm the system.** SIA is a one-way channel: the hub talks, the plugin listens. The security system tile in Home is read-only; arm and disarm with the Ajax app, a keypad or a key fob. The Ajax Enterprise API that allows remote commands is only granted to large installers, and the Ajax end user agreement forbids reverse engineering the mobile app, so this project does neither.
- **Detectors only report while they are armed**, unless they are configured as always active in the Ajax app. A motion detector in a disarmed system is silent, so its HomeKit sensor stays idle.
- **Sirens and photo verification are not exposed.** SIA carries event codes only. A MotionCam / PhOD detector shows up as a regular motion sensor; its photos stay in the Ajax app.
- **State is learned from events.** If the system changes while Homebridge is down, HomeKit is wrong until the next event. The last known state is restored after a restart.

## How it works

```text
  Ajax hub ──── SIA DC-09 (TCP/UDP, optional AES) ────▶  Homebridge
  (Ethernet, Wi-Fi or 4G)                                 │
                                                          ├─ validates, acknowledges
                                                          ├─ decodes events
                                                          └─ HomeKit accessories
```

Nothing leaves your network, and the Ajax cloud is not involved: with direct SIA, the hub sends events to your server instead of an alarm receiving centre. See [docs/architecture.md](docs/architecture.md) for details.

## Requirements

- Homebridge 1.8 or 2.x, Node.js 22 or 24
- An Ajax hub with firmware **OS Malevich 2.7 or later** (Hub 2, Hub 2 Plus, Hub 2 (4G) and other recent hubs)
- The hub must be able to reach the Homebridge server on your network
- No runtime dependency: the plugin only uses Node.js built-ins

## Installation

From the Homebridge UI, search for **Ajax SIA**, or:

```sh
npm install -g homebridge-ajax-sia
```

## Set up the hub

In the Ajax app, open the space settings and go to **Security companies → Monitoring station** (the exact menu names vary a little between app versions), then:

1. **Protocol**: `SIA DC-09 (SIA-DCS)`.
2. **IP address** and **port**: those of the machine running Homebridge, and the port from the plugin config (7777 by default). Give that machine a fixed address or a DHCP reservation.
3. **Object number**: pick any hexadecimal value, 3 to 16 characters, for example `AB12`. It has to match `accountId` in the plugin.
4. **Encryption** (recommended): enable it and set a key of 16 characters. Put the same key in the plugin.
5. **Periodic test**: enable it, for example every minute, if you want the plugin to notice a silent hub (see `heartbeatTimeoutMinutes`).
6. Keep the channels you want enabled. Ethernet is the most reliable when the hub is wired.

Make sure no firewall blocks the port on the Homebridge host. If the hub uses a cellular channel only, it cannot reach a private address; use Ethernet or Wi-Fi for this connection.

> Heads up: the Monitoring station setting is also how a hub reports to a professional monitoring company. If yours is monitored, do not change it without checking with your installer or provider first.

## Configure the plugin

Use the Homebridge UI, or add a platform to `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AjaxSia",
      "name": "Ajax",
      "accountId": "AB12",
      "port": 7777,
      "encryptionKey": "0123456789abcdef",
      "devices": [
        { "zone": 1, "name": "Living room", "type": "motion" },
        { "zone": 2, "name": "Front door", "type": "contact" }
      ]
    }
  ]
}
```

| Option | Default | Description |
| --- | --- | --- |
| `accountId` | required | The hub's object number (3 to 16 hex characters). Messages from any other account are refused. |
| `port` | `7777` | Port to listen on, for TCP and UDP. |
| `protocol` | `both` | `tcp`, `udp` or `both`. |
| `listenAddress` | `0.0.0.0` | Interface to bind to. |
| `encryptionKey` | none | AES key shared with the hub. When set, **unencrypted messages are refused**. |
| `encryptionKeyFormat` | `ascii` | `ascii` for a 16, 24 or 32 character key; `hex` if you entered the key as 32, 48 or 64 hex digits. |
| `devices` | `[]` | Detectors to expose: `zone`, `name`, and `type` (`motion`, `contact`, `smoke`, `leak`, `co`). |
| `areas` | `1` | Number of Ajax groups. With several, the alarm reads **Home** until all are armed. |
| `motionResetSeconds` | `30` | How long a motion stays visible in HomeKit. |
| `heartbeatTimeoutMinutes` | `0` | Report a fault when the hub is silent this long. `0` disables it. |
| `maxTimeSkewSeconds` | `60` | Refuse timestamped messages further than this from the server clock. `0` disables it. |
| `allowedAddresses` | `[]` | Only accept traffic from these IP addresses. |

### Finding a detector's zone number

Leave `devices` empty at first. Arm the system, trip a detector, and watch the Homebridge log:

```text
[Ajax] Zone 12 reported BA but is not configured. To expose it, add { "zone": 12, "name": "...", "type": "motion" } to "devices".
```

## HomeKit mapping

| Ajax | HomeKit |
| --- | --- |
| Armed | Security system: **Away** (or **Home** while only some groups are armed) |
| Night mode | **Night** |
| Disarmed | **Off** |
| Intrusion, fire, gas or panic alarm | **Alarm triggered**, until disarmed or restored |
| Detector alarm | Motion detected / contact open / smoke / leak / CO on that sensor |
| Tamper, low battery | `StatusTampered`, `StatusLowBattery` |
| Mains or battery trouble on the hub, or silent hub | `StatusFault` |

The complete list of handled SIA codes is in [docs/events.md](docs/events.md).

## Troubleshooting

Run Homebridge in debug mode (`homebridge -D`) to see every message the hub sends and how it is understood.

| Symptom | Likely cause |
| --- | --- |
| Nothing in the log | The hub cannot reach the port: check the address, the port, and the firewall on the Homebridge host. |
| `Unencrypted message refused` | An `encryptionKey` is set in the plugin but encryption is off on the hub. |
| `Encrypted message received but no encryptionKey is configured` | The opposite. |
| `Decryption failed (wrong key?)` | Different keys, or the wrong `encryptionKeyFormat`. |
| `Timestamp off by ...` | The hub and Homebridge clocks differ. Check NTP on both, or raise `maxTimeSkewSeconds`. |
| `Unknown account` | `accountId` does not match the object number on the hub. |
| `Unsupported protocol ADM-CID` | Select `SIA-DCS` on the hub. |
| A state is wrong in HomeKit | The state changed while Homebridge was not listening. It corrects itself at the next arming event. |

### Reporting problems

Hubs differ slightly in which codes they send and when. If something is mis-reported, open an issue with the debug log lines around the event (redact the object number if you like). That is the most useful thing you can contribute.

## Development

```sh
git clone https://github.com/MoustacheOff/homebridge-ajax-sia.git
cd homebridge-ajax-sia
npm install
npm test           # unit and integration tests
npm run lint
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by or supported by Ajax Systems. "Ajax" is a trademark of its owner. Home notifications are a convenience, not a safety system: do not rely on HomeKit alone to be warned of a fire, an intrusion or a leak.

## License

[MIT](LICENSE)

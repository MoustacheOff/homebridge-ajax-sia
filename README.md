<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" alt="Homebridge" height="140"></a>
</p>

<h1 align="center">homebridge-ajax-sia</h1>

<p align="center">Ajax Systems alarm in Apple Home, through Homebridge</p>

<p align="center">
  <a href="https://www.npmjs.com/package/homebridge-ajax-sia"><img alt="npm" src="https://img.shields.io/npm/v/homebridge-ajax-sia?logo=npm&logoColor=white&color=CB3837"></a>
  <a href="https://github.com/MoustacheOff/homebridge-ajax-sia/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/MoustacheOff/homebridge-ajax-sia/ci.yml?logo=githubactions&logoColor=white&label=CI"></a>
  <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/node/v/homebridge-ajax-sia?logo=nodedotjs&logoColor=white&color=5FA04E"></a>
  <a href="https://homebridge.io"><img alt="Homebridge" src="https://img.shields.io/badge/homebridge-1.8%20%7C%202.x-491F59"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

Bring an [Ajax Systems](https://ajax.systems) alarm into Apple Home. By default it works **locally**, with no cloud account, no API key and no extra hardware.

The hub reports its events straight to Homebridge over **SIA DC-09**, the same protocol it uses to talk to a monitoring station. The plugin turns them into a HomeKit security system and sensors, so you can see the alarm state on all your Apple devices (iPhone, iPad, Apple Watch and Mac), get notified, and use it in automations. Arming and disarming from HomeKit is possible too, through an optional and unofficial connection described [below](#commands-from-homekit-unofficial).

## What you get

| In HomeKit | From the Ajax system |
| --- | --- |
| Security system: **Away**, **Night**, **Off**, **Alarm triggered** | Arming, night mode, disarming, intrusion / fire / gas / panic alarms |
| Tampered and fault indicators on the security system | Hub tamper, mains or battery trouble, hub gone silent |
| Motion, contact, smoke, leak and carbon monoxide sensors | Detectors you declare in the config |
| Tamper and low battery on each sensor | Detector tamper and battery events |

### What it cannot do

Be clear-eyed about this before installing:

- **SIA alone cannot arm or disarm the system.** It is a one-way channel: the hub talks, the plugin listens, so by default the security system tile is read-only. Commands go through the optional, unofficial cloud connection; read its [warning](#commands-from-homekit-unofficial) before enabling it.
- **Detectors only report while they are armed**, unless they are set as always active in the Ajax app. A motion detector in a disarmed system is silent, so its HomeKit sensor stays idle. In night mode, each detector follows its own "Arm in Night mode" setting.
- **Sirens, key fobs and photo verification are not exposed.** SIA carries event codes only. A MotionCam / PhOD detector shows up as a regular motion sensor; its photos stay in the Ajax app.
- **State is learned from events.** If the system changes while Homebridge is down, HomeKit is wrong until the next event, or until the next state read when commands are enabled. The last known state is restored after a restart.

## How it works

```text
  Ajax hub ──── SIA DC-09 (TCP/UDP, optional AES) ────▶  Homebridge
  (Ethernet, Wi-Fi or 4G)                                 │
                                                          ├─ validates, acknowledges
                                                          ├─ decodes events
                                                          └─ HomeKit accessories
```

With direct SIA, the hub sends its events to your server instead of an alarm receiving centre, and the Ajax cloud is not involved. See [docs/architecture.md](docs/architecture.md) for details.

## Requirements

- Homebridge 1.8 or 2.x, Node.js 22, 24 or 26
- An Ajax hub with firmware **OS Malevich 2.7 or later** (Hub 2, Hub 2 Plus, Hub 2 (4G) and other recent hubs)
- The hub must be able to reach the Homebridge server on your network
- No runtime dependency: the plugin only uses Node.js built-ins

## Installation

From the Homebridge UI, search for **Ajax SIA**, or:

```sh
npm install -g homebridge-ajax-sia
```

## Set up the hub

In the Ajax app, open the space settings and go to **Security companies → Monitoring station** (menu names vary a little between app versions and languages). This is *not* the "Invite the installer / company" form, which asks for an e-mail address and is unrelated. Then:

1. **Protocol**: `SIA DC-09 (SIA-DCS)`.
2. **IP address** and **port**: those of the machine running Homebridge, and the port from the plugin config (7777 by default). Give that machine a fixed address or a DHCP reservation.
3. **Object number** (**Site number** in the app): pick any hexadecimal value, 3 to 16 characters, for example `AB12`. It is only an identifier that the hub puts in every message: the plugin ignores messages carrying another one. It has to match `accountId` in the plugin.
4. **Encryption** (recommended): enable it and set a key of 16 characters. Put the same key in the plugin.
5. **Periodic test**: enable it, for example every minute, if you want the plugin to notice a silent hub (see `heartbeatTimeoutMinutes`).
6. Keep only the channels that can reach your server. Ethernet is the most reliable; a cellular channel cannot reach a private address, so turn it off for this connection.

Make sure no firewall blocks the port on the Homebridge host.

> The Monitoring station setting is also how a hub reports to a professional monitoring company. If yours is monitored, do not change it without checking with your installer or provider first.

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
      "hub": { "model": "Hub 2 (4G)", "serial": "003171A3" },
      "devices": [
        { "zone": 1, "name": "Front door", "type": "contact", "model": "DoorProtect Plus", "serial": "30FC05F80F2" },
        { "zone": 2, "name": "Living room", "type": "motion", "model": "MotionProtect Plus", "serial": "30E2BB490E1" }
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
| `devices` | `[]` | Detectors to expose: `zone`, `name`, `type` (`motion`, `contact`, `smoke`, `leak`, `co`), and optionally `model`, `serial`, `firmware`. |
| `hub` | `{}` | What HomeKit shows for the alarm: optional `model`, `serial`, `firmware`. |
| `areas` | `1` | Number of Ajax groups. With several, the alarm reads **Home** until all are armed. |
| `motionResetSeconds` | `30` | How long a motion stays visible in HomeKit. |
| `heartbeatTimeoutMinutes` | `0` | Report a fault when the hub is silent this long. `0` disables it. |
| `maxTimeSkewSeconds` | `60` | Refuse timestamped messages further than this from the server clock. `0` disables it. |
| `allowedAddresses` | `[]` | Only accept traffic from these IP addresses. |

### Finding a detector's zone number

The zone is the **device number** the hub gives each detector. In the Ajax app, open a detector and scroll to the bottom of its page: it shows the device number (for example **Device 3**), next to its firmware and device ID. That number is the `zone`. Ajax's own documentation shows an intrusion alarm from device 1 reported as `[#1234|Nri2/BA1]`, which is zone 1.

You can also leave `devices` empty, arm the system and trip a detector; the Homebridge log then says:

```text
[Ajax] Zone 12 reported BA but is not configured. To expose it, add { "zone": 12, "name": "...", "type": "motion" } to "devices".
```

Beware that tripping an armed detector makes the sirens sound.

### What HomeKit shows about each accessory

The accessory page in Home lists a manufacturer, model, serial number and "internal program" (the firmware). By default the plugin shows `Ajax Systems`, a generic model, `Device <zone>` as serial number, and **its own version** as firmware. Set `model`, `serial` and `firmware` to what the Ajax app shows (the **device ID** at the bottom of the detector page makes a good serial number) to make them meaningful. HomeKit keeps only three numbers of a firmware version, so `5.59.3.3` appears as `5.59.3`.

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

### In the Home app

- The alarm is a normal tile. With commands enabled it offers **Away**, **Night** and **Off**; "Home" is not offered because Ajax has no equivalent without groups.
- **Sensors are not tiles.** Apple groups motion and contact sensors into status badges at the top of their room ("Motion: none detected", "Contact sensor: closed"), never on the main page. That is how Home treats every such sensor; use them in **automations** instead, for example a notification when a motion is detected while the alarm is armed.
- Siri and the Control Center can arm and disarm. Disarming asks you to unlock the device first, and smart speakers refuse it by design.

## Commands from HomeKit (unofficial)

SIA only listens. To arm, disarm and switch to night mode from Apple Home, the plugin can also talk to the Ajax cloud the way the Ajax mobile apps do. It then:

- sends **Away**, **Night** and **Off** from the Home app, Siri and automations to the hub,
- reads the real state at startup, after each command and every hour, so HomeKit is right even after a restart,
- keeps using SIA for instant events.

> **Read this first.** This uses the protocol of the Ajax mobile apps. It is **not** an official API: Ajax can change it or block it without notice (it has already retired old client versions), and the Ajax end user agreement restricts reverse engineering of its software and allows Ajax to terminate an account that breaks it. **Nobody can promise that an account will never be restricted.** Using this feature is your decision, at your own risk. It is off by default; SIA alone never contacts the Ajax cloud.

### Protecting your Ajax account

- **Use a dedicated account.** Create a second Ajax account, invite it to your space from the Ajax app with only the rights it needs (arming and disarming), and give *that* account to the plugin. If Ajax ever restricted it, your own account, your phones and your watch would be unaffected, and you can revoke it in one tap.
- **The plugin keeps its traffic small.** It logs in once and reuses the session across restarts, reads the state only at startup, after a command and every hour (`syncIntervalMinutes`), and relies on SIA for everything else.
- **It stops instead of insisting.** On wrong credentials, a locked account, a retired client version or a missing two-factor secret, it stops contacting Ajax until Homebridge is restarted, rather than repeating a failure that cannot succeed. The log says why.
- **It is easy to spot.** In the app, the list of active sessions shows the plugin under the name `Homebridge` with the operating system it runs on, named like fastfetch does, for example `Debian GNU/Linux bookworm 12.15 aarch64` or `macOS 27.0.1` (`deviceModel` and `deviceOs`). End that session to cut its access at any time.

```json
{
  "platform": "AjaxSia",
  "accountId": "AB12",
  "cloud": {
    "enabled": true,
    "email": "homebridge@example.com",
    "password": "the-password-of-that-account",
    "spaceName": "Home"
  }
}
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Turns the feature on. |
| `email`, `password` | required | The Ajax account. They are stored in `config.json` like any plugin credential, so keep that file readable by its owner only (`chmod 600`). |
| `totpSecret` | none | Base32 secret of your authenticator app, if the account uses two-factor authentication. |
| `spaceName` | none | Needed only when the account has several spaces. The log lists them. |
| `spaceId` | none | Alternative to `spaceName`. |
| `syncIntervalMinutes` | `60` | How often to read the real state. `0` reads only at startup and after a command. |
| `deviceModel`, `deviceOs` | `Homebridge`, the host's OS and version | How the plugin is named in the list of sessions of the account. The OS is read from the machine, for example `Debian GNU/Linux bookworm 12.15 aarch64` or `macOS 27.0.1`. |
| `clientVersion` | `3.57` | App version announced to Ajax. Raise it if the log says Ajax no longer accepts the client. |

A command that is refused (hub busy, malfunction to acknowledge, no permission) is logged with the reason and reported to HomeKit as a failure. The device id and session are kept in the Homebridge storage folder (`homebridge-ajax-sia-cloud.json`, readable by its owner only), so a restart does not open a new session.

### Check your account first

A read-only probe logs in and lists your spaces without sending any command, then ends its session:

```sh
npm run build
read -rs AJAX_PASSWORD && export AJAX_PASSWORD
AJAX_EMAIL=you@example.com node scripts/probe.mjs
```

## Troubleshooting

Run Homebridge in debug mode (`homebridge -D`) to see every message the hub sends and how it is understood.

| Symptom | Likely cause |
| --- | --- |
| The accessory shows "No Response" in Home | The plugin did not start. Look for `Invalid configuration` or `ERROR LOADING PLUGIN` in the Homebridge log. |
| Nothing in the log | The hub cannot reach the port: check the address, the port, and the firewall on the Homebridge host. |
| `Unencrypted message refused` | An `encryptionKey` is set in the plugin but encryption is off on the hub. |
| `Encrypted message received but no encryptionKey is configured` | The opposite. |
| `Decryption failed (wrong key?)` | Different keys, or the wrong `encryptionKeyFormat`. |
| `Timestamp off by ...` | The hub and Homebridge clocks differ. Check NTP on both, or raise `maxTimeSkewSeconds`. |
| `Unknown account` | `accountId` does not match the object number on the hub. |
| `Unsupported protocol ADM-CID` | Select `SIA-DCS` on the hub. |
| `Zone N reported ... but is not configured` | A detector you have not declared fired; add it to `devices`. |
| `Ajax no longer accepts this client version` | Ajax retired the announced app version: raise `clientVersion`. |
| `Calls to Ajax are stopped to protect your account` | Wrong credentials, locked account or missing two-factor secret. Fix it and restart Homebridge. |
| `Ajax refused "...": hub busy` (or similar) | The hub was in the middle of another transition. Try again. |
| A state is wrong in HomeKit | The state changed while Homebridge was not listening. It corrects itself at the next arming event or state read. |

### Reporting problems

Hubs differ slightly in which codes they send and when. If something is mis-reported, open an issue with the debug log lines around the event (redact the object number if you like). That is the most useful thing you can contribute.

## Development

```sh
git clone https://github.com/MoustacheOff/homebridge-ajax-sia.git
cd homebridge-ajax-sia
npm install
npm test           # unit and integration tests
npm run lint
npm run typecheck
npm run build
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by or supported by Ajax Systems. "Ajax" is a trademark of its owner. Home notifications are a convenience, not a safety system: do not rely on HomeKit alone to be warned of a fire, an intrusion or a leak.

## License

[MIT](LICENSE)

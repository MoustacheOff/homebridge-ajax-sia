# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The sirens and keyfobs of the Ajax account (StreetSiren, HomeSiren, SpaceControl, button and the like) are exposed in HomeKit for their **battery**, **tamper** and **connection** (`cloud.statusDevices`, on by default, and it needs `cloud.discoverDevices`). They detect nothing and HomeKit has no siren or keyfob tile, so each shows as a contact sensor that always reads closed; Apple Home flags it as "No Response" when it is offline. They also react to the hub's SIA events for their zone (lid open, battery low, connection lost). The new device types `siren` and `remote` can be used under `devices` as well.

## [1.4.0] - 2026-11-16

### Added

- A detector that reports a failure, a dirty smoke chamber or a faulty CO sensor (`FT`, `FS`, `GS`) shows as faulty in HomeKit until the matching restore (`FJ`, `GX`), without needing the Ajax account. It is a fault, never an alarm.
- High radio interference reported by the hub (`XQ`) marks the alarm tile as faulty until it is back to normal (`XH`).
- Every code of Ajax's SIA table now has a defined effect: a detector shows as tampered for an open enclosure switch, a disconnected antenna, a device that was moved or a sabotaged output line (`EJ`, `EM`, `SM`, `UA`), as faulty for a zone malfunction, a failed self-test, an output fault or masking (`BG`, `UT`, `BS`, `OU`, `BT`), and as inactive (`StatusActive` off) while it is deactivated (`BB`, `QB`, `HB`). The Ajax account's own "deactivated" flag feeds the same field. Each of these stays on until every one of its causes is lifted.
- Hold-up confirmed (`HV`) and medical or emergency (`MA`) alarms raise the hub's alarm, and clear with `PH` and `MR`. An alarm aborted or cancelled by a disarm (`AB`, `OC`) is acknowledged like `OR`.
- The hub's links and power show as a fault of the alarm tile while they are down: offline (`YC`), Ethernet, cellular or Wi-Fi (`YS`, `LT`, `YW`), power supply (`YP`).
- What changes no state but is worth knowing (an arming that failed, a firmware update, a keypad locked) is named in the log, as a warning or as information, instead of only in the debug log.

## [1.3.0] - 2026-11-16

### Added

- Once the Ajax account is set up, the firmware the hub runs is read from it (`cloud.hubFirmware`, on by default, once a day) and shown in HomeKit, unless one is typed under `hub.firmware`. It comes from a second connection of the Ajax app, which this plugin opens only for that and closes right after. If it cannot be read, HomeKit keeps showing the version of the plugin.
- Once the Ajax account is set up, its detectors are followed live (`cloud.liveUpdates`, on by default among the cloud options; without an account the plugin still never contacts Ajax): the plugin keeps a connection open, as the Ajax app does, so a battery, a tamper or a detector that goes offline shows as it changes. The connection is opened again after a loss, waiting longer after each failure, and the periodic read stays as the safety net while it is down. Set `liveUpdates` to `false` to read the account only every `syncIntervalMinutes`.

### Changed

- The documentation no longer says that **Connect on demand** stops the hub from sending test reports, which Ajax does not state.

## [1.2.0] - 2026-11-15

### Added

- Events the plugin does not use are named in the debug log (`Ignored event YC (Hub is offline)`), for every code in Ajax's SIA table.
- A detector that loses contact with the hub (`XL`) shows as faulty in HomeKit, and clears when it is back (`XC`), without needing the Ajax account.
- A missing hub battery (`YM`) is reported as a hub fault until it is connected again (`YA`).
- A user resetting the fire alarm state (`FC`) clears the fire alarms that have no restore of their own, such as a keypad's fire button.

### Fixed

- Arming and disarming with a key switch were mixed up: `OS` is armed and `CS` is disarmed.
- Night mode started by a scenario (`NC`), or with malfunctions present (`NF`, `NB`), and arming by a scenario (`CB`, `AF`) or a group disarmed by one (`OB`) are now recognised.
- A restore after alarm (`OR`) acknowledges the alarm without disarming.
- Mains and battery troubles reported by a device (a range extender, a keypad, a FireProtect...) no longer put the hub in fault. A reserve battery that is low now shows on that device.
- A message the hub sends again because it did not see the acknowledgement is applied once. It is still acknowledged, and still counts as a sign that the hub is alive.

## [1.1.4] - 2026-11-14

### Changed

- The default Ajax app version announced to Ajax is now 3.60, the latest on the App Store.

## [1.1.3] - 2026-10-24

### Added

- The README has a section on securing the listener (encryption and `allowedAddresses`), as the Homebridge team suggested when verifying the plugin, and carries the Verified by Homebridge badge.

### Changed

- The default Ajax app version announced to Ajax is now 3.58, the latest on the App Store.

## [1.1.2] - 2026-10-12

### Fixed

- Two links of the README pointed to the old title of the section on the Ajax account, and went nowhere.

### Removed

- The alarm tile is no longer marked as faulty when the Ajax account reports the hub offline or in malfunction (1.1.0), nor read again after two minutes (1.1.1): Ajax reports a passing malfunction at every restart of Homebridge, and the plugin cannot tell it from a real one. The log no longer lists the sirens, keyfobs and keypads that need attention.
- The special handling of the verified burglary code `BV` and the log lines for `NE` and for duress codes (1.1.0): they came from a table of SIA codes and were never seen on a real hub. The release workflow is back to a single `gh release create`.

## [1.1.1] - 2026-10-12

### Fixed

- A fault reported by the Ajax account (for example the hub that lost the monitoring station for a moment while Homebridge restarted) stayed on the alarm tile until the next hourly check. The account is now read again after two minutes, up to five times, as long as a device needs attention, and the fault is cleared as soon as it is gone.

## [1.1.0] - 2026-10-12

### Added

- With the Ajax account connected, the detectors show their **battery level**, are flagged when **offline**, in **malfunction** or opened, and carry their real **model and serial number**.
- A **temperature sensor** is added to the detectors that measure it (`cloud.temperatureSensors`).
- Detectors that are in the Ajax account but not in `devices` are **found and exposed** with their name in the Ajax app (`cloud.discoverDevices`); the ones that leave the account are removed.
- The alarm tile is marked as faulty when the account says the hub is offline or in malfunction, and the log says when a siren, keyfob or keypad goes offline, runs low on battery or is opened.
- The probe script (`scripts/probe.mjs`) lists the devices of each space.
- A daily workflow looks up the latest release of the Ajax app on the App Store and proposes raising the default announced app version, in the code, the settings form and the README, so the default no longer waits for Ajax to retire the old one.

### Changed

- Every call to the Ajax cloud now goes through a queue, so reading the state and the devices at startup opens one session, not two.
- Night mode that the hub turns off by itself (`NO`, by its schedule) or with a duress code (`ND`) is now followed in HomeKit, instead of staying on Night until the next check. A refused night arming (`NE`) and a duress code are written to the log.
- A verified burglary (`BV`) is treated as an alarm of the hub, as SIA defines it: the number that comes with it is an area, no longer mistaken for a detector.
- The README mentions the per-channel IP addresses of OS Malevich 2.16.
- The README says that a home hub (Apple TV, HomePod or HomePod mini) is needed to use the alarm away from home and in automations.
- The README credits the projects and documentation this plugin was built from.
- The Homebridge badge of the README reads the supported versions from the published package, like the Node.js one.

## [1.0.2] - 2026-10-11

### Changed

- The plugin is listed as "Homebridge Ajax SIA" in the Homebridge UI, like most plugins.
- The README has the Homebridge logo and badges.

## [1.0.1] - 2026-10-11

### Added

- Support for Node.js 26, tested alongside 22 and 24.

### Changed

- Releases are staged on npm from GitHub Actions and approved by the maintainer with two-factor authentication.
- The README shows the usual Homebridge badges.
- Development dependencies: vitest 5.

## [1.0.0] - 2026-10-11

First release.

### Added

- SIA DC-09 receiver over TCP and UDP, with SIA-DCS messages, link tests and optional AES-128/192/256 encryption.
- HomeKit security system reflecting arming, night mode and alarms, with tamper and fault indicators.
- Motion, contact, smoke, leak and carbon monoxide sensors with tamper and low battery.
- Model, serial number and firmware shown in HomeKit for the hub and each detector, configurable from the plugin settings.
- Last known arming state restored after a restart, and detection of a silent hub from periodic tests.
- Homebridge UI configuration form.
- Optional and unofficial connection to the Ajax cloud, off by default, to arm, disarm and switch to night mode from HomeKit and to read the real state at startup, after each command and every hour.
  - The session is reused across restarts, and the plugin stops contacting Ajax after a failure that retrying cannot fix (wrong credentials, locked account, retired client version, missing two-factor secret).
  - The plugin names itself `Homebridge`, with the operating system it runs on (read from the machine, for example `Debian GNU/Linux bookworm 12.15 aarch64` or `macOS 27.0.1`), in the list of sessions of the Ajax account, and renames its session when that name changes.
- `scripts/probe.mjs`, a read-only check of an Ajax account that ends its session when it exits.

[Unreleased]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.4...v1.2.0
[1.1.4]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/releases/tag/v1.0.0

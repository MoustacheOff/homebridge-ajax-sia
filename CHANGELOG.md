# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/releases/tag/v1.0.0

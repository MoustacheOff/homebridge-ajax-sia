# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/MoustacheOff/homebridge-ajax-sia/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/MoustacheOff/homebridge-ajax-sia/releases/tag/v1.0.0

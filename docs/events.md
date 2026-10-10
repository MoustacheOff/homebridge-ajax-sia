# Handled SIA events

Events are `Nri<area>/<code><zone>`, for example `Nri1/BA12`: code `BA` (burglary alarm) on zone 12 in area 1. For arming codes the number after the code is a user, not a zone.

Anything not listed is ignored and logged at debug level.

## Arming

| Code | Meaning | Effect |
| --- | --- | --- |
| `CL`, `CA`, `CP`, `CF`, `CG` | Armed (manually, automatically, forced, per group) | Area is armed |
| `NL` | Night mode on | **Night** |
| `NP` | Night mode off | Night cleared |
| `OP`, `OA`, `OK`, `OR`, `OS`, `OG` | Disarmed (manually, automatically, from alarm, per group) | Area disarmed, night cleared, intrusion and panic alarms acknowledged |

When every area (`areas` in the config) is armed the state is **Away**; when only some are, **Home**. Night mode wins over both.

## Alarms

| Alarm | Restore | Raises | Shown on |
| --- | --- | --- | --- |
| `BA`, `BV` intrusion | `BR`, `BH` | intrusion | motion / contact sensor, and the hub |
| `FA`, `KA` fire, heat | `FR`, `FH`, `KR`, `KH` | fire | smoke sensor, and the hub |
| `GA` gas | `GR`, `GH` | gas | CO sensor, and the hub |
| `WA` water | `WR`, `WH` | water | leak sensor only |
| `PA`, `HA` panic, hold-up | `PR`, `HR` | panic | the hub only |

A disarm acknowledges intrusion and panic alarms. Fire, gas and water alarms stay until the detector reports a restore.

## Troubles

| Code | Meaning | Effect |
| --- | --- | --- |
| `TA` / `TR` | Tamper / restore | `StatusTampered` on the zone, or on the hub when there is no zone |
| `XT` / `XR` | Detector battery low / restore | `StatusLowBattery` on the zone |
| `AT` / `AR` | Hub mains power lost / restore | Hub `StatusFault` |
| `YT` / `YR` | Hub battery low / restore | Hub `StatusFault` |

Zone `0`, or no zone, always means the hub itself.

## Link tests

`NULL` messages and automatic test reports (`RP`) only prove the hub is alive. They are acknowledged and, with `heartbeatTimeoutMinutes`, keep the hub from being reported as silent.

# Handled SIA events

Events are `Nri<area>/<code><zone>`, for example `Nri1/BA12`: code `BA` (intrusion alarm) on zone 12 in area 1. For arming codes the number after the code is a user, not a zone.

The codes and their meanings are those of Ajax's "SIA codes for OS Malevich" table. Ajax calls an arming a "restore" and a disarming an "event", and some codes are not what the SIA standard says they are: `OS` is *armed* with an arm switch and `CS` is *disarmed* with one.

Anything not listed here is ignored and logged at debug level, with its name when Ajax documents it. A hub sends a message again when it does not see the acknowledgement: a copy received within two minutes (same sequence number and same content) is acknowledged but not applied a second time.

## Arming

| Code | Meaning | Effect |
| --- | --- | --- |
| `CL`, `CF`, `CG` | Armed (also with malfunctions, or one group) | Area is armed |
| `CA`, `CB`, `AF` | Armed by a scenario (also one group, or with malfunctions) | Area is armed |
| `OS` | Armed with an arm switch | Area is armed |
| `NL`, `NF` | Night mode on (also with malfunctions) | **Night** |
| `NC`, `NB` | Night mode on by a scenario (also with malfunctions) | **Night** |
| `NP`, `NO`, `ND` | Night mode off (by a user, by a scenario, with a duress code) | Night cleared |
| `OP`, `OG` | Disarmed (also one group) | Area disarmed, night cleared, intrusion and panic alarms acknowledged |
| `OA`, `OB` | Disarmed by a scenario (also one group) | Same |
| `CS` | Disarmed with an arm switch | Same |
| `OR` | System restored after alarms | Intrusion and panic alarms acknowledged. Arming is left as it is |
| `AB`, `OC` | Alarm aborted / cancelled by disarming | Same as `OR` |

The standard SIA codes `CP` (armed) and `OK` (disarmed) are accepted too, although Ajax does not send them.

When every area (`areas` in the config) is armed the state is **Away**; when only some are, **Home**. Night mode wins over both.

## Alarms

| Alarm | Restore | Raises | Shown on |
| --- | --- | --- | --- |
| `BA`, `BV` intrusion | `BR`, `BH` | intrusion | motion / contact sensor, and the hub |
| `FA`, `KA` fire, heat | `FR`, `FH`, `KR`, `KH` | fire | smoke sensor, and the hub |
| `GA` gas | `GR`, `GH` | gas | CO sensor, and the hub |
| `WA` water | `WR`, `WH` | water | leak sensor only |
| `PA`, `HA` panic, hold-up; `HV` hold-up confirmed; `MA` medical or emergency | `PR`, `HR`, `PH`, `MR` | panic | the hub only |

A disarm acknowledges intrusion and panic alarms. Fire, gas and water alarms stay until the detector reports a restore, except that `FC` (a user reset the fire alarm state) clears every fire alarm: the fire button of a keypad and an evacuation send no restore of their own.

## Troubles

| Code | Meaning | Effect |
| --- | --- | --- |
| `TA` / `TR` | Tamper or lid open / restore | `StatusTampered` on the zone, or on the hub when there is no zone |
| `EJ` / `ES` | Enclosure tamper switch disconnected / connected | `StatusTampered` on the zone. Ignored when there is no zone |
| `EM` / `EN` | External antenna or self-test device disconnected / connected | Same |
| `SM` / `SC` | Device moved / moved back | Same |
| `UA` / `UH` | Output line sabotage / restored | Same |
| `XT` / `XR` | Detector battery low / restore | `StatusLowBattery` on the zone |
| `YT` / `YR` | Battery low / restore | `StatusLowBattery` on the zone when the event has one (the reserve battery of a FireProtect, a keypad...), the hub's `StatusFault` otherwise |
| `XL` / `XC` | Detector connection lost / restored | `StatusFault` on the zone |
| `FT` / `FS` / `GS` | Detector failure / smoke chamber dirty or detector faulty / CO sensor faulty | `StatusFault` on the zone, never an alarm. Ignored when there is no zone |
| `BG` / `UT` / `BS` / `OU` / `BT` | Zone malfunction / malfunction / self-test failed or ring fault / output fault / masking | Same |
| `FJ`, `GX`, `UJ`, `BJ`, `OV` | Failure over (`FT`, `FS`) / CO sensor back to normal (`GS`) / malfunction over (`UT`) / masking, short circuit or ring fault over (`BG`, `BS`, `BT`) / output fault over (`OU`) | Lifts what it names. A detector stays faulty, or tampered, while another of its causes is still open |
| `FX`, `BX` | Smoke chamber test / self-test passed | Logged only: a test that went well does not say a failure is over |
| `BB` / `BU`, `QB` / `QU`, `HB` / `HU` | Detector deactivated / active again (by the user, temporarily, by a setting) | `StatusActive` is off on the zone while any of them is on. Ignored when there is no zone |
| `XQ` / `XH` | Radio interference is high / back to normal | Hub `StatusFault`. Ignored when a zone is given |
| `YC` / `YK` | Hub is offline / back online | Hub `StatusFault`. Ignored when a zone is given |
| `YS` / `YZ`, `LT` / `LR`, `YW` / `YY` | Server link lost / restored over Ethernet, cellular, Wi-Fi | Hub `StatusFault` while any link is down. Ignored when a zone is given |
| `YP` / `YQ` | Power supply trouble / restored | Hub `StatusFault`. Ignored when a zone is given |
| `AT` / `AR` | Hub mains power lost / restore | Hub `StatusFault`. Ignored when a zone is given: that is the power of a range extender, a keypad or a power supply |
| `YM` / `YA` | Hub battery missing / connected again | Hub `StatusFault`. Ignored when a zone is given |

Zone `0`, or no zone, always means the hub itself.

### Logged, no effect on the state

These are named in the log (a warning for the first group, information for the second) and change nothing in HomeKit:

- **Warning:** `CC`, `CD`, `NE`, `CI`, `EA` (an arming failed or did not complete), `JA` (unauthorized access attempt), `XI` (device reset to factory settings), `KT` (overheating shutdown), `YF` (hub memory corrupted), `ZA` (low temperature), `YX` (device not responding).
- **Information:** `CR`, `KJ`, `ZR`, `AE`, `AY`, `YG`, `RB`, `RS`, `TB`, `TU`, `UR`, `US`, `KG`, `RG`, `RL`, `PF`, `PO`, `ZY`, `ZZ`, `FX`, `BX`.
- **Debug only:** `RP` (periodic test), the photo codes `PC`, `PD`, `PE`, `PG`, and the calls with a company `AD`, `AC`, `AH`, `AG`, `AI`.

## Link tests

`NULL` messages and automatic test reports (`RP`) only prove the hub is alive. They are acknowledged and, with `heartbeatTimeoutMinutes`, keep the hub from being reported as silent. The hub sends the test reports only when **Periodic test** is on, which it is not by default.

## Known limits

Some codes mean different things on different devices, and the SIA message does not say which device it comes from:

- `KA` is a fire alarm on a FireProtect, but a high-temperature malfunction on a Transmitter, a MultiTransmitter or a SeismoProtect. It is always treated as a fire alarm.
- `HA` is a hold-up button, and also "disarmed with a duress code". It is always treated as a panic alarm.
- Events marked "pulse" by Ajax (some leak, gas and medical inputs) have no restore, so the alarm stays until the next restore or reset.

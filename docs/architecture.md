# Architecture

The plugin is a small pipeline. Each stage is a pure, independently tested module, except the thin layers at both ends that touch the network and HomeKit.

```text
 socket ──▶ SiaServer ──▶ SiaReceiver ──▶ parseFrame / parseDataBlock
                              │                    (wire format)
                              ▼
                       Message { events }
                              │
                              ▼
                         AjaxModel ───▶ HubAccessory / ZoneAccessory ──▶ HomeKit
                    (state machine)
```

| Module | Role |
| --- | --- |
| `src/sia/frame.ts` | DC-09 wire format: framing, CRC-16, AES-CBC, timestamps. |
| `src/sia/event.ts` | Parses the SIA-DCS data block into events (`code`, `zone`, `area`, `user`). |
| `src/sia/receiver.ts` | Protocol logic: account check, encryption policy, timestamp check, and the ACK / NAK / DUH reply. No I/O. |
| `src/sia/server.ts` | TCP and UDP listeners. Reassembles messages, enforces size and address limits. |
| `src/ajax/model.ts` | What the events mean: arming state, alarms, tamper, battery, faults. No I/O, no HomeKit. |
| `src/accessories/` | HomeKit services driven by the model. |
| `src/platform.ts` | Wires everything and manages the Homebridge accessory cache. |
| `src/config.ts` | Validates the user config without throwing. |

## The SIA exchange

Every message from the hub must be answered, otherwise the hub retries and eventually reports a communication failure.

- **ACK**: accepted. The reply echoes the sequence, receiver, line and account. For an encrypted message the reply is encrypted too and carries a timestamp.
- **NAK**: refused (bad CRC, wrong account, stale timestamp, encryption policy). A NAK carries the server time so a hub can resynchronise.
- **DUH**: understood as DC-09 but not processable here (a protocol other than SIA-DCS, an unreadable data block).

## Security notes

SIA is not authenticated. Anyone who can reach the port can send events, which is why:

- with an `encryptionKey`, unencrypted messages are refused, so events cannot be forged without the key;
- timestamps inside encrypted messages are checked, which limits replays;
- `allowedAddresses` can restrict the source;
- the server caps connections and the size of a message.

Without encryption, keep the port on your local network.

## Design decisions

- **Receive-only.** SIA has no command channel, and the alternatives (a restricted partner API, reverse engineering the mobile app) are deliberately out of scope.
- **No runtime dependencies.** Node's `net`, `dgram` and `crypto` are enough; the plugin stays small and easy to audit.
- **Events, not polling.** The model keeps only what the events tell it, and persists the arming state across restarts.

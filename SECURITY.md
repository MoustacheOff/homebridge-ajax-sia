# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact you foresee.

You can expect an acknowledgement within a few days. Fixes are released as patch versions and credited in the changelog unless you prefer otherwise.

## Scope

The plugin runs a network listener that parses messages from a device on your network, so reports about the following are especially welcome:

- crashes or resource exhaustion triggered by a crafted message,
- ways to forge events despite an encryption key being configured,
- any handling of the encryption key or credentials that could leak them in logs.

SIA DC-09 itself has no authentication. Without an `encryptionKey`, anyone who can reach the port can send events; this is a protocol property, documented in the README, and not a vulnerability of the plugin.

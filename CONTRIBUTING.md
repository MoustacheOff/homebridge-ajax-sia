# Contributing

Thanks for taking the time. Bug reports from real hubs are the most valuable contribution, followed by tests and fixes.

## Reporting a problem

Open an issue using the bug template. Include:

- the hub model and firmware (OS Malevich version),
- your Homebridge, Node.js and plugin versions,
- the Homebridge **debug** log around the problem (`homebridge -D`), with the object number redacted if you prefer.

For security issues, see [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

You need Node.js 22, 24 or 26.

```sh
npm install
npm test            # vitest
npm run lint
npm run typecheck
npm run build
```

`npm run test:watch` re-runs tests on change.

The code is layered so that most of it can be tested without a network or HomeKit; read [docs/architecture.md](docs/architecture.md) first. A few conventions:

- **No runtime dependencies.** Node's built-ins are enough here. If you think one is needed, open an issue first.
- **Tests come with behaviour.** Protocol changes need a test built from an independent construction of the message (see `test/helpers.ts`), not one produced by the code under test.
- **Unknown input never throws.** Hubs send surprising things; reject and log instead.
- Keep the style the linter enforces: 2 spaces, single quotes, semicolons.

## Adding support for an event code

1. Map the code in `src/ajax/model.ts`.
2. Add cases to `test/model.test.ts`.
3. Document it in `docs/events.md`.

If you are not sure what a hub sends for a given action, attach the raw debug log to the issue or pull request; that is enough to start.

## Pull requests

- Branch from `main`, keep the change focused, and describe the behaviour change rather than the diff.
- Add an entry to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md).
- CI must pass (lint, typecheck, tests, build).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

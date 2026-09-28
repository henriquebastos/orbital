# Development

This repository is a TypeScript npm workspace. Use Node.js 22.19.0 or later.
Run commands from the repository root. See `docs/development.md` and `docs/verification.md`.

- `packages/orbital` owns workspace operations, images, settings, and E2B transport.
- `packages/pod` owns the guest runtime bundled by Orbital's build.
- `packages/pi-orbital` owns Pi integration and tool routing.
- `tests` owns shared fixtures, installation checks, and hosted checks.

Run `npm ci` and `npm run test:local` for local verification.
Run `npm run test:install` after changes to package contents or installation behavior.
The workspace installs Pi. Use `npm run pi` rather than requiring a global Pi installation.
Do not edit generated `dist` directories or `packages/orbital/guest`.

# Amp orbs

`.agents/setup` installs development tools and dependencies, then builds the packages.
The project has no persistent development service or resume hook.
An Amp orb hosts development. Orbital's test Orbs are separate E2B resources.

Local checks require no hosted credentials. Never print secrets or commit personal environment files.
Hosted checks and `image:build` create remote resources. Get explicit approval before running them.
See `docs/verification.md` for required variables and cleanup receipts.

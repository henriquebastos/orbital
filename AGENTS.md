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
Amp stores only `OP_ENVIRONMENT_ID` and the secret `OP_SERVICE_ACCOUNT_TOKEN` for this project's environment.
The orb's login shell loads that Environment automatically through `.agents/environment` using 1Password CLI beta.
Run ordinary commands, such as `npm run test:hosted -- --case basic`, without a wrapper.
The service account needs read access to that 1Password Environment.
Keep `E2B_API_KEY` in 1Password, not Amp settings.
Orbital configuration owns environment resolution. Use `createOrbitalConfiguration()` instead of reading credentials in callers.
Hosted checks discover the default image by recipe hash in E2B and build it when absent. `ORBITAL_IMAGE` is an optional override.
Keep shared base images in E2B. Disposable preparation tests use an isolated recipe identity for cleanup.
Never export resolved secrets into setup snapshots, shell profiles, or `.env` files.
Commands inherit plaintext secrets in memory without output masking. Never print the environment or enable shell tracing.
Run `bash tests/orb-environment.sh` after changes to the environment hook.
Hosted checks and `image:build` create remote resources. Get explicit approval before running them.
See `docs/verification.md` for required variables and cleanup receipts.

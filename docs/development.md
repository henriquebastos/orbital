# 1 Development environment

Orbital's Node configuration adapter resolves environment variables and saved settings for project commands.
Each developer or execution environment chooses how to supply those values.
The project does not require a specific secret manager or service account.

## 1a Command requirements

| Commands | Required environment |
| --- | --- |
| Build, typecheck, and local tests | No hosted credentials. |
| `image:build` and `test:preparation` | `E2B_API_KEY`. |
| Other hosted tests and `test:acceptance` | `E2B_API_KEY`. `ORBITAL_IMAGE` is an optional override. |

The image command and hosted tests fail when required values are missing, before allocating remote resources.
These checks verify presence. E2B verifies credential validity when a command contacts the service.
See [verification](verification.md) for image preparation and test commands.

## 1b Local development

Supply variables through your shell, secret manager, or a personal `.envrc`.
Git ignores the root `.envrc`. Each developer owns its contents.
If you use direnv, create your `.envrc` and run `direnv allow` after reviewing it.
Then run project commands directly, such as `npm run image:build`.

## 1c CI, Amp, and remote VMs

Configure required variables through the runner's secrets or VM provisioning.
Provisioning owns any secret-manager authentication and service-account permissions.
Project commands use the resulting values without reading a personal `.envrc` or invoking a secret manager.
No local setup file is required in CI.

## 1d Amp orbs

Amp runs `.agents/setup` when it prepares an orb without a matching project snapshot.
The script checks the orb's Node version and installs missing test tools and the pinned 1Password CLI beta.
It then runs `npm ci` and `npm run build`.
It does not authenticate, read secrets, or create hosted resources.
No resume hook or persistent development service is required.

Run `npm run test:local` and `npm run test:install` to verify the environment.
Use `npm run pi` to start the workspace's Pi with the built extension.
Amp project settings hold two values:

- `OP_ENVIRONMENT_ID`: the project's 1Password Environment ID, stored as an environment variable.
- `OP_SERVICE_ACCOUNT_TOKEN`: a secret for a service account with read access to that Environment.

Store `E2B_API_KEY` in the 1Password Environment.
The orb's login shell loads its variables automatically when it starts inside this repository.
Run ordinary commands:

```sh
npm run test:hosted -- --case basic
```

Orbital discovers the default base under `orbital-base-{recipe-hash}` in E2B.
Fresh installations reuse a ready build or wait for a visible pending build. A missing image triggers a build.
Recipe changes select a new name. No image reference belongs in Amp settings or the repository.
The E2B credential must have access to the image. Keep shared base images while installations still use them.
`ORBITAL_IMAGE` remains an optional explicit override, resolved through Orbital configuration.
The hook captures Bash-quoted exports in memory. It writes no resolved secrets to disk and leaves Amp's `~/.env` unchanged.
Each login shell makes a 1Password request. Existing shells retain their values until replaced.
Commands receive plaintext environment variables without output masking. Never print secrets or enable shell tracing.
Without an Environment ID, the hook does nothing. With an ID, authentication failures stop the shell before it runs commands.
After changing Amp settings, use `amp orb restart-processes` to refresh the current orb's environment.
After changing values in 1Password, start a new login shell. Restart existing services to refresh their inherited environment.
Hosted checks require separate approval because they create E2B resources.

The setup file must reach the Amp project's base branch before future orbs can use it.
Confirm that the Amp project points to `https://github.com/henriquebastos/orbital`, not the earlier Python repository.

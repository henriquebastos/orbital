# 1 Development environment

Project commands read their required environment variables directly.
Each developer or execution environment chooses how to supply those values.
The project does not require a specific secret manager or service account.

## 1a Command requirements

| Commands | Required environment |
| --- | --- |
| Build, typecheck, and local tests | No hosted credentials. |
| `image:build` and `test:preparation` | `E2B_API_KEY`. |
| Other hosted tests and `test:acceptance` | `E2B_API_KEY` and `ORBITAL_IMAGE`. |

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

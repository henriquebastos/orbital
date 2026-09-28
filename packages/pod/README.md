# 1 Pod

Pod runs inside the VM that forms an Orb. This workspace package is private and is not published to npm.
Orbital bundles its source and runtime manifests into the Orbital archive during the build.

## 1a Files and dependencies

| Path | Purpose |
| --- | --- |
| `src/orbital-runner.mjs` | Run commands, manage process groups, and save output and completion records. |
| `src/renew.mjs` | Renew the E2B lease while ordinary work runs. |
| `runtime/package.json` | Pin guest Node and E2B dependencies. |
| `runtime/package-lock.json` | Lock guest installation separately from the host workspace. |
| `tests/runner.test.mjs` | Check guest command and process behavior on Linux. |
| `tests/hosted-runner.mjs` | Run those checks in an E2B sandbox. |

The image recipe installs runtime dependencies under `/opt/orbital` and Pod under `/opt/orbital/pod`.
The image exposes `orbital-runner` as a command. Jobs save their files under `/home/user/.orbital/jobs`.

Ordinary commands renew the Orb while they run. Background services do not renew the Orb.
Cancellation and timeout stop the managed process group. Transport loss does not cancel or replay work.

## 1b Verification

Run `npm run test:linux` from the repository root with `E2B_API_KEY` and `ORBITAL_IMAGE` set.
The shared harness checks this source inside Linux and verifies sandbox cleanup.
See [verification](../../docs/verification.md) for receipts and the complete hosted gate.

Available under the [MIT license](LICENSE).

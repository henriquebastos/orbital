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
Cancellation also interrupts the first renewal of an ordinary job, so a cancelled job never starts its command.
A job runs once. A second `run` for a job that already has a receipt exits with status 1 and changes nothing.

Every finished receipt has the same fields: `jobId`, `mode`, `pid`, `pgid`, `outcome`, `scopeStopped`, `exitCode`, `signal`, `phase`, `errorCode`, `error`, and `renewal`.
A field is `null` when its value is unknown. `outcome: "exited"` means the shell exited on its own, with any exit code.
After an ordinary shell exits, the runner stops surviving members of its process group.
After a background shell exits, the runner only observes the group: `scopeStopped` is `false` while the service runs. `orbital-runner cancel` on such a finished job stops the service and updates the receipt.
The finished receipt waits at most one second for the output pipes. Capture continues after the receipt until the pipes close.

A renewal failure still stops the managed process group. The five-second request timeout and renewal schedule are unchanged.
Renewal failure records include `renewal`: an allowlisted error category, a valid HTTP status when available, attempt count, duration in milliseconds, and the last successful renewal timestamp.
`lastSuccessAt` is `null` when no renewal succeeded. Configuration failures before a request use attempt zero.
Durations use a monotonic clock; timestamps use UTC. Messages, stacks, headers, URLs, and arbitrary error codes are excluded.
The E2B adapter validates these fields again before exposing them in error evidence. Pi includes that evidence in the failed tool result.

## 1b Verification

Run `npm run test:linux` from the repository root with `E2B_API_KEY` and `ORBITAL_IMAGE` set.
The shared harness checks this source inside Linux and verifies sandbox cleanup.
See [verification](../../docs/verification.md) for receipts and the complete hosted gate.

Available under the [MIT license](LICENSE).

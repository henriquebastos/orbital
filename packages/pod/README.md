# 1 Pod

Pod is the guest runtime inside an Orb. This workspace package is private and is not published to npm.
The Orbital build copies its source and runtime manifests into the Orbital archive.

## 1a Files and dependencies

| Path | Purpose |
| --- | --- |
| `src/orbital-runner.mjs` | Run one command, supervise its process group, and save output and receipts. |
| `src/renew.mjs` | Renew the E2B lease while ordinary work runs. |
| `runtime/package.json` | Pin guest Node and E2B dependencies. |
| `runtime/package-lock.json` | Lock guest installation separately from the host workspace. |
| `tests/runner.test.mjs` | Check guest command and process behavior on Linux. |
| `tests/hosted-runner.mjs` | Run those checks in an E2B sandbox. |

The image recipe installs runtime dependencies under `/opt/orbital` and Pod under `/opt/orbital/pod`.
The image exposes `orbital-runner` as a command. Jobs save their files under `/home/user/.orbital/jobs`.

## 1b Job protocol

A job is a directory named by a UUID. The caller writes `request.json`, then runs `orbital-runner run <uuid>` once.
The runner writes `stdout`, `stderr`, and `combined`, and publishes `status.json`. A `cancel` file requests cancellation.
A job runs once. A second `run` for a job that already has a receipt exits with status 1 and changes nothing.

Ordinary commands renew the Orb while they run. Background services do not renew the Orb.
Cancellation and timeout stop the managed process group. Transport loss does not cancel or replay work.
Cancellation also interrupts the first renewal of an ordinary job, so a cancelled job never starts its command.
A cancellation marker that exists before launch finishes the job without creating its output files.

After an ordinary shell exits, the runner stops surviving members of its process group.
After a background shell exits, the runner only observes the group: `scopeStopped` is `false` while the service runs.
`orbital-runner cancel <uuid>` on such a finished job stops the service and updates the receipt.
The finished receipt waits at most one second for the output pipes. Capture continues after the receipt until the pipes close.

## 1c Receipts

`status.json` holds a `started` receipt, then a `finished` receipt.
Every finished receipt has the same fields: `jobId`, `mode`, `pid`, `pgid`, `outcome`, `scopeStopped`, `exitCode`, `signal`, `phase`, `errorCode`, `error`, and `renewal`.
A field is `null` when its value is unknown.
`outcome` is `exited`, `cancelled`, `timed_out`, or `failed`. `exited` means the shell exited on its own, with any exit code.
`phase` is `pre_execution` before the shell starts and `execution` after. The runner's own exit status does not report the command result.

## 1d Renewal failures

A renewal failure stops the managed process group and reports `errorCode: "renewal_failed"`.
The `renewal` field holds an allowlisted error category, a valid HTTP status when available, the attempt count, the duration in milliseconds, and the last successful renewal timestamp.
`lastSuccessAt` is `null` when no renewal succeeded. A configuration failure before any request uses attempt zero.
Durations use a monotonic clock. Timestamps use UTC. Messages, stacks, headers, URLs, and arbitrary error codes are excluded.
The E2B adapter validates these fields again before it exposes them as error evidence. Pi includes that evidence in the failed tool result.

## 1e Verification

Run `npm run test:linux` from the repository root with `E2B_API_KEY` set. `ORBITAL_IMAGE` is optional.
The shared harness runs this package's tests inside Linux on E2B and verifies sandbox cleanup.
See [verification](../../docs/verification.md) for receipts and the complete hosted gate.

Available under the [MIT license](LICENSE).

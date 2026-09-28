# 1 Verify Orbital

Run tests from the repository root after `npm ci`. Use Node 22.19.0 or later.
Real Pi terminal tests need `pi`, `expect`, and a POSIX host. Install `expect` with your system package manager.
Installation tests also need npm registry access.

## 1a Run local checks

| Command | Checks |
| --- | --- |
| `npm run test:local` | Build packages, check types, and test public contracts, E2B transport faults, and real Pi with controlled provider effects. |
| `npm run test:unit` | Run the local tests against the existing build. Useful for repeated checks. |
| `npm run test:install` | Install package archives outside the workspace. Check standalone Orbital and real Pi discovery with isolated settings and no hosted resources. |
| `npm run test:simulation -- --seed 20260924` | A deterministic operation and fault schedule. |
| `npm run test:replay -- path/to/receipt.json` | The schedule in a simulation receipt, with a matching source hash. |
| `npm run test:sensitivity` | Five deliberate defects in disposable source copies. Each defect must fail its intended assertion. |

Use the receipt path printed by `test:simulation` for `test:replay`.
Build with `npm run build` before direct simulation, replay, or hosted Linux checks.
`test:local` and `test:install` build their prerequisites. Acceptance builds once before running its stages directly.
Orbital and Pi tests live in their package directories. Shared fixtures and integration tests live under root `tests`.
Sensitivity checks rebuild each mutated workspace before they run its assertion.

## 1b Run hosted checks

The preparation test requires `E2B_API_KEY` and builds its own disposable images.
Other hosted checks also require `ORBITAL_IMAGE`.
Prepare an image with `npm run image:build`, then use the returned `reference` as `ORBITAL_IMAGE`.
Hosted tests create E2B resources.

| Command | Checks |
| --- | --- |
| `npm run test:preparation` | Install the packed package outside the checkout. Check automatic base creation, preparation, cache reuse, refresh, runner behavior, and cleanup on E2B. |
| `npm run test:linux` | The command runner and Linux process behavior inside E2B. |
| `npm run test:lifetime` | Pi exit, remote renewal, timeouts, and cancellation. |
| `npm run test:hosted -- --case all` | Remote files, restart, artifacts, and native HTTP while Pi is offline. |
| `npm run test:acceptance` | The workspace regression gate, including local checks, replay, hosted checks, routing, and cleanup. |

Focused hosted cases are `basic`, `restart`, `restore`, `workspace`, `artifacts`, and `http`.
The full HTTP case can take about 20 minutes because the test observes sleep without renewing the orb.
The acceptance gate runs hosted stages in sequence. Each stage uses at most one live sandbox.
Run both `test:preparation` and `test:acceptance` for image changes. Preparation uses several isolated test Orbs and temporary seeds.

## 1c Read the results

Local commands use the standard TypeScript and Node test output and exit codes.
Integration, simulation, sensitivity, and acceptance commands write receipts under `test-output` with their checked source, result, and cleanup.
Missing prerequisites cause a nonzero exit. A skipped required check does not count as a pass.
The acceptance receipt lists every stage, saves its log, and links to any stage receipts.
The runner lives in `tests/acceptance.ts`. Tests share result reporting through `tests/support/receipts.ts`.
Check `status: "passed"` and confirm deletion in each hosted cleanup receipt.
If a run stops before cleanup, use its progress receipt to identify the exact resource that needs recovery.

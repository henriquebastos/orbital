# 1 Test sensitivity

Run `node --import tsx tests/sensitivity/run.ts` from the repository root. Use `--case host_bash`, `--case pty_host_bash`, `--case suppress_renewal`, `--case replay_unknown_command`, or `--case ignore_malformed_latest_binding` to run one case. The two Bash cases apply the same defect to separate Pi checks.

The runner copies the required source and tests to temporary directories. It runs each selected test before and after one deliberate defect. A case passes only when the baseline test passes and the changed test fails at its expected assertion. The runner removes the temporary copies and writes a receipt under `test-output/`. It does not create an E2B sandbox.

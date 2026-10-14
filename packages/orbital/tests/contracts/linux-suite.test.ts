import assert from "node:assert/strict";
import { test } from "node:test";

import { assertLinuxSuitePassed } from "../../../../tests/support/linux-suite.js";

function output(count = 19): string {
  return `TAP version 13
1..${count}
# tests ${count}
# suites 0
# pass ${count}
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 123.456
`;
}

const successful = { kind: "exited", exitCode: 0, stdout: output() };

test("Linux suite accepts any positive successful test count", () => {
  for (const count of [1, 14, 19, 20, 100]) {
    assert.doesNotThrow(() => assertLinuxSuitePassed({ ...successful, stdout: output(count) }));
  }
  assert.doesNotThrow(() => assertLinuxSuitePassed({ ...successful, stdout: output().replaceAll("\n", "\r\n") }));
});

const invalidOutputs: Record<string, string> = {
  "failed tests": output().replace("# fail 0", "# fail 1"),
  "skipped tests": output().replace("# skipped 0", "# skipped 1"),
  "cancelled tests": output().replace("# cancelled 0", "# cancelled 1"),
  "TODO tests": output().replace("# todo 0", "# todo 1"),
  "zero tests": output(0),
  "unaccounted tests": output().replace("# pass 19", "# pass 18"),
  "excess passes": output().replace("# pass 19", "# pass 20"),
  "missing summary": "TAP version 13\nok 1 - unfinished\n",
  "missing counter": output().replace("# cancelled 0\n", ""),
  "truncated footer": output().replace("# duration_ms 123.456\n", ""),
  "noninteger counter": output().replace("# pass 19", "# pass 19.5"),
  "malformed counter": output().replace("# pass 19", "# pass 19extra"),
  "negative counter": output().replace("# fail 0", "# fail -1"),
  "unsafe counter": output(Number.MAX_SAFE_INTEGER + 1),
  "duplicate counter": output().replace("# pass 19", "# pass 19\n# pass 19"),
  "malformed duration": output().replace("123.456", "unknown"),
  "trailing incomplete output": `${output()}not ok 20 - unfinished\n`,
};

for (const [name, stdout] of Object.entries(invalidOutputs)) {
  test(`Linux suite rejects ${name}`, () => {
    assert.throws(() => assertLinuxSuitePassed({ ...successful, stdout }), assert.AssertionError);
  });
}

test("Linux suite rejects unsuccessful or incomplete execution despite a passing summary", () => {
  for (const result of [
    { ...successful, exitCode: 1 },
    { ...successful, exitCode: undefined },
    { ...successful, kind: "cancelled" },
    { ...successful, kind: "timed_out" },
    { ...successful, kind: "background" },
  ]) {
    assert.throws(() => assertLinuxSuitePassed(result), assert.AssertionError);
  }
});

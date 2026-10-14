import assert from "node:assert/strict";

export function assertLinuxSuitePassed(result: { kind: string; exitCode?: number; stdout: string }): void {
  assert.equal(result.kind, "exited", "The Linux suite must finish normally.");
  assert.equal(result.exitCode, 0, "The Linux suite must exit successfully.");
  const summary = result.stdout.trimEnd().match(
    /(?:^|\n)# tests (\d+)\r?\n# suites (\d+)\r?\n# pass (\d+)\r?\n# fail (\d+)\r?\n# cancelled (\d+)\r?\n# skipped (\d+)\r?\n# todo (\d+)\r?\n# duration_ms (\d+(?:\.\d+)?)$/,
  );
  assert.ok(summary, "The Linux suite must report a complete Node test summary.");
  const counts = summary.slice(1, 8).map(Number);
  assert.ok(counts.every(Number.isSafeInteger), "Test counts must be safe integers.");
  assert.ok(Number.isFinite(Number(summary[8])), "Test duration must be finite.");
  assert.ok(counts[0]! > 0, "The Linux suite must execute tests.");
  assert.equal(counts[2], counts[0], "Every Linux test must pass.");
  assert.deepEqual(counts.slice(3), [0, 0, 0, 0], "Linux tests must not fail, cancel, skip, or remain TODO.");
}

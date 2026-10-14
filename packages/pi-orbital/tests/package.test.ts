import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

for (const name of ["@earendil-works/pi-coding-agent", "typebox"]) {
  test(`${name} comes from the Pi host`, () => {
    assert.equal(manifest.dependencies?.[name], undefined);
    assert.equal(manifest.peerDependencies?.[name], "*");
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true);
  });
}

import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { Template } from "e2b";

import { hashBaseRecipe, orbitalRecipe, runtimeCheckCommand } from "../../src/hangar/images/recipe.js";
import { baseImageName } from "../../src/hangar/images/preparation.js";

const root = resolve(import.meta.dirname, "../..");

test("recipe identity includes resource sizes, file paths, and exact bytes", () => {
  const resources = { cpuCount: 2, memoryMB: 1024 };
  const files = [{ path: "runner", bytes: Buffer.from("hello\n") }];
  const original = hashBaseRecipe("recipe", resources, files);
  assert.equal(hashBaseRecipe("recipe", { memoryMB: 1024, cpuCount: 2 }, files), original);
  assert.notEqual(hashBaseRecipe("recipe", { ...resources, cpuCount: 4 }, files), original);
  assert.notEqual(hashBaseRecipe("recipe", { ...resources, memoryMB: 2048 }, files), original);
  assert.notEqual(hashBaseRecipe("changed", resources, files), original);
  assert.notEqual(hashBaseRecipe("recipe", resources, [{ ...files[0]!, path: "renew" }]), original);
  assert.notEqual(hashBaseRecipe("recipe", resources, [{ path: "runner", bytes: Buffer.from("hello") }]), original);
  assert.equal(baseImageName(original), `orbital-base-${original}`);
});

test("the base recipe preserves the runner install and runtime checks", async () => {
  const first = await orbitalRecipe();
  const second = await orbitalRecipe();
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(second.sourceHash, first.sourceHash);
  assert.equal(first.cpuCount, 2);
  assert.equal(first.memoryMB, 1024);

  const document = JSON.parse(await Template.toJSON(first.template, false)) as {
    fromImage: string;
    steps: Array<{ type: string; args: string[] }>;
  };
  assert.equal(document.fromImage, "e2bdev/base");
  assert.deepEqual(document.steps.map(({ type }) => type),
    ["RUN", "RUN", "COPY", "COPY", "COPY", "COPY", "RUN", "RUN", "RUN"]);
  assert.deepEqual(document.steps.slice(2, 6).map(({ args }) => args), [
    ["pod/package.json", "/opt/orbital/package.json", "root", ""],
    ["pod/package-lock.json", "/opt/orbital/package-lock.json", "root", ""],
    ["pod/orbital-runner.mjs", "/opt/orbital/pod/orbital-runner.mjs", "root", "0755"],
    ["pod/renew.mjs", "/opt/orbital/pod/renew.mjs", "root", "0644"],
  ]);
  assert.deepEqual(document.steps[6]?.args, ["cd /opt/orbital && npm ci --omit=dev", "root"]);
  assert.deepEqual(document.steps.at(-1)?.args, [runtimeCheckCommand, "user"]);
  assert.match(runtimeCheckCommand, /sudo -n true && command -v rg && command -v fd && command -v git && command -v python3 && command -v bash && test -d \/opt\/orbital\/pod && test -d \/home\/user\/\.orbital\/jobs && test -x \/usr\/local\/bin\/orbital-runner && test -w \/home\/user\/\.orbital\/jobs$/);
});

test("the source hash changes with payload bytes and recipe commands", async () => {
  const directory = await mkdtemp(resolve(root, ".image-recipe-test-"));
  try {
    for (const path of ["src/hangar/images/recipe.ts", "guest/pod/orbital-runner.mjs", "guest/pod/renew.mjs", "guest/pod/package.json", "guest/pod/package-lock.json"]) {
      await mkdir(resolve(directory, path, ".."), { recursive: true });
      await copyFile(resolve(root, path), resolve(directory, path));
    }
    const moduleUrl = pathToFileURL(resolve(directory, "src/hangar/images/recipe.ts")).href;
    const copy = await import(moduleUrl) as { orbitalRecipe: typeof orbitalRecipe };
    const original = await copy.orbitalRecipe();
    await appendFile(resolve(directory, "guest/pod/orbital-runner.mjs"), "\n");
    const changedPayload = await copy.orbitalRecipe();
    assert.notEqual(changedPayload.sourceHash, original.sourceHash);

    const source = await readFile(resolve(directory, "src/hangar/images/recipe.ts"), "utf8");
    await writeFile(resolve(directory, "src/hangar/images/recipe.ts"), source.replace("cd /opt/orbital && npm ci --omit=dev", "cd /opt/orbital && npm ci --omit=dev --ignore-scripts"));
    const changedRecipe = await import(`${moduleUrl}?variant=1`) as { orbitalRecipe: typeof orbitalRecipe };
    assert.notEqual((await changedRecipe.orbitalRecipe()).sourceHash, changedPayload.sourceHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

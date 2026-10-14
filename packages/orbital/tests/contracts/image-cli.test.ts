import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function runCli(settings: string, args: string[], projectFiles: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "orbital-image-cli-"));
  try {
    await mkdir(join(directory, "orbital"));
    await writeFile(join(directory, "orbital", "settings.json"), settings);
    await mkdir(join(directory, ".orbital"));
    for (const [name, content] of Object.entries(projectFiles)) await writeFile(join(directory, ".orbital", name), content, { mode: 0o644 });
    const environment: NodeJS.ProcessEnv = { ...process.env, E2B_API_KEY: "test-only", XDG_CONFIG_HOME: directory };
    delete environment.ORBITAL_IMAGE;
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("packages/orbital/src/cli/image.ts"), ...args], {
      cwd: directory, encoding: "utf8", env: environment, timeout: 10_000,
    });
    assert.equal(result.error, undefined);
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the image command applies explicit image input before saved-file diagnostics", async () => {
  const result = await runCli("malformed JSON", ["--image", "custom:v1", "--refresh"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "external_refresh_unsupported");
});

test("image preparation ignores settings that it does not consume", async () => {
  const result = await runCli(JSON.stringify({ image: "custom:v1", idleTimeoutMs: "invalid" }), ["--refresh"]);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "external_refresh_unsupported");
});

test("image command discovers project preparation before contacting E2B", async () => {
  const result = await runCli("{}", ["--image", "custom:v1", "--refresh"], {
    "settings.json": "{}", build: "echo not-executable",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "configuration");
  assert.match(JSON.parse(result.stderr).message, /build entry point must be executable/);
});

test("explicit preparation replaces project directory discovery", async () => {
  const result = await runCli("{}", ["--image", "custom:v1", "--refresh", "--preparation", ".orbital/empty"], {
    "settings.json": "{}", build: "echo not-executable", empty: "",
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, "external_refresh_unsupported");
});

test("image command help does not read malformed settings", async () => {
  const result = await runCli("malformed JSON", ["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--preparation FILE/);
});

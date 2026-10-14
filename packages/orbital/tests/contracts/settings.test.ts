import assert from "node:assert/strict";
import test from "node:test";
import { orbitalSettingsSchema, resolveSettings } from "../../src/configuration/settings.js";

const resources = { cpuCount: 2, memoryMB: 1024, minFreeDiskMb: undefined };
const resourceSources = { cpuCount: "default", memoryMB: "default", minFreeDiskMb: "default" };

test("shared settings use defaults, saved values, and named environment overrides", () => {
  const snapshot = resolveSettings(orbitalSettingsSchema, {
    user: { image: "saved-image", idleTimeoutMs: 90_000 },
    environment: { ORBITAL_IMAGE: "env-image" },
  });

  assert.deepEqual(snapshot.effective, { ...resources, image: "env-image", idleTimeoutMs: 90_000, forwardEnv: [] });
  assert.deepEqual(snapshot.saved, { image: "saved-image", idleTimeoutMs: 90_000 });
  assert.deepEqual(snapshot.source, { ...resourceSources, image: "environment", idleTimeoutMs: "user", forwardEnv: "default" });
  assert.deepEqual(snapshot.diagnostics, []);

  const defaults = resolveSettings(orbitalSettingsSchema, {});
  assert.deepEqual(defaults.effective, { ...resources, image: undefined, idleTimeoutMs: 60_000, forwardEnv: [] });
  assert.deepEqual(defaults.source, { ...resourceSources, image: "default", idleTimeoutMs: "default", forwardEnv: "default" });
});

test("invalid saved and environment values report their source even when another value wins", () => {
  const snapshot = resolveSettings(orbitalSettingsSchema, {
    user: { image: "saved-image", idleTimeoutMs: 2, extra: true },
    environment: { ORBITAL_IMAGE: " ", ORBITAL_IDLE_TIMEOUT_MS: "3e4" },
  });

  assert.deepEqual(snapshot.effective, { ...resources, image: "saved-image", idleTimeoutMs: 60_000, forwardEnv: [] });
  assert.deepEqual(snapshot.diagnostics.map(({ source, key }) => `${source}:${key}`).sort(), [
    "environment:idleTimeoutMs",
    "environment:image",
    "user:extra",
    "user:idleTimeoutMs",
  ].sort());
  assert.equal(snapshot.diagnostics.some(item => item.message.includes("3e4")), false);
});

test("resource settings validate values and preserve layer precedence", () => {
  const result = resolveSettings(orbitalSettingsSchema, {
    user: { cpuCount: 4, memoryMB: 4096, minFreeDiskMb: 10240 },
    project: { cpuCount: 8 }, environment: { ORBITAL_MEMORY_MB: "8192", ORBITAL_MIN_FREE_DISK_MB: "0" },
  });
  assert.equal(result.effective.cpuCount, 8);
  assert.equal(result.effective.memoryMB, 8192);
  assert.equal(result.effective.minFreeDiskMb, 0);
  assert.equal(result.source.cpuCount, "project");
  assert.equal(result.source.memoryMB, "environment");
  assert.deepEqual(result.diagnostics, []);
  for (const [key, bad] of [["cpuCount", 0], ["memoryMB", 127], ["minFreeDiskMb", -1],
    ["cpuCount", 1.5], ["memoryMB", "8192"]] as const) {
    assert.throws(() => orbitalSettingsSchema[key].parseSaved(bad));
  }
  for (const key of ["cpuCount", "memoryMB", "minFreeDiskMb"] as const) {
    for (const bad of ["1e4", "-1", "1.5", " ", "9007199254740992"]) {
      assert.throws(() => orbitalSettingsSchema[key].parseEnvironment(bad));
    }
  }
});

test("forwardEnv lists replace rather than compose across global, project, and environment layers", () => {
  const user = { forwardEnv: ["GLOBAL", "E2B_API_KEY"] };
  const project = { forwardEnv: ["PROJECT", "E2B_API_KEY", "PROJECT"] };
  const cases = [
    { sources: { user }, expected: ["GLOBAL", "E2B_API_KEY"], source: "user" },
    { sources: { user, project }, expected: ["PROJECT", "E2B_API_KEY"], source: "project" },
    { sources: { user, project: {} }, expected: ["GLOBAL", "E2B_API_KEY"], source: "user" },
    { sources: { user, project: { forwardEnv: [] } }, expected: [], source: "project" },
    { sources: { user, project, environment: { ORBITAL_FORWARD_ENV: " GH_TOKEN, E2B_API_KEY,GH_TOKEN " } },
      expected: ["GH_TOKEN", "E2B_API_KEY"], source: "environment" },
    { sources: { user, project, environment: { ORBITAL_FORWARD_ENV: "" } }, expected: [], source: "environment" },
  ];
  for (const { sources, expected, source } of cases) {
    const result = resolveSettings(orbitalSettingsSchema, sources);
    assert.deepEqual(result.effective.forwardEnv, expected);
    assert.equal(result.source.forwardEnv, source);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.saved, user);
  }
});

test("invalid forwardEnv lists and project files report diagnostics without input values", () => {
  for (const forwardEnv of ["bad-secret", [123], [""], ["a=b"], ["nul\0name"]]) {
    const result = resolveSettings(orbitalSettingsSchema, { project: { forwardEnv } });
    assert.deepEqual(result.diagnostics.map(item => item.source), ["project"]);
    assert.doesNotMatch(JSON.stringify(result), /bad-secret/);
  }
  for (const value of ["a,,b", "a,", "a=b", "a\0b"]) {
    const result = resolveSettings(orbitalSettingsSchema, { environment: { ORBITAL_FORWARD_ENV: value } });
    assert.deepEqual(result.diagnostics.map(item => item.source), ["environment"]);
  }
  assert.equal(resolveSettings(orbitalSettingsSchema, { project: [] }).diagnostics[0]?.source, "project");
});

test("repository settings select the whole project layer instead of private settings", () => {
  const user = { memoryMB: 1024, forwardEnv: ["GLOBAL"] };
  const userProject = { memoryMB: 8192, forwardEnv: ["PRIVATE", "PRIVATE"] };
  for (const [overrides, memoryMB, forwardEnv, source] of [
    [{}, 8192, ["PRIVATE"], "userProject"],
    [{ project: { memoryMB: 4096, forwardEnv: [] } }, 4096, [], "project"],
    [{ project: {} }, 1024, ["GLOBAL"], "user"],
    [{ project: { memoryMB: 4096 }, environment: { ORBITAL_MEMORY_MB: "2048", ORBITAL_FORWARD_ENV: "ENV" } }, 2048, ["ENV"], "environment"],
  ] as const) {
    const result = resolveSettings(orbitalSettingsSchema, { user, userProject, ...overrides });
    assert.equal(result.effective.memoryMB, memoryMB);
    assert.deepEqual(result.effective.forwardEnv, forwardEnv);
    assert.equal(result.source.memoryMB, source);
    assert.equal(result.source.forwardEnv, source);
    assert.deepEqual(result.saved, user);
    assert.deepEqual(result.userProject, "project" in overrides ? undefined : { memoryMB: 8192, forwardEnv: ["PRIVATE"] });
    assert.deepEqual(result.diagnostics, []);
  }
  const invalid = resolveSettings(orbitalSettingsSchema, {
    user, userProject: { memoryMB: "PRIVATE_VALUE", extra: "PRIVATE_VALUE" }, project: { memoryMB: 4096 },
  });
  assert.equal(invalid.effective.memoryMB, 4096);
  assert.deepEqual(invalid.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_VALUE/);
  assert.equal(resolveSettings(orbitalSettingsSchema, { userProject: [] }).diagnostics[0]?.source, "userProject");
});

test("the generic resolver accepts a separate host preference schema", () => {
  const schema = {
    autoOn: {
      environment: "ORBITAL_AUTO_ON",
      defaultValue: false,
      parseSaved(value: unknown) {
        if (typeof value !== "boolean") throw new Error("must be a boolean");
        return value;
      },
      parseEnvironment(value: string) {
        if (value !== "true" && value !== "false") throw new Error("must be true or false");
        return value === "true";
      },
    },
  };
  const snapshot = resolveSettings(schema, { user: { autoOn: true }, environment: { ORBITAL_AUTO_ON: "false" } });

  assert.deepEqual(snapshot.effective, { autoOn: false });
  assert.deepEqual(snapshot.saved, { autoOn: true });
  assert.deepEqual(snapshot.source, { autoOn: "environment" });
});

test("parser errors cannot expose a saved value or an environment value", () => {
  const schema = {
    label: {
      environment: "ORBITAL_LABEL",
      defaultValue: "default",
      parseSaved(value: unknown): string { throw new Error(`Rejected ${value}`); },
      parseEnvironment(value: string): string { throw new Error(`Rejected ${value}`); },
    },
  };
  const snapshot = resolveSettings(schema, {
    user: { label: "saved-secret" },
    environment: { ORBITAL_LABEL: "env-secret" },
  });

  assert.equal(JSON.stringify(snapshot.diagnostics).includes("saved-secret"), false);
  assert.equal(JSON.stringify(snapshot.diagnostics).includes("env-secret"), false);
  assert.deepEqual(snapshot.diagnostics.map(({ source, key }) => [source, key]), [
    ["user", "label"],
    ["environment", "label"],
  ]);
});

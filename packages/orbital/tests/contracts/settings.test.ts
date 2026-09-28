import assert from "node:assert/strict";
import test from "node:test";
import { orbitalSettingsSchema, resolveSettings } from "../../src/configuration/settings.js";

test("shared settings use defaults, saved values, and named environment overrides", () => {
  const snapshot = resolveSettings(orbitalSettingsSchema, {
    user: { image: "saved-image", idleTimeoutMs: 90_000 },
    environment: { ORBITAL_IMAGE: "env-image" },
  });

  assert.deepEqual(snapshot.effective, { image: "env-image", idleTimeoutMs: 90_000 });
  assert.deepEqual(snapshot.saved, { image: "saved-image", idleTimeoutMs: 90_000 });
  assert.deepEqual(snapshot.source, { image: "environment", idleTimeoutMs: "user" });
  assert.deepEqual(snapshot.diagnostics, []);

  const defaults = resolveSettings(orbitalSettingsSchema, {});
  assert.deepEqual(defaults.effective, { image: undefined, idleTimeoutMs: 60_000 });
  assert.deepEqual(defaults.source, { image: "default", idleTimeoutMs: "default" });
});

test("invalid saved and environment values report their source even when another value wins", () => {
  const snapshot = resolveSettings(orbitalSettingsSchema, {
    user: { image: "saved-image", idleTimeoutMs: 2, extra: true },
    environment: { ORBITAL_IMAGE: " ", ORBITAL_IDLE_TIMEOUT_MS: "3e4" },
  });

  assert.deepEqual(snapshot.effective, { image: "saved-image", idleTimeoutMs: 60_000 });
  assert.deepEqual(snapshot.diagnostics.map(({ source, key }) => `${source}:${key}`).sort(), [
    "environment:idleTimeoutMs",
    "environment:image",
    "user:extra",
    "user:idleTimeoutMs",
  ].sort());
  assert.equal(snapshot.diagnostics.some(item => item.message.includes("3e4")), false);
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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { orbitalSettingsSchema } from "../../src/configuration/index.js";
import { createNodeSettings } from "../../src/configuration/node.js";

test("the Node adapter uses the XDG fallback for empty or relative config paths", () => {
  for (const value of [undefined, "", "relative-path"]) {
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, environment: { XDG_CONFIG_HOME: value } });
    assert.equal(settings.filePath, join(homedir(), ".config", "orbital", "settings.json"));
  }
  const explicit = createNodeSettings({ schema: orbitalSettingsSchema, environment: { XDG_CONFIG_HOME: "/config" } });
  assert.equal(explicit.filePath, "/config/orbital/settings.json");
});

test("the optional Node adapter saves only selected user values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: { ORBITAL_IMAGE: "env-image" } });
    assert.equal(settings.filePath, join(directory, "settings.json"));
    assert.equal((await settings.refresh()).effective.idleTimeoutMs, 60_000);
    const afterSave = await settings.set("image", "saved-image");
    assert.equal(afterSave.saved.image, "saved-image");
    assert.equal(afterSave.effective.image, "env-image");
    assert.equal(afterSave.source.image, "environment");
    await settings.set("idleTimeoutMs", 90_000);

    const second = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    assert.deepEqual((await second.refresh()).saved, { image: "saved-image", idleTimeoutMs: 90_000 });
    assert.deepEqual((await settings.unset("idleTimeoutMs")).saved, { image: "saved-image" });
    assert.deepEqual((await second.refresh()).saved, { image: "saved-image" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a malformed settings file stays intact after refresh and rejected edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const filePath = join(directory, "settings.json");
    const malformed = '{ "image": "private-value",';
    await writeFile(filePath, malformed);
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    const snapshot = await settings.refresh();

    assert.deepEqual(snapshot.effective, { image: undefined, idleTimeoutMs: 60_000 });
    assert.deepEqual(snapshot.diagnostics.map(({ source, path }) => [source, path]), [["user", filePath]]);
    assert.equal(snapshot.diagnostics[0]?.message.includes("private-value"), false);
    await assert.rejects(settings.set("image", "replacement"), /Cannot edit invalid settings/);
    assert.equal(await readFile(filePath, "utf8"), malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a caller cannot clear file diagnostics to enable an unsafe edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const filePath = join(directory, "settings.json");
    const malformed = "{invalid";
    await writeFile(filePath, malformed);
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    const visibleSnapshot = await settings.refresh();
    visibleSnapshot.diagnostics.length = 0;

    await assert.rejects(settings.set("image", "replacement"), /Cannot edit invalid settings/);
    assert.equal(await readFile(filePath, "utf8"), malformed);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the adapter saves the schema's normalized value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const schema = {
      label: {
        environment: "ORBITAL_LABEL",
        defaultValue: "default",
        parseSaved(value: unknown) {
          if (typeof value !== "string") throw new Error("must be a string");
          return value.trim();
        },
        parseEnvironment(value: string) { return value.trim(); },
      },
    };
    const settings = createNodeSettings({ schema, directory, environment: {} });
    await settings.refresh();
    assert.equal((await settings.set("label", " spaced ")).saved.label, "spaced");
    assert.deepEqual(JSON.parse(await readFile(settings.filePath, "utf8")), { label: "spaced" });

    const second = createNodeSettings({ schema, directory, environment: {} });
    assert.equal((await second.refresh()).saved.label, "spaced");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editing a returned snapshot cannot change the adapter's current values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    await settings.refresh();
    const visible = await settings.set("image", "saved-image");
    visible.saved.image = "changed";
    visible.effective.idleTimeoutMs = 1;
    visible.source.image = "default";
    visible.diagnostics.push({ source: "user", message: "injected" });

    assert.deepEqual(settings.snapshot(), {
      saved: { image: "saved-image" },
      effective: { image: "saved-image", idleTimeoutMs: 60_000 },
      source: { image: "user", idleTimeoutMs: "default" },
      diagnostics: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a stale settings view cannot overwrite an external edit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const filePath = join(directory, "settings.json");
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    await settings.refresh();
    await writeFile(filePath, '{"image":"external-image"}\n');

    await assert.rejects(settings.set("idleTimeoutMs", 90_000), /changed on disk/);
    assert.equal((await settings.refresh()).saved.image, "external-image");
    assert.equal((await settings.set("idleTimeoutMs", 90_000)).saved.idleTimeoutMs, 90_000);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a settings read error appears in diagnostics and blocks edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-settings-"));
  try {
    const filePath = join(directory, "settings.json");
    await mkdir(filePath);
    const settings = createNodeSettings({ schema: orbitalSettingsSchema, directory, environment: {} });
    const snapshot = await settings.refresh();

    assert.deepEqual(snapshot.effective, { image: undefined, idleTimeoutMs: 60_000 });
    assert.deepEqual(snapshot.diagnostics.map(({ source, path }) => [source, path]), [["user", filePath]]);
    await assert.rejects(settings.set("image", "replacement"), /Cannot edit invalid settings/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { orbitalSettingsSchema } from "../../src/configuration/index.js";
import { createNodeSettings, createOrbitalConfiguration } from "../../src/configuration/node.js";

const resources = { cpuCount: 2, memoryMB: 1024, minFreeDiskMb: undefined };

test("Orbital configuration resolves credentials without saving or exposing them in settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-configuration-"));
  const environment: Record<string, string | undefined> = { E2B_API_KEY: "test-secret", ORBITAL_IMAGE: "environment-image" };
  try {
    const configuration = createOrbitalConfiguration({ directory, environment });
    assert.deepEqual(configuration.e2b(), { apiKey: "test-secret" });
    assert.equal(await configuration.image(), "environment-image");
    await configuration.settings.set("image", "saved-image");
    assert.equal(await configuration.image("explicit-image"), "explicit-image");
    assert.equal(await configuration.image(), "environment-image");
    delete environment.ORBITAL_IMAGE;
    assert.equal(await configuration.image(), "saved-image");
    await configuration.settings.unset("image");
    assert.equal(await configuration.image(), undefined);
    assert.equal(JSON.stringify(configuration.settings.snapshot()).includes("test-secret"), false);
    assert.equal((await readFile(configuration.settings.filePath, "utf8")).includes("test-secret"), false);
    for (const missing of [undefined, "", " "]) {
      environment.E2B_API_KEY = missing;
      assert.throws(() => configuration.e2b(), { code: "missing_api_key" });
      assert.equal(await configuration.image(), undefined);
    }
    environment.ORBITAL_IMAGE = " ";
    await assert.rejects(configuration.image(), { code: "configuration" });
    assert.equal(await configuration.image("explicit-image"), "explicit-image");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration resolves resource defaults and rejects invalid resource overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-resources-"));
  const environment: Record<string, string | undefined> = { ORBITAL_CPU_COUNT: "8", ORBITAL_MEMORY_MB: "8192", ORBITAL_MIN_FREE_DISK_MB: "20480" };
  try {
    const configuration = createOrbitalConfiguration({ directory, cwd: directory, environment });
    assert.deepEqual(await configuration.resources(), { cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 20480 });
    environment.ORBITAL_MEMORY_MB = "bad-value";
    await assert.rejects(configuration.resources(), { code: "configuration" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("instance environment resolves only selected host names and keeps values out of settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-environment-"));
  const values = { GH_TOKEN: "test-secret", E2B_API_KEY: "instance-key", SANDBOX_URL: "https://sandbox.test",
    EMPTY: "", MULTILINE: "first\nsecond", "custom.name": "value" };
  const environment = { ...values, UNSELECTED: "never-forward", ORBITAL_ENV: '{"LEGACY":"ignored"}' };
  try {
    const configuration = createOrbitalConfiguration({ directory, environment, cwd: directory });
    assert.deepEqual(configuration.env(Object.keys(values)), values);
    await configuration.settings.refresh();
    await configuration.settings.set("forwardEnv", Object.keys(values));
    for (const output of [JSON.stringify(configuration.settings.snapshot()), await readFile(configuration.settings.filePath, "utf8")]) {
      assert.doesNotMatch(output, /test-secret|instance-key|never-forward/);
    }
    assert.throws(() => configuration.env([]), { code: "missing_renewal_key" });
    assert.throws(() => configuration.env(["GH_TOKEN"]), { code: "missing_renewal_key" });
    assert.throws(() => configuration.env(["E2B_API_KEY", "MISSING"]), { code: "missing_environment" });
    environment.E2B_API_KEY = "";
    assert.throws(() => configuration.env(["E2B_API_KEY"]), { code: "missing_renewal_key" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("project settings replace global forwarding and refresh detects project edits and errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-project-settings-"));
  const cwd = join(directory, "project");
  await mkdir(join(cwd, ".orbital"), { recursive: true });
  const projectPath = join(cwd, ".orbital/settings.json");
  const environment: Record<string, string | undefined> = {};
  try {
    const configuration = createOrbitalConfiguration({ directory, environment, cwd });
    const settings = configuration.settings;
    await settings.refresh();
    await settings.set("forwardEnv", ["GLOBAL", "E2B_API_KEY"]);
    await writeFile(projectPath, JSON.stringify({ forwardEnv: ["PROJECT", "E2B_API_KEY"] }));
    assert.deepEqual(settings.snapshot().effective.forwardEnv, ["GLOBAL", "E2B_API_KEY"]);
    assert.deepEqual((await settings.refresh()).effective.forwardEnv, ["PROJECT", "E2B_API_KEY"]);
    assert.equal(settings.snapshot().source.forwardEnv, "project");
    assert.equal(settings.projectFilePath, projectPath);
    await settings.unset("forwardEnv");
    assert.deepEqual(settings.snapshot().project, { forwardEnv: ["PROJECT", "E2B_API_KEY"] });
    environment.ORBITAL_FORWARD_ENV = "E2B_API_KEY";
    assert.deepEqual((await settings.refresh()).effective.forwardEnv, ["E2B_API_KEY"]);
    assert.equal(settings.snapshot().source.forwardEnv, "environment");
    delete environment.ORBITAL_FORWARD_ENV;
    await writeFile(projectPath, '{"forwardEnv":[],"secret":"DO_NOT_ECHO",');
    const invalid = await settings.refresh();
    assert.deepEqual(invalid.diagnostics.map(item => [item.source, item.path]), [["project", projectPath]]);
    assert.doesNotMatch(JSON.stringify(invalid), /DO_NOT_ECHO/);
    await writeFile(projectPath, '{"forwardEnv":[]}');
    assert.deepEqual((await settings.refresh()).effective.forwardEnv, []);
    await rm(projectPath);
    assert.equal((await settings.refresh()).source.forwardEnv, "default");
    await mkdir(projectPath);
    assert.equal((await settings.refresh()).diagnostics[0]?.source, "project");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private project files resolve by directory name without changing global write targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-private-project-"));
  const cwd = join(directory, "checkout", "backend");
  const configDirectory = join(directory, "config", "orbital");
  const privatePath = join(configDirectory, "backend", "settings.json");
  const repositoryPath = join(cwd, ".orbital", "settings.json");
  await mkdir(join(cwd, ".orbital"), { recursive: true });
  await mkdir(join(configDirectory, "backend"), { recursive: true });
  const environment: Record<string, string | undefined> = { XDG_CONFIG_HOME: join(directory, "config") };
  try {
    const configuration = createOrbitalConfiguration({ cwd, environment });
    const settings = configuration.settings;
    assert.equal(settings.userProjectFilePath, privatePath);
    await settings.refresh();
    await settings.set("memoryMB", 2048);
    const privateText = '{"cpuCount":2,"memoryMB":8192,"minFreeDiskMb":8192}\n';
    await writeFile(privatePath, privateText);
    assert.deepEqual(await configuration.resources(), { cpuCount: 2, memoryMB: 8192, minFreeDiskMb: 8192 });
    assert.equal(settings.snapshot().source.memoryMB, "userProject");
    assert.deepEqual(settings.snapshot().userProject, { cpuCount: 2, memoryMB: 8192, minFreeDiskMb: 8192 });
    await settings.set("memoryMB", 4096);
    assert.equal(settings.snapshot().effective.memoryMB, 8192);
    assert.equal(await readFile(privatePath, "utf8"), privateText);
    assert.deepEqual(JSON.parse(await readFile(settings.filePath, "utf8")), { memoryMB: 4096 });
    await writeFile(repositoryPath, '{"cpuCount":4}');
    assert.deepEqual(await configuration.resources(), { cpuCount: 4, memoryMB: 4096, minFreeDiskMb: undefined });
    assert.equal(settings.selectedProjectFilePath, repositoryPath);
    assert.equal(settings.snapshot().userProject, undefined);
    environment.ORBITAL_CPU_COUNT = "8";
    assert.equal((await configuration.resources()).cpuCount, 8);
    delete environment.ORBITAL_CPU_COUNT;
    const other = createOrbitalConfiguration({ cwd: join(directory, "other"), environment });
    assert.equal((await other.resources()).memoryMB, 4096);
    assert.equal(other.settings.snapshot().source.memoryMB, "user");
    const sameName = createOrbitalConfiguration({ cwd: join(directory, "another", "backend"), environment });
    assert.equal((await sameName.resources()).memoryMB, 8192);
    await rm(privatePath);
    assert.deepEqual(await configuration.resources(), { cpuCount: 4, memoryMB: 4096, minFreeDiskMb: undefined });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private project diagnostics include the path and refresh clears read and parse errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-private-errors-"));
  const privatePath = join(directory, "backend", "settings.json");
  await mkdir(join(directory, "backend"));
  try {
    const configuration = createOrbitalConfiguration({ directory, cwd: join(directory, "backend"), environment: {} });
    for (const text of ['{"memoryMB":"PRIVATE_VALUE",', '{"memoryMB":"PRIVATE_VALUE"}', '[]']) {
      await writeFile(privatePath, text);
      await assert.rejects(configuration.resources(), { code: "configuration" });
      const snapshot = configuration.settings.snapshot();
      assert.deepEqual(snapshot.diagnostics.map(item => [item.source, item.path]), [["userProject", privatePath]]);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_VALUE/);
    }
    await rm(privatePath);
    await mkdir(privatePath);
    await assert.rejects(configuration.resources(), { code: "configuration" });
    assert.equal(configuration.settings.snapshot().diagnostics[0]?.path, privatePath);
    await rm(privatePath, { recursive: true });
    assert.deepEqual(await configuration.resources(), resources);
    assert.deepEqual(configuration.settings.snapshot().diagnostics, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("project directories do not collide with global settings and Pi preferences", () => {
  for (const name of ["settings", "pi"]) {
    const configuration = createOrbitalConfiguration({ directory: "/config/orbital", cwd: `/projects/${name}`, environment: {} });
    assert.equal(configuration.settings.userProjectFilePath, `/config/orbital/${name}/settings.json`);
    assert.equal(configuration.settings.projectFilePath, `/projects/${name}/.orbital/settings.json`);
  }
  assert.throws(() => createNodeSettings({ schema: orbitalSettingsSchema, userProjectFilePath: "relative.json" }), /must be absolute/);
});

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

    assert.deepEqual(snapshot.effective, { ...resources, image: undefined, idleTimeoutMs: 60_000, forwardEnv: [] });
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
      effective: { ...resources, image: "saved-image", idleTimeoutMs: 60_000, forwardEnv: [] },
      source: { cpuCount: "default", memoryMB: "default", minFreeDiskMb: "default",
        image: "user", idleTimeoutMs: "default", forwardEnv: "default" },
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

    assert.deepEqual(snapshot.effective, { ...resources, image: undefined, idleTimeoutMs: 60_000, forwardEnv: [] });
    assert.deepEqual(snapshot.diagnostics.map(({ source, path }) => [source, path]), [["user", filePath]]);
    await assert.rejects(settings.set("image", "replacement"), /Cannot edit invalid settings/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

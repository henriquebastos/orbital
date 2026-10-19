import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, resolve } from "node:path";
import test from "node:test";
import { hostEnvironment } from "../../../tests/support/pi-environment.js";

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "orbital-settings-pi-"));
  const config = resolve(directory, "config", "orbital");
  mkdirSync(config, { recursive: true });
  function command(message: string, overrides: NodeJS.ProcessEnv = {}, customType = "orbital.settings") {
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--mode", "json", "--no-session", "--print", message], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...hostEnvironment, PI_CODING_AGENT_DIR: resolve(directory, "agent"),
        XDG_CONFIG_HOME: resolve(directory, "config"), E2B_API_KEY: "", ORBITAL_IMAGE: undefined,
        ORBITAL_LEASE_WINDOW_MS: undefined, ORBITAL_AUTO_ON: undefined, ORBITAL_SKILL_ROOTS: undefined,
        ORBITAL_FORWARD_ENV: undefined, ...overrides },
    });
    assert.equal(run.status, 0, run.stderr);
    const events = run.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    assert.equal(events.some(event => event.type === "agent_start"), false, "Settings commands must not start a model turn.");
    const output = events.find(event => event.type === "message_end" && event.message?.customType === customType);
    assert.ok(output, run.stdout + run.stderr);
    return output.message;
  }
  function tools(calls: { name: string; arguments: Record<string, unknown> }[], overrides: NodeJS.ProcessEnv = {}) {
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--extension", resolve("tests/support/installed-model.ts"),
      "--provider", "orbital-fixture", "--model", "probe", "--mode", "json", "--no-session", "--print", "run fixture"], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...hostEnvironment, E2B_API_KEY: "", ORBITAL_AUTO_ON: "false", ORBITAL_IMAGE: undefined,
        ORBITAL_LEASE_WINDOW_MS: undefined, ORBITAL_SKILL_ROOTS: undefined, ORBITAL_FORWARD_ENV: undefined,
        XDG_CONFIG_HOME: resolve(directory, "config"), PI_CODING_AGENT_DIR: resolve(directory, "agent"),
        ORBITAL_PI_CALLS: JSON.stringify(calls), ...overrides },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .filter(event => event.type === "tool_execution_end");
    assert.equal(results.length, calls.length, run.stdout + run.stderr);
    return results;
  }
  return { directory, config, command, tools, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test("the orbital tool edits every setting with the same results as slash commands", () => {
  const f = fixture();
  try {
    const values = { image: "saved-image", leaseWindowMs: 45000, forwardEnv: ["GH_TOKEN", "E2B_API_KEY"],
      autoOn: true, skillRoots: ["/skills/two  spaces"] };
    const results = f.tools([
      ...Object.entries(values).map(([name, value]) => ({ name: "orbital", arguments: { action: "settings_set", name, value } })),
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "orbital", arguments: { action: "status" } },
    ], { E2B_API_KEY: "test-key", GH_TOKEN: "instance-secret" });
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    const details = results[5].result.details;
    const command = f.command("/orb settings", { ORBITAL_AUTO_ON: "false" });
    assert.deepEqual(details, command.details);
    assert.deepEqual(details.settings.saved, { image: values.image, leaseWindowMs: values.leaseWindowMs, forwardEnv: values.forwardEnv });
    assert.deepEqual(details.preferences.saved, { autoOn: true, skillRoots: values.skillRoots });
    assert.equal(results[6].result.details.route, "local", "Settings changes must not change the current route.");
    assert.equal(results[6].result.details.allocation, "neverRequested");
    assert.equal(results[6].result.details.readiness.create, true);
    assert.doesNotMatch(JSON.stringify(results), /instance-secret|test-key/);
    const unsets = f.tools(Object.keys(values).map(name => ({ name: "orbital", arguments: { action: "settings_unset", name } })));
    for (const result of unsets) assert.equal(result.isError, false, JSON.stringify(result));
    const final = unsets.at(-1)!.result.details;
    assert.deepEqual(final.settings.saved, {});
    assert.deepEqual(final.preferences.saved, {});
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")), {});
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "pi.json"), "utf8")), {});
  } finally { f.close(); }
});

test("resource settings work through commands and tools without allocating a machine", () => {
  const f = fixture();
  try {
    for (const [name, value] of Object.entries({ cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 20480 })) {
      const message = f.command(`/orb settings set ${name} ${value}`);
      assert.equal(message.details.settings.saved[name], value);
    }
    const results = f.tools([
      { name: "orbital", arguments: { action: "status" } },
      { name: "orbital", arguments: { action: "settings_set", name: "minFreeDiskMb", value: 0 } },
      { name: "orbital", arguments: { action: "settings_set", name: "memoryMB", value: 127 } },
      { name: "orbital", arguments: { action: "settings_unset", name: "cpuCount" } },
      { name: "orbital", arguments: { action: "status" } },
    ]);
    assert.deepEqual(results.map(result => result.isError), [false, false, true, false, false]);
    assert.deepEqual(results[0].result.details.configuredResources, { cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 20480 });
    assert.deepEqual(results[4].result.details.configuredResources, { cpuCount: 2, memoryMB: 8192, minFreeDiskMb: 0 });
    assert.equal(results[4].result.details.allocation, "neverRequested");
  } finally { f.close(); }
});

test("settings tools work in remote mode without an allocation and accept false and empty arrays", () => {
  const f = fixture();
  try {
    const results = f.tools([
      { name: "orbital", arguments: { action: "set_route", route: "remote" } },
      { name: "orbital", arguments: { action: "settings_set", name: "autoOn", value: false } },
      { name: "orbital", arguments: { action: "settings_set", name: "forwardEnv", value: [] } },
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "orbital", arguments: { action: "settings_refresh" } },
      { name: "orbital", arguments: { action: "settings_unset", name: "autoOn" } },
      { name: "orbital", arguments: { action: "status" } },
    ]);
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(results[1].result.details.preferences.saved.autoOn, false);
    assert.deepEqual(results[2].result.details.settings.saved.forwardEnv, []);
    assert.equal(results[6].result.details.route, "remote");
    assert.equal(results[6].result.details.allocation, "neverRequested");
    assert.equal(results[6].result.details.readiness.remote, false);
  } finally { f.close(); }
});

test("tool settings preserve project and environment precedence", () => {
  const f = fixture();
  try {
    mkdirSync(resolve(f.directory, ".orbital"));
    writeFileSync(resolve(f.directory, ".orbital/settings.json"), '{"image":"project-image"}');
    const results = f.tools([
      { name: "orbital", arguments: { action: "settings_set", name: "image", value: "saved-image" } },
      { name: "orbital", arguments: { action: "settings_unset", name: "image" } },
    ], { ORBITAL_IMAGE: "environment-image" });
    for (const result of results) {
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.result.details.settings.project.image, "project-image");
      assert.equal(result.result.details.settings.effective.image, "environment-image");
      assert.equal(result.result.details.settings.source.image, "environment");
    }
    assert.equal(results[0].result.details.settings.saved.image, "saved-image");
    assert.equal(results[1].result.details.settings.saved.image, undefined);
    assert.equal(f.command("/orb settings").details.settings.effective.image, "project-image");
  } finally { f.close(); }
});

test("Pi reports and refreshes private project settings without allocating an orb", () => {
  const f = fixture();
  const path = resolve(f.config, basename(f.directory), "settings.json");
  try {
    const results = f.tools([
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "write", arguments: { path, content: '{"memoryMB":8192}' } },
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "orbital", arguments: { action: "settings_refresh" } },
      { name: "orbital", arguments: { action: "status" } },
    ]);
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(results[2].result.details.settings.source.memoryMB, "default");
    assert.equal(results[3].result.details.settings.source.memoryMB, "userProject");
    assert.deepEqual(results[3].result.details.settings.userProject, { memoryMB: 8192 });
    assert.equal(results[4].result.details.configuredResources.memoryMB, 8192);
    assert.equal(results[4].result.details.allocation, "neverRequested");
    const message = f.command("/orb settings set memoryMB 4096");
    assert.equal(message.details.settings.saved.memoryMB, 4096);
    assert.equal(message.details.settings.effective.memoryMB, 8192);
    assert.ok(JSON.stringify(message.content).includes(path));
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { memoryMB: 8192 });
  } finally { f.close(); }
});

test("tool settings refresh reads external changes while get retains the cached snapshot", () => {
  const f = fixture();
  try {
    const results = f.tools([
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "write", arguments: { path: resolve(f.config, "settings.json"), content: '{"image":"external-image"}' } },
      { name: "orbital", arguments: { action: "settings_get" } },
      { name: "orbital", arguments: { action: "settings_refresh" } },
      { name: "orbital", arguments: { action: "status" } },
    ]);
    for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(results[0].result.details.settings.effective.image, undefined);
    assert.equal(results[2].result.details.settings.effective.image, undefined);
    assert.equal(results[3].result.details.settings.effective.image, "external-image");
    assert.equal(results[4].result.details.route, "local");
    assert.equal(results[4].result.details.allocation, "neverRequested");
  } finally { f.close(); }
});

test("invalid tool settings fail without changing saved values", () => {
  const f = fixture();
  try {
    f.command("/orb settings set image original");
    const results = f.tools([
      { action: "settings_set" },
      { action: "settings_unset" },
      { action: "settings_set", name: "image" },
      { action: "settings_set", name: "image", value: false },
      { action: "settings_set", name: "leaseWindowMs", value: 2 },
      { action: "settings_set", name: "autoOn", value: "true" },
      { action: "settings_set", name: "skillRoots", value: ["relative"] },
      { action: "settings_set", name: "forwardEnv", value: ["GH_TOKEN=do-not-echo"] },
      { action: "settings_get" },
    ].map(arguments_ => ({ name: "orbital", arguments: arguments_ })));
    for (const result of results.slice(0, -1)) {
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.doesNotMatch(JSON.stringify(result.result), /do-not-echo/);
    }
    assert.equal(results.at(-1)!.isError, false);
    assert.deepEqual(results.at(-1)!.result.details.settings.saved, { image: "original" });
    assert.equal(readFileSync(resolve(f.config, "settings.json"), "utf8").includes("original"), true);
    const malformed = '{"image":"DO_NOT_ECHO_BAD_FILE",';
    writeFileSync(resolve(f.config, "settings.json"), malformed);
    const failure = f.tools([{ name: "orbital", arguments: { action: "settings_set", name: "image", value: "replacement" } }])[0];
    assert.equal(failure.isError, true);
    assert.match(JSON.stringify(failure.result), /Cannot edit invalid settings/);
    assert.doesNotMatch(JSON.stringify(failure.result), /DO_NOT_ECHO_BAD_FILE/);
    assert.equal(readFileSync(resolve(f.config, "settings.json"), "utf8"), malformed);
  } finally { f.close(); }
});

test("Pi status validates instance variables without exposing their values", () => {
  const f = fixture();
  try {
    const overrides = { E2B_API_KEY: "test-key", GH_TOKEN: "instance-secret", ORBITAL_FORWARD_ENV: "GH_TOKEN,E2B_API_KEY" };
    const status = f.command("/orb status", overrides, "orbital.status");
    assert.equal(status.details.readiness.create, true);
    assert.doesNotMatch(JSON.stringify(status), /instance-secret/);
    const settings = f.command("/orb settings set leaseWindowMs 90000", overrides);
    assert.doesNotMatch(JSON.stringify(settings), /instance-secret|test-key/);
    assert.doesNotMatch(readFileSync(resolve(f.config, "settings.json"), "utf8"), /instance-secret|GH_TOKEN/);
    for (const forwardEnv of ["GH_TOKEN", "E2B_API_KEY,MISSING", "", "a,,b"]) {
      const invalid = f.command("/orb status", { ...overrides, ORBITAL_FORWARD_ENV: forwardEnv }, "orbital.status");
      assert.equal(invalid.details.readiness.create, false);
      assert.doesNotMatch(JSON.stringify(invalid), /instance-secret|test-key/);
    }
  } finally { f.close(); }
});

test("Pi edits global forwarding while showing project and environment replacement", () => {
  const f = fixture();
  try {
    const saved = f.command('/orb settings set forwardEnv ["GH_TOKEN","E2B_API_KEY","GH_TOKEN"]');
    assert.deepEqual(saved.details.settings.saved.forwardEnv, ["GH_TOKEN", "E2B_API_KEY"]);
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")),
      { forwardEnv: ["GH_TOKEN", "E2B_API_KEY"] });
    mkdirSync(resolve(f.directory, ".orbital"));
    writeFileSync(resolve(f.directory, ".orbital/settings.json"), '{"forwardEnv":["PROJECT","E2B_API_KEY"]}');
    const project = f.command("/orb settings");
    assert.deepEqual(project.details.settings.effective.forwardEnv, ["PROJECT", "E2B_API_KEY"]);
    assert.equal(project.details.settings.source.forwardEnv, "project");
    const overridden = f.command("/orb settings", { ORBITAL_FORWARD_ENV: "E2B_API_KEY" });
    assert.deepEqual(overridden.details.settings.effective.forwardEnv, ["E2B_API_KEY"]);
    assert.equal(overridden.details.settings.source.forwardEnv, "environment");
    const unset = f.command("/orb settings unset forwardEnv");
    assert.equal(unset.details.settings.saved.forwardEnv, undefined);
    assert.deepEqual(unset.details.settings.effective.forwardEnv, ["PROJECT", "E2B_API_KEY"]);
    const invalid = f.command('/orb settings set forwardEnv {"GH_TOKEN":"do-not-echo"}');
    assert.ok(invalid.details.error);
    assert.doesNotMatch(JSON.stringify(invalid), /do-not-echo/);
  } finally { f.close(); }
});

test("Pi saves an Orbital default separately from its environment override", () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.config, "settings.json"), JSON.stringify({ leaseWindowMs: 90000 }));
    const message = f.command("/orb settings set image saved-image", { ORBITAL_IMAGE: "environment-image" });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")), {
      leaseWindowMs: 90000, image: "saved-image",
    });
    assert.equal(message.details.settings.saved.image, "saved-image");
    assert.equal(message.details.settings.effective.image, "environment-image");
    assert.equal(message.details.settings.source.image, "environment");
    assert.match(message.content, /next allocation/i);
  } finally { f.close(); }
});

test("Pi saves auto-on in its own file with the environment override taking precedence", () => {
  const f = fixture();
  try {
    const message = f.command("/orb settings set autoOn true", { ORBITAL_AUTO_ON: "false" });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "pi.json"), "utf8")), { autoOn: true });
    assert.equal(message.details.preferences.effective.autoOn, false);
    assert.equal(message.details.preferences.source.autoOn, "environment");
    assert.match(message.content, /new sessions/i);
  } finally { f.close(); }
});

test("Pi saves skill roots as an array and decodes their environment override", () => {
  const f = fixture();
  try {
    const message = f.command('/orb settings set skillRoots ["/saved/skills"]', {
      ORBITAL_SKILL_ROOTS: ["/override/one", "/override/two"].join(delimiter),
    });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "pi.json"), "utf8")), { skillRoots: ["/saved/skills"] });
    assert.deepEqual(message.details.preferences.effective.skillRoots, ["/override/one", "/override/two"]);
    assert.match(message.content, /next skill read/i);
  } finally { f.close(); }
});

test("a real Pi tool reads skills from the saved Pi preferences", () => {
  const f = fixture();
  try {
    const root = resolve(f.directory, "skills");
    mkdirSync(resolve(root, "orbital-settings-proof"), { recursive: true });
    writeFileSync(resolve(root, "orbital-settings-proof", "SKILL.md"), "SAVED_ROOT_SKILL_CONTENT");
    f.command(`/orb settings set skillRoots ${JSON.stringify([root])}`);
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--extension", resolve("tests/support/installed-model.ts"),
      "--provider", "orbital-fixture", "--model", "probe", "--mode", "json", "--no-session", "--print", "run fixture"], {
      cwd: f.directory, encoding: "utf8", timeout: 30_000,
      env: { ...hostEnvironment, E2B_API_KEY: "", ORBITAL_AUTO_ON: "false", ORBITAL_SKILL_ROOTS: undefined,
        XDG_CONFIG_HOME: resolve(f.directory, "config"), PI_CODING_AGENT_DIR: resolve(f.directory, "agent"),
        ORBITAL_PI_CALLS: JSON.stringify([{ name: "orbital_skill", arguments: { action: "read", name: "orbital-settings-proof" } }]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const result = run.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
      .find(event => event.type === "tool_execution_end");
    assert.equal(result?.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /SAVED_ROOT_SKILL_CONTENT/);
  } finally { f.close(); }
});

test("Pi unsets a saved value without deleting its environment override or other settings", () => {
  const f = fixture();
  try {
    f.command("/orb settings set image saved-image");
    f.command("/orb settings set leaseWindowMs 45000");
    const message = f.command("/orb settings unset image", { ORBITAL_IMAGE: "override-image" });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")), { leaseWindowMs: 45000 });
    assert.equal(message.details.settings.effective.image, "override-image");
    assert.equal(message.details.settings.source.image, "environment");
  } finally { f.close(); }
});

test("Pi refresh reads external settings changes without starting a model turn", async () => {
  const f = fixture();
  const child = spawn(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", resolve("packages/pi-orbital/src/index.ts"), "--mode", "rpc", "--no-session"], {
    cwd: f.directory, env: { ...hostEnvironment, E2B_API_KEY: "", ORBITAL_IMAGE: undefined,
      ORBITAL_LEASE_WINDOW_MS: undefined, ORBITAL_AUTO_ON: undefined, ORBITAL_SKILL_ROOTS: undefined,
      XDG_CONFIG_HOME: resolve(f.directory, "config"), PI_CODING_AGENT_DIR: resolve(f.directory, "agent") },
  });
  const events: any[] = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  let sequence = 0;
  async function command(message: string) {
    const start = events.length;
    const id = String(++sequence);
    child.stdin.write(JSON.stringify({ type: "prompt", id, message }) + "\n");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const recent = events.slice(start);
      const response = recent.find(event => event.id === id && event.type === "response");
      const output = recent.find(event => event.type === "message_end" && event.message?.customType === "orbital.settings");
      if (response && output) { assert.equal(response.success, true); return output.message; }
      if (stderr.includes("Extension error") || child.exitCode !== null) throw new Error(stderr);
      await new Promise(done => setTimeout(done, 10));
    }
    throw new Error(`Settings command timed out: ${stderr}`);
  }
  try {
    assert.equal((await command("/orb settings")).details.settings.effective.image, undefined);
    writeFileSync(resolve(f.config, "settings.json"), JSON.stringify({ image: "external-image" }));
    assert.equal((await command("/orb settings")).details.settings.effective.image, undefined);
    assert.equal((await command("/orb settings refresh")).details.settings.effective.image, "external-image");
    assert.equal(events.some(event => event.type === "agent_start"), false);
  } finally {
    const closed = new Promise<void>(done => child.once("close", () => done()));
    child.kill("SIGKILL");
    await closed;
    f.close();
  }
});

test("Pi reports a malformed configuration and preserves it when an edit is rejected", () => {
  const f = fixture();
  try {
    const file = resolve(f.config, "settings.json");
    const malformed = '{"image": "DO_NOT_ECHO_BAD_FILE",';
    writeFileSync(file, malformed);
    const message = f.command("/orb settings set image replacement");
    assert.match(message.details.error, /Cannot edit invalid settings/);
    assert.match(message.content, /settings.json/);
    assert.ok(message.details.settings.diagnostics.length > 0);
    assert.doesNotMatch(JSON.stringify(message), /DO_NOT_ECHO_BAD_FILE/);
    assert.equal(readFileSync(file, "utf8"), malformed);
  } finally { f.close(); }
});

test("Pi print mode shows settings on its diagnostic stream without a TUI or a model turn", () => {
  const f = fixture();
  try {
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--no-session", "--print", "/orb settings"], {
      cwd: f.directory, encoding: "utf8", timeout: 30_000,
      env: { ...hostEnvironment, E2B_API_KEY: "", PI_CODING_AGENT_DIR: resolve(f.directory, "agent"),
        XDG_CONFIG_HOME: resolve(f.directory, "config") },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Orbital settings:/);
    assert.match(run.stderr, /leaseWindowMs/);
  } finally { f.close(); }
});

test("Pi status reports route and readiness as data without contacting E2B", () => {
  const f = fixture();
  try {
    const message = f.command("/orb status", {}, "orbital.status");
    assert.equal(message.details.route, "local");
    assert.equal(message.details.allocation, "neverRequested");
    assert.equal(message.details.activity, "idle");
    assert.deepEqual(message.details.provider, { state: "unknown" });
    assert.equal(message.details.readiness.remote, false);
    assert.equal(message.details.readiness.create, false);
    assert.match(message.content, /E2B_API_KEY/);
  } finally { f.close(); }
});

test("Pi print mode shows the route without a TUI", () => {
  const f = fixture();
  try {
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--no-session", "--print", "/orb status"], {
      cwd: f.directory, encoding: "utf8", timeout: 30_000,
      env: { ...hostEnvironment, E2B_API_KEY: "", ORBITAL_AUTO_ON: "false",
        PI_CODING_AGENT_DIR: resolve(f.directory, "agent"), XDG_CONFIG_HOME: resolve(f.directory, "config") },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Orbital route: local/);
  } finally { f.close(); }
});

test("Pi settings preserves spaces inside a skill path", () => {
  const f = fixture();
  try {
    const message = f.command('/orb settings set skillRoots ["/skills/two  spaces"]');
    assert.deepEqual(message.details.preferences.saved.skillRoots, ["/skills/two  spaces"]);
  } finally { f.close(); }
});

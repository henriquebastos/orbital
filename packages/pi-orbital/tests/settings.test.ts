import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import test from "node:test";

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "orbital-settings-pi-"));
  const config = resolve(directory, "config", "orbital");
  mkdirSync(config, { recursive: true });
  function command(message: string, overrides: NodeJS.ProcessEnv = {}, customType = "orbital.settings") {
    const run = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", resolve("packages/pi-orbital/src/index.ts"), "--mode", "json", "--no-session", "--print", message], {
      cwd: directory, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(directory, "agent"),
        XDG_CONFIG_HOME: resolve(directory, "config"), E2B_API_KEY: "", ORBITAL_IMAGE: undefined,
        ORBITAL_IDLE_TIMEOUT_MS: undefined, ORBITAL_AUTO_ON: undefined, ORBITAL_SKILL_ROOTS: undefined, ...overrides },
    });
    assert.equal(run.status, 0, run.stderr);
    const events = run.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    assert.equal(events.some(event => event.type === "agent_start"), false, "Settings commands must not start a model turn.");
    const output = events.find(event => event.type === "message_end" && event.message?.customType === customType);
    assert.ok(output, run.stdout + run.stderr);
    return output.message;
  }
  return { directory, config, command, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test("Pi saves an Orbital default separately from its environment override", () => {
  const f = fixture();
  try {
    writeFileSync(resolve(f.config, "settings.json"), JSON.stringify({ idleTimeoutMs: 90000 }));
    const message = f.command("/orb settings set image saved-image", { ORBITAL_IMAGE: "environment-image" });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")), {
      idleTimeoutMs: 90000, image: "saved-image",
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
      env: { ...process.env, E2B_API_KEY: "", ORBITAL_AUTO_ON: "false", ORBITAL_SKILL_ROOTS: undefined,
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
    f.command("/orb settings set idleTimeoutMs 45000");
    const message = f.command("/orb settings unset image", { ORBITAL_IMAGE: "override-image" });
    assert.deepEqual(JSON.parse(readFileSync(resolve(f.config, "settings.json"), "utf8")), { idleTimeoutMs: 45000 });
    assert.equal(message.details.settings.effective.image, "override-image");
    assert.equal(message.details.settings.source.image, "environment");
  } finally { f.close(); }
});

test("Pi refresh reads external settings changes without starting a model turn", async () => {
  const f = fixture();
  const child = spawn(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", resolve("packages/pi-orbital/src/index.ts"), "--mode", "rpc", "--no-session"], {
    cwd: f.directory, env: { ...process.env, E2B_API_KEY: "", ORBITAL_IMAGE: undefined,
      ORBITAL_IDLE_TIMEOUT_MS: undefined, ORBITAL_AUTO_ON: undefined, ORBITAL_SKILL_ROOTS: undefined,
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
      env: { ...process.env, E2B_API_KEY: "", PI_CODING_AGENT_DIR: resolve(f.directory, "agent"),
        XDG_CONFIG_HOME: resolve(f.directory, "config") },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /Orbital settings:/);
    assert.match(run.stderr, /idleTimeoutMs/);
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
      env: { ...process.env, E2B_API_KEY: "", ORBITAL_AUTO_ON: "false",
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

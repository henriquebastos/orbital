import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createOrbital } from "@henriquebastosnet/orbital";
import { createPiSession } from "../src/session.js";
import { SimulatedProvider } from "../../../tests/support/provider.js";

type Response = { type: string; id?: string; success?: boolean; error?: string; data?: any };

function start(dir: string, extra: Record<string, string> = {}) {
  const child = spawn(resolve("node_modules/.bin/pi"), ["--offline", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--extension",
    resolve("packages/pi-orbital/tests/fixture-extension.ts"), "--provider", "orbital-fixture", "--model", "probe",
    "--mode", "rpc", "--session", resolve(dir, "session.jsonl")], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"),
      ORBITAL_PI_FIXTURE_ROOT: dir, ...extra },
  });
  let sequence = 0;
  let buffer = "";
  let stderr = "";
  const pending = new Map<string, (response: Response) => void>();
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      const response = JSON.parse(line) as Response;
      if (response.type === "response" && response.id) pending.get(response.id)?.(response);
    }
  });
  return {
    async request(type: string, args: Record<string, unknown> = {}): Promise<Response> {
      const id = String(++sequence);
      return new Promise((done, fail) => {
        const timeout = setTimeout(() => fail(new Error(`RPC ${type} timed out. ${stderr}`)), 10_000);
        pending.set(id, response => { clearTimeout(timeout); pending.delete(id); done(response); });
        child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      await new Promise<void>(done => { child.once("exit", () => done()); child.kill(); });
    },
  };
}

async function persistSession(session: ReturnType<typeof start>) {
  await session.request("prompt", { message: "initialize session" });
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await session.request("get_state");
    if (!state.data?.isStreaming) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error("The fixture model did not finish.");
}

test("a Pi session with no image setting prepares its default on first remote demand", async () => {
  const provider = new SimulatedProvider();
  provider.exec = async () => ({ kind: "exited", exitCode: 0, jobId: "directory-check",
    stdout: "/home/user\n", stderr: "", outputPath: "/home/user/output" });
  const imageRequests: unknown[] = [];
  const orbital = createOrbital({ provider, images: {
    async ensure(request) {
      imageRequests.push(request);
      return { reference: "prepared-default", baseReference: "default-base", cacheKey: "key", reused: false };
    },
  } });
  const entries: unknown[] = [];
  const pi = { appendEntry(_type: string, entry: unknown) { entries.push(entry); } };
  const context = { sessionManager: {
    getSessionId: () => "pi-session", getBranch: () => [], getSessionFile: () => undefined,
    getHeader: () => undefined, getEntries: () => [],
  } };
  const session = createPiSession(pi as never, orbital, async () => ({ image: undefined, idleTimeoutMs: 60_000 }));
  await session.restore(context as never, "new");
  session.setRoute("remote");
  assert.deepEqual(provider.effects, []);
  assert.deepEqual(imageRequests, []);
  await session.workspace();
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
  assert.deepEqual(imageRequests, [{ image: undefined, preparation: undefined }]);
  assert.equal(provider.orbs[0]?.image, "prepared-default");
  assert.equal(entries.length, 4);
  await session.workspace();
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
  assert.equal(imageRequests.length, 1);
});

test("on saves remote intent without allocation, first demand allocates, and off preserves the orb", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir);
  try {
    assert.equal((await session.request("prompt", { message: "/orb on" })).success, true);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
    const remote = await session.request("bash", { command: "printf REMOTE > marker; pwd" });
    assert.equal(remote.success, true, JSON.stringify(remote));
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTE");
    const before = readFileSync(resolve(dir, "snapshot.json"), "utf8");
    assert.equal((await session.request("prompt", { message: "/orb off" })).success, true);
    assert.equal((await session.request("bash", { command: "printf LOCAL > marker" })).success, true);
    assert.equal(readFileSync(resolve(dir, "marker"), "utf8"), "LOCAL");
    assert.equal(readFileSync(resolve(dir, "snapshot.json"), "utf8"), before);
    await session.request("prompt", { message: "/orb on" });
    await session.request("bash", { command: "printf AGAIN >> marker" });
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTEAGAIN");
    assert.equal(readFileSync(resolve(dir, "snapshot.json"), "utf8"), before);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routing changes are rejected while a local user shell is active", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir);
  try {
    const shell = session.request("bash", { command: "printf STARTED > started; sleep 0.4; printf LOCAL > marker" });
    for (let attempt = 0; !existsSync(resolve(dir, "started")) && attempt < 100; attempt++) {
      await new Promise(done => setTimeout(done, 10));
    }
    assert.equal(existsSync(resolve(dir, "started")), true);
    await session.request("prompt", { message: "/orb on" });
    const messages = await session.request("get_messages");
    assert.match(JSON.stringify(messages), /Orbital is busy/);
    await shell;
    await session.request("bash", { command: "printf STILL_LOCAL >> marker" });
    assert.equal(readFileSync(resolve(dir, "marker"), "utf8"), "LOCALSTILL_LOCAL");
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lost allocation reply survives restart and never recreates a missing orb implicitly", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  let session = start(dir, { ORBITAL_PI_FAULT: "creation", ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl") });
  try {
    await persistSession(session);
    await session.request("prompt", { message: "/orb on" });
    const failed = await session.request("bash", { command: "printf SHOULD_NOT_RUN > marker" });
    assert.match(JSON.stringify(failed), /fixture_creation_lost/);
    assert.match(readFileSync(resolve(dir, "session.jsonl"), "utf8"), /"allocation":"requested"/);
    await session.close();
    rmSync(resolve(dir, "snapshot.json"));
    session = start(dir, { ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl") });
    const resumed = await session.request("bash", { command: "printf SHOULD_NOT_RUN > marker" });
    assert.match(JSON.stringify(resumed), /allocation_unresolved/);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
    assert.equal(existsSync(resolve(dir, "marker")), false);
    assert.equal(existsSync(resolve(dir, "orb", "marker")), false);
    const creates = readFileSync(resolve(dir, "provider.jsonl"), "utf8").trim().split("\n");
    assert.equal(creates.length, 1);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auto-on applies to a new session and preserves a saved local choice on resume", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  let session = start(dir, { ORBITAL_AUTO_ON: "true" });
  try {
    await persistSession(session);
    await session.request("bash", { command: "printf REMOTE > marker" });
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTE");
    await session.request("prompt", { message: "/orb off" });
    await session.close();
    session = start(dir, { ORBITAL_AUTO_ON: "true" });
    await session.request("bash", { command: "printf LOCAL > marker" });
    assert.equal(readFileSync(resolve(dir, "marker"), "utf8"), "LOCAL");
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTE");
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi tree navigation restores the selected branch route", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir);
  try {
    await persistSession(session);
    await session.request("prompt", { message: "/orb on" });
    await session.request("bash", { command: "printf REMOTE > marker" });
    const entries = readFileSync(resolve(dir, "session.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const target = entries.reverse().find(entry => entry.customType === "orbital.binding" && entry.data.allocation === "attached");
    assert.ok(target);
    await session.request("prompt", { message: "/orb off" });
    await session.request("bash", { command: "printf LOCAL > marker" });
    await session.request("prompt", { message: `/fixture-tree ${target.id}` });
    await session.request("bash", { command: "printf BRANCH >> marker" });
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTEBRANCH");
    assert.equal(readFileSync(resolve(dir, "marker"), "utf8"), "LOCAL");
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy bindings restore remote routing and existing unbound histories stay local", async () => {
  for (const legacy of [true, false]) {
    const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
    let session = start(dir);
    try {
      await persistSession(session);
      await session.request("prompt", { message: "/orb on" });
      await session.request("bash", { command: "printf REMOTE > marker" });
      await session.close();
      const file = resolve(dir, "session.jsonl");
      const entries = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
      for (const entry of entries) {
        if (entry.customType !== "orbital.binding") continue;
        if (legacy) entry.data = { orbCwd: "/home/user" };
        else entry.customType = "other-extension";
      }
      writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      session = start(dir, { ORBITAL_AUTO_ON: "true" });
      await session.request("bash", { command: "printf RESUMED >> marker" });
      assert.equal(readFileSync(resolve(dir, legacy ? "orb/marker" : "marker"), "utf8"),
        legacy ? "REMOTERESUMED" : "RESUMED");
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("concurrent first remote demands share one allocation", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_PI_CREATE_DELAY: "true",
    ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl") });
  try {
    await persistSession(session);
    await session.request("prompt", { message: "/orb on" });
    const results = await Promise.all([
      session.request("bash", { command: "printf FIRST > first" }),
      session.request("bash", { command: "printf SECOND > second" }),
    ]);
    for (const result of results) assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(readFileSync(resolve(dir, "orb", "first"), "utf8"), "FIRST");
    assert.equal(readFileSync(resolve(dir, "orb", "second"), "utf8"), "SECOND");
    assert.equal(readFileSync(resolve(dir, "provider.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed provider lookup does not allocate or fall back to the host", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_PI_FAULT: "lookup" });
  try {
    await session.request("prompt", { message: "/orb on" });
    const result = await session.request("bash", { command: "printf CHANGED > marker" });
    assert.match(JSON.stringify(result), /lookup is unavailable/);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
    assert.equal(existsSync(resolve(dir, "marker")), false);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("routing changes are rejected during model reasoning before any tool starts", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_PI_MODEL_DELAY_MS: "500" });
  try {
    await session.request("prompt", { message: "run fixture" });
    const state = await session.request("get_state");
    assert.equal(state.data?.isStreaming, true);
    await session.request("prompt", { message: "/orb on" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!(await session.request("get_state")).data?.isStreaming) break;
      await new Promise(done => setTimeout(done, 10));
    }
    const messages = await session.request("get_messages");
    assert.match(JSON.stringify(messages), /Orbital is busy/);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("all seven workspace tools use Pi local backends in local mode", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const calls = [
    { name: "write", arguments: { path: "note.txt", content: "ORIGINAL" } },
    { name: "read", arguments: { path: "note.txt" } },
    { name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "ORIGINAL", newText: "REVISED" }] } },
    { name: "grep", arguments: { pattern: "REVISED", path: "note.txt" } },
    { name: "find", arguments: { pattern: "note.txt" } },
    { name: "ls", arguments: {} },
    { name: "bash", arguments: { command: "printf SHELL > shell.txt" } },
  ];
  const session = start(dir, { ORBITAL_PI_CALLS: JSON.stringify(calls) });
  try {
    await persistSession(session);
    const response = await session.request("get_messages");
    const results = response.data.messages.filter((message: { role: string }) => message.role === "toolResult");
    assert.deepEqual(results.map((result: { toolName: string }) => result.toolName),
      ["write", "read", "edit", "grep", "find", "ls", "bash"]);
    for (const result of results) {
      if (result.toolName === "find" && result.isError) {
        assert.match(JSON.stringify(result.content), /fd is not available/);
      } else assert.equal(result.isError, false, JSON.stringify(result));
    }
    assert.equal(readFileSync(resolve(dir, "note.txt"), "utf8"), "REVISED");
    assert.equal(readFileSync(resolve(dir, "shell.txt"), "utf8"), "SHELL");
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session switch cannot replace the identity of an admitted remote operation", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_PI_CREATE_DELAY: "true",
    ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl") });
  try {
    await persistSession(session);
    const before = await session.request("get_state");
    await session.request("prompt", { message: "/orb on" });
    const command = session.request("bash", { command: "printf ORIGINAL > marker" });
    for (let attempt = 0; !existsSync(resolve(dir, "provider.jsonl")) && attempt < 100; attempt++) {
      await new Promise(done => setTimeout(done, 5));
    }
    assert.equal(existsSync(resolve(dir, "provider.jsonl")), true);
    await session.request("new_session");
    await command;
    const after = await session.request("get_state");
    assert.equal(after.data.sessionId, before.data.sessionId);
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "ORIGINAL");
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an invalid background timeout does not allocate the first orb", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_AUTO_ON: "true", ORBITAL_PI_CALLS: JSON.stringify([
    { name: "bash", arguments: { command: "printf SHOULD_NOT_RUN", mode: "background", timeout: 1 } },
  ]) });
  try {
    await persistSession(session);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
    assert.match(JSON.stringify(await session.request("get_messages")), /background_timeout/);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed explicit attachment keeps subsequent workspace calls off the host", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  const session = start(dir, { ORBITAL_PI_FAULT: "lookup", ORBITAL_PI_CALLS: JSON.stringify([
    { name: "orbital", arguments: { action: "create_and_attach" } },
    { name: "bash", arguments: { command: "printf SHOULD_NOT_RUN > marker" } },
  ]) });
  try {
    await persistSession(session);
    assert.equal(existsSync(resolve(dir, "marker")), false);
    assert.equal(existsSync(resolve(dir, "snapshot.json")), false);
    const response = await session.request("get_messages");
    const results = response.data.messages.filter((message: { role: string }) => message.role === "toolResult");
    assert.deepEqual(results.map((result: { toolName: string; isError: boolean }) => [result.toolName, result.isError]),
      [["orbital", true], ["bash", true]]);
    assert.match(JSON.stringify(results), /lookup is unavailable/);
    await session.request("prompt", { message: "/orb status" });
    const status = JSON.stringify(await session.request("get_messages"));
    assert.match(status, /route: remote/);
    assert.match(status, /Allocation: neverRequested/);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lost allocation reply requires explicit recovery even when the orb still exists", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-routing-"));
  let session = start(dir, { ORBITAL_PI_FAULT: "creation", ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl") });
  try {
    await persistSession(session);
    await session.request("prompt", { message: "/orb on" });
    const failed = await session.request("bash", { command: "printf SHOULD_NOT_RUN > forbidden" });
    assert.match(JSON.stringify(failed), /fixture_creation_lost/);
    const original = readFileSync(resolve(dir, "snapshot.json"), "utf8");
    await session.close();
    session = start(dir, { ORBITAL_PI_PROVIDER_TRACE: resolve(dir, "provider.jsonl"), ORBITAL_PI_CALLS: JSON.stringify([
      { name: "bash", arguments: { command: "printf SHOULD_NOT_RUN > forbidden" } },
      { name: "orbital", arguments: { action: "inspect" } },
      { name: "orbital", arguments: { action: "create_and_attach" } },
      { name: "bash", arguments: { command: "printf RECOVERED > marker" } },
    ]) });
    await persistSession(session);
    assert.equal(existsSync(resolve(dir, "orb", "forbidden")), false);
    assert.equal(existsSync(resolve(dir, "forbidden")), false);
    const response = await session.request("get_messages");
    const results = response.data.messages.filter((message: { role: string }) => message.role === "toolResult");
    assert.deepEqual(results.map((result: { toolName: string; isError: boolean }) => [result.toolName, result.isError]),
      [["bash", true], ["orbital", false], ["orbital", false], ["bash", false]]);
    assert.match(JSON.stringify(results[0]), /allocation_unresolved/);
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "RECOVERED");
    assert.equal(readFileSync(resolve(dir, "snapshot.json"), "utf8"), original);
    assert.equal(readFileSync(resolve(dir, "provider.jsonl"), "utf8").trim().split("\n").length, 1);
  } finally {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createOrbital, type Observer } from "@henriquebastosnet/orbital";
import { registerOrbitalPi } from "../src/extension.js";
import { SimulatedProvider } from "../../../tests/support/provider.js";

async function fixture(beforeOpen?: (observer: Observer) => Promise<void>) {
  const provider = new SimulatedProvider();
  provider.orbs.push({ orbId: "agent-original", resourceId: "allocation-1", image: "fixture-image",
    state: "running", leaseWindowMs: 60000, creationIntent: { image: "fixture-image" } });
  provider.files.set("allocation-1:/home/user/note.txt", Buffer.from("original"));
  provider.files.set("allocation-1:/home/user/.orbital/jobs/job-1/output", Buffer.from(""));
  const orbital = createOrbital({ provider });
  const acquisitions: { orbId: string; orbCwd: string; signal?: AbortSignal }[] = [];
  const openWorkspace = orbital.openWorkspace.bind(orbital);
  orbital.openWorkspace = async (request, observer = {}) => {
    acquisitions.push({ ...request, signal: observer.signal });
    await beforeOpen?.(observer);
    return openWorkspace(request, observer);
  };
  const sessionManager = SessionManager.inMemory("/host", { id: "agent-original" });
  sessionManager.appendCustomEntry("orbital.control", {
    version: 1, route: "remote", allocation: "attached", orbCwd: "/home/user",
  });
  const ctx = { cwd: "/host", sessionManager, isIdle: () => false } as unknown as ExtensionContext;
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: never, context: ExtensionContext) => unknown>();
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    appendEntry(type: string, data: unknown) { sessionManager.appendCustomEntry(type, data); },
    on(name: string, handler: (event: never, context: ExtensionContext) => unknown) { handlers.set(name, handler); },
  };
  registerOrbitalPi(pi as never, orbital, { image: "fixture-image", leaseWindowMs: 60000 });
  await handlers.get("session_start")!({ reason: "resume" } as never, ctx);
  return { provider, acquisitions, ctx, handlers,
    execute(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
      return tools.get(name)!.execute(`call-${name}`, params, signal, undefined, ctx);
    },
  };
}

const workspaceCalls = [
  { name: "bash", params: { command: "pwd" } },
  { name: "read", params: { path: "note.txt" } },
  { name: "write", params: { path: "note.txt", content: "changed" } },
  { name: "edit", params: { path: "note.txt", edits: [{ oldText: "original", newText: "changed" }] } },
  { name: "grep", params: { pattern: "original" } },
  { name: "find", params: { pattern: "*.txt" } },
  { name: "ls", params: {} },
];
for (const { name, params } of workspaceCalls) {
  test(`the remote ${name} agent tool acquires one workspace with its cancellation signal`, async () => {
    const f = await fixture();
    const { signal } = new AbortController();
    await f.execute(name, params, signal);
    assert.deepEqual(f.acquisitions, [{ orbId: "agent-original", orbCwd: "/home/user", signal }]);
    assert.equal(f.acquisitions[0]!.signal, signal);
  });
}

test("a blocked agent tool acquisition rejects route changes and session navigation", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const blocked = new Promise<void>(done => { release = done; });
  const f = await fixture(async () => { entered(); await blocked; });
  const { signal } = new AbortController();
  const read = f.execute("read", { path: "note.txt" }, signal);
  await started;
  try {
    await assert.rejects(f.execute("orbital", { action: "set_route", route: "local" }), /Orbital is busy/);
    for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
      assert.deepEqual(await f.handlers.get(event)!({} as never, f.ctx), { cancel: true }, event);
    }
    const status = await f.execute("orbital", { action: "status" });
    assert.equal((status.details as { route: string }).route, "remote");
    assert.equal(f.ctx.sessionManager.getSessionId(), "agent-original");
    assert.deepEqual(f.acquisitions, [{ orbId: "agent-original", orbCwd: "/home/user", signal }]);
  } finally { release(); }
  const result = await read;
  assert.deepEqual(result.content, [{ type: "text", text: "original" }]);
  assert.equal(f.acquisitions.length, 1);
  await f.execute("orbital", { action: "set_route", route: "local" });
  for (const event of ["session_before_switch", "session_before_fork", "session_before_tree"]) {
    assert.equal(await f.handlers.get(event)!({} as never, f.ctx), undefined, event);
  }
});

test("cancellation during agent acquisition prevents a write and releases the routing guard", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const blocked = new Promise<void>(done => { release = done; });
  const f = await fixture(async () => { entered(); await blocked; });
  const controller = new AbortController();
  const write = f.execute("write", { path: "note.txt", content: "changed" }, controller.signal);
  const rejected = assert.rejects(write, /cancelled/i);
  await started;
  controller.abort();
  release();
  await rejected;
  assert.equal(f.acquisitions.length, 1);
  assert.equal(f.acquisitions[0]!.signal, controller.signal);
  assert.equal(Buffer.from(f.provider.files.get("allocation-1:/home/user/note.txt")!).toString(), "original");
  assert.deepEqual(f.provider.effects, []);
  await f.execute("orbital", { action: "set_route", route: "local" });
});

test("an invalid background timeout is rejected before agent workspace acquisition", async () => {
  const f = await fixture();
  await assert.rejects(f.execute("bash", { command: "pwd", mode: "background", timeout: 1 }), /background_timeout/);
  assert.deepEqual(f.acquisitions, []);
  assert.deepEqual(f.provider.effects, []);
});

test("remote edits reject overlapping occurrences without changing the source file", async () => {
  const f = await fixture();
  const key = "allocation-1:/home/user/note.txt";
  f.provider.files.set(key, Buffer.from("aaa"));
  await assert.rejects(f.execute("edit", { path: "note.txt", edits: [{ oldText: "aa", newText: "changed" }] }),
    /Each oldText must match exactly once/);
  assert.equal(Buffer.from(f.provider.files.get(key)!).toString(), "aaa");
  assert.deepEqual(f.provider.effects, []);
});

test("remote multi-edits reject overlapping ranges but permit adjacent ranges in the original file", async () => {
  const f = await fixture();
  const key = "allocation-1:/home/user/note.txt";
  f.provider.files.set(key, Buffer.from("abcdef"));
  await assert.rejects(f.execute("edit", { path: "note.txt", edits: [
    { oldText: "abc", newText: "A" }, { oldText: "cde", newText: "B" },
  ] }), /Remote edits must not overlap/);
  assert.equal(Buffer.from(f.provider.files.get(key)!).toString(), "abcdef");
  assert.deepEqual(f.provider.effects, []);
  await f.execute("edit", { path: "note.txt", edits: [
    { oldText: "def", newText: "B" }, { oldText: "abc", newText: "LONGER" },
  ] });
  assert.equal(Buffer.from(f.provider.files.get(key)!).toString(), "LONGERB");
  assert.deepEqual(f.provider.effects, ["write:allocation-1:/home/user/note.txt"]);
});

test("tool status reports idle while only the status call itself is active", async () => {
  const f = await fixture();
  f.ctx.isIdle = () => true;
  const result = await f.execute("orbital", { action: "status" }) as { details: { activity: string } };
  assert.equal(result.details.activity, "idle");
});

test("explicit attachment keeps the retained remote directory when no directory is given", async () => {
  const f = await fixture();
  const exec = f.provider.exec.bind(f.provider);
  f.provider.exec = async (orb, request) => {
    const result = await exec(orb, request);
    const entered = /^cd -- '([^']+)' && pwd -P$/.exec(request.command);
    return entered ? { ...result, stdout: `${entered[1]}\n` } : result;
  };
  await f.execute("orbital", { action: "select_directory", orbCwd: "/home/user/project" });
  const attached = await f.execute("orbital", { action: "create_and_attach" }) as { details: { orbCwd: string } };
  assert.equal(attached.details.orbCwd, "/home/user/project");
});

test("search and listing item limits add the same truncation notice as byte clipping", async () => {
  const f = await fixture();
  f.provider.files.set("allocation-1:/home/user/.orbital/jobs/job-1/output", Buffer.from("/home/user/a\0/home/user/b\0/home/user/c\0"));
  const clipped = await f.execute("ls", { limit: 2 }) as { content: { text: string }[] };
  assert.match(clipped.content[0]!.text, /^a\nb\n\[Output truncated\. Full output: \/home\/user\/\.orbital\/jobs\/job-1\/output\]$/);
  const complete = await f.execute("find", { pattern: "*", limit: 3 }) as { content: { text: string }[] };
  assert.doesNotMatch(complete.content[0]!.text, /Output truncated/);
});

test("explicit attachment of a new orb starts at the default directory", async () => {
  const f = await fixture();
  f.provider.orbs = [];
  const exec = f.provider.exec.bind(f.provider);
  f.provider.exec = async (orb, request) => {
    const result = await exec(orb, request);
    const entered = /^cd -- '([^']+)' && pwd -P$/.exec(request.command);
    return entered ? { ...result, stdout: `${entered[1]}\n` } : result;
  };
  const attached = await f.execute("orbital", { action: "create_and_attach" }) as { details: { orbCwd: string } };
  assert.equal(attached.details.orbCwd, "/home/user");
  assert.deepEqual(f.provider.effects.filter(effect => effect.startsWith("create")), ["create:allocation-1"]);
});

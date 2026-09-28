import assert from "node:assert/strict";
import test from "node:test";
import { createOrbital } from "@henriquebastosnet/orbital";
import { SimulatedProvider } from "../../../../tests/support/provider.js";

test("creation requires an explicit orb ID before contacting the provider", async () => {
  const orbital = createOrbital({ provider: {} as never });
  await assert.rejects(orbital.create({ orbId: "", image: "test-image", idleTimeoutMs: 60000 }), /orbId/);
});

test("a caller creates an orb and executes in its selected remote directory", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const orb = await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: orb.orbId, orbCwd: "/home/user" });
  const result = await workspace.exec({ command: "pwd" });
  assert.equal(result.stdout, "/home/user");
  assert.equal(result.exitCode, 0);
  assert.equal((await orbital.inspect({ orbId: orb.orbId }))?.resourceId, orb.resourceId);
});

test("workspace demand wakes the same sleeping allocation without creating a replacement", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const orb = await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  orb.state = "sleeping";
  const workspace = await orbital.openWorkspace({ orbId: orb.orbId, orbCwd: "/home/user" });
  await workspace.exec({ command: "pwd" });
  assert.equal((await orbital.inspect({ orbId: orb.orbId }))?.state, "running");
  assert.deepEqual(provider.effects, ["create:allocation-1", "resume:allocation-1", "exec:allocation-1:pwd"]);
});

test("retrying a known identity reuses its allocation and rejects an image conflict", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const request = { orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 };
  const first = await orbital.create(request);
  const second = await orbital.create(request);
  assert.equal(second.resourceId, first.resourceId);
  await assert.rejects(orbital.create({ ...request, image: "different-image" }), /conflict/i);
  assert.equal(provider.orbs.length, 1);
});

test("remote bytes preserve literal paths and edit changes exactly one match", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  const path = "space λ $(touch sentinel).txt";
  await workspace.writeFile(path, Buffer.from("original\n"));
  await workspace.edit({ path, oldText: "original", newText: "changed" });
  assert.equal(Buffer.from(await workspace.readFile(path)).toString(), "changed\n");
  await assert.rejects(workspace.edit({ path, oldText: "missing", newText: "bad" }), /match/);
  await workspace.writeFile("~/binary", new Uint8Array([0, 255, 128, 13]));
  assert.deepEqual(await workspace.readFile("/home/user/binary"), new Uint8Array([0, 255, 128, 13]));
});

test("unknown command and write failures remain uncertain and are never replayed", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  provider.exec = async () => { provider.effects.push("admitted"); throw new Error("lost transport"); };
  await assert.rejects(workspace.exec({ command: "change" }), { outcome: "uncertain" });
  assert.equal(provider.effects.filter(effect => effect === "admitted").length, 1);
  provider.fault = "lose_write";
  await assert.rejects(workspace.writeFile("result", Buffer.from("changed")), { outcome: "uncertain" });
  assert.equal(Buffer.from(await workspace.readFile("result")).toString(), "changed");
  assert.equal(provider.effects.filter(effect => effect.startsWith("write:")).length, 1);
});

test("directory selection validates remotely and returns the canonical directory", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  provider.exec = async (_orb, request) => ({ kind: "exited", exitCode: request.command.includes("missing") ? 1 : 0, stdout: "/home/user/project\n", stderr: "", jobId: "directory", outputPath: "/home/user/.orbital/jobs/directory/output" });
  assert.equal(await workspace.validateDirectory("project"), "/home/user/project");
  await assert.rejects(workspace.validateDirectory("missing"), /directory/);
  assert.equal(workspace.orbCwd, "/home/user");
});

test("URL lookup is passive and deletion makes later demand fail without replacement", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const orb = await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  orb.state = "sleeping";
  assert.equal(await orbital.url({ orbId: orb.orbId, port: 3000 }), "https://3000-allocation-1.example.test");
  assert.equal((await orbital.inspect({ orbId: orb.orbId }))?.state, "sleeping");
  await orbital.delete({ orbId: orb.orbId });
  await assert.rejects(orbital.openWorkspace({ orbId: orb.orbId, orbCwd: "/home/user" }), { outcome: "not_started", code: "missing" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("pre-cancelled creation admits no work and cancelled commands do not submit", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const request = { orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 };
  await assert.rejects(orbital.create(request, { signal: AbortSignal.abort() }), { outcome: "not_started", code: "cancelled" });
  assert.equal(provider.orbs.length, 0);
  await orbital.create(request);
  const workspace = await orbital.openWorkspace({ orbId: request.orbId, orbCwd: "/home/user" });
  await assert.rejects(workspace.exec({ command: "effect" }, { signal: AbortSignal.abort() }), { outcome: "not_started", code: "cancelled" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("an open workspace keeps its resolved allocation while provider metadata changes", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  await workspace.writeFile("sentinel", Buffer.from("original allocation"));
  provider.orbs[0]!.resourceId = "replacement";
  assert.equal(Buffer.from(await workspace.readFile("sentinel")).toString(), "original allocation");
});

test("cancellation after creation admission reports the surviving allocation without attaching", async () => {
  const provider = new SimulatedProvider();
  const controller = new AbortController();
  const original = provider.create.bind(provider);
  provider.create = async (request) => { const orb = await original(request); controller.abort(); return orb; };
  const orbital = createOrbital({ provider });
  await assert.rejects(orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 }, { signal: controller.signal }), (error: unknown) => {
    assert.equal((error as { outcome: string }).outcome, "uncertain");
    assert.equal((error as { evidence: { resourceId: string } }).evidence.resourceId, "allocation-1");
    return true;
  });
  assert.equal((await orbital.inspect({ orbId: "pi-session" }))?.resourceId, "allocation-1");
});

test("invalid remote context and execution timeout fail before provider work", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await assert.rejects(orbital.openWorkspace({ orbId: "pi-session", orbCwd: "relative" }), { code: "invalid_directory" });
  await assert.rejects(orbital.create({ orbId: "pi-session", image: "", idleTimeoutMs: -1 }), { code: "invalid_create" });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  await assert.rejects(workspace.exec({ command: "effect", timeoutMs: 0 }), { code: "invalid_timeout" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("every public operation rejects an empty orb ID", async () => {
  const orbital = createOrbital({ provider: {} as never });
  for (const operation of [
    () => orbital.inspect({ orbId: "" }),
    () => orbital.delete({ orbId: " " }),
    () => orbital.url({ orbId: "", port: 3000 }),
    () => orbital.openWorkspace({ orbId: "", orbCwd: "/home/user" }),
  ]) await assert.rejects(operation(), { code: "invalid_id", outcome: "not_started" });
});

test("cancelling an open workspace prevents a later file mutation", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const controller = new AbortController();
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(workspace.writeFile("sentinel", Buffer.from("changed")), { outcome: "not_started", code: "cancelled" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("workspace resolution captures the caller directory before external lookup completes", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const target = { orbId: "pi-session", orbCwd: "/home/user" };
  const opening = orbital.openWorkspace(target);
  target.orbCwd = "/changed-during-lookup";
  assert.equal((await (await opening).exec({ command: "pwd" })).stdout, "/home/user");
});

test("background commands reject a timeout rather than silently ignoring it", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  await orbital.create({ orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 });
  const workspace = await orbital.openWorkspace({ orbId: "pi-session", orbCwd: "/home/user" });
  await assert.rejects(workspace.exec({ command: "service", mode: "background", timeoutMs: 100 }), { outcome: "not_started", code: "invalid_timeout" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("successful demand wake returns a running snapshot even when the adapter does not mutate its input", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const request = { orbId: "pi-session", image: "test-image", idleTimeoutMs: 60000 };
  await orbital.create(request);
  provider.resume = async (orb) => { provider.orbs = provider.orbs.map(item => item.resourceId === orb.resourceId ? { ...item, state: "running" } : item); };
  provider.orbs[0]!.state = "sleeping";
  assert.equal((await orbital.create(request)).state, "running");
  provider.orbs[0]!.state = "sleeping";
  assert.equal((await orbital.openWorkspace({ orbId: request.orbId, orbCwd: "/home/user" })).orb.state, "running");
});

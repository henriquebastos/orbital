import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createOrbital, createE2BProvider } from "@henriquebastosnet/orbital";
import { saveReceipt } from "../support/receipts.js";

interface RpcEvent {
  id?: string;
  type: string;
  success?: boolean;
  data?: { output?: string; exitCode?: number };
  message?: { customType?: string; content?: string; details?: Record<string, unknown> };
}

const image = process.env.ORBITAL_IMAGE;
const apiKey = process.env.E2B_API_KEY;
if (!image || !apiKey) {
  saveReceipt("hosted-routing", { status: "blocked", reason: "ORBITAL_IMAGE and E2B_API_KEY are required.",
    cleanup: "No allocation created", skips: [] });
  process.exit(1);
}
const provider = createE2BProvider({ apiKey });
const orbital = createOrbital({ provider });
const directory = mkdtempSync(resolve(tmpdir(), "orbital-hosted-routing-"));
const session = resolve(directory, "session.jsonl");
const configDirectory = resolve(directory, "config", "orbital");
const receiptDirectory = resolve("test-output", `${new Date().toISOString().replaceAll(":", "-")}-hosted-routing`);
const runs: Record<string, unknown>[] = [];
let orbId: string | undefined;
let resourceId: string | undefined;
let failure: string | undefined;
let cleanup: Record<string, unknown> = {};
const started = Date.now();
mkdirSync(receiptDirectory, { recursive: true });
mkdirSync(configDirectory, { recursive: true });
writeFileSync(resolve(configDirectory, "settings.json"), JSON.stringify({ image, idleTimeoutMs: 30000 }) + "\n");
writeFileSync(resolve(configDirectory, "pi.json"), JSON.stringify({ autoOn: false, skillRoots: [] }) + "\n");
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: resolve(directory, "agent"),
  XDG_CONFIG_HOME: resolve(directory, "config"), ORBITAL_AUTO_ON: "false" };
delete env.ORBITAL_IMAGE;
delete env.ORBITAL_IDLE_TIMEOUT_MS;

function checkpoint(): void {
  writeFileSync(resolve(receiptDirectory, "progress.json"), JSON.stringify({ image, orbId, resourceId, runs }, null, 2) + "\n");
}

function startPi(): { request(type: "prompt" | "bash", value: string): Promise<RpcEvent>;
  stop(): Promise<void>; events: RpcEvent[] } {
  const child: ChildProcessWithoutNullStreams = spawn(resolve("node_modules/.bin/pi"),
    ["--offline", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--mode", "rpc", "--session", session], { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"] });
  const events: RpcEvent[] = [];
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.stdout.setEncoding("utf8").on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) events.push(JSON.parse(line) as RpcEvent);
  });
  async function request(type: "prompt" | "bash", value: string): Promise<RpcEvent> {
    const id = `routing-${++sequence}`;
    const first = events.length;
    child.stdin.write(JSON.stringify(type === "prompt"
      ? { id, type, message: value } : { id, type, command: value }) + "\n");
    const start = Date.now();
    const timeoutMs = type === "bash" ? 180000 : 30000;
    while (Date.now() - start < timeoutMs) {
      const response = events.slice(first).find(event => event.type === "response" && event.id === id);
      const message = type === "prompt" ? events.slice(first).find(event => event.type === "message_end"
        && event.message?.customType === (value.startsWith("/orb settings") ? "orbital.settings" : "orbital.status")) : undefined;
      if (response?.success === false) throw new Error(`Pi rejected ${value}: ${JSON.stringify(response)}`);
      if (response && (type === "bash" || message)) {
        runs.push({ request: value, type, response, message, events: events.slice(first), stderr: stderr.slice(-2000) });
        checkpoint();
        assert.equal(response.success, true, JSON.stringify({ value, response, stderr }));
        if (value === "/orb on") assert.match(message?.message?.content ?? "", /Orbital route: remote/);
        if (value === "/orb off") assert.match(message?.message?.content ?? "", /Orbital route: local/);
        return response;
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Pi exited before ${id}: ${stderr}`);
      await new Promise(done => setTimeout(done, 25));
    }
    throw new Error(`Pi RPC timeout for ${value}: ${stderr}. Events: ${JSON.stringify(events.slice(first)).slice(-4000)}`);
  }
  async function stop(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); done(); }, 5000);
      child.once("close", () => { clearTimeout(timer); done(); });
    });
  }
  return { request, stop, events };
}

function bindingRecords(): Record<string, unknown>[] {
  const entries = readFileSync(session, "utf8").trimEnd().split("\n").map(line => JSON.parse(line) as {
    type?: string; customType?: string; data?: Record<string, unknown>;
  });
  orbId = (entries[0] as { id: string }).id;
  return entries.filter(entry => entry.type === "custom" && entry.customType === "orbital.binding")
    .map(entry => entry.data!);
}

try {
  const install = spawnSync(resolve("node_modules/.bin/pi"), ["install", resolve("packages/pi-orbital")], {
    cwd: directory, env, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(install.status, 0, install.stderr);
  const seed = spawnSync(resolve("node_modules/.bin/pi"), ["--offline", "--no-skills", "--no-prompt-templates",
    "--no-themes", "--no-context-files", "--no-approve", "--extension", resolve("tests/support/installed-model.ts"),
    "--provider", "orbital-fixture", "--model", "probe", "--tools", "bash", "--mode", "json",
    "--session", session, "--print", "Seed the session with the fixed model."], {
    cwd: directory, env: { ...env, ORBITAL_PI_CALLS: JSON.stringify([
      { name: "bash", arguments: { command: "printf SEED_OK > seed-marker" } },
    ]) }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(seed.status, 0, seed.stderr);
  const seedResults = seed.stdout.split("\n").filter(line => line.startsWith("{"))
    .map(line => JSON.parse(line) as RpcEvent & { isError?: boolean })
    .filter(event => event.type === "tool_execution_end");
  assert.deepEqual(seedResults.map(result => result.isError), [false], seed.stdout);
  assert.equal(readFileSync(resolve(directory, "seed-marker"), "utf8"), "SEED_OK");
  runs.push({ label: "fixed-model-session-seed", results: seedResults });
  bindingRecords();
  assert.equal(await orbital.inspect({ orbId: orbId! }), undefined);
  writeFileSync(resolve(directory, "marker"), "HOST_ONLY");
  let pi = startPi();
  try {
    await pi.request("prompt", "/orb on");
    assert.equal(bindingRecords().at(-1)?.route, "remote");
    assert.equal(await orbital.inspect({ orbId: orbId! }), undefined, "On must not allocate an orb");
    const first = await pi.request("bash", "printf REMOTE_ONLY > marker; pwd");
    assert.equal(first.data?.exitCode, 0, JSON.stringify(first));
    assert.match(first.data?.output ?? "", /\/home\/user/);
    assert.equal(readFileSync(resolve(directory, "marker"), "utf8"), "HOST_ONLY");
    const created = await orbital.inspect({ orbId: orbId! });
    assert.ok(created);
    resourceId = created.resourceId;
    assert.equal(created.image, image);
    assert.equal(created.idleTimeoutMs, 30000);
    checkpoint();
    assert.deepEqual(bindingRecords().at(-1), { version: 1, route: "remote", allocation: "attached", orbCwd: "/home/user" });

    await pi.request("prompt", "/orb off");
    assert.equal(bindingRecords().at(-1)?.route, "local");
    const local = await pi.request("bash", "printf LOCAL_AFTER_OFF > marker; cat marker");
    assert.equal(local.data?.exitCode, 0, JSON.stringify(local));
    assert.match(local.data?.output ?? "", /LOCAL_AFTER_OFF/);
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);

    await pi.request("prompt", "/orb settings set image changed-image-for-reuse-test");
    await pi.request("prompt", "/orb settings set idleTimeoutMs 60000");
    assert.deepEqual(JSON.parse(readFileSync(resolve(configDirectory, "settings.json"), "utf8")),
      { image: "changed-image-for-reuse-test", idleTimeoutMs: 60000 });
    const retained = await orbital.inspect({ orbId: orbId! });
    assert.equal(retained?.resourceId, resourceId);
    assert.equal(retained.image, image);
    assert.equal(retained.idleTimeoutMs, 30000);
  } finally { await pi.stop(); }

  pi = startPi();
  try {
    assert.equal(bindingRecords().at(-1)?.route, "local");
    const local = await pi.request("bash", "cat marker");
    assert.equal(local.data?.exitCode, 0, JSON.stringify(local));
    assert.match(local.data?.output ?? "", /LOCAL_AFTER_OFF/);
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);
    await pi.request("prompt", "/orb on");
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);
    const reused = await pi.request("bash", "cat marker; pwd");
    assert.equal(reused.data?.exitCode, 0, JSON.stringify(reused));
    assert.match(reused.data?.output ?? "", /REMOTE_ONLY/);
    assert.match(reused.data?.output ?? "", /\/home\/user/);
    const same = await orbital.inspect({ orbId: orbId! });
    assert.equal(same?.resourceId, resourceId);
    assert.equal(same.image, image);
    assert.equal(same.idleTimeoutMs, 30000);
    assert.equal(readFileSync(resolve(directory, "marker"), "utf8"), "LOCAL_AFTER_OFF");
  } finally { await pi.stop(); }
  assert.equal(readFileSync(session, "utf8").includes(apiKey), false);
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
finally {
  if (orbId) {
    try {
      const orb = await orbital.inspect({ orbId });
      if (orb) { resourceId = orb.resourceId; await provider.delete(orb); }
      cleanup = { deletedResourceId: resourceId, missingAfterDelete: (await orbital.inspect({ orbId })) === undefined };
    } catch (error) { cleanup = { resourceId, failure: error instanceof Error ? error.message : String(error) }; }
  }
  rmSync(directory, { recursive: true, force: true });
}
const passed = !failure && !cleanup.failure && cleanup.missingAfterDelete === true;
saveReceipt("hosted-routing", { status: passed ? "passed" : "failed", image, orbId, resourceId, runs, failure, cleanup,
  durationMs: Date.now() - started, real: ["Pi RPC", "Pi installation", "E2B SDK", "Orbital image"],
  substituted: ["fixed model response for the initial saved assistant turn"], skips: [] }, receiptDirectory);
process.exitCode = passed ? 0 : 1;

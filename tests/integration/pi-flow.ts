import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createOrbital, createE2BProvider } from "@henriquebastosnet/orbital";
import { saveReceipt } from "../support/receipts.js";

interface Call { name: string; arguments: Record<string, unknown> }
interface PiEvent { type: string; toolName?: string; isError?: boolean; result?: { content?: { type: string; text?: string }[]; details?: Record<string, unknown> }; [key: string]: unknown }
const image = process.env.ORBITAL_IMAGE;
if (!image || !process.env.E2B_API_KEY) {
  saveReceipt("hosted-pi", { status: "blocked", reason: "ORBITAL_IMAGE and E2B_API_KEY are required.", skips: [], cleanup: "No allocations created" });
  process.exit(1);
}
const provider = createE2BProvider({ apiKey: process.env.E2B_API_KEY });
const orbital = createOrbital({ provider });
const directory = mkdtempSync(resolve(tmpdir(), "orbital-hosted-pi-"));
const session = resolve(directory, "session.jsonl");
const configHome = resolve(directory, "config");
const runs: Record<string, unknown>[] = [];
let orbId: string | undefined;
let resourceId: string | undefined;
let failure: string | undefined;
let cleanup: Record<string, unknown> = {};
const started = Date.now();
const selectedCase = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : "all";
const receiptDirectory = resolve("test-output", `${new Date().toISOString().replaceAll(":", "-")}-hosted-pi`);
mkdirSync(receiptDirectory, { recursive: true });
function checkpoint() {
  writeFileSync(resolve(receiptDirectory, "progress.json"), JSON.stringify({ image, selectedCase, orbId, resourceId, runs }, null, 2) + "\n");
}

async function waitForSleep(label: string) {
  const start = Date.now();
  const observations = [];
  while (Date.now() - start < 360000) {
    const orb = await orbital.inspect({ orbId: orbId! });
    assert.ok(orb, "The test orb must still exist.");
    assert.equal(orb.resourceId, resourceId);
    observations.push({ elapsedMs: Date.now() - start, state: orb.state });
    if (orb.state === "sleeping") { runs.push({ label, observations, passive: true }); checkpoint(); return; }
    await new Promise(done => setTimeout(done, 2000));
  }
  runs.push({ label, observations, passive: true });
  throw new Error("The orb did not sleep within the bounded observation period.");
}

async function requestHttp(label: string, url: string, init?: RequestInit) {
  const start = Date.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45000) });
  const body = await response.text();
  runs.push({ label, url, status: response.status, body, elapsedMs: Date.now() - start, piOffline: true });
  return { status: response.status, body };
}

async function runPi(label: string, calls: Call[]): Promise<PiEvent[]> {
  const args = ["--offline", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--extension", resolve("tests/support/installed-model.ts"),
    "--provider", "orbital-fixture", "--model", "probe", "--tools", "orbital,bash,read,write,edit,grep,find,ls",
    "--mode", "json", "--session", session, "--print", "Run the fixed fixture."];
  const child = spawn(resolve("node_modules/.bin/pi"), args, { cwd: directory, env: { ...process.env,
    PI_CODING_AGENT_DIR: resolve(directory, "agent"), XDG_CONFIG_HOME: configHome,
    ORBITAL_AUTO_ON: "false", ORBITAL_PI_CALLS: JSON.stringify(calls),
    ORBITAL_IMAGE: image, ORBITAL_IDLE_TIMEOUT_MS: "30000", ORBITAL_SECRET_SENTINEL: "HOST_SECRET_MUST_NOT_LEAVE" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  const code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); });
  clearTimeout(timer);
  const events = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as PiEvent);
  runs.push({ label, code, stderr: stderr.slice(-4000), events });
  if (existsSync(session)) {
    const header = JSON.parse(readFileSync(session, "utf8").split("\n")[0]!);
    orbId = header.id;
  }
  checkpoint();
  assert.equal(code, 0, stderr);
  const results = events.filter(event => event.type === "tool_execution_end");
  assert.equal(results.length, calls.length, JSON.stringify(events).slice(-8000));
  return results;
}

try {
  assert.ok(["basic", "restart", "restore", "workspace", "artifacts", "http", "all"].includes(selectedCase!), "Unknown hosted case.");
  const install = spawnSync(resolve("node_modules/.bin/pi"), ["install", resolve("packages/pi-orbital")], {
    cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: resolve(directory, "agent"),
      XDG_CONFIG_HOME: configHome, ORBITAL_AUTO_ON: "false" },
    encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
  runs.push({ label: "pi-install", code: install.status, stdout: install.stdout, stderr: install.stderr });
  assert.equal(install.status, 0, install.stderr);
  writeFileSync(resolve(directory, "sentinel.txt"), "HOST_ONLY");
  const results = await runPi("create-command", [
    { name: "orbital", arguments: { action: "create_and_attach" } },
    { name: "bash", arguments: { command: "printf REMOTE_ONLY > sentinel.txt; pwd" } },
    { name: "read", arguments: { path: "sentinel.txt" } },
  ]);
  assert.ok(results.every(result => !result.isError), JSON.stringify(results));
  assert.match(JSON.stringify(results[1]), /\/home\/user/);
  assert.match(JSON.stringify(results[2]), /REMOTE_ONLY/);
  assert.equal(readFileSync(resolve(directory, "sentinel.txt"), "utf8"), "HOST_ONLY");
  const orb = await orbital.inspect({ orbId: orbId! });
  assert.ok(orb);
  resourceId = orb.resourceId;
  checkpoint();
  if (["restart", "restore", "workspace", "http", "all"].includes(selectedCase!)) {
    const selected = await runPi("select-directory", [
      { name: "bash", arguments: { command: "mkdir -p project && printf RESUME_SENTINEL > project/sentinel.txt" } },
      { name: "orbital", arguments: { action: "select_directory", orbCwd: "/home/user/project" } },
    ]);
    assert.ok(selected.every(result => !result.isError), JSON.stringify(selected));
    await waitForSleep("sleep-before-restart");
    const resumed = await runPi("same-session-restart", [
      { name: "read", arguments: { path: "sentinel.txt" } },
      { name: "bash", arguments: { command: "pwd" } },
    ]);
    assert.ok(resumed.every(result => !result.isError), JSON.stringify(resumed));
    assert.match(JSON.stringify(resumed[0]), /RESUME_SENTINEL/);
    assert.match(JSON.stringify(resumed[1]), /\/home\/user\/project/);
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);
    const entries = readFileSync(session, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const bindings = entries.filter(entry => entry.type === "custom" && entry.customType === "orbital.binding");
    assert.ok(bindings.length >= 2);
    assert.deepEqual(bindings.at(-1).data,
      { version: 1, route: "remote", allocation: "attached", orbCwd: "/home/user/project" });
    for (const entry of bindings) assert.equal(entry.data.version, 1);
  }
  if (["workspace", "http", "all"].includes(selectedCase!)) {
    const workspace = await runPi("workspace-tools", [
      { name: "bash", arguments: { command: "git clone -q https://github.com/octocat/Hello-World.git checkout && git -C checkout checkout -q --detach 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" } },
      { name: "read", arguments: { path: "checkout/README" } },
      { name: "edit", arguments: { path: "checkout/README", edits: [{ oldText: "Hello World!", newText: "Hello Orbital!" }] } },
      { name: "bash", arguments: { command: "node -e 'const f=require(\"node:fs\"); if(f.readFileSync(\"checkout/README\",\"utf8\")!==\"Hello Orbital!\\n\") process.exit(1)'" } },
      { name: "write", arguments: { path: "space λ $(literal).txt", content: "CONTEXT_BEFORE\nCHANGED_LINE\nCONTEXT_AFTER\n" } },
      { name: "read", arguments: { path: "space λ $(literal).txt", offset: 2, limit: 1 } },
      { name: "grep", arguments: { pattern: "CHANGED_LINE", path: ".", context: 1 } },
      { name: "find", arguments: { pattern: "*.txt", path: "." } },
      { name: "ls", arguments: { path: "." } },
      { name: "bash", arguments: { command: "cd /tmp && pwd" } },
      { name: "bash", arguments: { command: "pwd; test -z \"${ORBITAL_SECRET_SENTINEL:-}\" && test -z \"${E2B_API_KEY:-}\"" } },
    ]);
    assert.ok(workspace.every(result => !result.isError), JSON.stringify(workspace));
    assert.match(JSON.stringify(workspace[1]), /Hello World!/);
    assert.match(JSON.stringify(workspace[5]), /CHANGED_LINE/);
    assert.doesNotMatch(JSON.stringify(workspace[5]), /CONTEXT_BEFORE/);
    assert.match(JSON.stringify(workspace[6]), /CONTEXT_BEFORE/);
    assert.match(JSON.stringify(workspace[6]), /CONTEXT_AFTER/);
    assert.match(JSON.stringify(workspace[7]), /space λ/);
    assert.match(JSON.stringify(workspace[8]), /checkout/);
    assert.match(JSON.stringify(workspace[10]), /\/home\/user\/project/);
    const invalid = await runPi("invalid-directory", [
      { name: "orbital", arguments: { action: "select_directory", orbCwd: "missing" } },
      { name: "orbital", arguments: { action: "select_directory", orbCwd: "sentinel.txt" } },
      { name: "orbital", arguments: { action: "select_directory", orbCwd: "/root" } },
      { name: "bash", arguments: { command: "pwd" } },
    ]);
    assert.deepEqual(invalid.map(result => result.isError), [true, true, true, false]);
    assert.match(JSON.stringify(invalid[3]), /\/home\/user\/project/);
  }
  if (["artifacts", "http", "all"].includes(selectedCase!)) {
    const artifacts = await runPi("remote-output-and-image", [
      { name: "bash", arguments: { command: "node -e 'for(let i=0;i<8000;i++) console.log(\"LINE_\"+i)'" } },
      { name: "bash", arguments: { command: "node -e 'const f=require(\"node:fs\");f.writeFileSync(\"binary.bin\",Buffer.from([0,255,128,13]));f.writeFileSync(\"pixel.png\",Buffer.from(\"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5eQAAAAASUVORK5CYII=\",\"base64\"))'" } },
      { name: "read", arguments: { path: "pixel.png" } },
    ]);
    assert.ok(artifacts.every(result => !result.isError), JSON.stringify(artifacts).slice(-5000));
    const outputPath = artifacts[0]!.result!.details!.fullOutputPath;
    assert.equal(typeof outputPath, "string");
    assert.match(outputPath as string, /^\/home\/user\/\.orbital\/jobs\//);
    assert.ok(artifacts[2]!.result!.content!.some(content => content.type === "image"));
    const followup = await runPi("read-full-output", [{ name: "read", arguments: { path: outputPath, offset: 7501, limit: 1 } }]);
    assert.equal(followup[0]!.isError, false);
    assert.match(JSON.stringify(followup[0]), /LINE_7500/);
    const workspace = await orbital.openWorkspace({ orbId: orbId!, orbCwd: selectedCase === "artifacts" ? "/home/user" : "/home/user/project" });
    assert.deepEqual(Array.from(await workspace.readFile("binary.bin")), [0, 255, 128, 13]);
  }
  if (["http", "all"].includes(selectedCase!)) {
    console.log(JSON.stringify({ stage: "launch-http-services" }));
    const services = await runPi("launch-two-services", [
      { name: "write", arguments: { path: "services.mjs", content: readFileSync("tests/integration/services.mjs", "utf8") } },
      { name: "bash", arguments: { command: "node services.mjs", mode: "background" } },
      { name: "orbital", arguments: { action: "url", port: 3000 } },
      { name: "orbital", arguments: { action: "url", port: 4000 } },
      { name: "orbital", arguments: { action: "url", port: 4999 } },
    ]);
    assert.ok(services.every(result => !result.isError), JSON.stringify(services));
    const siteUrl = services[2]!.result!.content![0]!.text!;
    const hookUrl = services[3]!.result!.content![0]!.text!;
    const unusedUrl = services[4]!.result!.content![0]!.text!;
    assert.notEqual(siteUrl, hookUrl);
    const awake = await requestHttp("website-awake", siteUrl);
    assert.equal(awake.status, 200);
    assert.match(awake.body, /ORBITAL_WEBSITE_FIXTURE/);
    const unusedAwake = await requestHttp("no-listener-awake", unusedUrl);
    assert.ok(unusedAwake.status >= 400);
    await waitForSleep("services-sleep-with-pi-offline");
    console.log(JSON.stringify({ stage: "http-website-wake" }));
    const website = await requestHttp("website-wakes-existing-orb", siteUrl);
    assert.equal(website.status, 200);
    assert.match(website.body, /ORBITAL_WEBSITE_FIXTURE/);
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);
    await waitForSleep("sleep-after-website-request");
    console.log(JSON.stringify({ stage: "http-webhook-wake" }));
    const webhook = await requestHttp("webhook-wakes-existing-orb", `${hookUrl}/ingest?fixture=1`, {
      method: "POST", headers: { "x-orbital-fixture": "preserved-header", "content-type": "application/octet-stream" },
      body: new Uint8Array([0, 1, 2, 255]),
    });
    assert.equal(webhook.status, 200);
    assert.deepEqual(JSON.parse(webhook.body), { marker: "ORBITAL_WEBHOOK_FIXTURE", method: "POST", url: "/ingest?fixture=1", header: "preserved-header", body: "AAEC/w==" });
    await waitForSleep("sleep-before-unused-port-request");
    const unusedSleeping = await requestHttp("no-listener-sleeping", unusedUrl);
    assert.ok(unusedSleeping.status >= 400);
    runs.push({ label: "state-after-unused-port", orb: await orbital.inspect({ orbId: orbId! }) });
    console.log(JSON.stringify({ stage: "http-stream-characterization" }));
    const stream = await fetch(`${siteUrl}/stream`, { signal: AbortSignal.timeout(420000) });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /STREAM_READY/);
    await waitForSleep("sleep-during-http-stream");
    let streamObservation: string;
    try {
      while (!(await reader.read()).done) { /* Drain bytes retained before sleep. */ }
      streamObservation = "stream ended";
    } catch (error) { streamObservation = error instanceof Error ? error.name : "stream interrupted"; }
    runs.push({ label: "stream-across-sleep", observation: streamObservation });
    const reconnected = await requestHttp("fresh-http-request-after-sleep", siteUrl);
    assert.equal(reconnected.status, 200);
    assert.match(reconnected.body, /ORBITAL_WEBSITE_FIXTURE/);
    const resumed = await runPi("resume-after-offline-webhook", [{ name: "read", arguments: { path: "webhook.json" } }]);
    assert.equal(resumed[0]!.isError, false);
    assert.match(JSON.stringify(resumed[0]), /ORBITAL_WEBHOOK_FIXTURE/);
  }
  if (["restore", "all"].includes(selectedCase!)) {
    const originalSession = readFileSync(session, "utf8");
    const entries = originalSession.trimEnd().split("\n").map(line => JSON.parse(line));
    const corrupt = entries.map(entry => entry.type === "custom" && entry.customType === "orbital.binding"
      ? { ...entry, data: { orbCwd: 5 } } : entry);
    writeFileSync(session, corrupt.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const rejected = await runPi("restore-corrupt-binding", [{ name: "bash", arguments: { command: "printf CHANGED > sentinel.txt" } }]);
    assert.equal(rejected[0]!.isError, true);
    assert.match(JSON.stringify(rejected[0]), /invalid_binding/);
    writeFileSync(session, originalSession);
    const unboundEntries = entries.filter(entry => !(entry.type === "custom" && entry.customType === "orbital.binding"));
    writeFileSync(session, unboundEntries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const unbound = await runPi("restore-no-binding", [{ name: "read", arguments: { path: "sentinel.txt" } }]);
    assert.equal(unbound[0]!.isError, false);
    assert.match(JSON.stringify(unbound[0]), /HOST_ONLY/);
    assert.equal((await orbital.inspect({ orbId: orbId! }))?.resourceId, resourceId);
    writeFileSync(session, originalSession);
    assert.equal(readFileSync(resolve(directory, "sentinel.txt"), "utf8"), "HOST_ONLY");
    const oldResourceId = resourceId;
    const oldUrl = await orbital.url({ orbId: orbId!, port: 3000 });
    const deleted = await runPi("delete-before-restore", [{ name: "orbital", arguments: { action: "delete" } }]);
    assert.equal(deleted[0]!.isError, false);
    assert.equal(await orbital.inspect({ orbId: orbId! }), undefined);
    runs.push({ label: "deleted-first-allocation", resourceId: oldResourceId, missingAfterDelete: true });
    const missing = await runPi("restore-missing-target", [{ name: "read", arguments: { path: "sentinel.txt" } }]);
    assert.equal(missing[0]!.isError, true);
    assert.match(JSON.stringify(missing[0]), /missing/);
    assert.equal(await orbital.inspect({ orbId: orbId! }), undefined);
    const recreated = await runPi("explicit-recreation", [
      { name: "orbital", arguments: { action: "create_and_attach" } },
      { name: "bash", arguments: { command: "printf RECREATED > sentinel.txt" } },
      { name: "read", arguments: { path: "sentinel.txt" } },
    ]);
    assert.ok(recreated.every(result => !result.isError), JSON.stringify(recreated));
    const replacement = await orbital.inspect({ orbId: orbId! });
    assert.ok(replacement);
    resourceId = replacement.resourceId;
    checkpoint();
    assert.notEqual(resourceId, oldResourceId);
    assert.notEqual(await orbital.url({ orbId: orbId!, port: 3000 }), oldUrl);
    assert.match(JSON.stringify(recreated[2]), /RECREATED/);
    assert.equal(readFileSync(resolve(directory, "sentinel.txt"), "utf8"), "HOST_ONLY");
  }
  assert.equal(readFileSync(session, "utf8").includes(process.env.E2B_API_KEY!), false, "Session records must not contain the provider key.");
} catch (error) { failure = error instanceof Error ? error.stack : String(error); }
finally {
  if (orbId) {
    try {
      const orb = await orbital.inspect({ orbId });
      if (orb) { resourceId = orb.resourceId; await provider.delete(orb); }
      cleanup = { deletedResourceId: resourceId, missingAfterDelete: (await orbital.inspect({ orbId })) === undefined };
    } catch (error) { cleanup = { failure: error instanceof Error ? error.message : String(error), resourceId }; }
  }
  rmSync(directory, { recursive: true, force: true });
}
const passed = !failure && !cleanup.failure && cleanup.missingAfterDelete === true;
saveReceipt("hosted-pi", { status: passed ? "passed" : "failed", selectedCase, image, orbId, resourceId, runs, failure, cleanup,
  durationMs: Date.now() - started, real: ["Pi install", "Pi automatic extension discovery", "Pi process", "Orbital extension", "shared library", "E2B SDK", "Orbital image"], substituted: ["model responses"], skips: [] }, receiptDirectory);
process.exitCode = passed ? 0 : 1;

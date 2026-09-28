import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import type { Sandbox as SandboxClass, Template as TemplateClass } from "e2b";

import { saveReceipt } from "../support/receipts.js";
import type { createOrbital as createOrbitalType, createE2BImages as createE2BImagesType,
  createE2BProvider as createE2BProviderType } from "@henriquebastosnet/orbital";
import type { orbitalRecipe as orbitalRecipeType } from "../../packages/orbital/src/hangar/images/recipe.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const runId = randomUUID();
const receiptDirectory = resolve(root, "test-output", `preparation-${runId}`);
const cacheDirectory = join(receiptDirectory, "image-cache");
const orbIds = Object.fromEntries(["base", "one", "two", "refreshed", "failed"]
  .map((name) => [name, `orbital-preparation-${runId}-${name}`])) as Record<"base" | "one" | "two" | "refreshed" | "failed", string>;
const startedAt = Date.now();
const events: Array<Record<string, unknown>> = [];
const apiKey = process.env.E2B_API_KEY;
const packageOnly = process.argv.includes("--package-only");
const preparation = `if [ -n "\${E2B_API_KEY:-}" ]; then echo 'guest key leaked' >&2; exit 34; fi\nprintf '%s\\n' '${runId}' > /home/user/orbital-prepared.txt\nprintf 'prepared:${runId}\\n'`;

type Orbital = ReturnType<typeof createOrbitalType>;
type SandboxApi = typeof SandboxClass;
type Installed = {
  createOrbital: typeof createOrbitalType;
  createE2BImages: typeof createE2BImagesType;
  createE2BProvider: typeof createE2BProviderType;
  orbitalRecipe: typeof orbitalRecipeType;
  Sandbox: SandboxApi;
  Template: typeof TemplateClass;
};

let staging: string | undefined;
let orbital: Orbital | undefined;
let sdk: SandboxApi | undefined;
let templateSdk: typeof TemplateClass | undefined;
let sourceHash: string | undefined;
let packageDigest: string | undefined;
let packageEntry: string | undefined;
let failure: string | undefined;
const cleanup: Record<string, unknown> = { orbs: [], seeds: [], artifacts: [], errors: [] };
const ownedArtifactNames = new Set<string>();

function record(event: string, details: Record<string, unknown> = {}): void {
  const entry = { event, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
    runId, orbIds, cacheDirectory, ...details };
  events.push(entry);
  const descriptor = openSync(join(receiptDirectory, "progress.jsonl"), "a");
  try {
    writeSync(descriptor, `${JSON.stringify(entry)}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  process.stdout.write(`${JSON.stringify({ event, elapsedMs: entry.elapsedMs, ...details })}\n`);
}

function ownArtifact(reference: string): void {
  const colon = reference.lastIndexOf(":");
  const slash = reference.lastIndexOf("/");
  const name = colon > slash ? reference.slice(0, colon) : reference;
  ownedArtifactNames.add(name);
  record("artifact_owned", { reference, name });
}

async function installPackage(): Promise<Installed> {
  staging = await mkdtemp(join(tmpdir(), "orbital-preparation-package-"));
  const packed = await run("npm", ["pack", "--workspace", "@henriquebastosnet/orbital", "--ignore-scripts", "--json", "--pack-destination", staging], {
    cwd: root, maxBuffer: 4 * 1024 * 1024,
  });
  const archive = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  assert.equal(archive.length, 1);
  const paths = new Set(archive[0]!.files.map((file) => file.path));
  for (const path of ["dist/index.js", "dist/hangar/images/recipe.js", "dist/cli/image.js",
    "guest/pod/package.json", "guest/pod/package-lock.json", "guest/pod/orbital-runner.mjs", "guest/pod/renew.mjs"]) {
    assert.ok(paths.has(path), `The package omits ${path}.`);
  }
  const tarball = join(staging, archive[0]!.filename);
  packageDigest = createHash("sha256").update(await readFile(tarball)).digest("hex");
  const prefix = join(staging, "consumer");
  await run("npm", ["install", "--prefix", prefix, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: staging, maxBuffer: 4 * 1024 * 1024,
  });
  const installedRequire = createRequire(join(prefix, "consumer.mjs"));
  packageEntry = installedRequire.resolve("@henriquebastosnet/orbital");
  const packageDirectory = resolve(packageEntry, "../..");
  for (const path of ["pod/package.json", "pod/package-lock.json", "pod/orbital-runner.mjs", "pod/renew.mjs"]) {
    assert.deepEqual(await readFile(join(packageDirectory, "guest", path)),
      await readFile(join(root, "packages/orbital/guest", path)));
  }
  const help = await run(process.execPath, [join(packageDirectory, "dist/cli/image.js"), "--help"], {
    cwd: staging, env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.match(help.stdout, /orbital-image/);
  const installedBin = join(prefix, "node_modules/.bin/orbital-image");
  const binHelp = await run(installedBin, ["--help"], {
    cwd: staging, env: { ...process.env, NODE_OPTIONS: "" },
  });
  assert.match(binHelp.stdout, /orbital-image/);
  const entry = await import(pathToFileURL(packageEntry).href) as Omit<Installed, "Sandbox">;
  const e2bPath = installedRequire.resolve("e2b");
  const { Sandbox, Template } = await import(pathToFileURL(e2bPath).href) as {
    Sandbox: SandboxApi; Template: typeof TemplateClass;
  };
  const recipePath = join(packageDirectory, "dist/hangar/images/recipe.js");
  const { orbitalRecipe } = await import(pathToFileURL(recipePath).href) as { orbitalRecipe: typeof orbitalRecipeType };
  const recipe = await orbitalRecipe();
  sourceHash = recipe.sourceHash;
  record("package_installed", { packageDigest, packageEntry, sourceHash, archiveFiles: paths.size });
  return { createOrbital: entry.createOrbital, createE2BImages: entry.createE2BImages,
    createE2BProvider: entry.createE2BProvider, orbitalRecipe, Sandbox, Template };
}

async function waitForState(orbId: string, expected: "sleeping" | "running"): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if ((await orbital!.inspect({ orbId }))?.state === expected) return;
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`Orb ${orbId} did not enter ${expected} state.`);
}

async function testPreparation(): Promise<void> {
  assert.ok(apiKey, "E2B_API_KEY is required for the hosted preparation test.");
  const installed = await installPackage();
  sdk = installed.Sandbox;
  templateSdk = installed.Template;
  orbital = installed.createOrbital({
    provider: installed.createE2BProvider({ apiKey }),
    images: installed.createE2BImages({ apiKey, cacheDirectory }),
  });
  const progress: string[] = [];
  const observer = { onProgress: (event: { phase: string }) => {
    progress.push(event.phase);
    record("progress", { phase: event.phase });
  } };

  record("cold_default_create_intent", { orbId: orbIds.base });
  const baseOrb = await orbital.create({ orbId: orbIds.base, idleTimeoutMs: 30_000 }, observer);
  assert.ok(progress.includes("building_base"));
  ownArtifact(baseOrb.image);
  record("cold_default_created", { resourceId: baseOrb.resourceId, image: baseOrb.image, progress: [...progress] });
  progress.length = 0;
  const warm = await orbital.prepare({}, observer);
  assert.equal(warm.reused, true);
  assert.equal(warm.reference, baseOrb.image);
  record("warm_default_ready", { ...warm, progress: [...progress] });

  const output: string[] = [];
  progress.length = 0;
  const prepared = await orbital.prepare({ preparation }, {
    ...observer, onOutput: (chunk) => output.push(chunk),
  });
  assert.equal(prepared.reused, false);
  assert.notEqual(prepared.reference, baseOrb.image);
  assert.match(output.join(""), new RegExp(`prepared:${runId}`));
  ownArtifact(prepared.reference);
  record("script_ready", { ...prepared, progress: [...progress], output: output.join("") });

  record("allocation_intent", { orbIds: [orbIds.one, orbIds.two] });
  const one = await orbital.create({ orbId: orbIds.one, preparation, idleTimeoutMs: 30_000 });
  const two = await orbital.create({ orbId: orbIds.two, preparation, idleTimeoutMs: 30_000 });
  assert.equal(one.image, prepared.reference);
  assert.equal(two.image, prepared.reference);
  assert.notEqual(one.resourceId, two.resourceId);
  const oneWorkspace = await orbital.openWorkspace({ orbId: one.orbId, orbCwd: "/home/user" });
  const twoWorkspace = await orbital.openWorkspace({ orbId: two.orbId, orbCwd: "/home/user" });
  assert.equal(Buffer.from(await oneWorkspace.readFile("orbital-prepared.txt")).toString().trim(), runId);
  assert.equal(Buffer.from(await twoWorkspace.readFile("orbital-prepared.txt")).toString().trim(), runId);
  await oneWorkspace.writeFile("isolation.txt", Buffer.from("one"));
  await assert.rejects(twoWorkspace.readFile("isolation.txt"));
  record("cache_hit_allocations_isolated", { one: one.resourceId, two: two.resourceId });

  const refreshed = await orbital.prepare({ preparation, refresh: true }, observer);
  assert.equal(refreshed.reused, false);
  assert.notEqual(refreshed.reference, prepared.reference);
  ownArtifact(refreshed.reference);
  const repeat = await orbital.create({ orbId: one.orbId, preparation, idleTimeoutMs: 30_000 });
  assert.equal(repeat.resourceId, one.resourceId);
  record("refresh_preserved_existing_orb", { oldReference: prepared.reference,
    newReference: refreshed.reference, resourceId: repeat.resourceId });
  record("allocation_intent", { orbIds: [orbIds.refreshed] });
  const fresh = await orbital.create({ orbId: orbIds.refreshed, preparation, idleTimeoutMs: 5_000 });
  assert.equal(fresh.image, refreshed.reference);

  const workspace = await orbital.openWorkspace({ orbId: fresh.orbId, orbCwd: "/home/user" });
  const long = await workspace.exec({ command: "sleep 8; printf 'renewed\\n'", timeoutMs: 20_000 });
  assert.equal(long.kind, "exited");
  assert.equal(long.exitCode, 0);
  assert.match(long.stdout, /renewed/);
  record("long_execution_renewed", { resourceId: fresh.resourceId, jobId: long.jobId });

  assert.equal(await sdk.pause(fresh.resourceId, { apiKey }), true);
  await waitForState(fresh.orbId, "sleeping");
  const woken = await orbital.openWorkspace({ orbId: fresh.orbId, orbCwd: "/home/user" });
  const wakeResult = await woken.exec({ command: "printf 'awake\\n'" });
  assert.equal(wakeResult.exitCode, 0);
  assert.match(wakeResult.stdout, /awake/);
  record("pause_and_wake", { resourceId: fresh.resourceId, jobId: wakeResult.jobId });

  const runnerCancellation = new AbortController();
  let runnerStarted = false;
  const runnerAbortTimer = setTimeout(() => runnerCancellation.abort(), 15_000);
  try {
    const cancelled = await woken.exec({ command: "printf 'runner started\\n'; sleep 20", timeoutMs: 25_000 }, {
      signal: runnerCancellation.signal,
      onOutput: (chunk) => {
        if (chunk.includes("runner started")) {
          runnerStarted = true;
          runnerCancellation.abort();
        }
      },
    });
    assert.equal(runnerStarted, true);
    assert.equal(cancelled.kind, "cancelled");
    record("runner_cancelled", { resourceId: fresh.resourceId, jobId: cancelled.jobId,
      kind: cancelled.kind, outputPath: cancelled.outputPath });
  } finally { clearTimeout(runnerAbortTimer); }

  record("allocation_intent", { orbIds: [orbIds.failed] });
  await assert.rejects(orbital.create({ orbId: orbIds.failed, preparation: "exit 23", idleTimeoutMs: 30_000 }),
    (cause: unknown) => {
      const error = cause as { code?: string; outcome?: string; evidence?: Record<string, unknown> };
      record("script_rejected", { code: error.code, outcome: error.outcome, evidence: error.evidence });
      return error.code === "script_failed" && error.outcome === "failed";
    });
  assert.equal(await orbital.inspect({ orbId: orbIds.failed }), undefined);
  record("failed_script_no_allocation");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(orbital.prepare({ preparation: "sleep 20" }, { signal: controller.signal }),
    (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "cancelled");
  record("cancelled_before_submission");

  const inFlight = new AbortController();
  let outputSeen = false;
  const abortTimer = setTimeout(() => inFlight.abort(), 15_000);
  try {
    await assert.rejects(orbital.prepare({ preparation: "printf 'cancel marker\\n'; sleep 20" }, {
      signal: inFlight.signal,
      onOutput: (chunk) => {
        if (chunk.includes("cancel marker")) {
          outputSeen = true;
          inFlight.abort();
        }
      },
    }), (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "script_cancelled");
  } finally {
    clearTimeout(abortTimer);
  }
  assert.equal(outputSeen, true);
  record("cancelled_running_script");
}

async function cacheRecords(): Promise<Array<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let paths: string[];
  try { paths = await readdir(cacheDirectory, { recursive: true }); }
  catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  for (const path of paths) {
    if (!path.endsWith(".json")) continue;
    records.push(JSON.parse(await readFile(join(cacheDirectory, path), "utf8")) as Record<string, unknown>);
  }
  return records;
}

async function cleanupRemote(): Promise<void> {
  if (!apiKey || !sdk) return;
  for (const orbId of Object.values(orbIds)) {
    try {
      const orb = await orbital!.inspect({ orbId });
      if (orb) {
        record("delete_orb_intent", { orbId, resourceId: orb.resourceId });
        await orbital!.delete({ orbId });
        (cleanup.orbs as string[]).push(orb.resourceId);
      }
      assert.equal(await orbital!.inspect({ orbId }), undefined);
    } catch (cause) {
      (cleanup.errors as string[]).push(`orb ${orbId}: ${String(cause)}`);
    }
  }
  const records = await cacheRecords();
  const seeds = new Set<string>();
  const attemptIds = new Set<string>();
  const artifacts = new Set(ownedArtifactNames);
  const intentNames = new Set<string>();
  for (const record of records) {
    if (typeof record.attemptId === "string") attemptIds.add(record.attemptId);
    if (typeof record.seedId === "string") seeds.add(record.seedId);
    if (typeof record.generationName === "string") intentNames.add(record.generationName);
    for (const field of ["artifact", "base"] as const) {
      const item = record[field];
      if (item && typeof item === "object" && "reference" in item && typeof item.reference === "string") {
        const colon = item.reference.lastIndexOf(":");
        const slash = item.reference.lastIndexOf("/");
        artifacts.add(colon > slash ? item.reference.slice(0, colon) : item.reference);
      }
    }
  }
  for (const attemptId of attemptIds) {
    try {
      const listed = sdk.list({ apiKey, query: { metadata: { orbital_v2_preparation_attempt: attemptId },
        state: ["running", "paused"] } });
      while (listed.hasNext) {
        for (const seed of await listed.nextItems()) seeds.add(seed.sandboxId);
      }
    } catch (cause) { (cleanup.errors as string[]).push(`seed lookup ${attemptId}: ${String(cause)}`); }
  }
  for (const seedId of seeds) {
    try {
      record("delete_seed_intent", { seedId });
      await sdk.kill(seedId, { apiKey });
      (cleanup.seeds as string[]).push(seedId);
    } catch (cause) { (cleanup.errors as string[]).push(`seed ${seedId}: ${String(cause)}`); }
  }
  for (const attemptId of attemptIds) {
    try {
      const listed = sdk.list({ apiKey, query: { metadata: { orbital_v2_preparation_attempt: attemptId },
        state: ["running", "paused"] } });
      const remaining: string[] = [];
      while (listed.hasNext) remaining.push(...(await listed.nextItems()).map((seed) => seed.sandboxId));
      assert.deepEqual(remaining, []);
    } catch (cause) { (cleanup.errors as string[]).push(`seed verification ${attemptId}: ${String(cause)}`); }
  }
  for (const name of new Set([...artifacts, ...intentNames])) {
    try {
      record("delete_artifact_intent", { name, expected: artifacts.has(name) });
      const deleted = await sdk.deleteSnapshot(name, { apiKey });
      if (artifacts.has(name)) assert.equal(deleted, true, `Artifact ${name} was not deleted.`);
      (cleanup.artifacts as string[]).push(name);
      try {
        const tags = await templateSdk!.getTags(name, { apiKey });
        assert.deepEqual(tags, []);
      } catch (cause) {
        if (!(cause instanceof Error && "statusCode" in cause && cause.statusCode === 404)) throw cause;
      }
    } catch (cause) { (cleanup.errors as string[]).push(`artifact ${name}: ${String(cause)}`); }
  }
  record("cleanup", { ...cleanup, cacheRecords: records.length });
}

try {
  await mkdir(receiptDirectory, { recursive: true });
  record("start", { packageOnly, sourceRoot: root });
  if (packageOnly) await installPackage();
  else await testPreparation();
} catch (cause) {
  failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  const error = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
  record("failed", { failure, code: error.code, outcome: error.outcome, evidence: error.evidence });
  process.exitCode = 1;
} finally {
  try { await cleanupRemote(); }
  catch (cause) {
    (cleanup.errors as string[]).push(`cleanup: ${String(cause)}`);
    process.exitCode = 1;
  }
  if ((cleanup.errors as string[]).length) process.exitCode = 1;
  if (staging) await rm(staging, { recursive: true, force: true });
  saveReceipt("hosted-preparation", { status: process.exitCode ? "failed" : packageOnly ? "package_only" : "passed", runId,
    durationMs: Date.now() - startedAt, packageDigest, packageEntry, testedSourceHash: sourceHash,
    events, failure, cleanup, cacheDirectory, skips: packageOnly ? ["hosted image operations"] : [] }, receiptDirectory);
}

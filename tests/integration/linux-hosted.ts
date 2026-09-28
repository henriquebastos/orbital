import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createE2BProvider, OrbitalError, type OrbSnapshot } from "@henriquebastosnet/orbital";
import { saveReceipt } from "../support/receipts.js";
import { hostedConfiguration } from "../support/hosted-configuration.js";

const { apiKey, image } = await hostedConfiguration(process.argv[2]);

const startedAt = Date.now();
const runId = randomUUID();
const orbId = `orbital-v2-adapter-test-${runId}`;
const outputDirectory = resolve(import.meta.dirname, "../../test-output/e2b");
const receiptPath = resolve(outputDirectory, `${runId}.jsonl`);
const provider = createE2BProvider({ apiKey });
const events: Array<Record<string, unknown>> = [];
let owned: OrbSnapshot | undefined;
let createSubmitted = false;
let failure: string | undefined;
let cleanup: Record<string, unknown> = {};

async function findSubmittedOrb(): Promise<OrbSnapshot | undefined> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  do {
    try {
      const found = await provider.resolve(orbId);
      if (found) return found;
      lastError = undefined;
    } catch (cause) {
      lastError = cause;
    }
    if (Date.now() >= deadline) break;
    await new Promise((done) => setTimeout(done, 2_000));
  } while (true);
  if (lastError) throw lastError;
  return undefined;
}

function record(event: string, details: Record<string, unknown> = {}): void {
  events.push({ event, at: new Date().toISOString(), runId, ...details });
}

async function main(): Promise<void> {
  record("start", { image, orbId, e2bSdk: "2.51.0" });
  try {
    assert.equal(await provider.resolve(orbId), undefined);
    createSubmitted = true;
    owned = await provider.create({ orbId, image, idleTimeoutMs: 30_000 });
    record("created", { resourceId: owned.resourceId, state: owned.state,
      sandboxDomain: owned.sandboxDomain });
    assert.equal(owned.orbId, orbId);
    assert.equal(owned.image, image);
    assert.equal((await provider.resolve(orbId))?.resourceId, owned.resourceId);
    const repeated = await provider.create({ orbId, image, idleTimeoutMs: 30_000 });
    assert.equal(repeated.resourceId, owned.resourceId);
    await assert.rejects(
      provider.create({ orbId, image: "base", idleTimeoutMs: 30_000 }),
      (cause) => cause instanceof OrbitalError && cause.code === "orb_conflict" && cause.outcome === "not_started",
    );
    record("identity_policy_passed", { resourceId: owned.resourceId });

    const outputChunks: string[] = [];
    const result = await provider.exec(owned, {
      command: "printf 'orbital-live-out\\n'; printf 'orbital-live-err\\n' >&2; printf 'orbital-file' > /home/user/orbital-live.txt",
      orbCwd: "/home/user",
    }, { onOutput: (chunk) => outputChunks.push(chunk) });
    record("executed", { jobId: result.jobId, kind: result.kind, exitCode: result.exitCode,
      outputPath: result.outputPath, observedChunks: outputChunks.length });
    assert.equal(result.kind, "exited");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /orbital-live-out/);
    assert.match(result.stderr, /orbital-live-err/);
    assert.equal(new TextDecoder().decode(await provider.readFile(owned, "/home/user/orbital-live.txt")), "orbital-file");
    const combined = new TextDecoder().decode(await provider.readFile(owned, result.outputPath));
    assert.match(combined, /orbital-live-out/);
    assert.match(combined, /orbital-live-err/);
    assert.match(outputChunks.join(""), /orbital-live-out/);
    assert.match(provider.url(owned, 8080), /^https:\/\/8080-/);
    const linuxSuite = await readFile(resolve("packages/pod/tests/runner.test.mjs"));
    await provider.writeFile(owned, "/tmp/orbital-runner.test.mjs", linuxSuite);
    const linuxResult = await provider.exec(owned, {
      command: "ORBITAL_RUNNER_PATH=/opt/orbital/pod/orbital-runner.mjs node --test /tmp/orbital-runner.test.mjs",
      orbCwd: "/home/user",
      timeoutMs: 30_000,
    });
    await mkdir(outputDirectory, { recursive: true });
    const localOutputPath = resolve(outputDirectory, `${runId}-linux.tap`);
    await writeFile(localOutputPath, linuxResult.stdout + linuxResult.stderr);
    record("linux_suite", { jobId: linuxResult.jobId, kind: linuxResult.kind,
      exitCode: linuxResult.exitCode, outputPath: linuxResult.outputPath, localOutputPath,
      summary: linuxResult.stdout.split("\n").filter((line) => /^# (tests|pass|fail) /.test(line)) });
    assert.equal(linuxResult.exitCode, 0);
    assert.match(linuxResult.stdout, /pass 14/);
    assert.match(linuxResult.stdout, /fail 0/);
    assert.match(linuxResult.stdout, /skipped 0/);
    record("assertions_passed", { resourceId: owned.resourceId });
  } catch (cause) {
    failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    record("failed", { errorType: cause instanceof Error ? cause.name : "unknown",
      errorCode: cause && typeof cause === "object" && "code" in cause ? cause.code : undefined,
      evidence: cause instanceof OrbitalError ? cause.evidence : undefined });
    process.exitCode = 1;
  } finally {
    try {
      if (!owned && createSubmitted) owned = await findSubmittedOrb();
      if (owned) {
        await provider.delete(owned);
        record("deleted", { resourceId: owned.resourceId });
      }
      const remaining = await provider.resolve(orbId);
      record("cleanup_verified", { remainingResourceId: remaining?.resourceId ?? null });
      assert.equal(remaining, undefined);
      const admissionUncertain = createSubmitted && !owned;
      cleanup = { verified: !admissionUncertain, resourceId: owned?.resourceId ?? null,
        admissionUncertain, noMatchWithinMs: admissionUncertain ? 30_000 : undefined };
      if (admissionUncertain) process.exitCode = 1;
    } catch (cause) {
      record("cleanup_failed", { errorType: cause instanceof Error ? cause.name : "unknown" });
      cleanup = { verified: false, resourceId: owned?.resourceId ?? null,
        error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
      process.exitCode = 1;
    }
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(receiptPath, events.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    saveReceipt("hosted-e2b", { status: process.exitCode === 1 ? "failed" : "passed", runId,
      image, orbId, resourceId: owned?.resourceId ?? null, durationMs: Date.now() - startedAt,
      failure, cleanup, detailedReceipt: receiptPath,
      assertions: events.filter((entry) => entry.event === "assertions_passed" || entry.event === "linux_suite"),
      skips: [] });
  }
}

await main();

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { access, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const jobsDir = process.env.ORBITAL_JOBS_DIR ?? "/home/user/.orbital/jobs";
const jobId = process.argv[3];
const action = process.argv[2];
if (!["run", "cancel"].includes(action) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(jobId ?? "")) {
  console.error("Usage: orbital-runner <run|cancel> <job-uuid>");
  process.exit(2);
}

const jobDir = join(jobsDir, jobId);
const statusPath = join(jobDir, "status.json");
const cancelPath = join(jobDir, "cancel");
let activeProcessGroupId;
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Receipt publication. Rename gives atomic visibility, not fsync durability.
async function writeStatusReceipt(value) {
  const tempPath = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value));
  await rename(tempPath, statusPath);
}

// Receipt shapes, one constructor per existing branch. Each keeps its literal and spread order.
// The shapes differ on purpose: early failures and cancellation omit process fields, and the
// active renewal failure omits phase. These constructors perform no I/O.
const cancelledBeforeSpawnReceipt = () => ({ state: "finished", jobId, outcome: "cancelled", scopeStopped: true });
const preflightRenewalFailureReceipt = (renewalFailure) => ({ state: "finished", jobId, outcome: "failed", phase: "pre_execution",
  errorCode: "renewal_failed", error: "Renewal failed.", scopeStopped: true,
  renewal: renewalFailure ?? { category: "configuration", attempt: 0, durationMs: 0, lastSuccessAt: null } });
const startedProcessReceipt = (mode, pid) => ({ state: "started", jobId, mode, pid, pgid: pid });
const finishedSupervisedReceipt = (startedReceipt, outcome, scopeStopped, shellExit, failure) =>
  ({ ...startedReceipt, state: "finished", outcome, scopeStopped, ...shellExit, ...failure });
// The generic failure path carries error.message. It is outside the renewal privacy boundary below.
const unhandledRunFailureReceipt = (error, scopeStopped, groupRecorded) => ({ state: "finished", jobId, outcome: "failed",
  error: error.message, scopeStopped, ...(groupRecorded ? { phase: "execution" } : { phase: "pre_execution" }) });
const outputWriteFailureFields = () => ({ phase: "execution", errorCode: "output_write_failed", error: "Output capture failed." });
const activeRenewalFailureFields = (renewalFailure) => ({ errorCode: "renewal_failed", error: "Renewal failed.", renewal: renewalFailure });

// Renewal-only sanitization. Only renewal evidence passes through this allowlist; generic run
// errors and command output do not. Status resolution comes first, then ordered category selection.
function safeRenewalErrorDetails(cause) {
  // Exception messages, stacks, headers, and arbitrary codes can contain credentials.
  const knownStatus = { AuthenticationError: 401, RateLimitError: 429,
    ServiceBusyError: 503, SandboxNotFoundError: 404 };
  const reportedStatus = cause?.statusCode;
  const httpStatus = Number.isInteger(reportedStatus) && reportedStatus >= 100 && reportedStatus <= 599
    ? reportedStatus : Object.hasOwn(knownStatus, cause?.name) ? knownStatus[cause.name] : undefined;
  const codes = [cause?.code, cause?.cause?.code];

  let category = "unknown";
  if (cause?.name === "TimeoutError" || httpStatus === 408 || httpStatus === 504 ||
      codes.some(code => ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code))) {
    category = "timeout";
  } else if (cause?.name === "AbortError") category = "aborted";
  else if (httpStatus === 401 || httpStatus === 403) category = "authentication";
  else if (httpStatus === 429) category = "rate_limit";
  else if (httpStatus === 404) category = "not_found";
  else if (httpStatus >= 500) category = "unavailable";
  else if (httpStatus !== undefined) category = "http";
  else if (codes.some(code => ["ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET"].includes(code))) {
    category = "network";
  }
  return { category, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

function writeAll(fd, chunk) {
  for (let offset = 0; offset < chunk.length;) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

// The managed scope is one process group. Escaped processes are outside it.
async function hasLiveProcessGroupMembers(pgid) {
  if (await exists("/proc/self/stat")) {
    for (const entry of await readdir("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
        // Fields after the last ")" start with state, ppid, pgrp.
        const [processState, , processGroupId] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(processGroupId) === pgid && processState !== "Z") return true;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return false;
  }
  const listing = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  return listing.split("\n").some((line) => {
    const [processGroupId, processState] = line.trim().split(/\s+/);
    return Number(processGroupId) === pgid && processState !== undefined && !processState.startsWith("Z");
  });
}

function signalProcessGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopProcessGroup(pgid) {
  signalProcessGroup(pgid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await hasLiveProcessGroupMembers(pgid))) return true;
    await pause(50);
  }
  signalProcessGroup(pgid, "SIGKILL");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await hasLiveProcessGroupMembers(pgid))) return true;
    await pause(50);
  }
  return !(await hasLiveProcessGroupMembers(pgid));
}

// Cancellation contract: the request file must exist, a finished status prevents marker
// creation, and marker publication is a request, not shutdown acknowledgement. Cancel never waits.
async function requestCancellation() {
  await access(join(jobDir, "request.json"));
  if (await exists(statusPath)) {
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    if (current.state === "finished") return;
  }
  await writeFile(cancelPath, "", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

// Direct runner admission. The caller validates the other request fields more strictly.
function validateRunnerAdmission(request) {
  if (request.version !== 1 || !["ordinary", "background"].includes(request.mode)
      || typeof request.command !== "string" || typeof request.cwd !== "string"
      || !Number.isSafeInteger(request.idleTimeoutMs) || request.idleTimeoutMs < 3) {
    throw new Error("Invalid job request.");
  }
}

// Launch once per fresh job. Repeated runs can truncate output and execute again.
// Ordinary jobs renew the lease, enforce an optional execution timeout, and clean the group on normal shell exit.
// Background jobs do none of those. idleTimeoutMs is the lease window.
// executionTimeoutMs separately bounds ordinary execution, regardless of command activity.
async function runJob() {
  // Stage 1: read and admit the request.
  const request = JSON.parse(await readFile(join(jobDir, "request.json"), "utf8"));
  validateRunnerAdmission(request);
  // Both modes share the launch and output lifecycle. Only ordinary mode renews, enforces the
  // execution timeout, and cleans descendants on normal exit. The mode checks stay inline below.
  const leaseWindowMs = request.idleTimeoutMs;

  // Stage 2: open and truncate output, then check for an early cancellation marker.
  const stdout = await open(join(jobDir, "stdout"), "w", 0o600);
  const stderr = await open(join(jobDir, "stderr"), "w", 0o600);
  const combined = await open(join(jobDir, "combined"), "w", 0o600);
  if (await exists(cancelPath)) {
    await writeStatusReceipt(cancelledBeforeSpawnReceipt());
    await stdout.close();
    await stderr.close();
    await combined.close();
    return;
  }
  // Command overrides do not affect renewal, which uses the runner's process.env.
  // The child still inherits the runner's key unless the request overrides that name.
  const commandEnvironment = { ...process.env, ...request.env };

  // Renewal attempt and evidence tracking.
  let renew;
  let renewalAttempts = 0;
  let lastRenewalSuccessAt = null;
  let renewalFailure;
  async function renewLease(signal) {
    const attemptStartedAt = performance.now();
    renewalAttempts++;
    try {
      await renew({ sandboxId: request.sandboxId, apiKey: process.env.E2B_API_KEY,
        windowMs: leaseWindowMs, signal });
      lastRenewalSuccessAt = new Date().toISOString();
    } catch (cause) {
      renewalFailure = { ...safeRenewalErrorDetails(cause), attempt: renewalAttempts,
        durationMs: Math.round(performance.now() - attemptStartedAt), lastSuccessAt: lastRenewalSuccessAt };
      throw cause;
    }
  }
  // Stage 3: ordinary preflight renewal gate, then a second cancellation check.
  // Preflight renewal is awaited and has no runner-side cancellation deadline.
  if (request.mode === "ordinary") {
    try {
      if (!process.env.E2B_API_KEY) throw new Error("Renewal key is missing.");
      ({ renew } = await import(process.env.ORBITAL_RENEW_MODULE ?? "./renew.mjs"));
      await renewLease();
    } catch {
      await writeStatusReceipt(preflightRenewalFailureReceipt(renewalFailure));
      await stdout.close();
      await stderr.close();
      await combined.close();
      return;
    }
  }
  if (await exists(cancelPath)) {
    await writeStatusReceipt(cancelledBeforeSpawnReceipt());
    await stdout.close();
    await stderr.close();
    await combined.close();
    return;
  }
  // Stage 4: spawn the detached shell and publish the started receipt.
  const child = spawn("/bin/bash", ["-lc", request.command], {
    cwd: request.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: commandEnvironment,
  });
  try {
    let outputError;
    // Each chunk is fully written to its stream file, then to combined. Combined order is the
    // callback observation order, with no causal ordering across streams.
    const appendObservedOutputChunk = (chunk, stream) => {
      if (outputError) return;
      try {
        writeAll(stream.fd, chunk);
        writeAll(combined.fd, chunk);
      } catch (error) {
        outputError = error;
      }
    };
    child.stdout.on("data", (chunk) => {
      appendObservedOutputChunk(chunk, stdout);
    });
    child.stderr.on("data", (chunk) => {
      appendObservedOutputChunk(chunk, stderr);
    });
    // Shell exit ends supervision. Wait separately for stream closure before the final receipt.
    const outputStreamsClosed = new Promise((resolveClose) => child.once("close", resolveClose));
    let shellExit;
    child.once("exit", (exitCode, signal) => { shellExit = { exitCode, signal }; });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    activeProcessGroupId = child.pid;
    const startedReceipt = startedProcessReceipt(request.mode, child.pid);
    await writeStatusReceipt(startedReceipt);
    // Stage 5: supervise until shell exit or a selected stop outcome.
    // The execution clock starts after the started receipt, separate from the renewal attempt clock.
    const executionStartedAt = performance.now();
    const executionTimeoutMs = request.executionTimeoutMs;
    // Periodic renewal scheduling. The override is capped by the lease window and not validated.
    const renewalIntervalMs = Math.min(
      Number(process.env.ORBITAL_RENEW_INTERVAL_MS ?? Math.floor(leaseWindowMs / 3)),
      Math.floor(leaseWindowMs / 3),
    );
    let nextRenewalAt = executionStartedAt + renewalIntervalMs;
    // Completed means shell completion, not a zero exit code.
    let outcome = "completed";
    // scopeStopped is a receipt value. Normal background completion keeps this default without
    // checking or stopping descendants. Stop paths replace it with the observed termination result.
    let scopeStopped = true;
    let failure;
    let renewalInFlight = false;
    let periodicRenewalFailureObserved = false;
    let periodicRenewalAbortController;
    while (!shellExit) {
      if (outputError) {
        outcome = "failed";
        failure = outputWriteFailureFields();
        scopeStopped = await stopProcessGroup(child.pid);
        break;
      }
      if (await exists(cancelPath)) {
        outcome = "cancelled";
        scopeStopped = await stopProcessGroup(child.pid);
        break;
      }
      if (request.mode === "ordinary" && executionTimeoutMs !== undefined
          && performance.now() - executionStartedAt >= executionTimeoutMs) {
        outcome = "timed_out";
        scopeStopped = await stopProcessGroup(child.pid);
        break;
      }
      if (periodicRenewalFailureObserved) {
        outcome = "failed";
        failure = activeRenewalFailureFields(renewalFailure);
        scopeStopped = await stopProcessGroup(child.pid);
        break;
      }
      if (request.mode === "ordinary" && !renewalInFlight && performance.now() >= nextRenewalAt) {
        renewalInFlight = true;
        periodicRenewalAbortController = new AbortController();
        // Periodic renewal is nonblocking, with at most one request in flight. Rejection only sets
        // the flag. The next eligible supervision poll selects the outcome, unless shell exit comes first.
        Promise.resolve().then(() => renewLease(periodicRenewalAbortController.signal))
          .catch(() => { periodicRenewalFailureObserved = true; })
          .finally(() => { renewalInFlight = false; });
        nextRenewalAt = performance.now() + renewalIntervalMs;
      }
      await pause(20);
    }
    // Stage 6: abort any in-flight renewal without joining it, then clean the group when applicable.
    // Cancellation and timeout polling have ended with the loop.
    periodicRenewalAbortController?.abort();
    if (request.mode === "ordinary" && outcome === "completed" && await hasLiveProcessGroupMembers(child.pid)) {
      scopeStopped = await stopProcessGroup(child.pid);
    }
    // Stage 7: wait for stream closure, close output, and publish completion.
    await outputStreamsClosed;
    if (outputError && outcome === "completed") {
      outcome = "failed";
      failure = outputWriteFailureFields();
      scopeStopped = await stopProcessGroup(child.pid);
    }
    await stdout.close();
    await stderr.close();
    await combined.close();
    await writeStatusReceipt(finishedSupervisedReceipt(startedReceipt, outcome, scopeStopped, shellExit, failure));
    activeProcessGroupId = undefined;
  } finally {
    // Receipt-existence-conditioned cleanup: a started or stale receipt suppresses this fallback.
    // It is not an unconditional output-handle finalizer.
    if (!(await exists(statusPath))) {
      await stdout.close().catch(() => undefined);
      await stderr.close().catch(() => undefined);
      await combined.close().catch(() => undefined);
    }
  }
}

// Receipts describe job outcomes. Runner exit status does not indicate command success.
const operation = action === "run" ? runJob : requestCancellation;
operation().catch(async (error) => {
  if (action !== "run") {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let scopeStopped = activeProcessGroupId === undefined;
  if (activeProcessGroupId !== undefined) {
    try { scopeStopped = await stopProcessGroup(activeProcessGroupId); } catch { scopeStopped = false; }
  }
  try {
    // Phase is inferred from whether the group ID was recorded, not from the started receipt.
    await writeStatusReceipt(unhandledRunFailureReceipt(error, scopeStopped, activeProcessGroupId !== undefined));
  } catch {
    console.error("Failed to write the job receipt.");
  }
  process.exitCode = 1;
});

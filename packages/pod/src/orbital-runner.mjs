#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { access, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Pod is the guest runtime inside an Orb, which is an E2B sandbox (its sandboxId) with Pod installed.
// This runner executes one shell job inside the Orb, independent of the client connection that requested it.
// Protocol: the caller publishes <job>/request.json, then launches `orbital-runner run <id>` once.
// The runner writes stdout, stderr, and combined, publishes status.json receipts, and watches the
// `cancel` marker. `orbital-runner cancel <id>` publishes that marker or stops a surviving service.

const jobsDir = process.env.ORBITAL_JOBS_DIR ?? "/home/user/.orbital/jobs";
const jobId = process.argv[3];
const action = process.argv[2];
if (!["run", "cancel"].includes(action) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(jobId ?? "")) {
  console.error("Usage: orbital-runner <run|cancel> <job-uuid>");
  process.exit(2);
}

const jobDir = join(jobsDir, jobId);
const requestPath = join(jobDir, "request.json");
const statusPath = join(jobDir, "status.json");
const cancelPath = join(jobDir, "cancel");
// Supervision poll period, and the bound on waiting for output pipes before the finished receipt.
const supervisionPollMs = 20;
const outputDrainMs = 1000;
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

const cancellationRequested = () => exists(cancelPath);

// 1. Receipts.

// Receipt publication. Rename gives atomic visibility, not fsync durability.
async function writeStatusReceipt(value) {
  const tempPath = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value));
  await rename(tempPath, statusPath);
}

// Every finished receipt has this one shape. Unknown fields are null, never omitted.
// "finished" means the outcome is final. The shell may never have started, a stop may have failed
// (scopeStopped false), survivors may still run, and capture may still grow.
// outcome "exited" means the shell exited on its own, with any exit code or signal.
// scopeStopped records an observation of the process group, not an action.
function finishedReceipt({ mode, outcome, scopeStopped, phase, pid = null, exitCode = null, signal = null,
  errorCode = null, error = null, renewal = null }) {
  return { state: "finished", jobId, mode, pid, pgid: pid, outcome, scopeStopped,
    exitCode, signal, phase, errorCode, error, renewal };
}
const startedReceipt = (mode, pid) => ({ state: "started", jobId, mode, pid, pgid: pid });
const outputFailureFields = () => ({ errorCode: "output_write_failed", error: "Output capture failed." });

// 2. Process group scope.

// The managed scope is one process group. Escaped processes are outside it. Zombies do not count.
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

// SIGTERM, then SIGKILL, each followed by up to twenty 50 ms checks. Returns the final observation.
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

// 3. Lease renewal.

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

// The periodic cadence target is at most a third of the lease window. An override can shorten it.
// Invalid overrides (not a number, zero, negative) are ignored. A slow request stretches real spacing.
function renewalIntervalMs(leaseWindowMs) {
  const cap = Math.floor(leaseWindowMs / 3);
  const override = Number(process.env.ORBITAL_RENEW_INTERVAL_MS);
  return Number.isFinite(override) && override > 0 ? Math.min(override, cap) : cap;
}

// One job's renewal: the adapter, attempt count, last success, and sanitized evidence of the
// last failure. Renewal always uses the runner's own E2B_API_KEY, never a command override.
//
// Two separate things describe renewal trouble: evidence.lastFailure is the sanitized record of the
// last failed attempt, and periodic.failureObserved makes a periodic failure eligible for outcome
// selection. A configuration failure (missing key, import, or export) never attempts a request, so
// its receipt uses the attempt-zero fallback below instead of evidence.
const renewalFailureFields = (lastFailure) => ({ errorCode: "renewal_failed", error: "Renewal failed.",
  renewal: lastFailure ?? { category: "configuration", attempt: 0, durationMs: 0, lastSuccessAt: null } });

function createLeaseRenewal(request) {
  let renew;
  let attempts = 0;
  let lastSuccessAt = null;
  const evidence = { lastFailure: undefined };
  async function renewLease(signal) {
    const attemptStartedAt = performance.now();
    attempts++;
    try {
      await renew({ sandboxId: request.sandboxId, apiKey: process.env.E2B_API_KEY,
        windowMs: request.leaseWindowMs, signal });
      lastSuccessAt = new Date().toISOString();
    } catch (cause) {
      evidence.lastFailure = { ...safeRenewalErrorDetails(cause), attempt: attempts,
        durationMs: Math.round(performance.now() - attemptStartedAt), lastSuccessAt };
      throw cause;
    }
  }
  // Preflight: load the adapter and renew once. The cancellation marker can interrupt the renewal
  // wait, not the local import. Returns "renewed", "failed", or "cancelled". A missing key, a
  // failed import, or a module without a renew function is a configuration failure (attempt 0).
  async function preflight() {
    try {
      if (!process.env.E2B_API_KEY) throw new Error("Renewal key is missing.");
      ({ renew } = await import(process.env.ORBITAL_RENEW_MODULE ?? "./renew.mjs"));
      if (typeof renew !== "function") throw new Error("The renewal module has no renew function.");
    } catch {
      return "failed";
    }
    const abort = new AbortController();
    let settled;
    const attempt = renewLease(abort.signal).then(() => { settled = "renewed"; }, () => { settled = "failed"; });
    while (settled === undefined) {
      if (await cancellationRequested()) {
        abort.abort();
        attempt.catch(() => undefined);
        return "cancelled";
      }
      await pause(supervisionPollMs);
    }
    return settled;
  }
  // Periodic: at most one request in flight. Rejection only raises the flag; supervision selects
  // the outcome on a later poll, unless shell exit comes first. The first deadline counts from
  // start(), which supervision calls after the started receipt.
  const intervalMs = renewalIntervalMs(request.leaseWindowMs);
  let nextAt = Infinity;
  let inFlight = false;
  let abortController;
  const periodic = {
    failureObserved: false,
    start() { nextAt = performance.now() + intervalMs; },
    poll() {
      if (inFlight || performance.now() < nextAt) return;
      inFlight = true;
      abortController = new AbortController();
      Promise.resolve().then(() => renewLease(abortController.signal))
        .catch(() => { periodic.failureObserved = true; })
        .finally(() => { inFlight = false; });
      nextAt = performance.now() + intervalMs;
    },
    // Abort without joining. A late rejection changes nothing after the outcome is selected.
    abort() { abortController?.abort(); },
  };
  return { evidence, preflight, periodic };
}

// 4. Cancellation.

// A finished receipt whose managed scope still runs: a background service, or an earlier stop
// that did not confirm. This path waits through the stop attempts and records the new
// observation. The outcome and every other field stay as published.
async function stopFinishedScopeIfNeeded(current) {
  if (current.scopeStopped !== false || !Number.isInteger(current.pgid)) return;
  const scopeStopped = await stopProcessGroup(current.pgid);
  await writeStatusReceipt({ ...current, scopeStopped });
}

// Cancellation contract: the request file must exist. Two paths:
// - no finished receipt at the status read: publish the marker. That is a request, not shutdown
//   acknowledgement, and cancel does not wait for the running job's supervision. A job that
//   finishes between the read and the write keeps the marker unobserved; its receipt is final.
// - a finished receipt: never publish a marker; stop a surviving scope instead (see above).
async function requestCancellation() {
  await access(requestPath);
  if (await exists(statusPath)) {
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    if (current.state === "finished") return stopFinishedScopeIfNeeded(current);
  }
  await writeFile(cancelPath, "", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

// 5. Run stages.
//
// | Concern                            | Ordinary                                   | Background                  |
// | Shell launch                       | detached Bash with piped output            | same                        |
// | Preflight and periodic renewal     | enabled                                    | neither imported nor called |
// | Execution timeout                  | optional, starts after the started receipt | ignored                     |
// | Survivors after shell exit         | stop, then report the observation          | observe only                |
// | Capture after the finished receipt | until the pipes close                      | same                        |
//
// Five clocks, none shared: the lease window (remote, renewed through E2B), the periodic cadence
// target (renewalIntervalMs, counted from supervision start), the optional execution deadline, the
// adapter's 5000 ms request timeout, and the 1000 ms output drain wait before the receipt.

// Direct runner admission. The caller validates the other request fields more strictly.
// A background request must still carry a valid lease window, although it never renews.
function validateRunnerAdmission(request) {
  if (request.version !== 1 || !["ordinary", "background"].includes(request.mode)
      || typeof request.command !== "string" || typeof request.cwd !== "string"
      || !Number.isSafeInteger(request.leaseWindowMs) || request.leaseWindowMs < 3) {
    throw new Error("Invalid job request.");
  }
}

// Open and truncate the three output files with mode 0600, into the caller's record, so a
// failure part way still leaves the opened handles where closeOutputs finds them.
async function openOutputs(outputs) {
  for (const name of ["stdout", "stderr", "combined"]) {
    outputs[name] = await open(join(jobDir, name), "w", 0o600);
  }
}
async function closeOutputs(outputs) {
  for (const handle of Object.values(outputs)) await handle.close().catch(() => undefined);
}

function writeAll(fd, chunk) {
  for (let offset = 0; offset < chunk.length;) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

// Spawn the detached shell with piped output, wire capture, and wait for the spawn event.
// Each chunk is fully written to its stream file, then to combined. Combined order is the callback
// observation order, with no causal ordering across streams. The first write failure stops capture.
async function launchShell(request, outputs) {
  const child = spawn("/bin/bash", ["-lc", request.command], {
    cwd: request.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // Request values override the inherited environment. The runner's E2B_API_KEY is inherited too.
    env: { ...process.env, ...request.env },
  });
  const capture = { error: undefined };
  const append = (chunk, stream) => {
    if (capture.error) return;
    try {
      writeAll(stream.fd, chunk);
      writeAll(outputs.combined.fd, chunk);
    } catch (error) {
      capture.error = error;
    }
  };
  child.stdout.on("data", (chunk) => append(chunk, outputs.stdout));
  child.stderr.on("data", (chunk) => append(chunk, outputs.stderr));
  // Shell exit ends supervision. Stream closure is awaited separately, with a bound.
  const streamsClosed = new Promise((resolveClose) => child.once("close", resolveClose));
  const exit = { value: undefined };
  child.once("exit", (exitCode, signal) => { exit.value = { exitCode, signal }; });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", rejectSpawn);
  });
  return { pid: child.pid, capture, exit, streamsClosed };
}

// Poll until shell exit or a stop condition, in this order: output failure, cancellation,
// ordinary execution timeout, periodic renewal failure. A stop condition stops the group.
// The execution clock starts here, after the started receipt, not at spawn.
async function supervise(shell, request, leaseRenewal) {
  const executionStartedAt = performance.now();
  if (request.mode === "ordinary") leaseRenewal.periodic.start();
  while (!shell.exit.value) {
    if (shell.capture.error) {
      return { outcome: "failed", failure: outputFailureFields(), scopeStopped: await stopProcessGroup(shell.pid) };
    }
    if (await cancellationRequested()) {
      return { outcome: "cancelled", failure: {}, scopeStopped: await stopProcessGroup(shell.pid) };
    }
    if (request.mode === "ordinary" && request.executionTimeoutMs !== undefined
        && performance.now() - executionStartedAt >= request.executionTimeoutMs) {
      return { outcome: "timed_out", failure: {}, scopeStopped: await stopProcessGroup(shell.pid) };
    }
    if (leaseRenewal.periodic.failureObserved) {
      return { outcome: "failed", failure: renewalFailureFields(leaseRenewal.evidence.lastFailure),
        scopeStopped: await stopProcessGroup(shell.pid) };
    }
    if (request.mode === "ordinary") leaseRenewal.periodic.poll();
    await pause(supervisionPollMs);
  }
  // The shell exited on its own. Ordinary mode stops survivors; background mode only observes them.
  const survivors = await hasLiveProcessGroupMembers(shell.pid);
  const scopeStopped = request.mode === "ordinary" && survivors ? await stopProcessGroup(shell.pid) : !survivors;
  return { outcome: "exited", failure: {}, scopeStopped };
}

// Wait for stream closure up to the drain bound, so a survivor that keeps the pipes open cannot
// delay the receipt beyond it. A late capture failure replaces only an exited outcome. Outputs close
// before the receipt only when the streams drained; otherwise capture continues after it.
// A failed stop leaves the shell alive, so exit fields can be null.
async function publishExecutionReceipt(mode, shell, result, outputs) {
  const drained = await Promise.race([shell.streamsClosed.then(() => true), pause(outputDrainMs).then(() => false)]);
  if (shell.capture.error && result.outcome === "exited") {
    Object.assign(result, { outcome: "failed", failure: outputFailureFields(), scopeStopped: await stopProcessGroup(shell.pid) });
  }
  if (drained) await closeOutputs(outputs);
  await writeStatusReceipt(finishedReceipt({ mode, outcome: result.outcome, scopeStopped: result.scopeStopped,
    phase: "execution", pid: shell.pid, exitCode: shell.exit.value?.exitCode ?? null,
    signal: shell.exit.value?.signal ?? null, ...result.failure }));
}

// A job runs once: a second run finds the receipt and refuses before touching output files.
// There is no lock against two concurrent runs that both start before the first receipt.
// Ordinary jobs renew the lease, enforce an optional execution timeout, and stop survivors on
// shell exit. Background jobs do none of those. leaseWindowMs is the lease window passed to E2B.
// executionTimeoutMs separately bounds ordinary execution, regardless of command activity.
async function runJob() {
  if (await exists(statusPath)) {
    console.error("The job already has a receipt. A job runs once.");
    process.exitCode = 1;
    return;
  }
  // Context for the generic failure receipt: null until the run learns it.
  let mode = null;
  let groupId = null;
  let leaseRenewal;
  let streamsClosed;
  const outputs = {};
  const cancelledBeforeSpawn = () => finishedReceipt({ mode, outcome: "cancelled", scopeStopped: true, phase: "pre_execution" });
  try {
    // Stage 1: admit the request.
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    validateRunnerAdmission(request);
    mode = request.mode;
    // Stage 2: an early cancellation marker finishes the job before output files are touched.
    if (await cancellationRequested()) {
      await writeStatusReceipt(cancelledBeforeSpawn());
      return;
    }
    await openOutputs(outputs);
    // Stage 3: ordinary preflight renewal gate, then a second cancellation check.
    leaseRenewal = createLeaseRenewal(request);
    if (mode === "ordinary") {
      const gate = await leaseRenewal.preflight();
      if (gate !== "renewed") {
        await closeOutputs(outputs);
        await writeStatusReceipt(gate === "cancelled" ? cancelledBeforeSpawn()
          : finishedReceipt({ mode, outcome: "failed", scopeStopped: true, phase: "pre_execution",
            ...renewalFailureFields(leaseRenewal.evidence.lastFailure) }));
        return;
      }
    }
    if (await cancellationRequested()) {
      await closeOutputs(outputs);
      await writeStatusReceipt(cancelledBeforeSpawn());
      return;
    }
    // Stage 4: launch the shell and publish the started receipt.
    const shell = await launchShell(request, outputs);
    groupId = shell.pid;
    streamsClosed = shell.streamsClosed;
    await writeStatusReceipt(startedReceipt(mode, shell.pid));
    // Stage 5: supervise until shell exit or a stop condition. The finally aborts periodic renewal.
    const result = await supervise(shell, request, leaseRenewal);
    // Stage 6: publish. Publication finalizes the outcome and the scope observation; output can
    // still grow afterwards. Cleanup, in the finally, is the separate second milestone.
    await publishExecutionReceipt(mode, shell, result, outputs);
    groupId = null;
  } catch (error) {
    // Generic failure: stop a launched group, then publish error.message. This path is outside
    // the renewal privacy boundary. Exit status 1 reports the runner failure, not a command result.
    let scopeStopped = groupId === null;
    if (groupId !== null) {
      try { scopeStopped = await stopProcessGroup(groupId); } catch { scopeStopped = false; }
    }
    try {
      await writeStatusReceipt(finishedReceipt({ mode, outcome: "failed", scopeStopped, pid: groupId,
        phase: groupId === null ? "pre_execution" : "execution", error: error.message }));
    } catch {
      console.error("Failed to write the job receipt.");
    }
    streamsClosed = undefined;
    process.exitCode = 1;
  } finally {
    // One cleanup for every path: release periodic renewal, continue capture after the receipt
    // until the pipes close, then release the handles.
    leaseRenewal?.periodic.abort();
    if (streamsClosed) await streamsClosed;
    await closeOutputs(outputs);
  }
}

// Receipts describe job outcomes. Runner exit status does not indicate command success.
// runJob publishes a receipt for every failure inside its try, including request validation,
// and sets exit status 1 itself; the receipt-existence refusal returns normally after setting it.
// This handler sees only cancel errors.
const operation = action === "run" ? runJob : requestCancellation;
operation().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

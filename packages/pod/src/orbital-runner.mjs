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
let activePgid;
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

async function status(value) {
  const tempPath = `${statusPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value));
  await rename(tempPath, statusPath);
}

function writeAll(fd, chunk) {
  for (let offset = 0; offset < chunk.length;) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

async function liveGroup(pgid) {
  if (await exists("/proc/self/stat")) {
    for (const entry of await readdir("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pgid && fields[0] !== "Z") return true;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return false;
  }
  const listing = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8" });
  return listing.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && state !== undefined && !state.startsWith("Z");
  });
}

function signalGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopGroup(pgid) {
  signalGroup(pgid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await liveGroup(pgid))) return true;
    await pause(50);
  }
  signalGroup(pgid, "SIGKILL");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await liveGroup(pgid))) return true;
    await pause(50);
  }
  return !(await liveGroup(pgid));
}

async function cancel() {
  await access(join(jobDir, "request.json"));
  if (await exists(statusPath)) {
    const current = JSON.parse(await readFile(statusPath, "utf8"));
    if (current.state === "finished") return;
  }
  await writeFile(cancelPath, "", { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function run() {
  const request = JSON.parse(await readFile(join(jobDir, "request.json"), "utf8"));
  if (request.version !== 1 || !["ordinary", "background"].includes(request.mode)
      || typeof request.command !== "string" || typeof request.cwd !== "string"
      || !Number.isSafeInteger(request.idleTimeoutMs) || request.idleTimeoutMs < 3) {
    throw new Error("Invalid job request.");
  }

  const stdout = await open(join(jobDir, "stdout"), "w", 0o600);
  const stderr = await open(join(jobDir, "stderr"), "w", 0o600);
  const combined = await open(join(jobDir, "combined"), "w", 0o600);
  if (await exists(cancelPath)) {
    await status({ state: "finished", jobId, outcome: "cancelled", scopeStopped: true });
    await stdout.close();
    await stderr.close();
    await combined.close();
    return;
  }
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/home/user",
    USER: process.env.USER ?? "user",
    LANG: process.env.LANG ?? "C.UTF-8",
    ...request.env,
  };
  delete environment.E2B_API_KEY;

  let renew;
  if (request.mode === "ordinary") {
    try {
      if (!process.env.E2B_API_KEY) throw new Error("Renewal key is missing.");
      ({ renew } = await import(process.env.ORBITAL_RENEW_MODULE ?? "./renew.mjs"));
      await renew({ sandboxId: request.sandboxId, apiKey: process.env.E2B_API_KEY,
        windowMs: request.idleTimeoutMs });
    } catch {
      await status({ state: "finished", jobId, outcome: "failed", phase: "pre_execution",
        errorCode: "renewal_failed", error: "Renewal failed.", scopeStopped: true });
      await stdout.close();
      await stderr.close();
      await combined.close();
      return;
    }
  }
  if (await exists(cancelPath)) {
    await status({ state: "finished", jobId, outcome: "cancelled", scopeStopped: true });
    await stdout.close();
    await stderr.close();
    await combined.close();
    return;
  }
  const child = spawn("/bin/bash", ["-lc", request.command], {
    cwd: request.cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  try {
    let outputError;
    const recordOutput = (chunk, stream) => {
      if (outputError) return;
      try {
        writeAll(stream.fd, chunk);
        writeAll(combined.fd, chunk);
      } catch (error) {
        outputError = error;
      }
    };
    child.stdout.on("data", (chunk) => {
      recordOutput(chunk, stdout);
    });
    child.stderr.on("data", (chunk) => {
      recordOutput(chunk, stderr);
    });
    const closed = new Promise((resolveClose) => child.once("close", resolveClose));
    let exitResult;
    child.once("exit", (exitCode, signal) => { exitResult = { exitCode, signal }; });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    activePgid = child.pid;
    const started = { state: "started", jobId, mode: request.mode, pid: child.pid, pgid: child.pid };
    await status(started);
    const startedAt = performance.now();
    const timeoutMs = request.executionTimeoutMs;
    const renewIntervalMs = Math.min(
      Number(process.env.ORBITAL_RENEW_INTERVAL_MS ?? Math.floor(request.idleTimeoutMs / 3)),
      Math.floor(request.idleTimeoutMs / 3),
    );
    let nextRenewAt = startedAt + renewIntervalMs;
    let outcome = "completed";
    let scopeStopped = true;
    let failure;
    let renewalInFlight = false;
    let renewalError = false;
    let renewalAbort;
    while (!exitResult) {
      if (outputError) {
        outcome = "failed";
        failure = { phase: "execution", errorCode: "output_write_failed", error: "Output capture failed." };
        scopeStopped = await stopGroup(child.pid);
        break;
      }
      if (await exists(cancelPath)) {
        outcome = "cancelled";
        scopeStopped = await stopGroup(child.pid);
        break;
      }
      if (request.mode === "ordinary" && timeoutMs !== undefined
          && performance.now() - startedAt >= timeoutMs) {
        outcome = "timed_out";
        scopeStopped = await stopGroup(child.pid);
        break;
      }
      if (renewalError) {
        outcome = "failed";
        failure = { errorCode: "renewal_failed", error: "Renewal failed." };
        scopeStopped = await stopGroup(child.pid);
        break;
      }
      if (request.mode === "ordinary" && !renewalInFlight && performance.now() >= nextRenewAt) {
        renewalInFlight = true;
        renewalAbort = new AbortController();
        Promise.resolve().then(() => renew({ sandboxId: request.sandboxId,
          apiKey: process.env.E2B_API_KEY, windowMs: request.idleTimeoutMs,
          signal: renewalAbort.signal }))
          .catch(() => { renewalError = true; })
          .finally(() => { renewalInFlight = false; });
        nextRenewAt = performance.now() + renewIntervalMs;
      }
      await pause(20);
    }
    renewalAbort?.abort();
    if (request.mode === "ordinary" && outcome === "completed" && await liveGroup(child.pid)) {
      scopeStopped = await stopGroup(child.pid);
    }
    await closed;
    if (outputError && outcome === "completed") {
      outcome = "failed";
      failure = { phase: "execution", errorCode: "output_write_failed", error: "Output capture failed." };
      scopeStopped = await stopGroup(child.pid);
    }
    await stdout.close();
    await stderr.close();
    await combined.close();
    await status({ ...started, state: "finished", outcome, scopeStopped, ...exitResult, ...failure });
    activePgid = undefined;
  } finally {
    if (!(await exists(statusPath))) {
      await stdout.close().catch(() => undefined);
      await stderr.close().catch(() => undefined);
      await combined.close().catch(() => undefined);
    }
  }
}

const operation = action === "run" ? run : cancel;
operation().catch(async (error) => {
  if (action !== "run") {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  let scopeStopped = activePgid === undefined;
  if (activePgid !== undefined) {
    try { scopeStopped = await stopGroup(activePgid); } catch { scopeStopped = false; }
  }
  try {
    await status({ state: "finished", jobId, outcome: "failed", error: error.message,
      scopeStopped, ...(activePgid === undefined ? { phase: "pre_execution" } : { phase: "execution" }) });
  } catch {
    console.error("Failed to write the job receipt.");
  }
  process.exitCode = 1;
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Sandbox } from "e2b";

import { createE2BProvider, type OrbSnapshot } from "@henriquebastosnet/orbital";
import { saveReceipt } from "../support/receipts.js";
import { hostedConfiguration } from "../support/hosted-configuration.js";

type CaseName = "silent" | "timeout" | "cancel" | "early" | "admission";
interface Call { name: string; arguments: Record<string, unknown> }
interface PiEvent {
  type: string;
  id?: string;
  command?: string;
  toolName?: string;
  isError?: boolean;
  result?: { content?: { text?: string }[]; details?: { orbId?: string } };
  partialResult?: { content?: { text?: string }[] };
}
interface PiRun {
  child: ChildProcess;
  events: PiEvent[];
  stderr: () => string;
  session: string;
  waitFor: (predicate: (event: PiEvent) => boolean, timeoutMs?: number) => Promise<PiEvent>;
  stopped: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

let activePi: PiRun | undefined;

const requested = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : "all";
const selected: CaseName[] = requested === "all" ? ["silent", "timeout", "cancel", "early", "admission"] : [requested as CaseName];
const runId = randomUUID();
const receiptDirectory = resolve("test-output", `lifetime-${runId}`);
if (selected.some(name => !["silent", "timeout", "cancel", "early", "admission"].includes(name))) {
  saveReceipt("hosted-lifetime", { status: "blocked", reason: "A valid --case is required.",
    selected, cleanup: "No allocations created", skips: [] }, receiptDirectory);
  process.exit(1);
}
const { apiKey, image } = await hostedConfiguration();
const provider = createE2BProvider({ apiKey });
const attempts: Record<string, unknown>[] = [];
const startedAt = Date.now();
const deadline = startedAt + 9 * 60_000;
const includesPi = selected.some((name) => name === "silent" || name === "timeout" || name === "cancel");
const real = [...(includesPi ? ["Pi process", "Orbital extension", "shared library"] : []),
  "E2B SDK", "Orbital image", "Linux process groups"];
const substituted = includesPi ? ["model responses"] : [];

function remaining(limitMs: number): number {
  const available = deadline - Date.now();
  if (available <= 0) throw new Error("The lifetime harness exceeded its nine minute work budget.");
  return Math.min(limitMs, available);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, remaining(ms)));
}

function eventText(event: PiEvent): string {
  return event.partialResult?.content?.map((part) => part.text ?? "").join("") ?? "";
}

function startPi(directory: string, calls: Call[], mode: "json" | "rpc"): PiRun {
  const session = resolve(directory, "session.jsonl");
  const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--extension", resolve("tests/support/model-extension.ts"),
    "--provider", "orbital-fixture", "--model", "probe", "--tools", "orbital,bash",
    "--mode", mode, "--session", session];
  if (mode === "json") args.push("--print", "Run the fixed fixture.");
  const child = spawn(resolve("node_modules/.bin/pi"), args, {
    cwd: directory,
    env: { ...process.env, PI_CODING_AGENT_DIR: resolve(directory, "agent"),
      ORBITAL_PI_CALLS: JSON.stringify(calls), ORBITAL_IMAGE: image,
      ORBITAL_IDLE_TIMEOUT_MS: "30000" },
    stdio: [mode === "json" ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const events: PiEvent[] = [];
  const waiters = new Set<{ predicate: (event: PiEvent) => boolean; done: (event: PiEvent) => void;
    fail: (error: Error) => void; timer: NodeJS.Timeout }>();
  let buffer = "";
  let stderr = "";
  const stopped = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.fail(new Error(`Pi exited before the expected event. code=${code} signal=${signal}`));
      }
      waiters.clear();
      done({ code, signal });
    });
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      let event: PiEvent;
      try { event = JSON.parse(line) as PiEvent; }
      catch { continue; }
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.predicate(event)) continue;
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.done(event);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-12_000); });
  const waitFor = (predicate: (event: PiEvent) => boolean, timeoutMs = 60_000): Promise<PiEvent> => {
    const prior = events.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((done, fail) => {
      const waiter = { predicate, done, fail, timer: setTimeout(() => {
        waiters.delete(waiter);
        fail(new Error(`Pi event timeout after ${timeoutMs} ms. stderr=${stderr}`));
      }, remaining(timeoutMs)) };
      waiters.add(waiter);
    });
  };
  if (mode === "rpc") child.stdin!.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: "Run the fixed fixture." })}\n`);
  const run = { child, events, stderr: () => stderr, session, waitFor, stopped };
  activePi = run;
  return run;
}

function attached(event: PiEvent): string {
  assert.equal(event.isError, false, JSON.stringify(event));
  const orbId = event.result?.details?.orbId;
  assert.ok(orbId, "Pi must report the session-derived Orb ID.");
  return orbId;
}

async function startAttachedPi(directory: string, command: string, timeout?: number, mode: "json" | "rpc" = "json") {
  const pi = startPi(directory, [
    { name: "orbital", arguments: { action: "create_and_attach" } },
    { name: "bash", arguments: { command, ...(timeout === undefined ? {} : { timeout }) } },
  ], mode);
  const creation = await pi.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "orbital", 45_000);
  const orbId = attached(creation);
  const orb = await provider!.resolve(orbId);
  assert.ok(orb, "Pi creation must leave a resolvable orb.");
  return { pi, orbId, orb };
}

async function passiveInfo(resourceId: string) {
  const info = await Sandbox.getInfo(resourceId, { apiKey: apiKey!, requestTimeoutMs: 10_000 });
  return { state: info.state, endAt: info.endAt.toISOString(), resourceId: info.sandboxId };
}

async function findJob(orb: OrbSnapshot, token: string) {
  const sandbox = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  const entries = await sandbox.files.list("/home/user/.orbital/jobs");
  for (const entry of entries) {
    const requestPath = `${entry.path}/request.json`;
    if (!await sandbox.files.exists(requestPath)) continue;
    const request = JSON.parse(await sandbox.files.read(requestPath)) as { command?: string };
    if (!request.command?.includes(token)) continue;
    const status = JSON.parse(await sandbox.files.read(`${entry.path}/status.json`)) as Record<string, unknown>;
    const combined = await sandbox.files.read(`${entry.path}/combined`);
    return { jobId: entry.name, status, combined };
  }
  throw new Error(`No remote job matches token ${token}.`);
}

async function killPi(pi: PiRun): Promise<void> {
  if (pi.child.exitCode === null && pi.child.signalCode === null) pi.child.kill("SIGKILL");
  await pi.stopped;
}

async function verifyFollowUp(directory: string, orb: OrbSnapshot, trace: Record<string, unknown>[], label: string) {
  const token = `ORBITAL_FOLLOW_UP_${randomUUID()}`;
  const marker = `lifetime-follow-up-${randomUUID()}.txt`;
  const pi = startPi(directory, [{ name: "bash", arguments: {
    command: `printf '${token}' > /home/user/${marker}; cat /home/user/${marker}`,
  } }], "json");
  const result = await pi.waitFor((event) => event.type === "tool_execution_end" && event.toolName === "bash", 45_000);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.match(result.result?.content?.map((part) => part.text ?? "").join("") ?? "", new RegExp(token));
  assert.deepEqual(await pi.stopped, { code: 0, signal: null });
  const sessionId = (JSON.parse(readFileSync(pi.session, "utf8").split("\n")[0]!) as { id: string }).id;
  assert.equal(sessionId, orb.orbId);
  const current = await provider!.resolve(sessionId);
  assert.equal(current?.resourceId, orb.resourceId);
  assert.equal(Buffer.from(await provider!.readFile(current, `/home/user/${marker}`)).toString("utf8"), token);
  trace.push({ event: "same_session_follow_up", label, sessionId, resourceId: current.resourceId,
    marker, commandSucceeded: true });
}

async function silentCase(directory: string, trace: Record<string, unknown>[], setOwned: (orb: OrbSnapshot) => void) {
  const token = `ORBITAL_READY_${randomUUID()}`;
  const marker = `lifetime-silent-${randomUUID()}.txt`;
  const command = `printf '${token}\\n'; sleep 75; printf 'COMPLETE' > /home/user/${marker}`;
  const { pi, orbId, orb } = await startAttachedPi(directory, command);
  setOwned(orb);
  trace.push({ event: "attached", orbId, resourceId: orb.resourceId });
  await pi.waitFor((event) => event.type === "tool_execution_update" && event.toolName === "bash"
    && eventText(event).includes(token), 30_000);
  trace.push({ event: "actual_bash_output", token, at: new Date().toISOString() });
  await Sandbox.setTimeout(orb.resourceId, 30_000, { apiKey: apiKey!, requestTimeoutMs: 10_000 });
  const baseline = await passiveInfo(orb.resourceId);
  trace.push({ event: "deadline_set_before_pi_exit", ...baseline });
  await killPi(pi);
  const killedAt = Date.now();
  trace.push({ event: "pi_sigkill", at: new Date(killedAt).toISOString() });
  await sleep(40_000);
  const afterForty = await passiveInfo(orb.resourceId);
  trace.push({ event: "passive_after_40_seconds", elapsedMs: Date.now() - killedAt, ...afterForty });
  assert.equal(afterForty.resourceId, orb.resourceId);
  assert.equal(afterForty.state, "running", "The orb must still run past its forced 30 second deadline.");
  assert.ok(Date.parse(afterForty.endAt) > Date.parse(baseline.endAt) + 5_000,
    `The expiry did not advance after Pi exit. baseline=${baseline.endAt} observed=${afterForty.endAt}`);
  await sleep(Math.max(0, 80_000 - (Date.now() - killedAt)));
  const beforeRead = await passiveInfo(orb.resourceId);
  trace.push({ event: "passive_before_effect_read", elapsedMs: Date.now() - killedAt, ...beforeRead });
  const observations = [beforeRead];
  const sleepDeadline = Date.now() + 90_000;
  while (observations.at(-1)!.state !== "paused" && Date.now() < sleepDeadline) {
    await sleep(5_000);
    observations.push(await passiveInfo(orb.resourceId));
  }
  assert.equal(observations.at(-1)!.state, "paused", "The orb must sleep after silent work completes.");
  await sleep(10_000);
  const settled = await passiveInfo(orb.resourceId);
  assert.equal(settled.state, "paused");
  assert.equal(settled.endAt, observations.at(-1)!.endAt,
    "The sandbox deadline must stop advancing after the silent job ends.");
  trace.push({ event: "post_job_sleep_without_host_renewal", observations, settled });
  const content = Buffer.from(await provider!.readFile(orb, `/home/user/${marker}`)).toString("utf8");
  assert.equal(content, "COMPLETE");
  const job = await findJob(orb, token);
  assert.equal(job.status.outcome, "completed", JSON.stringify(job.status));
  assert.equal(job.status.scopeStopped, true);
  assert.equal(job.status.exitCode, 0);
  trace.push({ event: "remote_effect", marker, content, jobId: job.jobId, status: job.status });
}

async function timeoutCase(directory: string, trace: Record<string, unknown>[], setOwned: (orb: OrbSnapshot) => void) {
  const token = `ORBITAL_TIMEOUT_READY_${randomUUID()}`;
  const marker = `lifetime-timeout-${randomUUID()}.txt`;
  const command = `printf '${token}\\n'; (sleep 6; printf 'LATE' > /home/user/${marker}) & wait`;
  const { pi, orbId, orb } = await startAttachedPi(directory, command, 2);
  setOwned(orb);
  trace.push({ event: "attached", orbId, resourceId: orb.resourceId });
  await pi.waitFor((event) => event.type === "tool_execution_update" && event.toolName === "bash"
    && eventText(event).includes(token), 30_000);
  await killPi(pi);
  trace.push({ event: "pi_sigkill_after_actual_output", at: new Date().toISOString() });
  await sleep(7_000);
  trace.push({ event: "passive_before_effect_read", ...(await passiveInfo(orb.resourceId)) });
  const job = await findJob(orb, token);
  assert.equal(job.status.outcome, "timed_out", JSON.stringify(job.status));
  assert.equal(job.status.scopeStopped, true);
  assert.match(job.combined, new RegExp(token));
  const sandbox = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  assert.equal(await sandbox.files.exists(`/home/user/${marker}`), false);
  trace.push({ event: "remote_timeout_verified", markerAbsent: true, jobId: job.jobId, status: job.status });
  await verifyFollowUp(directory, orb, trace, "after_remote_timeout");
}

async function cancelCase(directory: string, trace: Record<string, unknown>[], setOwned: (orb: OrbSnapshot) => void) {
  const token = `ORBITAL_CANCEL_READY_${randomUUID()}`;
  const marker = `lifetime-cancel-${randomUUID()}.txt`;
  const command = `printf '${token}\\n'; (sleep 6; printf 'LATE' > /home/user/${marker}) & wait`;
  const { pi, orbId, orb } = await startAttachedPi(directory, command, undefined, "rpc");
  setOwned(orb);
  trace.push({ event: "attached", orbId, resourceId: orb.resourceId });
  await pi.waitFor((event) => event.type === "tool_execution_update" && event.toolName === "bash"
    && eventText(event).includes(token), 30_000);
  pi.child.stdin!.write(`${JSON.stringify({ id: "abort", type: "abort" })}\n`);
  trace.push({ event: "pi_rpc_abort_after_actual_output", at: new Date().toISOString() });
  const response = await pi.waitFor((event) => event.type === "response" && event.id === "abort", 20_000);
  assert.equal(response.command, "abort");
  await killPi(pi);
  await sleep(7_000);
  trace.push({ event: "passive_before_effect_read", ...(await passiveInfo(orb.resourceId)) });
  const job = await findJob(orb, token);
  assert.equal(job.status.outcome, "cancelled", JSON.stringify(job.status));
  assert.equal(job.status.scopeStopped, true);
  const sandbox = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  assert.equal(await sandbox.files.exists(`/home/user/${marker}`), false);
  trace.push({ event: "rpc_cancel_verified", markerAbsent: true, jobId: job.jobId, status: job.status });
  await verifyFollowUp(directory, orb, trace, "after_rpc_cancellation");
}

async function earlyCase(_directory: string, trace: Record<string, unknown>[], setOwned: (orb: OrbSnapshot) => void) {
  const orbId = `orbital-lifetime-early-${runId}`;
  const orb = await provider!.create({ orbId, image: image!, idleTimeoutMs: 30_000 });
  setOwned(orb);
  trace.push({ event: "created", orbId, resourceId: orb.resourceId });
  const token = `ORBITAL_EARLY_${randomUUID()}`;
  const marker = `lifetime-early-${randomUUID()}.txt`;
  const controller = new AbortController();
  const result = await provider!.exec(orb, { command: `sleep 6; printf '${token}' > /home/user/${marker}`,
    orbCwd: "/home/user" }, { signal: controller.signal,
    onProgress(event) { if (event.phase === "submitted") controller.abort(); } });
  assert.equal(result.kind, "cancelled");
  await sleep(7_000);
  trace.push({ event: "passive_before_effect_read", ...(await passiveInfo(orb.resourceId)) });
  const job = await findJob(orb, token);
  assert.equal(job.status.outcome, "cancelled", JSON.stringify(job.status));
  assert.equal(job.status.scopeStopped, true);
  const sandbox = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  assert.equal(await sandbox.files.exists(`/home/user/${marker}`), false);
  trace.push({ event: "submitted_abort_verified", jobId: job.jobId, preSpawn: job.status.pid === undefined,
    markerAbsent: true, status: job.status });
}

async function admissionCase(_directory: string, trace: Record<string, unknown>[], setOwned: (orb: OrbSnapshot) => void) {
  const orbId = `orbital-lifetime-admission-${runId}`;
  const orb = await provider!.create({ orbId, image: image!, idleTimeoutMs: 30_000 });
  setOwned(orb);
  trace.push({ event: "created", orbId, resourceId: orb.resourceId });
  const reference = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  const target = new URL((reference as unknown as { envdApiUrl: string }).envdApiUrl);
  const token = `ORBITAL_ADMISSION_${randomUUID()}`;
  const marker = `lifetime-admission-${randomUUID()}.txt`;
  const controller = new AbortController();
  let startRequests = 0;
  let ackHeldAt: number | undefined;
  let abortAt: number | undefined;
  let ackReleasedAt: number | undefined;
  let cancelWriteForwarded = false;
  const progress: { phase: string; at: number }[] = [];
  let releaseCancelWait: (() => void) | undefined;
  const cancelWrite = new Promise<void>((done) => { releaseCancelWait = done; });
  const proxy: Server = createServer((incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://127.0.0.1");
    const upstreamUrl = new URL(incoming.url ?? "/", target);
    const start = path.pathname.toLowerCase().endsWith("/process.process/start");
    const cancel = decodeURIComponent(path.search).includes("/cancel");
    if (start) startRequests += 1;
    const upstreamRequest = (target.protocol === "https:" ? httpsRequest : httpRequest)(upstreamUrl, {
      method: incoming.method,
      headers: { ...incoming.headers, host: target.host },
    }, (upstreamResponse) => {
      outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      if (start) {
        upstreamResponse.once("data", (firstChunk: Buffer) => {
          upstreamResponse.pause();
          ackHeldAt = Date.now();
          controller.abort();
          abortAt = Date.now();
          void Promise.race([cancelWrite, sleep(2_000)]).then(() => {
            ackReleasedAt = Date.now();
            outgoing.write(firstChunk);
            upstreamResponse.pipe(outgoing);
            upstreamResponse.resume();
          });
        });
      } else {
        upstreamResponse.pipe(outgoing);
        if (cancel) upstreamResponse.once("end", () => {
          if ((upstreamResponse.statusCode ?? 500) < 300) {
            cancelWriteForwarded = true;
            releaseCancelWait?.();
          }
        });
      }
    });
    upstreamRequest.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstreamRequest);
  });
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const previousSandboxUrl = process.env.E2B_SANDBOX_URL;
  let result: { kind: string; jobId: string } | undefined;
  let uncertainty: { outcome: string; code: string; jobId?: unknown } | undefined;
  try {
    process.env.E2B_SANDBOX_URL = `http://127.0.0.1:${address.port}`;
    try {
      result = await provider!.exec(orb, {
        command: `sleep 6; printf '${token}' > /home/user/${marker}`,
        orbCwd: "/home/user",
      }, { signal: controller.signal, onProgress: (event) => progress.push({ phase: event.phase, at: Date.now() }) });
    } catch (cause) {
      if (!cause || typeof cause !== "object" || !("outcome" in cause) || !("code" in cause)) throw cause;
      const identified = cause as { outcome: string; code: string; evidence?: { jobId?: unknown } };
      uncertainty = { outcome: identified.outcome, code: identified.code, jobId: identified.evidence?.jobId };
      assert.equal(uncertainty.outcome, "uncertain");
    }
  } finally {
    if (previousSandboxUrl === undefined) delete process.env.E2B_SANDBOX_URL;
    else process.env.E2B_SANDBOX_URL = previousSandboxUrl;
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
  }
  assert.equal(startRequests, 1, "The adapter must submit the command exactly once.");
  assert.ok(ackHeldAt !== undefined && abortAt !== undefined && ackReleasedAt !== undefined,
    "The proxy must hold a real Start response while cancellation is requested.");
  assert.ok(ackHeldAt <= abortAt && abortAt < ackReleasedAt,
    "Cancellation must precede delivery of the Start acknowledgment.");
  const releasedAt = ackReleasedAt;
  assert.equal(progress.some((event) => event.phase === "submitted" && event.at < releasedAt), false,
    "The adapter must not report admission before the held response is released.");
  assert.equal(cancelWriteForwarded, true, "The cancellation marker must reach E2B before Start acknowledgment release.");
  if (result) assert.equal(result.kind, "cancelled");
  trace.push({ event: "admission_response_held", startRequests, ackHeldAt, abortAt, ackReleasedAt, progress,
    cancelWriteForwarded, adapterResult: result?.kind, uncertainty });
  await sleep(7_000);
  trace.push({ event: "passive_before_effect_read", ...(await passiveInfo(orb.resourceId)) });
  const job = await findJob(orb, token);
  assert.equal(job.status.outcome, "cancelled", JSON.stringify(job.status));
  assert.equal(job.status.scopeStopped, true);
  const sandbox = await Sandbox.connect(orb.resourceId, { apiKey: apiKey!, timeoutMs: orb.idleTimeoutMs });
  assert.equal(await sandbox.files.exists(`/home/user/${marker}`), false);
  trace.push({ event: "admission_cancel_verified", jobId: job.jobId,
    preSpawn: job.status.pid === undefined, markerAbsent: true, status: job.status });
}

async function runCase(name: CaseName): Promise<boolean> {
  const directory = mkdtempSync(resolve(tmpdir(), `orbital-lifetime-${name}-`));
  const trace: Record<string, unknown>[] = [];
  let owned: OrbSnapshot | undefined;
  let failure: string | undefined;
  let cleanup: Record<string, unknown> = {};
  const caseStarted = Date.now();
  const setOwned = (orb: OrbSnapshot) => {
    owned = orb;
    saveReceipt("hosted-lifetime", { status: "in_progress", selected, image, runId,
      activeCase: name, owned: { orbId: orb.orbId, resourceId: orb.resourceId },
      attempts, cleanup: "pending", durationMs: Date.now() - startedAt,
      real, substituted, skips: selected.filter((item) => !attempts.some((attempt) => attempt.name === item)) }, receiptDirectory);
  };
  try {
    if (name === "silent") await silentCase(directory, trace, setOwned);
    if (name === "timeout") await timeoutCase(directory, trace, setOwned);
    if (name === "cancel") await cancelCase(directory, trace, setOwned);
    if (name === "early") await earlyCase(directory, trace, setOwned);
    if (name === "admission") await admissionCase(directory, trace, setOwned);
  } catch (error) {
    failure = error instanceof Error ? error.stack ?? error.message : String(error);
    if (activePi) trace.push({ event: "pi_failure_context", observedEvents: activePi.events.slice(-20),
      stderr: activePi.stderr(), sessionExists: existsSync(activePi.session) });
  } finally {
    if (activePi) {
      try { await killPi(activePi); }
      catch (error) { trace.push({ event: "pi_cleanup_failed", error: error instanceof Error ? error.message : String(error) }); }
      activePi = undefined;
    }
    try {
      const session = resolve(directory, "session.jsonl");
      const header = existsSync(session) ? JSON.parse(readFileSync(session, "utf8").split("\n")[0]!) as { id?: string } : undefined;
      const orbId = owned?.orbId ?? header?.id;
      if (orbId) {
        const found = await provider!.resolve(orbId);
        if (found) {
          owned = found;
          await provider!.delete(found);
        }
        cleanup = { orbId, deletedResourceId: owned?.resourceId,
          missingAfterDelete: (await provider!.resolve(orbId)) === undefined };
        assert.equal(cleanup.missingAfterDelete, true);
      } else cleanup = { noOrbId: true };
    } catch (error) {
      cleanup = { ...cleanup, failure: error instanceof Error ? error.message : String(error),
        resourceId: owned?.resourceId };
    }
    rmSync(directory, { recursive: true, force: true });
  }
  const passed = !failure && !cleanup.failure;
  attempts.push({ name, status: passed ? "passed" : "failed", trace, failure, cleanup,
    durationMs: Date.now() - caseStarted });
  saveReceipt("hosted-lifetime", { status: passed ? "in_progress" : "failed", selected,
    image, runId, attempts, durationMs: Date.now() - startedAt,
    real, substituted, skips: selected.filter((item) => !attempts.some((attempt) => attempt.name === item)) }, receiptDirectory);
  return passed;
}

let passed = true;
for (const name of selected) {
  if (!await runCase(name)) { passed = false; break; }
}
saveReceipt("hosted-lifetime", { status: passed ? "passed" : "failed", selected,
  image, runId, attempts, durationMs: Date.now() - startedAt,
  real, substituted, skips: selected.filter((item) => !attempts.some((attempt) => attempt.name === item)) }, receiptDirectory);
process.exitCode = passed ? 0 : 1;

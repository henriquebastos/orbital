import { randomUUID } from "node:crypto";

import {
  AuthenticationError,
  FileType,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  SandboxNotFoundError,
  type SandboxInfo,
} from "e2b";

import { OrbitalError, type Observer } from "../operations.js";
import type { AllocationRequest, Provider } from "../provider.js";
import type { CreationIntent, OrbSnapshot } from "../orb.js";
import type { ExecRequest, ExecResult } from "../workspace.js";
import { assertCreationMatches } from "../hangar/creation.js";

const ORB_ID = "orbital_v2_orb_id";
const IMAGE = "orbital_v2_image";
const IDLE_MS = "orbital_v2_idle_timeout_ms";
const CREATION_INTENT = "orbital_v2_creation_intent";
const JOB_ROOT = "/home/user/.orbital/jobs";
const RUNNER = "/usr/local/bin/orbital-runner";
const START_WAIT_MS = 20_000;
const OUTPUT_PREVIEW_BYTES = 64 * 1024;

export interface E2BProviderConfig {
  apiKey: string;
  domain?: string;
  apiUrl?: string;
  requestTimeoutMs?: number;
}

interface JobStatus {
  state: "accepted" | "started" | "finished";
  outcome?: "completed" | "cancelled" | "timed_out" | "failed";
  phase?: "pre_execution" | "execution";
  errorCode?: string;
  exitCode?: number;
  pid?: number;
  pgid?: number;
  scopeStopped?: boolean;
}

function error(outcome: "not_started" | "uncertain", code: string, message: string,
  evidence: Record<string, unknown> = {}): OrbitalError {
  return new OrbitalError(outcome, code, message, evidence);
}

function sdkOptions(config: E2BProviderConfig) {
  return {
    apiKey: config.apiKey,
    domain: config.domain ?? "e2b.app",
    apiUrl: config.apiUrl ?? `https://api.${config.domain ?? "e2b.app"}`,
    requestTimeoutMs: config.requestTimeoutMs,
    retries: 0,
  };
}

function snapshot(info: SandboxInfo): OrbSnapshot {
  const orbId = info.metadata[ORB_ID];
  const image = info.metadata[IMAGE];
  const idleTimeoutMs = Number(info.metadata[IDLE_MS]);
  if (!orbId || !image || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 3) {
    throw error("not_started", "invalid_metadata", "The E2B sandbox has invalid Orbital metadata.",
      { resourceId: info.sandboxId });
  }
  let creationIntent: CreationIntent | undefined;
  const rawIntent = info.metadata[CREATION_INTENT];
  if (rawIntent !== undefined) {
    try {
      const value: unknown = JSON.parse(rawIntent);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid intent");
      const intent = value as Record<string, unknown>;
      if (Object.keys(intent).some(key => key !== "image" && key !== "preparationHash") ||
        (intent.image !== undefined && (typeof intent.image !== "string" || !intent.image.trim())) ||
        (intent.preparationHash !== undefined && (typeof intent.preparationHash !== "string" || !/^[a-f0-9]{64}$/.test(intent.preparationHash)))) {
        throw new Error("Invalid intent");
      }
      creationIntent = intent as CreationIntent;
    } catch {
      throw error("not_started", "invalid_metadata", "The E2B sandbox has invalid creation intent.", { resourceId: info.sandboxId });
    }
  }
  return {
    orbId,
    resourceId: info.sandboxId,
    image,
    state: info.state === "paused" ? "sleeping" : "running",
    idleTimeoutMs,
    sandboxDomain: info.sandboxDomain,
    ...(creationIntent === undefined ? {} : { creationIntent }),
  };
}

function validateCreate(request: AllocationRequest): void {
  if (!request.orbId || !request.image || !Number.isSafeInteger(request.idleTimeoutMs) ||
    request.idleTimeoutMs < 3) {
    throw error("not_started", "invalid_create", "Orb ID, image, and an idle timeout of at least 3 milliseconds are required.");
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw error("not_started", "invalid_port", "Port must be an integer from 1 through 65535.");
  }
}

function validateExec(request: ExecRequest & { orbCwd: string }): void {
  if (request.mode === "background" && request.timeoutMs !== undefined) {
    throw error("not_started", "invalid_timeout", "Background commands do not accept an execution timeout.");
  }
  if (!request.command || !request.orbCwd.startsWith("/")) {
    throw error("not_started", "invalid_command", "Command and absolute orb directory are required.");
  }
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw error("not_started", "invalid_timeout", "Execution timeout must be a positive integer.");
  }
  if (request.env && Object.hasOwn(request.env, "E2B_API_KEY")) {
    throw error("not_started", "reserved_environment", "E2B_API_KEY cannot be passed to the command.");
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function outputPrefix(sandbox: Sandbox, path: string): Promise<string> {
  if (!await sandbox.files.exists(path)) return "";
  const stream = await sandbox.files.read(path, { format: "stream" });
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let remaining = OUTPUT_PREVIEW_BYTES;
  try {
    while (remaining > 0) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value.subarray(0, remaining);
      parts.push(part);
      remaining -= part.byteLength;
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(OUTPUT_PREVIEW_BYTES - remaining);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createE2BProvider(config: E2BProviderConfig): Provider {
  if (!config.apiKey) {
    throw error("not_started", "missing_api_key", "E2B_API_KEY is required.");
  }
  const options = sdkOptions(config);

  async function connect(orb: OrbSnapshot): Promise<Sandbox> {
    try {
      return await Sandbox.connect(orb.resourceId, { ...options, timeoutMs: orb.idleTimeoutMs });
    } catch (cause) {
      if (cause instanceof SandboxNotFoundError) {
        throw error("not_started", "orb_missing", "The E2B sandbox is missing.", { resourceId: orb.resourceId });
      }
      throw error("uncertain", "resume_unknown", "The E2B resume outcome is unknown.",
        { resourceId: orb.resourceId, cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  async function resolve(orbId: string): Promise<OrbSnapshot | undefined> {
    if (!orbId) {
      throw error("not_started", "invalid_orb_id", "Orb ID is required.");
    }
    try {
      const paginator = Sandbox.list({
        ...options,
        query: { metadata: { [ORB_ID]: orbId }, state: ["running", "paused"] },
        limit: 2,
      });
      const matches: SandboxInfo[] = [];
      while (paginator.hasNext && matches.length < 2) {
        matches.push(...await paginator.nextItems());
      }
      if (matches.length > 1) {
        throw error("not_started", "duplicate_orb", "Multiple E2B sandboxes match this Orb ID.",
          { orbId, resourceIds: matches.map((item) => item.sandboxId) });
      }
      return matches[0] ? snapshot(matches[0]) : undefined;
    } catch (cause) {
      if (cause instanceof OrbitalError) throw cause;
      throw error("not_started", "lookup_failed", "E2B sandbox lookup failed.",
        { orbId, cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  async function create(request: AllocationRequest, observer?: Observer): Promise<OrbSnapshot> {
    validateCreate(request);
    if (observer?.signal?.aborted) {
      throw error("not_started", "cancelled_before_create", "Creation was cancelled before the request.");
    }
    const prior = await resolve(request.orbId);
    if (observer?.signal?.aborted) {
      throw error("not_started", "cancelled_before_create", "Creation was cancelled before the request.");
    }
    if (prior) {
      try {
        assertCreationMatches(prior, request.creationIntent ?? { image: request.image }, request.idleTimeoutMs);
      } catch (cause) {
        if (cause instanceof OrbitalError && cause.code === "conflict") {
          throw error("not_started", "orb_conflict", "The Orb ID already uses different creation settings.",
            { orbId: request.orbId, resourceId: prior.resourceId });
        }
        throw cause;
      }
      if (prior.state === "sleeping") await resume(prior);
      return { ...prior, state: "running" };
    }
    observer?.onProgress?.({ phase: "creating", orbId: request.orbId });
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.create(request.image, {
        ...options,
        timeoutMs: request.idleTimeoutMs,
        metadata: {
          [ORB_ID]: request.orbId,
          [IMAGE]: request.image,
          [IDLE_MS]: String(request.idleTimeoutMs),
          ...(request.creationIntent === undefined ? {} : { [CREATION_INTENT]: JSON.stringify(request.creationIntent) }),
        },
        envs: { E2B_API_KEY: config.apiKey },
        lifecycle: { onTimeout: "pause", autoResume: true },
        network: { allowPublicTraffic: true },
      });
    } catch (cause) {
      if (cause instanceof AuthenticationError || cause instanceof InvalidArgumentError ||
        cause instanceof NotFoundError || cause instanceof RateLimitError) {
        throw error("not_started", "create_rejected", "E2B rejected the sandbox creation request.",
          { orbId: request.orbId, cause: cause.name });
      }
      throw error("uncertain", "create_unknown", "The E2B creation outcome is unknown. Resolve this Orb ID before retrying.",
        { orbId: request.orbId, cause: cause instanceof Error ? cause.name : "unknown" });
    }
    try {
      const info = await sandbox.getInfo();
      observer?.onProgress?.({ phase: "created", orbId: request.orbId });
      return snapshot(info);
    } catch (cause) {
      throw error("uncertain", "created_uninspected", "The E2B sandbox was created but inspection failed.",
        { orbId: request.orbId, resourceId: sandbox.sandboxId,
          cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  async function resume(orb: OrbSnapshot): Promise<void> {
    await connect(orb);
  }

  async function remove(orb: OrbSnapshot): Promise<void> {
    try {
      if (!await Sandbox.kill(orb.resourceId, options)) {
        throw error("not_started", "orb_missing", "The E2B sandbox is missing.",
          { resourceId: orb.resourceId });
      }
    } catch (cause) {
      if (cause instanceof OrbitalError) throw cause;
      throw error("uncertain", "delete_unknown", "The E2B deletion outcome is unknown.",
        { resourceId: orb.resourceId, cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  function url(orb: OrbSnapshot, port: number): string {
    validatePort(port);
    return `https://${port}-${orb.resourceId}.${orb.sandboxDomain ?? config.domain ?? "e2b.app"}`;
  }

  async function readFile(orb: OrbSnapshot, path: string): Promise<Uint8Array> {
    const sandbox = await connect(orb);
    return sandbox.files.read(path, { format: "bytes" });
  }

  async function writeFile(orb: OrbSnapshot, path: string, content: Uint8Array): Promise<void> {
    const sandbox = await connect(orb);
    try {
      await sandbox.files.write(path, Uint8Array.from(content).buffer);
    } catch (cause) {
      throw error("uncertain", "write_unknown", "The remote file write outcome is unknown.",
        { resourceId: orb.resourceId, path, cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  async function stat(orb: OrbSnapshot, path: string) {
    const sandbox = await connect(orb);
    const info = await sandbox.files.getInfo(path);
    return { kind: info.type === FileType.DIR ? "directory" as const : "file" as const, size: info.size };
  }

  async function exec(orb: OrbSnapshot, request: ExecRequest & { orbCwd: string }, observer?: Observer): Promise<ExecResult> {
    validateExec(request);
    if (observer?.signal?.aborted) {
      throw error("not_started", "cancelled_before_exec", "Execution was cancelled before launch.");
    }
    const sandbox = await connect(orb);
    const jobId = randomUUID();
    const directory = `${JOB_ROOT}/${jobId}`;
    const outputPath = `${directory}/combined`;
    const requestPath = `${directory}/request.json`;
    try {
      await sandbox.files.makeDir(directory);
      await sandbox.files.write(`${requestPath}.pending`, JSON.stringify({
        version: 1,
        mode: request.mode ?? "ordinary",
        command: request.command,
        cwd: request.orbCwd,
        executionTimeoutMs: request.timeoutMs,
        env: request.env,
        sandboxId: orb.resourceId,
        idleTimeoutMs: orb.idleTimeoutMs,
      }));
      await sandbox.files.rename(`${requestPath}.pending`, requestPath);
    } catch (cause) {
      throw error("not_started", "job_setup_failed", "The remote job request could not be prepared.",
        { jobId, resourceId: orb.resourceId, cause: cause instanceof Error ? cause.name : "unknown" });
    }
    let cancelError: unknown;
    let cancelRequested = false;
    let cancelWrite: Promise<void> | undefined;
    let partialOutput = "";
    const requestCancellation = (): void => {
      if (cancelRequested) return;
      cancelRequested = true;
      cancelWrite = sandbox.files.write(`${directory}/cancel`, "cancel").then(() => undefined).catch((cause: unknown) => {
        cancelError = cause;
      });
    };
    observer?.signal?.addEventListener("abort", requestCancellation);
    try {
      if (observer?.signal?.aborted) {
        throw error("not_started", "cancelled_before_exec", "Execution was cancelled before launch.");
      }
      try {
        await sandbox.commands.run(`${RUNNER} run ${jobId}`, { background: true, timeoutMs: 0 });
      } catch (cause) {
        await cancelWrite;
        try { partialOutput = await outputPrefix(sandbox, outputPath); } catch { /* The launch result remains unknown. */ }
        throw error("uncertain", "launch_unknown", "The remote command may have started.",
          { jobId, resourceId: orb.resourceId, outputPath, partialOutput,
            cause: cause instanceof Error ? cause.name : "unknown" });
      }
      observer?.onProgress?.({ phase: "submitted", orbId: orb.orbId });
      const startedAt = Date.now();
      let startedReported = false;
      while (true) {
        if (cancelError) {
          throw error("uncertain", "cancel_unknown", "Remote cancellation could not be confirmed.",
            { jobId, resourceId: orb.resourceId, outputPath, partialOutput,
              cause: cancelError instanceof Error ? cancelError.name : "unknown" });
        }
        let status: JobStatus | undefined;
        try {
          if (await sandbox.files.exists(`${directory}/status.json`)) {
            status = JSON.parse(await sandbox.files.read(`${directory}/status.json`)) as JobStatus;
          }
          const currentOutput = await outputPrefix(sandbox, outputPath);
          if (currentOutput.length > partialOutput.length) {
            observer?.onOutput?.(currentOutput.slice(partialOutput.length));
            partialOutput = currentOutput;
          }
        } catch (cause) {
          throw error("uncertain", "result_unknown", "The remote command result could not be read.",
            { jobId, resourceId: orb.resourceId, outputPath, partialOutput,
              cause: cause instanceof Error ? cause.name : "unknown" });
        }
        if (status?.state === "started" && !startedReported) {
          startedReported = true;
          if (request.mode === "background" && !observer?.signal?.aborted) {
            return { kind: "background", jobId, stdout: "", stderr: "", outputPath };
          }
          observer?.onProgress?.({ phase: "started", orbId: orb.orbId });
        }
        if (status?.state === "finished") {
          if (status.scopeStopped === false) {
            throw error("uncertain", "termination_unknown", "Managed process termination is not confirmed.",
              { jobId, resourceId: orb.resourceId, outputPath, partialOutput,
                outcome: status.outcome, pid: status.pid, pgid: status.pgid });
          }
          if (status.outcome === "failed") {
            throw error(status.phase === "pre_execution" ? "not_started" : "uncertain",
              status.errorCode ?? "job_failed", "The remote runner failed.",
              { jobId, resourceId: orb.resourceId, outputPath, partialOutput, phase: status.phase });
          }
          if ((status.outcome === "cancelled" || status.outcome === "timed_out") &&
            status.scopeStopped !== true) {
            throw error("uncertain", "termination_unknown", "Managed process termination is not confirmed.",
              { jobId, resourceId: orb.resourceId, outputPath, partialOutput, outcome: status.outcome });
          }
          let stdout: string;
          let stderr: string;
          try {
            stdout = await outputPrefix(sandbox, `${directory}/stdout`);
            stderr = await outputPrefix(sandbox, `${directory}/stderr`);
          } catch (cause) {
            throw error("uncertain", "output_unknown", "The remote command finished but its output could not be read.",
              { jobId, resourceId: orb.resourceId, outputPath, partialOutput,
                cause: cause instanceof Error ? cause.name : "unknown" });
          }
          const kind = status.outcome === "timed_out" ? "timed_out" :
            status.outcome === "cancelled" ? "cancelled" : "exited";
          return { kind, jobId, stdout, stderr, outputPath, exitCode: status.exitCode };
        }
        if (Date.now() - startedAt >= START_WAIT_MS && !startedReported) {
          throw error("uncertain", "admission_unknown", "The remote command has no start receipt.",
            { jobId, resourceId: orb.resourceId, outputPath, partialOutput });
        }
        await delay(250);
      }
    } finally {
      observer?.signal?.removeEventListener("abort", requestCancellation);
    }
  }

  return { resolve, create, resume, delete: remove, url, exec, readFile, writeFile, stat };
}

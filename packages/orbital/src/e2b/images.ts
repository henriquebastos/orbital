import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AuthenticationError,
  BuildError,
  CommandExitError,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  SandboxError,
  Template,
} from "e2b";

import { createImages, type BaseRecipe, type ImageBuild, type ImageEffects, type ImageSeed } from "../hangar/images/preparation.js";
import { OrbitalError, type Observer } from "../operations.js";
import type { Images } from "../hangar/images/types.js";
import { orbitalRecipe, runtimeCheckCommand } from "../hangar/images/recipe.js";
import { ImageRecords, type ImageArtifact } from "../hangar/images/records.js";
import type { E2BProviderConfig } from "./provider.js";

const SEED_LEASE_MS = 30 * 60_000;
const SCRIPT_DEADLINE_MS = 20 * 60_000;
const CHECK_DEADLINE_MS = 2 * 60_000;

function imageError(outcome: "not_started" | "failed" | "uncertain", code: string, message: string,
  evidence: Record<string, unknown> = {}): OrbitalError {
  return new OrbitalError(outcome, code, message, evidence);
}

function sdkOptions(config: E2BProviderConfig) {
  const domain = config.domain ?? "e2b.app";
  return { apiKey: config.apiKey, domain, apiUrl: config.apiUrl ?? `https://api.${domain}`,
    requestTimeoutMs: config.requestTimeoutMs, retries: 0 };
}

function scopeFor(config: E2BProviderConfig): string {
  const options = sdkOptions(config);
  return createHash("sha256").update(JSON.stringify([
    "e2b-scope-v1", options.apiUrl, options.domain,
    createHash("sha256").update(config.apiKey).digest("hex"),
  ])).digest("hex");
}

function referenceParts(reference: string): { name: string; tag: string } {
  const colon = reference.lastIndexOf(":");
  const slash = reference.lastIndexOf("/");
  if (colon > slash) return { name: reference.slice(0, colon), tag: reference.slice(colon + 1) };
  return { name: reference, tag: "default" };
}

function rejected(cause: unknown): boolean {
  return cause instanceof AuthenticationError || cause instanceof InvalidArgumentError ||
    cause instanceof NotFoundError || cause instanceof RateLimitError;
}

function missing(cause: unknown): boolean {
  if (cause instanceof SandboxError) return cause.statusCode === 404;
  // SDK 2.51 wraps build-status HTTP errors in BuildError without statusCode.
  return cause instanceof BuildError && /^404: /.test(cause.message);
}

function statusCode(cause: unknown): number | undefined {
  if (cause instanceof SandboxError) return cause.statusCode;
  if (cause instanceof BuildError) {
    const match = /^(\d{3}): /.exec(cause.message);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function createE2BImageEffects(config: E2BProviderConfig & { cacheDirectory?: string }): ImageEffects {
  if (!config.apiKey) throw imageError("not_started", "missing_api_key", "E2B_API_KEY is required.");
  const options = sdkOptions(config);
  const scope = scopeFor(config);

  async function apiGet(path: string): Promise<{ data: unknown; nextToken?: string } | undefined> {
    let response: Response;
    try {
      response = await fetch(`${options.apiUrl}${path}`, {
        headers: { "X-API-KEY": config.apiKey }, signal: AbortSignal.timeout(config.requestTimeoutMs ?? 60_000),
      });
    } catch (cause) {
      throw imageError("not_started", "image_lookup_failed", "The E2B image lookup failed.",
        { cause: cause instanceof Error ? cause.name : "unknown" });
    }
    if (response.status === 404) return undefined;
    if (!response.ok) throw imageError("not_started", "image_lookup_failed", "E2B rejected the image lookup.",
      { statusCode: response.status });
    let data: unknown;
    try { data = await response.json(); }
    catch (cause) {
      throw imageError("not_started", "image_lookup_failed", "The E2B image lookup returned invalid data.",
        { statusCode: response.status, cause: cause instanceof Error ? cause.name : "unknown" });
    }
    return { data, nextToken: response.headers.get("X-Next-Token") ?? undefined };
  }

  async function regularBuild(name: string, buildId: string): Promise<{ templateId: string; status: string } | undefined> {
    let templateId = name;
    let page = await apiGet(`/templates/${encodeURIComponent(templateId)}?limit=100`);
    if (!page) {
      const alias = await apiGet(`/templates/aliases/${encodeURIComponent(name)}`);
      if (!alias) return undefined;
      if (!alias.data || typeof alias.data !== "object" ||
        typeof (alias.data as { templateID?: unknown }).templateID !== "string") {
        throw imageError("not_started", "image_lookup_failed", "The E2B image alias has invalid data.");
      }
      templateId = (alias.data as { templateID: string }).templateID;
      page = await apiGet(`/templates/${encodeURIComponent(templateId)}?limit=100`);
      if (!page) return undefined;
    }
    for (let count = 0; count < 100; count++) {
      const data = page.data as { templateID?: unknown; builds?: Array<{ buildID?: unknown; status?: unknown }> };
      if (!data || typeof data !== "object" || data.templateID !== templateId || !Array.isArray(data.builds)) {
        throw imageError("not_started", "image_lookup_failed", "The E2B image build list has invalid data.");
      }
      const build = data.builds.find((item) => item.buildID === buildId);
      if (build) {
        if (typeof build.status !== "string") throw imageError("not_started", "image_lookup_failed", "The E2B image build has invalid status.");
        return { templateId, status: build.status };
      }
      if (!page.nextToken) return undefined;
      page = await apiGet(`/templates/${encodeURIComponent(templateId)}?limit=100&nextToken=${encodeURIComponent(page.nextToken)}`);
      if (!page) return undefined;
    }
    throw imageError("not_started", "image_lookup_failed", "The E2B image build list exceeded the page limit.");
  }

  async function snapshotReference(snapshotId: string): Promise<string | undefined> {
    try {
      const paginator = Sandbox.listSnapshots({ ...options, name: snapshotId, limit: 20 });
      while (paginator.hasNext) {
        const snapshots = await paginator.nextItems();
        const match = snapshots.find((snapshot) => snapshot.snapshotId === snapshotId ||
          !snapshotId.includes("/") && snapshot.snapshotId.endsWith(`/${snapshotId}`));
        if (match) return match.snapshotId;
      }
      return undefined;
    } catch (cause) {
      if (missing(cause)) return undefined;
      throw imageError("not_started", "image_lookup_failed", "The captured image could not be inspected.",
        { reference: snapshotId, cause: cause instanceof Error ? cause.name : "unknown", statusCode: statusCode(cause) });
    }
  }

  async function templateArtifact(reference: string): Promise<ImageArtifact> {
    const { name, tag } = referenceParts(reference);
    const snapshotId = `${name}:default`;
    const foundSnapshotId = await snapshotReference(snapshotId);
    if (foundSnapshotId) {
      const canonicalName = referenceParts(foundSnapshotId).name;
      let tags: Awaited<ReturnType<typeof Template.getTags>>;
      try { tags = await Template.getTags(canonicalName, options); }
      catch (cause) {
        if (missing(cause)) throw imageError("not_started", "image_missing", "The captured image tag does not exist.", { reference });
        throw imageError("not_started", "image_lookup_failed", "The captured image tag could not be inspected.",
          { reference, cause: cause instanceof Error ? cause.name : "unknown", statusCode: statusCode(cause) });
      }
      const match = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tag)
        ? tags.find((item) => item.buildId === tag)
        : tags.find((item) => item.tag === tag);
      if (!match) throw imageError("not_started", "image_unavailable", "The captured image build is not accessible.", { reference });
      return { reference: `${canonicalName}:${match.buildId}`, templateId: canonicalName, buildId: match.buildId,
        kind: "snapshot", snapshotId: foundSnapshotId };
    }
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(tag)) {
      const build = await regularBuild(name, tag);
      if (!build) throw imageError("not_started", "image_missing", "The requested E2B image build does not exist.", { reference });
      if (build.status !== "ready") throw imageError("not_started", "image_unavailable", "The requested E2B image is not ready.",
        { reference, status: build.status });
      return { reference, templateId: build.templateId, buildId: tag, kind: "template" };
    }
    let tags: Awaited<ReturnType<typeof Template.getTags>>;
    try {
      tags = await Template.getTags(name, options);
    } catch (cause) {
      if (missing(cause)) {
        throw imageError("not_started", "image_missing", "The requested E2B image does not exist.", { reference });
      }
      throw imageError("not_started", "image_lookup_failed", "The requested E2B image could not be inspected.",
        { reference, cause: cause instanceof Error ? cause.name : "unknown", statusCode: statusCode(cause) });
    }
    const match = tags.find((item) => item.tag === tag);
    if (!match) throw imageError("not_started", "image_missing", "The requested E2B image tag does not exist.", { reference });
    const build = await regularBuild(name, match.buildId);
    if (!build) throw imageError("not_started", "image_missing", "The requested E2B image build does not exist.", { reference });
    if (build.status !== "ready") throw imageError("not_started", "image_unavailable", "The requested E2B image is not ready.",
      { reference, status: build.status });
    return { reference: `${name}:${match.buildId}`, templateId: build.templateId, buildId: match.buildId, kind: "template" };
  }

  async function available(artifact: ImageArtifact): Promise<boolean> {
    if (artifact.kind === "snapshot") {
      const snapshotId = artifact.snapshotId ?? `${referenceParts(artifact.reference).name}:default`;
      if (!await snapshotReference(snapshotId)) return false;
      const current = await templateArtifact(artifact.reference);
      return current.kind === "snapshot" && current.buildId === artifact.buildId;
    }
    try {
      const build = await regularBuild(artifact.templateId, artifact.buildId!);
      if (!build) return false;
      if (build.status !== "ready") {
        throw imageError("not_started", "image_not_ready", "The exact image build is not ready.",
          { reference: artifact.reference, status: build.status });
      }
      return true;
    } catch (cause) {
      if (missing(cause)) return false;
      if (cause instanceof OrbitalError) throw cause;
      throw imageError("not_started", "image_lookup_failed", "The exact image build could not be inspected.",
        { reference: artifact.reference, cause: cause instanceof Error ? cause.name : "unknown", statusCode: statusCode(cause) });
    }
  }

  return {
    scope,
    available,
    external: templateArtifact,
    recipe: orbitalRecipe,
    async findBuild(name): Promise<ImageBuild | undefined> {
      const alias = await apiGet(`/templates/aliases/${encodeURIComponent(name)}`);
      if (!alias) return undefined;
      const templateId = (alias.data as { templateID?: unknown })?.templateID;
      if (typeof templateId !== "string" || !templateId) {
        throw imageError("not_started", "image_lookup_failed", "The E2B image alias has invalid data.");
      }
      let nextToken: string | undefined;
      let pending: ImageBuild | undefined;
      let failed: ImageBuild | undefined;
      for (let count = 0; count < 100; count++) {
        const page = await apiGet(`/templates/${encodeURIComponent(templateId)}?limit=100${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ""}`);
        if (!page) throw imageError("not_started", "image_lookup_failed", "The E2B image disappeared during lookup.");
        const data = page.data as { templateID?: unknown; builds?: Array<{ buildID?: unknown; status?: unknown }> };
        if (!data || data.templateID !== templateId || !Array.isArray(data.builds)) {
          throw imageError("not_started", "image_lookup_failed", "The E2B image build list has invalid data.");
        }
        for (const build of data.builds) {
          if (!build || typeof build.buildID !== "string" || !build.buildID ||
            !["waiting", "building", "ready", "error"].includes(build.status as string)) {
            throw imageError("not_started", "image_lookup_failed", "The E2B image build has invalid data.");
          }
          const result: ImageBuild = { artifact: { reference: `${name}:${build.buildID}`, templateId,
            buildId: build.buildID, kind: "template" }, status: build.status as ImageBuild["status"] };
          if (result.status === "ready") return result;
          if (result.status === "error") failed ??= result;
          else pending ??= result;
        }
        nextToken = page.nextToken;
        if (!nextToken) {
          if (pending || failed) return pending ?? failed;
          throw imageError("not_started", "image_lookup_failed", "The E2B image has no visible builds.");
        }
      }
      throw imageError("not_started", "image_lookup_failed", "The E2B image build list exceeded the page limit.");
    },
    async submitBuild(name: string, recipe: BaseRecipe, observer?: Observer): Promise<ImageArtifact> {
      if (observer?.signal?.aborted) throw imageError("not_started", "cancelled", "Base build was cancelled before submission.");
      let result: Awaited<ReturnType<typeof Template.buildInBackground>>;
      try {
        result = await Template.buildInBackground(recipe.template as ReturnType<typeof Template>, name,
          { ...options, cpuCount: recipe.cpuCount, memoryMB: recipe.memoryMB });
      } catch (cause) {
        if (rejected(cause)) throw imageError("not_started", "base_build_rejected", "E2B rejected the base build.", { name, cause: (cause as Error).name });
        throw imageError("uncertain", "base_build_unknown", "The E2B base build result is unknown.",
          { name, cause: cause instanceof Error ? cause.name : "unknown" });
      }
      const artifact: ImageArtifact = { reference: `${name}:${result.buildId}`, templateId: result.templateId,
        buildId: result.buildId, kind: "template" };
      return artifact;
    },
    async waitForBuild(artifact, observer): Promise<void> {
      const { templateId, buildId } = artifact;
      if (!buildId) throw imageError("not_started", "invalid_build", "A build ID is required.");
      const startedAt = Date.now();
      while (true) {
        if (observer?.signal?.aborted) throw imageError("uncertain", "base_build_cancelled", "The base build remains active after cancellation.",
          { templateId, buildId });
        let status: Awaited<ReturnType<typeof Template.getBuildStatus>>;
        try { status = await Template.getBuildStatus({ templateId, buildId }, options); }
        catch (cause) {
          throw imageError("uncertain", "base_build_status_unknown", "The base build status could not be read.",
            { templateId, buildId,
              cause: cause instanceof Error ? cause.name : "unknown" });
        }
        if (status.status === "ready") return;
        if (status.status === "error") throw imageError("failed", "base_build_failed", "The E2B base build failed.",
          { templateId, buildId, reason: status.reason?.message });
        if (Date.now() - startedAt > 30 * 60_000) throw imageError("uncertain", "base_build_deadline", "The base build exceeded its observation deadline.",
          { templateId, buildId });
        await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
      }
    },
    async createSeed(base: ImageArtifact, attemptId: string): Promise<ImageSeed> {
      if (!config.cacheDirectory) throw imageError("not_started", "missing_cache_directory", "A cache directory is required for preparation logs.");
      const logDirectory = join(config.cacheDirectory, scope, "logs");
      const logPath = join(logDirectory, `${attemptId}.log`);
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      let sandbox: Sandbox;
      try {
        sandbox = await Sandbox.create(base.reference, {
          ...options, timeoutMs: SEED_LEASE_MS,
          metadata: { orbital_v2_preparation_attempt: attemptId },
          envs: {}, lifecycle: { onTimeout: "kill", autoResume: false },
          network: { allowPublicTraffic: true },
        });
      } catch (cause) {
        if (rejected(cause)) throw imageError("not_started", "seed_create_rejected", "E2B rejected the preparation seed.",
          { attemptId, cause: (cause as Error).name });
        throw imageError("uncertain", "seed_create_unknown", "The preparation seed result is unknown.",
          { attemptId, cause: cause instanceof Error ? cause.name : "unknown" });
      }
      const scriptPath = `/tmp/orbital-preparation-${attemptId}.sh`;
      const receiptPath = `/tmp/orbital-preparation-${attemptId}.status`;
      return {
        id: sandbox.sandboxId,
        async writeScript(script) {
          try { await sandbox.files.write(scriptPath, script); }
          catch (cause) {
            throw imageError("uncertain", "script_write_unknown", "The preparation script write is unconfirmed.",
              { seedId: sandbox.sandboxId, scriptPath, cause: cause instanceof Error ? cause.name : "unknown" });
          }
        },
        async runScript(observer) {
          if (observer?.signal?.aborted) throw imageError("not_started", "cancelled_before_script", "Preparation was cancelled before execution.");
          const command = `bash -c 'set +e; timeout --signal=TERM --kill-after=10s 1200s bash -euo pipefail ${scriptPath}; result=$?; printf "%s\\n" "$result" > ${receiptPath}.pending; mv ${receiptPath}.pending ${receiptPath}; exit "$result"'`;
          let outputFailure: unknown;
          const output = async (chunk: string): Promise<void> => {
            try { await appendFile(logPath, chunk, { mode: 0o600 }); }
            catch (cause) { outputFailure = cause; }
            observer?.onOutput?.(chunk);
          };
          let handle: Awaited<ReturnType<typeof sandbox.commands.run>>;
          try {
            handle = await sandbox.commands.run(command, { background: true, timeoutMs: 0,
              user: "user", cwd: "/home/user", onStdout: output, onStderr: output });
          } catch (cause) {
            throw imageError("uncertain", "script_launch_unknown", "The preparation script may have started.",
              { seedId: sandbox.sandboxId, receiptPath, logPath, cause: cause instanceof Error ? cause.name : "unknown" });
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let abort: (() => void) | undefined;
          const stopped = new Promise<"timeout" | "cancelled">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), SCRIPT_DEADLINE_MS + 20_000);
            abort = () => resolve("cancelled");
            observer?.signal?.addEventListener("abort", abort, { once: true });
            if (observer?.signal?.aborted) resolve("cancelled");
          });
          try {
            const settled = await Promise.race([
              handle.wait().then(() => "finished" as const, (cause) => cause), stopped,
            ]);
            if (settled === "timeout" || settled === "cancelled") {
              let killed: boolean;
              try { killed = await Sandbox.kill(sandbox.sandboxId, options); }
              catch (cause) {
                throw imageError("uncertain", "script_termination_unknown", "The preparation script may still be running.",
                  { seedId: sandbox.sandboxId, receiptPath, logPath, cause: cause instanceof Error ? cause.name : "unknown" });
              }
              if (!killed) throw imageError("uncertain", "script_termination_unknown", "The preparation script termination is unconfirmed.",
                { seedId: sandbox.sandboxId, receiptPath, logPath });
              throw imageError("failed", settled === "timeout" ? "script_timed_out" : "script_cancelled",
                settled === "timeout" ? "The preparation script exceeded its deadline." : "The preparation script was cancelled.",
                { seedId: sandbox.sandboxId, receiptPath, logPath });
            }
            let receipt: string;
            try { receipt = (await sandbox.files.read(receiptPath)).trim(); }
            catch (cause) {
              throw imageError("uncertain", "script_result_unknown", "The preparation script result could not be read.",
                { seedId: sandbox.sandboxId, receiptPath, logPath, cause: cause instanceof Error ? cause.name : "unknown" });
            }
            const exitCode = Number(receipt);
            if (!/^\d+$/.test(receipt) || !Number.isSafeInteger(exitCode)) {
              throw imageError("uncertain", "script_result_unknown", "The preparation script result is invalid.",
                { seedId: sandbox.sandboxId, receiptPath, logPath, receipt });
            }
            if (exitCode !== 0) {
              throw imageError("failed", exitCode === 124 ? "script_timed_out" : "script_failed", "The preparation script exited with an error.",
                { seedId: sandbox.sandboxId, receiptPath, logPath, exitCode });
            }
            if (outputFailure) throw imageError("uncertain", "script_log_unknown", "The preparation output could not be saved.",
              { seedId: sandbox.sandboxId, logPath, cause: outputFailure instanceof Error ? outputFailure.name : "unknown" });
          } finally {
            if (timeout) clearTimeout(timeout);
            if (abort) observer?.signal?.removeEventListener("abort", abort);
          }
        },
        async checkRuntime(observer) {
          if (observer?.signal?.aborted) throw imageError("failed", "preparation_cancelled", "Preparation was cancelled before the runtime check.");
          try {
            await sandbox.commands.run(runtimeCheckCommand, { user: "user", cwd: "/home/user", timeoutMs: CHECK_DEADLINE_MS,
              onStdout: (chunk) => observer?.onOutput?.(chunk), onStderr: (chunk) => observer?.onOutput?.(chunk) });
          } catch (cause) {
            if (cause instanceof CommandExitError) throw imageError("failed", "runtime_check_failed", "The prepared image failed its runtime check.",
              { seedId: sandbox.sandboxId, exitCode: cause.exitCode });
            throw imageError("uncertain", "runtime_check_unknown", "The runtime check result is unknown.",
              { seedId: sandbox.sandboxId, cause: cause instanceof Error ? cause.name : "unknown" });
          }
        },
        async capture(name) {
          try {
            const snapshot = await Sandbox.createSnapshot(sandbox.sandboxId, { ...options, name });
            return templateArtifact(snapshot.snapshotId);
          } catch (cause) {
            if (rejected(cause)) throw imageError("failed", "capture_rejected", "E2B rejected the image capture.",
              { seedId: sandbox.sandboxId, name, cause: (cause as Error).name });
            throw imageError("uncertain", "capture_unknown", "The image capture result is unknown.",
              { seedId: sandbox.sandboxId, name, cause: cause instanceof Error ? cause.name : "unknown" });
          }
        },
        async delete() {
          try { await Sandbox.kill(sandbox.sandboxId, options); }
          catch (cause) {
            throw imageError("uncertain", "seed_cleanup_unknown", "The preparation seed deletion is unconfirmed.",
              { seedId: sandbox.sandboxId, cause: cause instanceof Error ? cause.name : "unknown" });
          }
        },
      };
    },
  };
}

export function createE2BImages(config: E2BProviderConfig & { cacheDirectory: string }): Images {
  if (!config.cacheDirectory) throw imageError("not_started", "missing_cache_directory", "A cache directory is required.");
  const effects = createE2BImageEffects(config);
  const images = createImages(effects, new ImageRecords(config.cacheDirectory, effects.scope));
  return {
    async ensure(request, observer) {
      try { return await images.ensure(request, observer); }
      catch (cause) {
        if (cause instanceof OrbitalError && cause.evidence.stage) throw cause;
        const validation = cause instanceof OrbitalError && (
          cause.code.startsWith("invalid_") || cause.code === "external_refresh_unsupported" || cause.code === "cancelled");
        if (cause instanceof OrbitalError) {
          throw imageError(cause.outcome, cause.code, cause.message,
            { ...cause.evidence, stage: validation ? "validation" : "lookup" });
        }
        throw imageError("uncertain", "image_lookup_unknown", "The image cache could not be inspected.",
          { stage: "lookup", cause: cause instanceof Error ? cause.name : "unknown" });
      }
    },
  };
}

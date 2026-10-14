import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  AuthenticationError,
  CommandExitError,
  InvalidArgumentError,
  NotFoundError,
  RateLimitError,
  Sandbox,
  Template,
} from "e2b";

import { createImages, type BaseRecipe, type ImageBuild, type ImageEffects, type ImageSeed } from "../lifecycle/images/preparation.js";
import { OrbitalError, type Observer } from "../operations.js";
import type { Images } from "../lifecycle/images/types.js";
import { orbitalRecipe, runtimeCheckCommand } from "../e2b/recipe.js";
import { ImageRecords, type ImageArtifact } from "../lifecycle/images/records.js";
import type { E2BProviderConfig } from "./provider.js";
import type { ImageResources } from "../configuration/settings.js";
import { createImageRegistry, imageError, sdkOptions } from "./image-registry.js";

// E2B image effects: identity lookups through the registry, base builds, and preparation seeds.
// The preparation policy (cache, attempts, publication) lives in lifecycle/images/preparation.

type ResourceSelection = Partial<ImageResources> | (() => Partial<ImageResources> | Promise<Partial<ImageResources>>);

const SEED_LEASE_MS = 30 * 60_000;
const SCRIPT_DEADLINE_MS = 20 * 60_000;
const CHECK_DEADLINE_MS = 2 * 60_000;

// The cache scope separates records by API endpoint and credential, without storing the key.
function scopeFor(config: E2BProviderConfig): string {
  const options = sdkOptions(config);
  return createHash("sha256").update(JSON.stringify([
    "e2b-scope-v1", options.apiUrl, options.domain,
    createHash("sha256").update(config.apiKey).digest("hex"),
  ])).digest("hex");
}

// The SDK rejected the request outright. Anything else leaves the remote outcome unknown.
function rejected(cause: unknown): boolean {
  return cause instanceof AuthenticationError || cause instanceof InvalidArgumentError ||
    cause instanceof NotFoundError || cause instanceof RateLimitError;
}

export function createE2BImageEffects(config: E2BProviderConfig & { cacheDirectory?: string; resources?: ResourceSelection }): ImageEffects {
  if (!config.apiKey) throw imageError("not_started", "missing_api_key", "E2B_API_KEY is required.");
  const options = sdkOptions(config);
  const scope = scopeFor(config);
  const registry = createImageRegistry(config);

  return {
    scope,
    available: registry.available,
    external: registry.resolve,
    findReusableBuild: registry.findReusableBuild,
    recipe: async () => orbitalRecipe(typeof config.resources === "function" ? await config.resources() : config.resources),
    async submitBuild(name: string, recipe: BaseRecipe, observer?: Observer): Promise<ImageArtifact> {
      if (observer?.signal?.aborted) throw imageError("not_started", "cancelled", "Base build was cancelled before submission.");
      let result: Awaited<ReturnType<typeof Template.buildInBackground>>;
      try {
        result = await Template.buildInBackground(recipe.template as ReturnType<typeof Template>, name,
          { ...options, cpuCount: recipe.cpuCount, memoryMB: recipe.memoryMB,
            ...(recipe.minFreeDiskMb === undefined ? {} : { minFreeDiskMb: recipe.minFreeDiskMb }) });
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
          // The script and its exit receipt are preparation scaffolding, not image content.
          // Removal is best effort: a leftover file does not change the captured runtime.
          await sandbox.commands.run(`rm -f -- ${scriptPath} ${receiptPath}`, { user: "user", timeoutMs: 30_000 })
            .catch(() => undefined);
          try {
            const snapshot = await Sandbox.createSnapshot(sandbox.sandboxId, { ...options, name });
            return registry.resolve(snapshot.snapshotId);
          } catch (cause) {
            if (rejected(cause)) throw imageError("failed", "capture_rejected", "E2B rejected the image capture.",
              { seedId: sandbox.sandboxId, name, cause: (cause as Error).name });
            throw imageError("uncertain", "capture_unknown", "The image capture result is unknown.",
              { seedId: sandbox.sandboxId, name, cause: cause instanceof Error ? cause.name : "unknown" });
          }
        },
        // A false result means the seed was already gone, which is the wanted end state.
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

export function createE2BImages(config: E2BProviderConfig & { cacheDirectory: string; resources?: ResourceSelection }): Images {
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

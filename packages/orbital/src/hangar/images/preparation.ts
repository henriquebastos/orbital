import { createHash, randomUUID } from "node:crypto";

import { OrbitalError, type Observer } from "../../operations.js";
import type { Images, PrepareRequest, PreparedImage } from "./types.js";
import { normalizeImageRequest } from "../creation.js";
import { ImageRecords, type ImageArtifact, type ImageAttempt, type ReadyImageRecord } from "./records.js";

export const PREPARATION_CONTRACT_VERSION = 1;

export interface BaseRecipe {
  sourceHash: string;
  template: unknown;
  cpuCount: number;
  memoryMB: number;
}

export interface ImageBuild {
  artifact: ImageArtifact;
  status: "waiting" | "building" | "ready" | "error";
}

export function baseImageName(sourceHash: string): string {
  return `orbital-base-${sourceHash}`;
}

export interface ImageSeed {
  id: string;
  writeScript(script: string): Promise<void>;
  runScript(observer?: Observer): Promise<void>;
  checkRuntime(observer?: Observer): Promise<void>;
  capture(name: string): Promise<ImageArtifact>;
  delete(): Promise<void>;
}

export interface ImageEffects {
  scope: string;
  available(artifact: ImageArtifact): Promise<boolean>;
  external(reference: string): Promise<ImageArtifact>;
  recipe(): Promise<BaseRecipe>;
  findBuild(name: string): Promise<ImageBuild | undefined>;
  submitBuild(name: string, recipe: BaseRecipe, observer?: Observer): Promise<ImageArtifact>;
  waitForBuild(artifact: ImageArtifact, observer?: Observer): Promise<void>;
  createSeed(base: ImageArtifact, attemptId: string): Promise<ImageSeed>;
}

function digest(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function cancelled(observer?: Observer): void {
  if (observer?.signal?.aborted) {
    throw new OrbitalError("not_started", "cancelled", "Image preparation was cancelled before submission.");
  }
}

function unresolved(attempt: ImageAttempt | undefined): void {
  if (attempt?.state === "active" || attempt?.state === "uncertain") {
    throw new OrbitalError("uncertain", "image_attempt_unresolved", "An earlier image attempt has no known result.",
      { attemptId: attempt.attemptId, stage: attempt.stage, seedId: attempt.seedId, artifact: attempt.artifact });
  }
}

function issue(cause: unknown, stage: string, attempt: ImageAttempt): OrbitalError {
  if (cause instanceof OrbitalError) {
    return new OrbitalError(cause.outcome, cause.code, cause.message,
      { ...cause.evidence, stage, attemptId: attempt.attemptId, seedId: attempt.seedId,
        artifact: attempt.artifact, generationName: attempt.generationName });
  }
  return new OrbitalError("uncertain", "image_operation_unknown", "The image operation has no confirmed result.",
    { stage, attemptId: attempt.attemptId, seedId: attempt.seedId,
      artifact: attempt.artifact, generationName: attempt.generationName,
      cause: cause instanceof Error ? cause.name : "unknown" });
}

export function createImages(effects: ImageEffects, records: ImageRecords): Images {
  const pending = new Map<string, Promise<unknown>>();
  const basePending = new Map<string, Promise<unknown>>();

  function queue<T>(items: Map<string, Promise<unknown>>, key: string, operation: () => Promise<T>): Promise<T> {
    const prior = items.get(key);
    const current = (prior ? prior.catch(() => undefined) : Promise.resolve()).then(operation);
    items.set(key, current);
    void current.finally(() => {
      if (items.get(key) === current) items.delete(key);
    }).catch(() => undefined);
    return current;
  }

  async function saveAttempt(attempt: ImageAttempt, stage: string, changes: Partial<ImageAttempt> = {}): Promise<void> {
    Object.assign(attempt, changes, { stage, updatedAt: new Date().toISOString() });
    try { await records.writeAttempt(attempt); }
    catch (cause) {
      throw new OrbitalError("uncertain", "image_record_write_failed", "The image attempt record could not be saved.",
        { stage, attemptId: attempt.attemptId, seedId: attempt.seedId,
          artifact: attempt.artifact, generationName: attempt.generationName,
          cause: cause instanceof Error ? cause.name : "unknown" });
    }
  }

  async function ready(key: string): Promise<ReadyImageRecord | undefined> {
    const record = await records.ready(key);
    if (!record) return undefined;
    if (await effects.available(record.artifact)) return record;
    return undefined;
  }

  async function recover(key: string, sourceHash?: string, preparationHash?: string, observer?: Observer): Promise<ImageArtifact | undefined> {
    const attempt = await records.attempt(key);
    if (attempt?.state !== "active" && attempt?.state !== "uncertain") return undefined;
    if (!attempt.artifact || !attempt.base && preparationHash !== undefined) unresolved(attempt);
    let available: boolean;
    try { available = await effects.available(attempt.artifact!); }
    catch (cause) {
      if (cause instanceof OrbitalError && cause.code === "image_not_ready") unresolved(attempt);
      throw cause;
    }
    if (!available) unresolved(attempt);
    const artifact = attempt.artifact!;
    const record: ReadyImageRecord = { version: 1, key, scope: effects.scope, attemptId: attempt.attemptId,
      base: attempt.base ?? artifact, artifact, sourceHash, preparationHash,
      contractVersion: PREPARATION_CONTRACT_VERSION, createdAt: new Date().toISOString() };
    await records.writeReady(record);
    await saveAttempt(attempt, "ready", { state: "ready", cleanup: attempt.seedId ? attempt.cleanup ?? "unknown" : attempt.cleanup });
    if (attempt.seedId && attempt.cleanup !== "deleted") observer?.onProgress?.({ phase: "seed_cleanup_unknown" });
    observer?.onProgress?.({ phase: "image_recovered" });
    return artifact;
  }

  async function baseOnce(request: PrepareRequest, observer?: Observer): Promise<{ artifact: ImageArtifact; reused: boolean }> {
    if (request.image !== undefined) {
      observer?.onProgress?.({ phase: "resolving_image" });
      const artifact = await effects.external(request.image);
      if (!await effects.available(artifact)) {
        throw new OrbitalError("not_started", "image_unavailable", "The external image is not ready.", { reference: request.image });
      }
      return { artifact, reused: true };
    }
    const recipe = await effects.recipe();
    const key = digest(["base", effects.scope, recipe.sourceHash, recipe.cpuCount, recipe.memoryMB]);
    if (!request.refresh || request.preparation !== undefined) {
      const found = await ready(key);
      if (found) return { artifact: found.artifact, reused: true };
    }
    const recovered = await recover(key, recipe.sourceHash, undefined, observer);
    if (recovered) return { artifact: recovered, reused: true };
    unresolved(await records.attempt(key));
    cancelled(observer);
    const attempt: ImageAttempt = { version: 1, key, scope: effects.scope, attemptId: randomUUID(),
      state: "active", stage: "build_intent", updatedAt: new Date().toISOString() };
    const name = baseImageName(recipe.sourceHash);
    const existing = !request.refresh || request.preparation !== undefined ? await effects.findBuild(name) : undefined;
    attempt.generationName = name;
    await records.writeAttempt(attempt);
    const reuse = existing !== undefined && existing.status !== "error";
    observer?.onProgress?.({ phase: reuse ? "reusing_base" : "building_base" });
    try {
      const artifact = reuse ? existing.artifact : await effects.submitBuild(name, recipe, observer);
      await saveAttempt(attempt, "base_build_submitted", { artifact });
      if (!reuse || existing.status !== "ready") await effects.waitForBuild(artifact, observer);
      await saveAttempt(attempt, "base_built", { artifact });
      if (!await effects.available(artifact)) {
        throw new OrbitalError("failed", "base_unavailable", "The built base image is not ready.", { reference: artifact.reference });
      }
      const record: ReadyImageRecord = { version: 1, key, scope: effects.scope, attemptId: attempt.attemptId,
        base: artifact, artifact, sourceHash: recipe.sourceHash, contractVersion: PREPARATION_CONTRACT_VERSION,
        createdAt: new Date().toISOString() };
      await records.writeReady(record);
      await saveAttempt(attempt, "ready", { state: "ready" });
      return { artifact, reused: reuse };
    } catch (cause) {
      const error = issue(cause, attempt.stage, attempt);
      await saveAttempt(attempt, attempt.stage, { state: error.outcome === "uncertain" ||
        (attempt.artifact !== undefined && error.outcome === "not_started") ? "uncertain" : "failed",
        detail: error.evidence });
      throw error;
    }
  }

  function base(request: PrepareRequest, observer?: Observer): Promise<{ artifact: ImageArtifact; reused: boolean }> {
    const key = digest(["base_queue", request.image]);
    return queue(basePending, key, () => baseOnce(request, observer));
  }

  async function ensureOnce(request: PrepareRequest, observer?: Observer): Promise<PreparedImage> {
    const normalized = normalizeImageRequest(request);
    const refresh = request.refresh === true;
    if (request.refresh !== undefined && typeof request.refresh !== "boolean") {
      throw new OrbitalError("not_started", "invalid_refresh", "Refresh must be a boolean.");
    }
    if (refresh && normalized.image !== undefined && normalized.preparation === undefined) {
      throw new OrbitalError("not_started", "external_refresh_unsupported", "An external image has no base recipe to refresh.");
    }
    cancelled(observer);
    const baseResult = await base({ ...normalized, refresh }, observer);
    const resolvedBase = baseResult.artifact;
    const preparation = normalized.preparation;
    if (preparation === undefined) {
      return { reference: resolvedBase.reference, baseReference: resolvedBase.reference,
        cacheKey: digest(["base_result", effects.scope, resolvedBase.templateId, resolvedBase.buildId]),
        reused: baseResult.reused };
    }
    const scriptHash = createHash("sha256").update(preparation, "utf8").digest("hex");
    const key = digest(["preparation", effects.scope, resolvedBase.templateId, resolvedBase.buildId,
      resolvedBase.reference, scriptHash, PREPARATION_CONTRACT_VERSION, 2, 1024]);
    if (!refresh) {
      const found = await ready(key);
      if (found) {
        observer?.onProgress?.({ phase: "image_reused" });
        return { reference: found.artifact.reference, baseReference: resolvedBase.reference, cacheKey: key, reused: true };
      }
    }
    const recovered = await recover(key, undefined, scriptHash, observer);
    if (recovered) return { reference: recovered.reference, baseReference: resolvedBase.reference, cacheKey: key, reused: true };
    unresolved(await records.attempt(key));
    cancelled(observer);
    const attempt: ImageAttempt = { version: 1, key, scope: effects.scope, attemptId: randomUUID(),
      state: "active", stage: "seed_intent", base: resolvedBase, updatedAt: new Date().toISOString() };
    await records.writeAttempt(attempt);
    let seed: ImageSeed | undefined;
    let result: PreparedImage | undefined;
    let failure: OrbitalError | undefined;
    try {
      observer?.onProgress?.({ phase: "creating_preparation_seed" });
      seed = await effects.createSeed(resolvedBase, attempt.attemptId);
      await saveAttempt(attempt, "seed_created", { seedId: seed.id });
      await seed.writeScript(preparation);
      await saveAttempt(attempt, "script_written");
      observer?.onProgress?.({ phase: "preparing_image" });
      await seed.runScript(observer);
      await saveAttempt(attempt, "script_succeeded");
      observer?.onProgress?.({ phase: "checking_image" });
      await seed.checkRuntime(observer);
      await saveAttempt(attempt, "runtime_checked");
      cancelled(observer);
      const name = `orbital-v2-prepared-${key.slice(0, 12)}-${attempt.attemptId}`;
      await saveAttempt(attempt, "capture_intent", { generationName: name });
      observer?.onProgress?.({ phase: "capturing_image" });
      const artifact = await seed.capture(name);
      await saveAttempt(attempt, "captured", { artifact });
      if (!await effects.available(artifact)) {
        throw new OrbitalError("failed", "prepared_image_unavailable", "The captured image is not ready.",
          { reference: artifact.reference });
      }
      const record: ReadyImageRecord = { version: 1, key, scope: effects.scope, attemptId: attempt.attemptId,
        base: resolvedBase, artifact, preparationHash: scriptHash,
        contractVersion: PREPARATION_CONTRACT_VERSION, createdAt: new Date().toISOString() };
      await records.writeReady(record);
      await saveAttempt(attempt, "ready", { state: "ready" });
      result = { reference: artifact.reference, baseReference: resolvedBase.reference, cacheKey: key, reused: false };
    } catch (cause) {
      failure = issue(cause, attempt.stage, attempt);
      await saveAttempt(attempt, attempt.stage, { state: failure.outcome === "uncertain" ||
        (attempt.artifact !== undefined && failure.outcome === "not_started") ? "uncertain" : "failed",
        detail: failure.evidence });
    } finally {
      if (seed) {
        try {
          await seed.delete();
          await saveAttempt(attempt, attempt.stage, { cleanup: "deleted" });
        } catch (cause) {
          await saveAttempt(attempt, attempt.stage, { cleanup: "unknown",
            detail: { ...attempt.detail, cleanupCause: cause instanceof Error ? cause.name : "unknown" } });
          observer?.onProgress?.({ phase: "seed_cleanup_unknown" });
          if (!result && !failure) failure = issue(cause, "seed_cleanup", attempt);
        }
      }
    }
    if (failure) throw failure;
    if (!result) throw new Error("Image preparation ended without a result.");
    return result;
  }

  return {
    async ensure(request, observer) {
      const normalized = normalizeImageRequest(request);
      cancelled(observer);
      const captured = { ...normalized, refresh: request.refresh };
      const key = digest(["preparation_queue", captured.image, captured.preparation]);
      return queue(pending, key, () => ensureOnce(captured, observer));
    },
  };
}

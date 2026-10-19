import { checkCancellation, OrbitalError, type Observer } from "../operations.js";
import type { Provider } from "../provider.js";
import type { ImageRequest, Images, PrepareRequest } from "./images/types.js";
import { assertCreationMatches, creationIntent, normalizeImageRequest } from "./creation.js";
import { Workspace } from "../workspace.js";
import { decideDemand, type CreationIntent, type OrbSnapshot } from "../orb.js";
import { validateEnvironment } from "../environment.js";

export interface CreateRequest extends ImageRequest {
  orbId: string;
  leaseWindowMs: number;
  env?: Record<string, string>;
}

/** Coordinates Orb lifecycle and image preparation through the supplied providers. */
export function createOrbital(configuration: { provider: Provider; images?: Images }) {
  function requireId(orbId: string) {
    if (!orbId?.trim()) throw new OrbitalError("not_started", "invalid_id", "orbId is required.");
  }
  // Reuse an existing Orb: compare its saved intent, wake it when needed, and report a wake that cancellation followed.
  async function attach(existing: OrbSnapshot, intent: CreationIntent, leaseWindowMs: number, observer: Observer): Promise<OrbSnapshot> {
    assertCreationMatches(existing, intent, leaseWindowMs);
    if (existing.state === "sleeping") {
      await configuration.provider.resume(existing);
    }
    if (observer.signal?.aborted) {
      throw new OrbitalError("uncertain", "creation_cancelled", "Cancellation followed demand wake. The existing allocation remains.", { orbId: existing.orbId, resourceId: existing.resourceId });
    }
    return { ...existing, state: "running" };
  }
  return {
    async prepare(request: PrepareRequest = {}, observer: Observer = {}) {
      checkCancellation(observer);
      const normalized = normalizeImageRequest(request);
      if (!configuration.images) throw new OrbitalError("not_started", "image_manager_unavailable", "Image preparation requires an image manager.");
      return configuration.images.ensure({ ...normalized, refresh: request.refresh }, observer);
    },
    async create(request: CreateRequest, observer: Observer = {}) {
      checkCancellation(observer);
      validateEnvironment(request.env);
      // Provider admission (for E2B, the renewal key) fails before lookup, reuse, or image work.
      configuration.provider.admitEnvironment(request.env);
      request = { ...request, env: request.env === undefined ? undefined : { ...request.env } };
      requireId(request.orbId);
      if (!Number.isSafeInteger(request.leaseWindowMs) || request.leaseWindowMs < 3) {
        throw new OrbitalError("not_started", "invalid_create", "An integer lease window of at least 3 milliseconds is required.");
      }
      const imageRequest = normalizeImageRequest(request);
      const intent = creationIntent(imageRequest);
      const existing = await configuration.provider.resolve(request.orbId);
      checkCancellation(observer);
      if (existing) return attach(existing, intent, request.leaseWindowMs, observer);
      let image = imageRequest.image;
      if (configuration.images) image = (await configuration.images.ensure(imageRequest, observer)).reference;
      else if (image === undefined || imageRequest.preparation !== undefined) {
        throw new OrbitalError("not_started", "image_manager_unavailable", "Default images and preparation require an image manager.");
      }
      checkCancellation(observer);
      // Image work can be long. A concurrent create may have allocated this Orb ID meanwhile, so resolve again
      // immediately before allocating. The provider's create does not look up existing Orbs.
      const concurrent = await configuration.provider.resolve(request.orbId);
      checkCancellation(observer);
      if (concurrent) return attach(concurrent, intent, request.leaseWindowMs, observer);
      const orb = await configuration.provider.create({ orbId: request.orbId, leaseWindowMs: request.leaseWindowMs,
        image: image!, creationIntent: intent, env: request.env }, observer);
      if (observer.signal?.aborted) {
        throw new OrbitalError("uncertain", "creation_cancelled", "Creation was admitted before cancellation. The allocation may remain.", { orbId: orb.orbId, resourceId: orb.resourceId });
      }
      return orb;
    },
    async inspect({ orbId }: { orbId: string }) { requireId(orbId); return configuration.provider.resolve(orbId); },
    async url({ orbId, port }: { orbId: string; port: number }) {
      requireId(orbId);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OrbitalError("not_started", "invalid_port", "Port must be an integer from 1 to 65535.");
      const orb = await configuration.provider.resolve(orbId);
      if (!orb) throw new OrbitalError("not_started", "missing", "The orb does not exist.");
      return configuration.provider.url(orb, port);
    },
    async delete({ orbId }: { orbId: string }) {
      requireId(orbId);
      const orb = await configuration.provider.resolve(orbId);
      if (!orb) throw new OrbitalError("not_started", "missing", "The orb does not exist.");
      await configuration.provider.delete(orb);
    },
    // Resolve, wake, and bind a directory. Workspace.validateDirectory separately checks that the directory exists.
    async openWorkspace({ orbId, orbCwd }: { orbId: string; orbCwd: string }, observer: Observer = {}) {
      checkCancellation(observer);
      requireId(orbId);
      if (!orbCwd?.startsWith("/") || orbCwd.includes("\0")) {
        throw new OrbitalError("not_started", "invalid_directory", "orbCwd must be an absolute remote directory.");
      }
      const orb = await configuration.provider.resolve(orbId);
      checkCancellation(observer);
      if (!orb) throw new OrbitalError("not_started", "missing", "The orb does not exist. Create it explicitly.");
      if (decideDemand(orb.state) === "resume") {
        observer.onProgress?.({ phase: "waking", orbId: orb.orbId });
        await configuration.provider.resume(orb);
      }
      checkCancellation(observer);
      return new Workspace(configuration.provider, Object.freeze({ ...orb, state: "running" }), orbCwd, observer);
    },
  };
}

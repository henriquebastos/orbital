import { checkCancellation, OrbitalError, type Observer } from "../operations.js";
import type { Provider } from "../provider.js";
import type { ImageRequest, Images, PrepareRequest } from "./images/types.js";
import { assertCreationMatches, creationIntent, normalizeImageRequest } from "./creation.js";
import { Workspace } from "../workspace.js";
import { decideDemand } from "../orb.js";

export interface CreateRequest extends ImageRequest {
  orbId: string;
  idleTimeoutMs: number;
}

export function createOrbital(configuration: { provider: Provider; images?: Images }) {
  function requireId(orbId: string) {
    if (!orbId?.trim()) throw new OrbitalError("not_started", "invalid_id", "orbId is required.");
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
      request = { ...request };
      requireId(request.orbId);
      if (!Number.isSafeInteger(request.idleTimeoutMs) || request.idleTimeoutMs < 3) {
        throw new OrbitalError("not_started", "invalid_create", "An integer idle timeout of at least 3 milliseconds is required.");
      }
      const imageRequest = normalizeImageRequest(request);
      const intent = creationIntent(imageRequest);
      const existing = await configuration.provider.resolve(request.orbId);
      checkCancellation(observer);
      if (existing) {
        assertCreationMatches(existing, intent, request.idleTimeoutMs);
        if (existing.state === "sleeping") {
          await configuration.provider.resume(existing);
        }
        if (observer.signal?.aborted) {
          throw new OrbitalError("uncertain", "creation_cancelled", "Cancellation followed demand wake. The existing allocation remains.", { orbId: existing.orbId, resourceId: existing.resourceId });
        }
        return { ...existing, state: "running" as const };
      }
      let image = imageRequest.image;
      if (configuration.images) image = (await configuration.images.ensure(imageRequest, observer)).reference;
      else if (image === undefined || imageRequest.preparation !== undefined) {
        throw new OrbitalError("not_started", "image_manager_unavailable", "Default images and preparation require an image manager.");
      }
      checkCancellation(observer);
      const orb = await configuration.provider.create({ orbId: request.orbId, idleTimeoutMs: request.idleTimeoutMs,
        image: image!, creationIntent: intent }, observer);
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

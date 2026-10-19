import { createHash } from "node:crypto";
import { OrbitalError } from "../operations.js";
import type { CreationIntent, OrbSnapshot } from "../orb.js";
import type { ImageRequest } from "./images/types.js";

export function normalizeImageRequest(request: ImageRequest): ImageRequest {
  if (request.image !== undefined && (typeof request.image !== "string" || !request.image.trim())) {
    throw new OrbitalError("not_started", "invalid_create", "An image override must be a nonempty reference.");
  }
  if (request.preparation !== undefined && typeof request.preparation !== "string") {
    throw new OrbitalError("not_started", "invalid_preparation", "Preparation must contain Bash script text.");
  }
  return { image: request.image, preparation: request.preparation === "" ? undefined : request.preparation };
}

export function creationIntent(request: ImageRequest): CreationIntent {
  const normalized = normalizeImageRequest(request);
  return {
    ...(normalized.image === undefined ? {} : { image: normalized.image }),
    ...(normalized.preparation === undefined ? {} : {
      preparationHash: createHash("sha256").update(normalized.preparation, "utf8").digest("hex"),
    }),
  };
}

// Reuse compares original image and preparation intent and lease window, not environment or current image resources.
export function assertCreationMatches(orb: OrbSnapshot, intent: CreationIntent, leaseWindowMs: number): void {
  const expected = orb.creationIntent;
  if (expected.image !== intent.image || expected.preparationHash !== intent.preparationHash || orb.leaseWindowMs !== leaseWindowMs) {
    throw new OrbitalError("not_started", "conflict", "Creation settings conflict with the existing orb.", { orbId: orb.orbId });
  }
}

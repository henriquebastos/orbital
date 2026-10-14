import type { Observer } from "../../operations.js";

export interface ImageRequest {
  image?: string;
  preparation?: string;
}

export interface PrepareRequest extends ImageRequest {
  /** Rebuild the prepared image, or the owned base when preparation is absent. Recover unresolved artifacts before starting replacement work. */
  refresh?: boolean;
}

export interface PreparedImage {
  reference: string;
  baseReference: string;
  /** Result identity. Base-only results use an artifact key, not the recipe key used by ImageRecords. */
  cacheKey: string;
  reused: boolean;
}

export interface Images {
  ensure(request: PrepareRequest, observer?: Observer): Promise<PreparedImage>;
}

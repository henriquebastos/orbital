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
  /** The ImageRecords key of this result. An external image has no record, so its key is derived from the pinned build. */
  cacheKey: string;
  reused: boolean;
}

export interface Images {
  ensure(request: PrepareRequest, observer?: Observer): Promise<PreparedImage>;
}

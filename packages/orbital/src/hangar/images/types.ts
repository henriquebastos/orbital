import type { Observer } from "../../operations.js";

export interface ImageRequest {
  image?: string;
  preparation?: string;
}

export interface PrepareRequest extends ImageRequest {
  refresh?: boolean;
}

export interface PreparedImage {
  reference: string;
  baseReference: string;
  cacheKey: string;
  reused: boolean;
}

export interface Images {
  ensure(request: PrepareRequest, observer?: Observer): Promise<PreparedImage>;
}

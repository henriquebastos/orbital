export interface Observer {
  signal?: AbortSignal;
  onProgress?: (event: { phase: string; orbId?: string }) => void;
  onOutput?: (chunk: string) => void;
}

export class OrbitalError extends Error {
  constructor(
    public readonly outcome: "not_started" | "failed" | "uncertain",
    public readonly code: string,
    message: string,
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrbitalError";
  }
}

export function checkCancellation(observer: Observer) {
  if (observer.signal?.aborted) throw new OrbitalError("not_started", "cancelled", "The operation was cancelled before submission.");
}

import type { CreationIntent, OrbSnapshot } from "./orb.js";
import type { Observer } from "./operations.js";
import type { ExecRequest, ExecResult, FileStat } from "./workspace.js";

export interface AllocationRequest {
  orbId: string;
  image: string;
  idleTimeoutMs: number;
  creationIntent?: CreationIntent;
}

/** External effects only. The application owns policy and never retries mutations. */
export interface Provider {
  resolve(orbId: string): Promise<OrbSnapshot | undefined>;
  create(request: AllocationRequest, observer?: Observer): Promise<OrbSnapshot>;
  resume(orb: OrbSnapshot): Promise<void>;
  delete(orb: OrbSnapshot): Promise<void>;
  url(orb: OrbSnapshot, port: number): string;
  exec(orb: OrbSnapshot, request: ExecRequest & { orbCwd: string }, observer?: Observer): Promise<ExecResult>;
  readFile(orb: OrbSnapshot, path: string): Promise<Uint8Array>;
  writeFile(orb: OrbSnapshot, path: string, content: Uint8Array): Promise<void>;
  stat(orb: OrbSnapshot, path: string): Promise<FileStat>;
}

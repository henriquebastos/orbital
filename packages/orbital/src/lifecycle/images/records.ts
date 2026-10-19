import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * One pinned E2B build. `name` is the string E2B accepted at creation: the alias of an owned base,
 * the canonical `<team>/<name>` of a captured snapshot, or the user's name for an external reference.
 * `templateId` is the raw E2B template ID, resolved once.
 */
export interface ImageArtifact {
  name: string;
  templateId: string;
  buildId: string;
}

// The allocation reference. It pins the build so a later lookup cannot drift behind a tag.
export function artifactReference(artifact: ImageArtifact): string {
  return `${artifact.name}:${artifact.buildId}`;
}

export interface ReadyImageRecord {
  version: 1;
  key: string;
  scope: string;
  attemptId: string;
  base: ImageArtifact;
  artifact: ImageArtifact;
  sourceHash?: string;
  preparationHash?: string;
  contractVersion: number;
  createdAt: string;
}

export interface ImageAttempt {
  version: 1;
  key: string;
  scope: string;
  attemptId: string;
  stage: string;
  state: "active" | "failed" | "uncertain" | "ready";
  base?: ImageArtifact;
  seedId?: string;
  artifact?: ImageArtifact;
  generationName?: string;
  cleanup?: "deleted" | "unknown";
  detail?: Record<string, unknown>;
  updatedAt: string;
}

const ARTIFACT_KEYS = ["buildId", "name", "templateId"] as const;

// Exactly the structured shape. Records from earlier contracts carried other keys and are rejected.
function validArtifact(artifact: unknown): artifact is ImageArtifact {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
  const keys = Object.keys(artifact).sort();
  if (keys.length !== ARTIFACT_KEYS.length || keys.some((key, index) => key !== ARTIFACT_KEYS[index])) return false;
  return ARTIFACT_KEYS.every((key) => {
    const value = (artifact as Record<string, unknown>)[key];
    return typeof value === "string" && value.length > 0;
  });
}

async function atomicJSON(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

async function readJSON<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  }
}

export class ImageRecords {
  constructor(private readonly directory: string, private readonly scope: string) {}

  private path(type: "ready" | "attempt", key: string): string {
    return join(this.directory, this.scope, type, `${key}.json`);
  }

  async ready(key: string): Promise<ReadyImageRecord | undefined> {
    const record = await readJSON<ReadyImageRecord>(this.path("ready", key));
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) ||
      record.version !== 1 || record.key !== key || record.scope !== this.scope)) {
      throw new Error("Image cache record has an invalid identity.");
    }
    if (record !== undefined && (!record.attemptId || !validArtifact(record.artifact) || !validArtifact(record.base))) {
      throw new Error("Image cache record has an invalid artifact.");
    }
    return record;
  }

  // Both attempt readers apply the same validation. Only the identity they check differs.
  private validateAttempt(record: ImageAttempt | undefined, identity: (record: ImageAttempt) => boolean): ImageAttempt | undefined {
    if (record === undefined) return undefined;
    if (!record || typeof record !== "object" || Array.isArray(record) ||
      record.version !== 1 || record.scope !== this.scope || !identity(record)) {
      throw new Error("Image attempt record has an invalid identity.");
    }
    if (!record.attemptId || !record.stage ||
      !["active", "failed", "uncertain", "ready"].includes(record.state) ||
      record.artifact !== undefined && !validArtifact(record.artifact) ||
      record.base !== undefined && !validArtifact(record.base)) {
      throw new Error("Image attempt record has an invalid state.");
    }
    return record;
  }

  async attempt(key: string): Promise<ImageAttempt | undefined> {
    return this.validateAttempt(await readJSON<ImageAttempt>(this.path("attempt", key)), (record) => record.key === key);
  }

  /** Latest saved state of one attempt by ID, not a log of its stage transitions. */
  async attemptById(attemptId: string): Promise<ImageAttempt | undefined> {
    return this.validateAttempt(await readJSON<ImageAttempt>(join(this.directory, this.scope, "attempts", `${attemptId}.json`)),
      (record) => record.attemptId === attemptId);
  }

  async writeReady(record: ReadyImageRecord): Promise<void> {
    if (record.scope !== this.scope) throw new Error("Image scope does not match the record store.");
    await atomicJSON(this.path("ready", record.key), record);
  }

  // One attempt record is written under two indexes: attempt/<key> for the current attempt of a
  // cache key, and attempts/<attemptId> for the latest state of that attempt. Both are overwritten.
  async writeAttempt(record: ImageAttempt): Promise<void> {
    if (record.scope !== this.scope) throw new Error("Image scope does not match the record store.");
    await atomicJSON(this.path("attempt", record.key), record);
    await atomicJSON(join(this.directory, this.scope, "attempts", `${record.attemptId}.json`), record);
  }

  async keys(): Promise<string[]> {
    try { return (await readdir(join(this.directory, this.scope, "ready"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); }
    catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
      throw cause;
    }
  }
}

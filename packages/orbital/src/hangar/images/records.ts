import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ImageArtifact {
  reference: string;
  templateId: string;
  buildId?: string;
  kind: "template" | "snapshot";
  snapshotId?: string;
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

function validArtifact(artifact: unknown): artifact is ImageArtifact {
  if (!artifact || typeof artifact !== "object") return false;
  const item = artifact as Partial<ImageArtifact>;
  return typeof item.reference === "string" && item.reference.length > 0 &&
    typeof item.templateId === "string" && item.templateId.length > 0 &&
    typeof item.buildId === "string" && item.buildId.length > 0 &&
    (item.kind === "template" || item.kind === "snapshot");
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

  async attempt(key: string): Promise<ImageAttempt | undefined> {
    const record = await readJSON<ImageAttempt>(this.path("attempt", key));
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) ||
      record.version !== 1 || record.key !== key || record.scope !== this.scope)) {
      throw new Error("Image attempt record has an invalid identity.");
    }
    if (record !== undefined && (!record.attemptId || !record.stage ||
      !["active", "failed", "uncertain", "ready"].includes(record.state) ||
      record.artifact !== undefined && !validArtifact(record.artifact) ||
      record.base !== undefined && !validArtifact(record.base))) {
      throw new Error("Image attempt record has an invalid state.");
    }
    return record;
  }

  async writeReady(record: ReadyImageRecord): Promise<void> {
    if (record.scope !== this.scope) throw new Error("Image scope does not match the record store.");
    await atomicJSON(this.path("ready", record.key), record);
  }

  async writeAttempt(record: ImageAttempt): Promise<void> {
    if (record.scope !== this.scope) throw new Error("Image scope does not match the record store.");
    await atomicJSON(this.path("attempt", record.key), record);
    await atomicJSON(join(this.directory, this.scope, "history", `${record.attemptId}.json`), record);
  }

  async history(attemptId: string): Promise<ImageAttempt | undefined> {
    const record = await readJSON<ImageAttempt>(join(this.directory, this.scope, "history", `${attemptId}.json`));
    if (record !== undefined && (!record || typeof record !== "object" || Array.isArray(record) ||
      record.version !== 1 || record.scope !== this.scope || record.attemptId !== attemptId)) {
      throw new Error("Image attempt history has an invalid identity.");
    }
    return record;
  }

  async keys(): Promise<string[]> {
    try { return (await readdir(join(this.directory, this.scope, "ready"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)); }
    catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
      throw cause;
    }
  }
}

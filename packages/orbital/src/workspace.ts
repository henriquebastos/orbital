import { posix } from "node:path";
import { checkCancellation, OrbitalError, type Observer } from "./operations.js";
import type { OrbSnapshot } from "./orb.js";
import type { Provider } from "./provider.js";

export interface ExecRequest {
  command: string;
  mode?: "ordinary" | "background";
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface ExecResult {
  kind: "exited" | "background" | "cancelled" | "timed_out";
  jobId: string;
  stdout: string;
  stderr: string;
  outputPath: string;
  exitCode?: number;
}

export interface FileStat {
  kind: "file" | "directory";
  size: number;
}

export class Workspace {
  constructor(
    private readonly provider: Provider,
    public readonly orb: OrbSnapshot,
    public readonly orbCwd: string,
    private readonly observer: Observer = {},
  ) {}

  async exec(request: ExecRequest, observer: Observer = {}) {
    checkCancellation({ ...this.observer, ...observer });
    if (request.mode === "background" && request.timeoutMs !== undefined) {
      throw new OrbitalError("not_started", "invalid_timeout", "Background commands do not accept an execution timeout.");
    }
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
      throw new OrbitalError("not_started", "invalid_timeout", "An execution timeout must be a positive integer.");
    }
    try {
      return await this.provider.exec(this.orb, { ...request, orbCwd: this.orbCwd }, { ...this.observer, ...observer });
    } catch (error) {
      if (error instanceof OrbitalError) throw error;
      throw new OrbitalError("uncertain", "transport", "The command outcome is unknown. Inspect the orb before retrying.");
    }
  }

  private path(path: string) {
    if (!path || path.includes("\0")) throw new OrbitalError("not_started", "invalid_path", "A remote path without null bytes is required.");
    const expanded = path === "~" ? "/home/user" : path.startsWith("~/") ? `/home/user/${path.slice(2)}` : path;
    return posix.resolve(this.orbCwd, expanded);
  }

  readFile(path: string) { return this.provider.readFile(this.orb, this.path(path)); }
  async writeFile(path: string, content: Uint8Array) {
    checkCancellation(this.observer);
    const resolved = this.path(path);
    try { await this.provider.writeFile(this.orb, resolved, content); }
    catch (error) {
      if (error instanceof OrbitalError) throw error;
      throw new OrbitalError("uncertain", "transport", "The write outcome is unknown. Read the remote file before retrying.", { path: resolved });
    }
  }
  stat(path: string) { return this.provider.stat(this.orb, this.path(path)); }

  async validateDirectory(path: string) {
    const resolved = this.path(path);
    const quoted = `'${resolved.replaceAll("'", "'\\''")}'`;
    const result = await this.exec({ command: `cd -- ${quoted} && pwd -P` });
    if (result.kind !== "exited" || result.exitCode !== 0 || !result.stdout.startsWith("/")) {
      throw new OrbitalError("not_started", "invalid_directory", "The remote directory does not exist or cannot be entered.");
    }
    return result.stdout.replace(/\n$/, "");
  }

  async edit({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
    const original = Buffer.from(await this.readFile(path)).toString("utf8");
    if (!oldText || !original.includes(oldText) || original.indexOf(oldText) !== original.lastIndexOf(oldText)) {
      throw new OrbitalError("not_started", "edit_mismatch", "The old text must match exactly once.");
    }
    await this.writeFile(path, Buffer.from(original.replace(oldText, () => newText)));
  }
}

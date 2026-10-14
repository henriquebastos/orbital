import { posix } from "node:path";
import { OrbitalError } from "@henriquebastosnet/orbital";

// Shared helpers for the workspace tools, in four groups: remote path resolution and shell
// quoting, exact-edit validation and application, image detection and tool display formatting,
// and error conversion with evidence filtering. The first two are tool semantics, not rendering.
// Each display limit belongs to one tool contract.

// 1. Remote path resolution and shell quoting.

export const remoteHome = "/home/user";

// Resolve a tool path against the remote directory. The remote home is fixed, not discovered.
export function remotePath(cwd: string, path: string): string {
  const expanded = path === "~" ? remoteHome : path.startsWith("~/") ? `${remoteHome}/${path.slice(2)}` : path;
  if (expanded.includes("\0")) throw new Error("A remote path cannot contain a null byte.");
  return posix.resolve(cwd, expanded);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// 2. Exact-edit validation and application.

// Validate every edit against the original text, then apply them from the end backwards.
export function applyExactEdits(original: string, edits: readonly { oldText: string; newText: string }[]): string {
  const changes = edits.map(edit => {
    const index = original.indexOf(edit.oldText);
    if (!edit.oldText || index < 0 || original.indexOf(edit.oldText, index + 1) >= 0) {
      throw new Error("Each oldText must match exactly once in the original remote file.");
    }
    return { index, end: index + edit.oldText.length, newText: edit.newText };
  }).sort((a, b) => a.index - b.index);
  for (let i = 1; i < changes.length; i++) {
    if (changes[i]!.index < changes[i - 1]!.end) throw new Error("Remote edits must not overlap.");
  }
  let revised = original;
  for (const change of [...changes].reverse()) {
    revised = revised.slice(0, change.index) + change.newText + revised.slice(change.end);
  }
  return revised;
}

// 3. Image detection and tool display formatting.

export function imageMime(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (head.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (head.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

// Search and listing display: an item limit or a 50,000-byte cap both add the same notice.
export function clipSearchDisplay(text: string, path: string, itemsClipped: boolean, maxBytes = 50_000): string {
  const bytesClipped = Buffer.byteLength(text) > maxBytes;
  const shown = bytesClipped ? Buffer.from(text).subarray(0, maxBytes).toString("utf8") : text;
  return bytesClipped || itemsClipped ? `${shown}\n[Output truncated. Full output: ${path}]` : shown;
}

// Format returned stdout and stderr previews, not the tail of the full output file.
export function formatReturnedBashPreviewTail(text: string, outputPath: string): string {
  const lines = text.split("\n");
  const tail = lines.slice(-2000).join("\n");
  const shown = Buffer.from(tail).subarray(-50_000).toString("utf8");
  const clipped = Buffer.byteLength(shown) < Buffer.byteLength(text) || lines.length > 2000;
  return `${clipped ? "[Output truncated]\n" : ""}${shown}\nFull output: ${outputPath}`;
}

// Select one-based lines from the whole decoded file, then cap the display at 50,000 bytes.
export function formatRemoteTextRead(text: string, requestedOffset?: number, requestedLimit?: number): string {
  const lines = text.split("\n");
  const offset = Math.max(1, Math.floor(requestedOffset ?? 1));
  const limit = Math.max(1, Math.floor(requestedLimit ?? 2000));
  let shown = lines.slice(offset - 1, offset - 1 + limit).join("\n");
  const truncated = Buffer.byteLength(shown) > 50_000;
  if (truncated) shown = Buffer.from(shown).subarray(0, 50_000).toString("utf8");
  if (offset - 1 + limit < lines.length || truncated) shown += "\n[Read output truncated. Continue with offset.]";
  return shown;
}

// 4. Error conversion and evidence filtering.

// Orbital errors keep outcome, code, and allowlisted evidence. String evidence is clipped.
export function presentError(error: unknown): Error {
  if (!(error instanceof OrbitalError)) return error instanceof Error ? error : new Error(String(error));
  const keys = ["orbId", "resourceId", "jobId", "outputPath", "path", "partialOutput",
    "phase", "cause", "pid", "pgid", "outcome", "renewal"];
  const evidence = Object.fromEntries(keys.flatMap(key => {
    const value = error.evidence[key];
    if (value === undefined) return [];
    return [[key, typeof value === "string" ? value.slice(0, 4000) : value]];
  }));
  const details = Object.keys(evidence).length ? ` Evidence: ${JSON.stringify(evidence)}` : "";
  return new Error(`Orbital ${error.outcome} [${error.code}]: ${error.message}${details}`);
}

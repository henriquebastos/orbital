import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { Type } from "typebox";
import type { ExecResult } from "@henriquebastosnet/orbital";
import type { PiSession, ToolRegistration } from "./registration.js";
import { applyExactEdits, clipSearchDisplay, formatRemoteTextRead, formatReturnedBashPreviewTail,
  imageMime, remotePath, shellQuote } from "./presentation.js";

// The seven workspace tools. Each remote implementation is paired with its native Pi factory,
// which the registration uses for local routing.

const bashSchema = Type.Object({
  command: Type.String(),
  timeout: Type.Optional(Type.Number()),
  mode: Type.Optional(Type.Union([Type.Literal("ordinary"), Type.Literal("background")])),
});
const writeSchema = Type.Object({ path: Type.String(), content: Type.String() });
const readSchema = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});
const editSchema = Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() }), { minItems: 1 }),
});
const grepSchema = Type.Object({
  pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()),
});
const findSchema = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()) });
const lsSchema = Type.Object({ path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) });

const itemLimit = (requested: number | undefined, fallback: number) => Math.max(1, Math.floor(requested ?? fallback));

type BashParams = { command: string; timeout?: number; mode?: "ordinary" | "background" };
type ToolUpdate = (update: { content: { type: "text"; text: string }[]; details: undefined }) => void;

// Remote Bash contract: stream up to 50,000 bytes and 2000 lines as updates; the final text is
// the tail of the returned stdout plus stderr previews, not of the full output file, and always
// names the full-output path; a start receipt is returned for a background result; an ordinary
// nonzero exit or any other result kind is an error.
async function executeRemoteBash(session: PiSession, params: BashParams, signal: AbortSignal | undefined,
  onUpdate: ToolUpdate | undefined) {
  const workspace = await session.workspace({ signal });
  let streamedBytes = 0;
  let streamedLines = 0;
  const result: ExecResult = await workspace.exec({ command: params.command, mode: params.mode,
    timeoutMs: params.timeout === undefined ? undefined : params.timeout * 1000 }, {
    signal,
    onOutput(chunk) {
      const remaining = 50_000 - streamedBytes;
      if (remaining <= 0 || streamedLines >= 2000) return;
      const shown = Buffer.from(chunk).subarray(0, remaining).toString("utf8").split("\n")
        .slice(0, 2000 - streamedLines).join("\n");
      streamedBytes += Buffer.byteLength(shown);
      streamedLines += shown.split("\n").length - 1;
      if (shown) onUpdate?.({ content: [{ type: "text", text: shown }], details: undefined });
    },
  });
  const text = result.stdout + result.stderr;
  // Dispatch on the returned result kind, not the requested mode. A background request
  // returns a start receipt, or ordinary completion when the command finished early.
  if (result.kind === "background") {
    return { content: [{ type: "text" as const, text: `Started background job ${result.jobId}. Full output: ${result.outputPath}` }],
      details: { fullOutputPath: result.outputPath } };
  }
  if (result.kind !== "exited" || result.exitCode !== 0) {
    throw new Error(`Remote command ${result.kind} (${result.exitCode ?? "no exit code"}), job ${result.jobId}. ${formatReturnedBashPreviewTail(text, result.outputPath)}`);
  }
  return { content: [{ type: "text" as const, text: formatReturnedBashPreviewTail(text, result.outputPath) }],
    details: { fullOutputPath: result.outputPath } };
}

export function registerWorkspaceTools(pi: ExtensionAPI, session: PiSession, registration: ToolRegistration): void {
  registration.registerWorkspaceTool({
    name: "bash",
    label: "bash",
    description: "Run a shell command in the selected local or remote workspace. Background mode requires remote routing.",
    promptSnippet: "Execute shell commands in the selected workspace",
    parameters: bashSchema,
    execute: (_id, params, signal, onUpdate) => executeRemoteBash(session, params, signal, onUpdate),
  }, createBashToolDefinition);

  registration.registerWorkspaceTool({
    name: "write", label: "write", description: "Create or overwrite a file in the selected workspace.",
    promptSnippet: "Write files in the selected workspace", parameters: writeSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      await workspace.writeFile(params.path, Buffer.from(params.content, "utf8"));
      return { content: [{ type: "text", text: `Wrote ${params.path}` }], details: undefined };
    },
  }, createWriteToolDefinition);

  registration.registerWorkspaceTool({
    name: "read", label: "read", description: "Read a text file or image in the selected workspace.",
    promptSnippet: "Read files in the selected workspace", parameters: readSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      const bytes = await workspace.readFile(params.path);
      const mime = imageMime(bytes);
      if (mime) return { content: [{ type: "image" as const,
        data: Buffer.from(bytes).toString("base64"), mimeType: mime }], details: undefined };
      const shown = formatRemoteTextRead(Buffer.from(bytes).toString("utf8"), params.offset, params.limit);
      return { content: [{ type: "text", text: shown }], details: undefined };
    },
  }, createReadToolDefinition);

  registration.registerWorkspaceTool({
    name: "edit", label: "edit", description: "Replace exact text in one selected workspace file. Each oldText must match once in the original file, and edits must not overlap.",
    promptSnippet: "Edit files in the selected workspace", parameters: editSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      const original = Buffer.from(await workspace.readFile(params.path)).toString("utf8");
      const revised = applyExactEdits(original, params.edits);
      await workspace.writeFile(params.path, Buffer.from(revised, "utf8"));
      return { content: [{ type: "text", text: `Edited ${params.path}` }], details: undefined };
    },
  }, createEditToolDefinition);

  registration.registerWorkspaceTool({
    name: "grep", label: "grep", description: "Search text in the selected workspace. The search respects its ignore files.",
    promptSnippet: "Search file contents in the selected workspace", parameters: grepSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      const args = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", shellQuote(params.glob));
      if (params.context !== undefined) args.push("--context", String(Math.max(0, Math.floor(params.context))));
      args.push("--", shellQuote(params.pattern), shellQuote(remotePath(workspace.orbCwd, params.path ?? ".")));
      const result = await workspace.exec({ command: args.join(" ") }, { signal });
      if (result.kind !== "exited" || (result.exitCode !== 0 && result.exitCode !== 1)) {
        throw new Error(`Remote search failed: ${result.stderr || result.kind}`);
      }
      const matches: string[] = [];
      const limit = itemLimit(params.limit, 100);
      let itemsClipped = false;
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      for (const line of output.split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; data?: { path?: { text?: string };
          line_number?: number; lines?: { text?: string } } };
        if (event.type !== "match" && (params.context === undefined || event.type !== "context")) continue;
        if (matches.length >= limit) { itemsClipped = true; break; }
        const separator = event.type === "context" ? "-" : ":";
        matches.push(`${event.data?.path?.text ?? ""}${separator}${event.data?.line_number ?? 0}${separator} ${event.data?.lines?.text?.trimEnd() ?? ""}`);
      }
      const shown = matches.length ? matches.join("\n") : "No matches found";
      return { content: [{ type: "text", text: clipSearchDisplay(shown, result.outputPath, itemsClipped) }], details: undefined };
    },
  }, createGrepToolDefinition);

  registration.registerWorkspaceTool({
    name: "find", label: "find", description: "Find files by glob in the selected workspace. The search respects ignore files and returns files, not directories.",
    promptSnippet: "Find files in the selected workspace", parameters: findSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      const path = remotePath(workspace.orbCwd, params.path ?? ".");
      const result = await workspace.exec({ command: `rg --files --hidden --null --glob ${shellQuote(params.pattern)} -- ${shellQuote(path)}` }, { signal });
      if (result.kind !== "exited" || (result.exitCode !== 0 && result.exitCode !== 1)) {
        throw new Error(`Remote find failed: ${result.stderr || result.kind}`);
      }
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      const all = output.split("\0").filter(Boolean);
      const limit = itemLimit(params.limit, 1000);
      const paths = all.slice(0, limit);
      return { content: [{ type: "text", text: clipSearchDisplay(paths.join("\n") || "No files found matching pattern",
        result.outputPath, all.length > limit) }], details: undefined };
    },
  }, createFindToolDefinition);

  registration.registerWorkspaceTool({
    name: "ls", label: "ls", description: "List one directory in the selected workspace, including hidden entries.",
    promptSnippet: "List directories in the selected workspace", parameters: lsSchema,
    async execute(_id, params, signal) {
      const workspace = await session.workspace({ signal });
      const path = remotePath(workspace.orbCwd, params.path ?? ".");
      const result = await workspace.exec({ command: `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -print0` }, { signal });
      if (result.kind !== "exited" || result.exitCode !== 0) {
        throw new Error(`Remote listing failed: ${result.stderr || result.kind}`);
      }
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      const all = output.split("\0").filter(Boolean).map(item => posix.basename(item)).sort();
      const limit = itemLimit(params.limit, 1000);
      const entries = all.slice(0, limit);
      return { content: [{ type: "text", text: clipSearchDisplay(entries.join("\n") || "Empty directory",
        result.outputPath, all.length > limit) }], details: undefined };
    },
  }, createLsToolDefinition);
}

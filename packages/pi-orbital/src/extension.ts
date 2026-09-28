import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  createLsToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { AsyncLocalStorage } from "node:async_hooks";
import { Type, type TSchema } from "typebox";
import { posix } from "node:path";
import { OrbitalError, type CreateRequest, type Observer, type OrbSnapshot, type ExecResult,
  type Workspace } from "@henriquebastosnet/orbital";
import { createPiSession } from "./session.js";
import { listSkills, readSkill, readSkillAsset } from "./skill-resources.js";

export interface PiOrbitalApi {
  create(request: CreateRequest, observer?: Observer): Promise<OrbSnapshot>;
  inspect(request: { orbId: string }): Promise<OrbSnapshot | undefined>;
  delete(request: { orbId: string }): Promise<void>;
  url(request: { orbId: string; port: number }): Promise<string>;
  openWorkspace(request: { orbId: string; orbCwd: string }, observer?: Observer): Promise<Workspace>;
}

export interface PiOptions {
  image?: string;
  idleTimeoutMs: number;
  autoOn?: boolean;
  skillRoots?: readonly string[];
  creationProblem?: string;
  remoteProblem?: string;
}

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
const orbitalSchema = Type.Object({
  action: Type.Union([
    Type.Literal("create_and_attach"), Type.Literal("select_directory"),
    Type.Literal("inspect"), Type.Literal("url"), Type.Literal("delete"),
  ]),
  orbCwd: Type.Optional(Type.String()),
  port: Type.Optional(Type.Number()),
}, { additionalProperties: false });
const skillSchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("copy_asset")]),
  name: Type.Optional(Type.String()),
  asset: Type.Optional(Type.String()),
  destination: Type.Optional(Type.String()),
}, { additionalProperties: false });

function imageMime(bytes: Uint8Array): string | undefined {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (head.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (head.toString("ascii", 0, 2) === "BM") return "image/bmp";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function remotePath(cwd: string, path: string): string {
  const expanded = path === "~" ? "/home/user" : path.startsWith("~/") ? `/home/user/${path.slice(2)}` : path;
  if (expanded.includes("\0")) throw new Error("A remote path cannot contain a null byte.");
  return posix.resolve(cwd, expanded);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function displaySearch(text: string, path: string, maxBytes = 50_000): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return `${Buffer.from(text).subarray(0, maxBytes).toString("utf8")}\n[Output truncated. Full output: ${path}]`;
}

function displayBash(text: string, outputPath: string): string {
  const lines = text.split("\n");
  const tail = lines.slice(-2000).join("\n");
  const shown = Buffer.from(tail).subarray(-50_000).toString("utf8");
  const clipped = Buffer.byteLength(shown) < Buffer.byteLength(text) || lines.length > 2000;
  return `${clipped ? "[Output truncated]\n" : ""}${shown}\nFull output: ${outputPath}`;
}

function presentError(error: unknown): Error {
  if (!(error instanceof OrbitalError)) return error instanceof Error ? error : new Error(String(error));
  const keys = ["orbId", "resourceId", "jobId", "outputPath", "path", "partialOutput",
    "phase", "cause", "pid", "pgid", "outcome"];
  const evidence = Object.fromEntries(keys.flatMap(key => {
    const value = error.evidence[key];
    if (value === undefined) return [];
    return [[key, typeof value === "string" ? value.slice(0, 4000) : value]];
  }));
  const details = Object.keys(evidence).length ? ` Evidence: ${JSON.stringify(evidence)}` : "";
  return new Error(`Orbital ${error.outcome} [${error.code}]: ${error.message}${details}`);
}

function registerRemoteTool<TParams extends TSchema, TDetails, TState>(
  pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails, TState>,
): void {
  pi.registerTool({ ...tool, async execute(...args) {
    try { return await tool.execute(...args); }
    catch (error) { throw presentError(error); }
  } });
}

export function registerOrbitalPi(pi: ExtensionAPI, orbital: PiOrbitalApi,
  options: PiOptions | (() => PiOptions | Promise<PiOptions>),
  settingsCommand?: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
): void {
  const getOptions = async () => typeof options === "function" ? options() : options;
  const session = createPiSession(pi, orbital, getOptions);
  const admitted = new AsyncLocalStorage<Workspace>();
  const workspaceFor = (signal?: AbortSignal) => {
    const workspace = admitted.getStore();
    return workspace ? Promise.resolve(workspace) : session.workspace({ signal });
  };
  let inFlight = 0;
  const localFactories = {
    bash: createBashToolDefinition, read: createReadToolDefinition, write: createWriteToolDefinition,
    edit: createEditToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition,
    ls: createLsToolDefinition,
  };
  function registerPiTool<TParams extends TSchema, TDetails, TState>(
    api: ExtensionAPI, tool: ToolDefinition<TParams, TDetails, TState>,
  ): void {
    registerRemoteTool(api, { ...tool, async execute(...args) {
      const factory = localFactories[tool.name as keyof typeof localFactories];
      inFlight++;
      try {
        if (!factory) return await tool.execute(...args);
        const shell = args[1] as { mode?: string; timeout?: number };
        if (tool.name === "bash" && shell.mode === "background" && shell.timeout !== undefined) {
          throw new OrbitalError("not_started", "background_timeout", "Background launch does not accept an execution timeout.");
        }
        if (session.control().route === "local") {
          if (tool.name === "bash" && (args[1] as { mode?: string }).mode === "background") {
            throw new Error("Background Bash requires remote routing.");
          }
          const local = factory(args[4].cwd) as unknown as ToolDefinition<TParams, TDetails, TState>;
          return await local.execute(...args);
        }
        const workspace = await session.workspace({ signal: args[2] });
        return await admitted.run(workspace, () => tool.execute(...args));
      } finally {
        inFlight--;
      }
    } });
  }

  pi.on("session_start", (event, ctx) => session.restore(ctx, event.reason));
  pi.on("session_tree", (_event, ctx) => session.restore(ctx, "tree"));
  pi.on("session_before_switch", () => inFlight ? { cancel: true } : undefined);
  pi.on("session_before_fork", () => inFlight ? { cancel: true } : undefined);
  pi.on("session_before_tree", () => inFlight ? { cancel: true } : undefined);

  pi.registerCommand("orb", {
    description: "Select local or remote routing, show status, or change Orbital settings.",
    async handler(args, ctx) {
      const action = args.trim().split(/\s+/)[0] || "status";
      if (action === "settings" && settingsCommand) return settingsCommand(args.trim().slice(action.length).trim(), ctx);
      let message: string;
      let details: Record<string, unknown>;
      try {
        if (action === "on" || action === "off") {
          if (!ctx.isIdle() || inFlight) throw new Error("Orbital is busy. Wait for the current work to finish.");
          session.setRoute(action === "on" ? "remote" : "local");
        } else if (action !== "status") throw new Error("Use /orb on, /orb off, /orb status, or /orb settings.");
        const current = session.control();
        const settings = await getOptions();
        const activity = inFlight || !ctx.isIdle() ? "busy" : "idle";
        const problems = [settings.remoteProblem, settings.creationProblem].filter(Boolean);
        details = { ...current, orbId: ctx.sessionManager.getSessionId(), activity,
          provider: { state: "unknown" },
          readiness: { remote: !settings.remoteProblem, create: problems.length === 0, problems } };
        message = `Orbital route: ${current.route}. Allocation: ${current.allocation}. Remote directory: ${current.orbCwd}. Activity: ${activity}. Provider state: unknown.`;
        if (problems.length) message += `\nReadiness: ${problems.join(" ")}`;
      } catch (error) {
        message = presentError(error).message;
        details = { error: message };
      }
      pi.sendMessage({ customType: "orbital.status", content: message, display: true, details }, { triggerTurn: false });
      if (ctx.mode === "print") process.stderr.write(`${message}\n`);
      if (ctx.hasUI) ctx.ui.notify(message, "info");
    },
  });

  pi.on("before_agent_start", event => {
    const state = session.state;
    const attachment = state.kind === "invalid"
      ? "The saved Orbital attachment is invalid. Use orbital create_and_attach explicitly before workspace tools."
      : session.control().route === "local"
        ? "Workspace tools and the user shell use the local host."
        : `Workspace tools and the user shell use the remote orb. Remote directory: ${session.control().orbCwd}. The first remote operation prepares the orb.`;
    event.systemPromptOptions.sections["orbital-workspace"] = attachment;
  });

  pi.on("user_bash", () => {
    let route;
    try { route = session.control().route; }
    catch (error) { throw presentError(error); }
    const local = route === "local" ? createLocalBashOperations() : undefined;
    return { operations: {
      async exec(command, _hostCwd, options) {
        inFlight++;
        try {
          if (local) return await local.exec(command, _hostCwd, options);
          const workspace = await session.workspace({ signal: options.signal });
          let sent = 0;
          const maxInline = 48_000;
          const result = await workspace.exec({ command,
            timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000 }, {
            signal: options.signal,
            onOutput(chunk) {
              const bytes = Buffer.from(chunk);
              const remaining = maxInline - sent;
              if (remaining > 0) {
                const shown = bytes.subarray(0, remaining);
                options.onData(shown);
                sent += shown.length;
              }
            },
          });
          if (sent === 0 && (result.stdout || result.stderr)) {
            const shown = Buffer.from(result.stdout + result.stderr).subarray(0, maxInline);
            options.onData(shown);
          }
          options.onData(Buffer.from(`\nFull output: ${result.outputPath}\n`));
          if (result.kind !== "exited") throw new Error(`Remote command ${result.kind}. Full output: ${result.outputPath}`);
          return { exitCode: result.exitCode ?? null };
        } catch (error) {
          throw presentError(error);
        } finally {
          inFlight--;
        }
      },
    } };
  });

  registerPiTool(pi, {
    name: "orbital",
    label: "Orbital",
    description: "Create and attach the current Pi session to an orb, select its working directory, inspect it, get a public port URL, or delete it. The orb ID always comes from the current Pi session. Workspace tools need an attachment.",
    parameters: orbitalSchema,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      const orbId = ctx.sessionManager.getSessionId();
      if (params.action === "create_and_attach") {
        const orbCwd = params.orbCwd ?? "/home/user";
        onUpdate?.({ content: [{ type: "text", text: `Creating or finding ${orbId}` }], details: undefined });
        const binding = await session.create(orbCwd, signal);
        return { content: [{ type: "text", text: `Attached to ${orbId} at ${binding.orbCwd}` }], details: binding };
      }
      if (params.action === "select_directory") {
        const binding = session.binding();
        if (!params.orbCwd) throw new Error("orbCwd is required to select a directory.");
        const workspace = await orbital.openWorkspace(binding, { signal });
        const selected = await workspace.validateDirectory(params.orbCwd);
        const next = session.select(selected);
        return { content: [{ type: "text", text: `Selected ${selected}` }], details: next };
      }
      if (params.action === "inspect") {
        const orb = await orbital.inspect({ orbId });
        if (!orb) throw new Error(`Orb ${orbId} is missing.`);
        return { content: [{ type: "text", text: JSON.stringify(orb) }], details: orb };
      }
      if (params.action === "url") {
        session.binding();
        if (!Number.isInteger(params.port) || params.port! < 1 || params.port! > 65535) {
          throw new Error("A valid port is required.");
        }
        const url = await orbital.url({ orbId, port: params.port! });
        return { content: [{ type: "text", text: url }], details: { url } };
      }
      session.binding();
      await orbital.delete({ orbId });
      return { content: [{ type: "text", text: `Deleted ${orbId}` }], details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "orbital_skill",
    label: "Orbital skill",
    description: "List allowed host skills, read one named SKILL.md, or copy one named skill asset into the attached orb. This only reads configured skill roots on the host.",
    parameters: skillSchema,
    async execute(_id, params, signal) {
      const roots = (await getOptions()).skillRoots;
      if (params.action === "list") {
        const names = await listSkills(roots);
        return { content: [{ type: "text", text: names.join("\n") || "No skills found" }], details: undefined };
      }
      if (!params.name) throw new Error("A skill name is required.");
      if (params.action === "read") {
        return { content: [{ type: "text", text: await readSkill(params.name, roots) }], details: undefined };
      }
      if (!params.asset || !params.destination) throw new Error("Asset and destination are required.");
      const bytes = await readSkillAsset(params.name, params.asset, roots);
      const workspace = await orbital.openWorkspace(session.binding(), { signal });
      await workspace.writeFile(params.destination, bytes);
      return { content: [{ type: "text", text: `Copied ${params.name}/${params.asset} to ${params.destination} in the orb` }],
        details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "bash",
    label: "bash",
    description: "Run a shell command in the selected local or remote workspace. Background mode requires remote routing.",
    promptSnippet: "Execute shell commands in the selected workspace",
    parameters: bashSchema,
    async execute(_id, params, signal, onUpdate) {
      const workspace = await workspaceFor(signal);
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
      if (result.kind === "background") {
        return { content: [{ type: "text", text: `Started background job ${result.jobId}. Full output: ${result.outputPath}` }],
          details: { fullOutputPath: result.outputPath } };
      }
      if (result.kind !== "exited" || result.exitCode !== 0) {
        throw new Error(`Remote command ${result.kind} (${result.exitCode ?? "no exit code"}), job ${result.jobId}. ${displayBash(text, result.outputPath)}`);
      }
      return { content: [{ type: "text", text: displayBash(text, result.outputPath) }],
        details: { fullOutputPath: result.outputPath } };
    },
  });

  registerPiTool(pi, {
    name: "write", label: "write", description: "Create or overwrite a file in the selected workspace.",
    promptSnippet: "Write files in the selected workspace", parameters: writeSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
      await workspace.writeFile(params.path, Buffer.from(params.content, "utf8"));
      return { content: [{ type: "text", text: `Wrote ${params.path}` }], details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "read", label: "read", description: "Read a text file or image in the selected workspace.",
    promptSnippet: "Read files in the selected workspace", parameters: readSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
      const bytes = await workspace.readFile(params.path);
      const mime = imageMime(bytes);
      if (mime) return { content: [{ type: "image" as const,
        data: Buffer.from(bytes).toString("base64"), mimeType: mime }], details: undefined };
      const lines = Buffer.from(bytes).toString("utf8").split("\n");
      const offset = Math.max(1, Math.floor(params.offset ?? 1));
      const limit = Math.max(1, Math.floor(params.limit ?? 2000));
      let shown = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      const truncated = Buffer.byteLength(shown) > 50_000;
      if (truncated) shown = Buffer.from(shown).subarray(0, 50_000).toString("utf8");
      if (offset - 1 + limit < lines.length || truncated) shown += "\n[Read output truncated. Continue with offset.]";
      return { content: [{ type: "text", text: shown }], details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "edit", label: "edit", description: "Replace exact text in one selected workspace file. Each oldText must match once in the original file, and edits must not overlap.",
    promptSnippet: "Edit files in the selected workspace", parameters: editSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
      const original = Buffer.from(await workspace.readFile(params.path)).toString("utf8");
      const changes = params.edits.map(edit => {
        const index = original.indexOf(edit.oldText);
        if (!edit.oldText || index < 0 || original.indexOf(edit.oldText, index + edit.oldText.length) >= 0) {
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
      await workspace.writeFile(params.path, Buffer.from(revised, "utf8"));
      return { content: [{ type: "text", text: `Edited ${params.path}` }], details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "grep", label: "grep", description: "Search text in the selected workspace. The search respects its ignore files.",
    promptSnippet: "Search file contents in the selected workspace", parameters: grepSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
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
      const limit = Math.max(1, Math.floor(params.limit ?? 100));
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      for (const line of output.split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line) as { type: string; data?: { path?: { text?: string };
          line_number?: number; lines?: { text?: string } } };
        if (event.type !== "match" && (params.context === undefined || event.type !== "context")) continue;
        const separator = event.type === "context" ? "-" : ":";
        matches.push(`${event.data?.path?.text ?? ""}${separator}${event.data?.line_number ?? 0}${separator} ${event.data?.lines?.text?.trimEnd() ?? ""}`);
        if (matches.length >= limit) break;
      }
      const shown = matches.length ? matches.join("\n") : "No matches found";
      return { content: [{ type: "text", text: displaySearch(shown, result.outputPath) }], details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "find", label: "find", description: "Find paths by glob in the selected workspace. The search respects ignore files.",
    promptSnippet: "Find files in the selected workspace", parameters: findSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
      const path = remotePath(workspace.orbCwd, params.path ?? ".");
      const result = await workspace.exec({ command: `rg --files --hidden --null --glob ${shellQuote(params.pattern)} -- ${shellQuote(path)}` }, { signal });
      if (result.kind !== "exited" || (result.exitCode !== 0 && result.exitCode !== 1)) {
        throw new Error(`Remote find failed: ${result.stderr || result.kind}`);
      }
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      const paths = output.split("\0").filter(Boolean).slice(0, Math.max(1, Math.floor(params.limit ?? 1000)));
      return { content: [{ type: "text", text: displaySearch(paths.join("\n") || "No files found matching pattern", result.outputPath) }],
        details: undefined };
    },
  });

  registerPiTool(pi, {
    name: "ls", label: "ls", description: "List one directory in the selected workspace, including hidden entries.",
    promptSnippet: "List directories in the selected workspace", parameters: lsSchema,
    async execute(_id, params, signal) {
      const workspace = await workspaceFor(signal);
      const path = remotePath(workspace.orbCwd, params.path ?? ".");
      const result = await workspace.exec({ command: `find ${shellQuote(path)} -mindepth 1 -maxdepth 1 -print0` }, { signal });
      if (result.kind !== "exited" || result.exitCode !== 0) {
        throw new Error(`Remote listing failed: ${result.stderr || result.kind}`);
      }
      const output = Buffer.from(await workspace.readFile(result.outputPath)).toString("utf8");
      const entries = output.split("\0").filter(Boolean).map(item => posix.basename(item)).sort()
        .slice(0, Math.max(1, Math.floor(params.limit ?? 1000)));
      return { content: [{ type: "text", text: displaySearch(entries.join("\n") || "Empty directory", result.outputPath) }],
        details: undefined };
    },
  });
}

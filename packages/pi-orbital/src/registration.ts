import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { OrbitalError } from "@henriquebastosnet/orbital";
import type { createPiSession } from "./session.js";
import { presentError } from "./presentation.js";

export type PiSession = ReturnType<typeof createPiSession>;
type AnyTool = ToolDefinition<any, any, any>;

// Tracked work: every registered tool and every user-shell command counts from entry until
// return, including acquisition and failures. While the count is above zero, route changes
// are refused as busy and session navigation is cancelled.
export function createToolRegistration(pi: ExtensionAPI, session: PiSession) {
  let activeTrackedCalls = 0;
  async function trackCall<T>(run: () => Promise<T>): Promise<T> {
    activeTrackedCalls++;
    try { return await run(); } finally { activeTrackedCalls--; }
  }
  function registerWithErrorPresentation<TParams extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void {
    pi.registerTool({ ...tool, async execute(...args) {
      try { return await tool.execute(...args); }
      catch (error) { throw presentError(error); }
    } });
  }
  // Control tools (orbital, orbital_skill) are tracked but never route-dispatched.
  function registerControlTool<TParams extends TSchema, TDetails, TState>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void {
    registerWithErrorPresentation({ ...tool, execute: (...args) => trackCall(() => tool.execute(...args)) });
  }
  // Bash preflight before any route is read or any workspace is acquired: a background launch
  // never carries an execution timeout, and on the local route it is refused outright.
  function rejectUnsupportedBackgroundLaunch(toolName: string, params: unknown, route?: "local" | "remote"): void {
    if (toolName !== "bash") return;
    const shell = params as { mode?: string; timeout?: number };
    if (shell.mode !== "background") return;
    if (route === undefined && shell.timeout !== undefined) {
      throw new OrbitalError("not_started", "background_timeout", "Background launch does not accept an execution timeout.");
    }
    if (route === "local") throw new Error("Background Bash requires remote routing.");
  }
  // Workspace tool pipeline: 1. enter tracked work; 2. Bash preflight; 3. read valid session
  // control, which fails closed on both routes; 4. run the native Pi tool for ctx.cwd on local
  // or the remote implementation otherwise; 5. release tracking in finally; 6. present errors
  // at the outer boundary.
  function registerWorkspaceTool<TParams extends TSchema, TDetails, TState>(
    remote: ToolDefinition<TParams, TDetails, TState>, localFactory: (cwd: string) => AnyTool,
  ): void {
    registerWithErrorPresentation({ ...remote, execute: (...args) => trackCall(async () => {
      const [, params, , , ctx] = args;
      rejectUnsupportedBackgroundLaunch(remote.name, params);
      const route = session.control().route;
      if (route === "local") {
        rejectUnsupportedBackgroundLaunch(remote.name, params, route);
        const local = localFactory(ctx.cwd) as ToolDefinition<TParams, TDetails, TState>;
        return local.execute(...args);
      }
      return remote.execute(...args);
    }) });
  }
  return { activeCalls: () => activeTrackedCalls, trackCall, registerControlTool, registerWorkspaceTool };
}

export type ToolRegistration = ReturnType<typeof createToolRegistration>;

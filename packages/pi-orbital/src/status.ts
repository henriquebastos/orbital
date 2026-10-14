import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiOptions } from "./extension.js";
import type { PiSession, ToolRegistration } from "./registration.js";
import type { PiSettingsControl } from "./preferences.js";
import { presentError } from "./presentation.js";

// Route selection, status reporting, the /orb command, and the system prompt section.
export function createRoutingStatus(session: PiSession, getOptions: () => Promise<PiOptions>,
  registration: ToolRegistration) {
  // The sequential control tool is itself one tracked call while it runs. The /orb command is none.
  const ownTrackedCall = (fromTool: boolean) => (fromTool ? 1 : 0);
  // Refuse, never wait: a route change with other tracked work is an error. The command path
  // also requires an idle Pi.
  function setRoute(route: "local" | "remote", ctx: ExtensionContext, fromTool = false) {
    const otherCalls = registration.activeCalls() - ownTrackedCall(fromTool);
    if (otherCalls > 0 || (!fromTool && !ctx.isIdle())) {
      throw new Error("Orbital is busy. Wait for the current work to finish.");
    }
    session.setRoute(route);
  }
  // Report cached control and configuration readiness. This never observes the provider;
  // inspect performs the provider lookup, and configured resources are not an orb's actual size.
  // Activity excludes the status call itself, so tool and command status agree on tracked work.
  // Both also report busy while Pi is not idle.
  async function describe(ctx: ExtensionContext, fromTool = false) {
    const current = session.control();
    const settings = await getOptions();
    const otherCalls = registration.activeCalls() - ownTrackedCall(fromTool);
    const activity = otherCalls > 0 || !ctx.isIdle() ? "busy" : "idle";
    const problems = [settings.creationProblem].filter(Boolean);
    const cwd = current.route === "local" ? ctx.cwd : current.orbCwd;
    const details = { ...current, orbId: ctx.sessionManager.getSessionId(), cwd, activity,
      provider: { state: "unknown" },
      configuredResources: { cpuCount: settings.cpuCount ?? 2, memoryMB: settings.memoryMB ?? 1024,
        minFreeDiskMb: settings.minFreeDiskMb },
      readiness: { remote: !settings.remoteProblem, create: problems.length === 0, problems } };
    let content = `Orbital route: ${current.route}. Allocation: ${current.allocation}. Working directory: ${cwd}. Remote directory: ${current.orbCwd}. Activity: ${activity}. Provider state: unknown.`;
    if (problems.length) content += `\nReadiness: ${problems.join(" ")}`;
    return { content, details };
  }
  return { setRoute, describe };
}

export type RoutingStatus = ReturnType<typeof createRoutingStatus>;

export function registerOrbCommand(pi: ExtensionAPI, status: RoutingStatus, settingsControl?: PiSettingsControl): void {
  pi.registerCommand("orb", {
    description: "Select local or remote routing, show status, or change Orbital settings.",
    async handler(args, ctx) {
      const action = args.trim().split(/\s+/)[0] || "status";
      if (action === "settings" && settingsControl) return settingsControl.command(args.trim().slice(action.length).trim(), ctx);
      let message: string;
      let details: Record<string, unknown>;
      try {
        if (action === "on" || action === "off") {
          status.setRoute(action === "on" ? "remote" : "local", ctx);
        } else if (action !== "status") throw new Error("Use /orb on, /orb off, /orb status, or /orb settings.");
        const result = await status.describe(ctx);
        message = result.content;
        details = result.details;
      } catch (error) {
        message = presentError(error).message;
        details = { error: message };
      }
      pi.sendMessage({ customType: "orbital.status", content: message, display: true, details }, { triggerTurn: false });
      if (ctx.mode === "print") process.stderr.write(`${message}\n`);
      if (ctx.hasUI) ctx.ui.notify(message, "info");
    },
  });
}

export function registerWorkspacePromptSection(pi: ExtensionAPI, session: PiSession): void {
  pi.on("before_agent_start", event => {
    const attachment = session.controlState.kind === "invalid"
      ? "The saved Orbital session control is invalid. Use orbital create_and_attach explicitly before workspace tools."
      : session.control().route === "local"
        ? "Workspace tools and the user shell use the local host."
        : `Workspace tools and the user shell use the remote orb. Remote directory: ${session.control().orbCwd}. A remote operation attaches the orb, and creates it when the session never requested one.`;
    event.systemPromptOptions.sections["orbital-workspace"] = `${attachment}\nThe orbital set_route tool can change the route during this turn. Its result identifies the workspace for subsequent calls.`;
  });
}

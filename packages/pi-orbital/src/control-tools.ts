import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiOptions, PiOrbitalApi } from "./extension.js";
import type { PiSession, ToolRegistration } from "./registration.js";
import type { RoutingStatus } from "./status.js";
import { settingNameSchema, type PiSettingsControl } from "./preferences.js";
import { listSkills, readSkill, readSkillAsset } from "./skill-resources.js";

// Control tools manage routing, settings, the session's orb, and host skills. They are tracked
// work but never route-dispatched: orb resource actions and the skill asset copy reach the orb
// on any route, while skill list and read stay on the host.

const orbitalSchema = Type.Object({
  action: Type.Union([
    Type.Literal("set_route"), Type.Literal("status"),
    Type.Literal("settings_get"), Type.Literal("settings_set"),
    Type.Literal("settings_unset"), Type.Literal("settings_refresh"),
    Type.Literal("create_and_attach"), Type.Literal("select_directory"),
    Type.Literal("inspect"), Type.Literal("url"), Type.Literal("delete"),
  ]),
  route: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")],
    { description: "Required for set_route." })),
  name: Type.Optional(settingNameSchema),
  value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())],
    { description: "Required for settings_set. image: string; leaseWindowMs, cpuCount, memoryMB, minFreeDiskMb: numbers; autoOn: boolean; forwardEnv and skillRoots: string arrays." })),
  orbCwd: Type.Optional(Type.String()),
  port: Type.Optional(Type.Number()),
}, { additionalProperties: false });
const skillSchema = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("copy_asset")]),
  name: Type.Optional(Type.String()),
  asset: Type.Optional(Type.String()),
  destination: Type.Optional(Type.String()),
}, { additionalProperties: false });

export interface ControlToolDependencies {
  session: PiSession;
  orbital: PiOrbitalApi;
  getOptions: () => Promise<PiOptions>;
  status: RoutingStatus;
  registration: ToolRegistration;
  settingsControl?: PiSettingsControl;
}

export function registerControlTools(pi: ExtensionAPI, deps: ControlToolDependencies): void {
  const { session, orbital, getOptions, status, registration, settingsControl } = deps;

  // Delete the attached orb but retain attached control, so later demand cannot silently recreate it.
  async function deleteAttachedSessionOrb(orbId: string) {
    session.attachment();
    await orbital.delete({ orbId });
    return { content: [{ type: "text" as const, text: `Deleted ${orbId}` }], details: undefined };
  }
  // Read authorized host bytes first. The write requires an existing remote attachment regardless
  // of route and never activates one.
  async function copyHostSkillAssetToAttachedOrb(name: string, asset: string, destination: string,
    roots: readonly string[] | undefined, signal: AbortSignal | undefined) {
    const bytes = await readSkillAsset(name, asset, roots);
    const workspace = await orbital.openWorkspace(session.attachment(), { signal });
    await workspace.writeFile(destination, bytes);
    return { content: [{ type: "text" as const, text: `Copied ${name}/${asset} to ${destination} in the orb` }],
      details: undefined };
  }

  registration.registerControlTool({
    name: "orbital",
    label: "Orbital",
    description: "Select local or remote workspace routing, show status, read or edit settings, or manage the current session's orb. set_route changes subsequent workspace tools and user shell commands without creating or deleting an orb. settings_set and settings_unset edit global defaults; settings_refresh reloads files. forwardEnv contains variable names, never secret values. Resource actions create or attach an orb, select its remote directory, inspect provider state, get a port URL, or delete the orb.",
    parameters: orbitalSchema,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      const orbId = ctx.sessionManager.getSessionId();
      // Routing and status actions.
      if (params.action === "set_route" || params.action === "status") {
        if (params.action === "set_route") {
          if (!params.route) throw new Error("route is required for set_route.");
          status.setRoute(params.route, ctx, true);
        }
        const result = await status.describe(ctx, true);
        return { content: [{ type: "text", text: result.content }], details: result.details };
      }
      // Settings actions.
      if (params.action === "settings_get" || params.action === "settings_set"
        || params.action === "settings_unset" || params.action === "settings_refresh") {
        if (!settingsControl) throw new Error("Orbital settings are unavailable in this extension.");
        let result;
        if (params.action === "settings_set" || params.action === "settings_unset") {
          if (!params.name) throw new Error("name is required to edit a setting.");
          if (params.action === "settings_set") {
            if (params.value === undefined) throw new Error("value is required for settings_set.");
            result = await settingsControl.execute({ action: params.action, name: params.name, value: params.value });
          } else result = await settingsControl.execute({ action: params.action, name: params.name });
        } else result = await settingsControl.execute({ action: params.action });
        return { content: [{ type: "text", text: result.content }], details: result.details };
      }
      // Resource actions.
      if (params.action === "create_and_attach") {
        onUpdate?.({ content: [{ type: "text", text: `Creating or finding ${orbId}` }], details: undefined });
        const attached = await session.create(params.orbCwd, signal);
        return { content: [{ type: "text", text: `Attached to ${orbId} at ${attached.orbCwd}` }], details: attached };
      }
      if (params.action === "select_directory") {
        const attached = session.attachment();
        if (!params.orbCwd) throw new Error("orbCwd is required to select a directory.");
        const workspace = await orbital.openWorkspace(attached, { signal });
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
        session.attachment();
        if (!Number.isInteger(params.port) || params.port! < 1 || params.port! > 65535) {
          throw new Error("A valid port is required.");
        }
        const url = await orbital.url({ orbId, port: params.port! });
        return { content: [{ type: "text", text: url }], details: { url } };
      }
      // The validated action union leaves only delete here.
      return deleteAttachedSessionOrb(orbId);
    },
  });

  registration.registerControlTool({
    name: "orbital_skill",
    label: "Orbital skill",
    description: "List allowed host skills, read one named SKILL.md, or copy one named skill asset into the attached orb. This reads the configured skill roots and the built-in roots on the host.",
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
      return copyHostSkillAssetToAttachedOrb(params.name, params.asset, params.destination, roots, signal);
    },
  });
}

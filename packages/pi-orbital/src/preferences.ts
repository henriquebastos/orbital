import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { delimiter, isAbsolute } from "node:path";
import { Type, type Static } from "typebox";
import { OrbitalError } from "@henriquebastosnet/orbital";
import { orbitalSettingsSchema, type SettingsSchema } from "@henriquebastosnet/orbital/settings";
import { createNodeSettings, createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";

interface PiPreferences { autoOn: boolean; skillRoots: string[] }

export const settingNameSchema = Type.Union([Type.Literal("image"), Type.Literal("idleTimeoutMs"),
  Type.Literal("forwardEnv"), Type.Literal("autoOn"), Type.Literal("skillRoots"),
  Type.Literal("cpuCount"), Type.Literal("memoryMB"), Type.Literal("minFreeDiskMb")],
  { description: "Required for settings_set and settings_unset." });
type SettingName = Static<typeof settingNameSchema>;
type SettingsAction =
  | { action: "settings_get" | "settings_refresh" }
  | { action: "settings_unset"; name: SettingName }
  | { action: "settings_set"; name: SettingName; value: unknown };

function parseCommand(args: string): SettingsAction {
  const input = args.trim();
  if (input === "refresh") return { action: "settings_refresh" };
  if (input === "" || input === "show") return { action: "settings_get" };
  const unset = /^unset\s+(image|idleTimeoutMs|forwardEnv|autoOn|skillRoots|cpuCount|memoryMB|minFreeDiskMb)$/.exec(input);
  if (unset) return { action: "settings_unset", name: unset[1] as SettingName };
  const match = /^set\s+(image|idleTimeoutMs|forwardEnv|autoOn|skillRoots|cpuCount|memoryMB|minFreeDiskMb)\s+([\s\S]+)$/.exec(input);
  if (!match) throw new Error("Use /orb settings set <key> <value> or unset <key>.");
  const name = match[1] as SettingName;
  const text = match[2]!;
  if (name === "image") return { action: "settings_set", name, value: text };
  if (name === "idleTimeoutMs" || name === "cpuCount" || name === "memoryMB" || name === "minFreeDiskMb") {
    return { action: "settings_set", name, value: orbitalSettingsSchema[name].parseEnvironment(text) };
  }
  if (name === "autoOn") return { action: "settings_set", name, value: piPreferencesSchema.autoOn.parseEnvironment(text) };
  try {
    return { action: "settings_set", name, value: JSON.parse(text) };
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error("forwardEnv and skillRoots must be JSON arrays of strings.");
    throw cause;
  }
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("autoOn must be true or false.");
  return value;
}

function skillRoots(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(root => typeof root !== "string" || !isAbsolute(root) || root.includes("\0"))) {
    throw new Error("skillRoots must be an array of absolute paths.");
  }
  return [...value];
}

const piPreferencesSchema: SettingsSchema<PiPreferences> = {
  autoOn: {
    environment: "ORBITAL_AUTO_ON", defaultValue: false, parseSaved: boolean,
    parseEnvironment(value) {
      if (value !== "true" && value !== "false") throw new Error("ORBITAL_AUTO_ON must be true or false.");
      return value === "true";
    },
  },
  skillRoots: {
    environment: "ORBITAL_SKILL_ROOTS", defaultValue: [], parseSaved: skillRoots,
    parseEnvironment(value) { return skillRoots(value === "" ? [] : value.split(delimiter)); },
  },
};

export function createPiConfiguration(pi: ExtensionAPI, remoteProblem?: string,
  settings = createOrbitalConfiguration().settings,
  getEnvironment = (names: readonly string[]) => createOrbitalConfiguration().env(names)) {
  const preferences = createNodeSettings({ schema: piPreferencesSchema, fileName: "pi.json" });
  const ready = Promise.all([settings.refresh(), preferences.refresh()]);
  async function options() {
    await ready;
    const snapshot = settings.snapshot();
    const problems = snapshot.diagnostics.map(item => item.message);
    let env: Record<string, string> | undefined;
    try { env = getEnvironment(snapshot.effective.forwardEnv); }
    catch (cause) { problems.push(cause instanceof OrbitalError ? cause.message : "Cannot resolve the instance environment."); }
    return { ...snapshot.effective, ...preferences.snapshot().effective, remoteProblem, env,
      creationProblem: problems.length ? problems.join(" ") : undefined };
  }
  async function execute(action: SettingsAction) {
    await ready;
    if (action.action === "settings_refresh") {
      await Promise.all([settings.refresh(), preferences.refresh()]);
    } else if (action.action === "settings_unset") {
      if (action.name === "autoOn" || action.name === "skillRoots") await preferences.unset(action.name);
      else await settings.unset(action.name);
    } else if (action.action === "settings_set") {
      if (action.name === "image") await settings.set("image", orbitalSettingsSchema.image.parseSaved(action.value));
      else if (action.name === "idleTimeoutMs") await settings.set("idleTimeoutMs", orbitalSettingsSchema.idleTimeoutMs.parseSaved(action.value));
      else if (action.name === "forwardEnv") await settings.set("forwardEnv", orbitalSettingsSchema.forwardEnv.parseSaved(action.value));
      else if (action.name === "cpuCount") await settings.set("cpuCount", orbitalSettingsSchema.cpuCount.parseSaved(action.value));
      else if (action.name === "memoryMB") await settings.set("memoryMB", orbitalSettingsSchema.memoryMB.parseSaved(action.value));
      else if (action.name === "minFreeDiskMb") await settings.set("minFreeDiskMb", orbitalSettingsSchema.minFreeDiskMb.parseSaved(action.value));
      else if (action.name === "autoOn") await preferences.set("autoOn", boolean(action.value));
      else await preferences.set("skillRoots", skillRoots(action.value));
    }
    return report();
  }
  function report(error?: string) {
    const snapshot = settings.snapshot();
    const piSnapshot = preferences.snapshot();
    const content = [
      ...(error ? [`Error: ${error}`] : []),
      `Orbital settings: ${settings.filePath}`,
      `Saved: ${JSON.stringify(snapshot.saved)}`,
      ...(settings.userProjectFilePath ? [`User project settings: ${settings.userProjectFilePath}`, `User project: ${JSON.stringify(snapshot.userProject)}`] : []),
      ...(settings.projectFilePath ? [`Project settings: ${settings.projectFilePath}`, `Project: ${JSON.stringify(snapshot.project)}`] : []),
      `Selected project: ${settings.selectedProjectFilePath ?? "none"}`,
      `Effective: ${JSON.stringify(snapshot.effective)}`,
      `Source: ${JSON.stringify(snapshot.source)}`,
      "Changes apply to the next allocation. Resource settings select the owned base for a new orb; existing orbs and explicit images retain their sizes.",
      `Pi preferences: ${preferences.filePath}`,
      `Saved: ${JSON.stringify(piSnapshot.saved)}`,
      `Effective: ${JSON.stringify(piSnapshot.effective)}`,
      `Source: ${JSON.stringify(piSnapshot.source)}`,
      "autoOn applies to new sessions. skillRoots applies to the next skill read.",
      `Diagnostics: ${JSON.stringify([...snapshot.diagnostics, ...piSnapshot.diagnostics])}`,
    ].join("\n");
    return { content, details: { settings: snapshot, preferences: piSnapshot, error } };
  }
  async function command(args: string, ctx: ExtensionCommandContext) {
    await ready;
    let result;
    try { result = await execute(parseCommand(args)); }
    catch (cause) { result = report(cause instanceof Error ? cause.message : "The setting could not be saved."); }
    const { content, details } = result;
    const error = details.error;
    pi.sendMessage({ customType: "orbital.settings", content, display: true, details }, { triggerTurn: false });
    if (ctx.mode === "print") process.stderr.write(`${content}\n`);
    if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
  }
  return { options, command, execute };
}

export type PiSettingsControl = Pick<ReturnType<typeof createPiConfiguration>, "command" | "execute">;

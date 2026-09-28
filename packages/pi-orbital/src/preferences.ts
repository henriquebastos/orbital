import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { delimiter, isAbsolute } from "node:path";
import { orbitalSettingsSchema, type SettingsSchema } from "@henriquebastosnet/orbital/settings";
import { createNodeSettings } from "@henriquebastosnet/orbital/settings/node";

interface PiPreferences { autoOn: boolean; skillRoots: string[] }

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

export function createPiConfiguration(pi: ExtensionAPI, remoteProblem?: string) {
  const settings = createNodeSettings({ schema: orbitalSettingsSchema });
  const preferences = createNodeSettings({ schema: piPreferencesSchema, fileName: "pi.json" });
  const ready = Promise.all([settings.refresh(), preferences.refresh()]);
  async function options() {
    await ready;
    const snapshot = settings.snapshot();
    return { ...snapshot.effective, ...preferences.snapshot().effective, remoteProblem,
      creationProblem: snapshot.diagnostics.length ? snapshot.diagnostics.map(item => item.message).join(" ") : undefined };
  }
  async function command(args: string, ctx: ExtensionCommandContext) {
    await ready;
    let error: string | undefined;
    try {
      const input = args.trim();
      const unset = /^unset\s+(image|idleTimeoutMs|autoOn|skillRoots)$/.exec(input);
      if (input === "refresh") {
        await Promise.all([settings.refresh(), preferences.refresh()]);
      } else if (input === "" || input === "show") {
        // The cached snapshot changes only after an explicit edit or refresh.
      } else if (unset) {
        const key = unset[1]!;
        if (key === "image" || key === "idleTimeoutMs") await settings.unset(key);
        else await preferences.unset(key as keyof PiPreferences);
      } else {
        const match = /^set\s+(image|idleTimeoutMs|autoOn|skillRoots)\s+([\s\S]+)$/.exec(input);
        if (!match) throw new Error("Use /orb settings set <key> <value> or unset <key>.");
        if (match[1] === "image") await settings.set("image", match[2]!);
        else if (match[1] === "idleTimeoutMs") await settings.set("idleTimeoutMs", orbitalSettingsSchema.idleTimeoutMs.parseEnvironment(match[2]!));
        else if (match[1] === "autoOn") await preferences.set("autoOn", piPreferencesSchema.autoOn.parseEnvironment(match[2]!));
        else await preferences.set("skillRoots", skillRoots(JSON.parse(match[2]!)));
      }
    } catch (cause) {
      error = cause instanceof SyntaxError ? "skillRoots must be a JSON array of absolute paths."
        : cause instanceof Error ? cause.message : "The setting could not be saved.";
    }
    const snapshot = settings.snapshot();
    const piSnapshot = preferences.snapshot();
    const content = [
      ...(error ? [`Error: ${error}`] : []),
      `Orbital settings: ${settings.filePath}`,
      `Saved: ${JSON.stringify(snapshot.saved)}`,
      `Effective: ${JSON.stringify(snapshot.effective)}`,
      `Source: ${JSON.stringify(snapshot.source)}`,
      "Changes apply to the next allocation.",
      `Pi preferences: ${preferences.filePath}`,
      `Saved: ${JSON.stringify(piSnapshot.saved)}`,
      `Effective: ${JSON.stringify(piSnapshot.effective)}`,
      `Source: ${JSON.stringify(piSnapshot.source)}`,
      "autoOn applies to new sessions. skillRoots applies to the next skill read.",
      `Diagnostics: ${JSON.stringify([...snapshot.diagnostics, ...piSnapshot.diagnostics])}`,
    ].join("\n");
    pi.sendMessage({ customType: "orbital.settings", content, display: true,
      details: { settings: snapshot, preferences: piSnapshot, error } }, { triggerTurn: false });
    if (ctx.mode === "print") process.stderr.write(`${content}\n`);
    if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
  }
  return { options, command };
}

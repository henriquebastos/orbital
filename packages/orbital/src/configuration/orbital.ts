import { basename, dirname, join, resolve } from "node:path";
import type { E2BProviderConfig } from "../e2b/provider.js";
import { imageCacheDirectory } from "../lifecycle/images/cache-directory.js";
import { OrbitalError } from "../operations.js";
import { validateEnvironment } from "../environment.js";
import { createNodeSettings, settingsDirectory } from "./file-store.js";
import { orbitalSettingsSchema, type ImageResources } from "./settings.js";
import { projectPreparation } from "./project.js";

export function createOrbitalConfiguration(options: {
  environment?: Record<string, string | undefined>;
  directory?: string;
  cwd?: string;
} = {}) {
  const environment = options.environment ?? process.env;
  const directory = options.directory ?? settingsDirectory(environment);
  const cwd = resolve(options.cwd ?? process.cwd());
  // Checkouts with the same directory basename share private project settings.
  const projectName = basename(cwd);
  const userProjectFilePath = projectName ? join(directory, projectName, "settings.json") : undefined;
  const settings = createNodeSettings({ schema: orbitalSettingsSchema, environment, directory,
    userProjectFilePath, projectFilePath: join(cwd, ".orbital/settings.json") });
  return {
    settings,
    cacheDirectory: imageCacheDirectory(environment),
    e2b(): E2BProviderConfig {
      const apiKey = environment.E2B_API_KEY;
      if (!apiKey?.trim()) throw new OrbitalError("not_started", "missing_api_key", "E2B_API_KEY is required for Orbital remote operations.");
      return { apiKey };
    },
    env(names: readonly string[]): Record<string, string> {
      const selected = orbitalSettingsSchema.forwardEnv.parseSaved(names);
      const values = Object.fromEntries(selected.map(name => {
        const value = Object.hasOwn(environment, name) ? environment[name] : undefined;
        if (value === undefined) throw new OrbitalError("not_started", "missing_environment",
          `A selected host environment variable is missing: ${name}.`);
        return [name, value];
      }));
      validateEnvironment(values);
      if (!values.E2B_API_KEY?.trim()) throw new OrbitalError("not_started", "missing_renewal_key",
        "forwardEnv must include a nonempty E2B_API_KEY for Orb renewal.");
      return values;
    },
    async preparation(): Promise<string | undefined> {
      const snapshot = await settings.refresh();
      const diagnostics = snapshot.diagnostics.filter(item => item.source === "project" || item.source === "userProject");
      if (diagnostics.length) throw new OrbitalError("not_started", "configuration",
        diagnostics.map(item => item.message).join(" "));
      const path = snapshot.project !== undefined ? settings.projectFilePath
        : snapshot.userProject !== undefined ? settings.userProjectFilePath : undefined;
      return path === undefined ? undefined : projectPreparation(dirname(path));
    },
    async resources(): Promise<ImageResources> {
      const snapshot = await settings.refresh();
      const keys = ["cpuCount", "memoryMB", "minFreeDiskMb"];
      const diagnostics = snapshot.diagnostics.filter(item => item.key === undefined || keys.includes(item.key));
      if (diagnostics.length) throw new OrbitalError("not_started", "configuration",
        diagnostics.map(item => item.message).join(" "));
      const { cpuCount, memoryMB, minFreeDiskMb } = snapshot.effective;
      return { cpuCount, memoryMB, minFreeDiskMb };
    },
    async image(override?: string): Promise<string | undefined> {
      if (override !== undefined) return orbitalSettingsSchema.image.parseSaved(override);
      const snapshot = await settings.refresh();
      const diagnostics = snapshot.diagnostics.filter(item => item.key === undefined || item.key === "image");
      if (diagnostics.length) throw new OrbitalError("not_started", "configuration",
        diagnostics.map(item => item.message).join(" "));
      return snapshot.effective.image;
    },
  };
}

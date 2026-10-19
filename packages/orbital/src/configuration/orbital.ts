import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  projectDirectory?: string;
} = {}) {
  const environment = options.environment ?? process.env;
  const directory = options.directory ?? settingsDirectory(environment);
  const cwd = resolve(options.cwd ?? process.cwd());
  // One project directory: the option, then ORBITAL_PROJECT_DIR, then <cwd>/.orbital. Only the default may be absent.
  // A blank option or variable is unset, like XDG_CONFIG_HOME, so an empty value never packages the whole checkout.
  const selectedProjectDirectory = [options.projectDirectory, environment.ORBITAL_PROJECT_DIR].find(value => value?.trim());
  const projectDirectory = resolve(cwd, selectedProjectDirectory ?? ".orbital");
  const settings = createNodeSettings({ schema: orbitalSettingsSchema, environment, directory,
    projectFilePath: join(projectDirectory, "settings.json") });
  return {
    settings,
    projectDirectory,
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
      const diagnostics = snapshot.diagnostics.filter(item => item.source === "project");
      if (diagnostics.length) throw new OrbitalError("not_started", "configuration",
        diagnostics.map(item => item.message).join(" "));
      try {
        await stat(projectDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (selectedProjectDirectory === undefined) return undefined;
          throw new OrbitalError("not_started", "configuration", `The project directory does not exist: ${projectDirectory}.`);
        }
      }
      return projectPreparation(projectDirectory);
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

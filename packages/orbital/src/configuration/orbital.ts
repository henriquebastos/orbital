import type { E2BProviderConfig } from "../e2b/provider.js";
import { imageCacheDirectory } from "../hangar/images/cache-directory.js";
import { OrbitalError } from "../operations.js";
import { createNodeSettings } from "./file-store.js";
import { orbitalSettingsSchema } from "./settings.js";

export function createOrbitalConfiguration(options: {
  environment?: Record<string, string | undefined>;
  directory?: string;
} = {}) {
  const environment = options.environment ?? process.env;
  const settings = createNodeSettings({ schema: orbitalSettingsSchema, environment, directory: options.directory });
  return {
    settings,
    cacheDirectory: imageCacheDirectory(environment),
    e2b(): E2BProviderConfig {
      const apiKey = environment.E2B_API_KEY;
      if (!apiKey?.trim()) throw new OrbitalError("not_started", "missing_api_key", "E2B_API_KEY is required for Orbital remote operations.");
      return { apiKey };
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

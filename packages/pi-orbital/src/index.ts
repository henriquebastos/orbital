import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOrbital, createE2BProvider, createE2BImages, type Provider, type Images } from "@henriquebastosnet/orbital";
import { createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";
import { registerOrbitalPi } from "./extension.js";
import { createPiConfiguration } from "./preferences.js";

function unavailableProvider(message: string): Provider {
  const unavailable = (): never => { throw new Error(message); };
  return {
    resolve: async () => unavailable(), create: async () => unavailable(),
    resume: async () => unavailable(), delete: async () => unavailable(),
    url: () => unavailable(), exec: async () => unavailable(),
    readFile: async () => unavailable(), writeFile: async () => unavailable(),
    stat: async () => unavailable(),
  };
}

// Composition root with three responsibilities: startup provider and image construction,
// refreshable configuration, and Pi registration.
export default function orbitalExtension(pi: ExtensionAPI): void {
  const orbitalConfiguration = createOrbitalConfiguration();
  let provider: Provider;
  let images: Images | undefined;
  let startupRemoteProblem: string | undefined;
  // CPU, memory, and disk settings enter through image selection, not create-request fields.
  // The image manager calls this lazily after registration, when configuration below exists.
  const getConfiguredImageResources = () => configuration.options();
  // Provider credentials (or unavailability) are fixed at startup, not rebuilt on settings refresh.
  try {
    const e2b = orbitalConfiguration.e2b();
    provider = createE2BProvider(e2b);
    images = createE2BImages({ ...e2b, cacheDirectory: orbitalConfiguration.cacheDirectory,
      resources: getConfiguredImageResources });
  } catch (cause) {
    startupRemoteProblem = cause instanceof Error ? cause.message : "Remote configuration is unavailable.";
    provider = unavailableProvider(startupRemoteProblem);
  }
  // Refreshable settings and Pi preferences. Refresh reloads snapshots, never the provider above.
  const configuration = createPiConfiguration(pi, startupRemoteProblem, orbitalConfiguration.settings, orbitalConfiguration.env);
  registerOrbitalPi(pi, createOrbital({ provider, images }), async () => ({
    ...await configuration.options(), preparation: orbitalConfiguration.preparation,
  }), configuration);
}

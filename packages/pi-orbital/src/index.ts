import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOrbital, createE2BProvider, createE2BImages, type Provider } from "@henriquebastosnet/orbital";
import type { ImageResources } from "@henriquebastosnet/orbital/settings";
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

// Startup-fixed remote dependencies. Provider credentials (or unavailability) are fixed here and
// never rebuilt on settings refresh. A failure installs a provider whose operations throw the problem.
function createStartupRemote(orbitalConfiguration: ReturnType<typeof createOrbitalConfiguration>,
  getConfiguredImageResources: () => Promise<Partial<ImageResources>>) {
  try {
    const e2b = orbitalConfiguration.e2b();
    const provider = createE2BProvider(e2b);
    const images = createE2BImages({ ...e2b, cacheDirectory: orbitalConfiguration.cacheDirectory,
      resources: getConfiguredImageResources });
    return { provider, images, startupRemoteProblem: undefined };
  } catch (cause) {
    const startupRemoteProblem = cause instanceof Error ? cause.message : "Remote configuration is unavailable.";
    return { provider: unavailableProvider(startupRemoteProblem), images: undefined, startupRemoteProblem };
  }
}

// Composition root: startup remote dependencies, refreshable configuration, then Pi registration.
export default function orbitalExtension(pi: ExtensionAPI): void {
  const orbitalConfiguration = createOrbitalConfiguration();
  // CPU, memory, and disk settings enter through image selection, not create-request fields.
  // The image manager calls this lazily after registration, when configuration below exists.
  const getConfiguredImageResources = () => configuration.options();
  const { provider, images, startupRemoteProblem } = createStartupRemote(orbitalConfiguration, getConfiguredImageResources);
  // Refreshable settings and Pi preferences. Refresh reloads snapshots, never the provider above.
  const configuration = createPiConfiguration(pi, startupRemoteProblem, orbitalConfiguration.settings, orbitalConfiguration.env);
  registerOrbitalPi(pi, createOrbital({ provider, images }), async () => ({
    ...await configuration.options(), preparation: orbitalConfiguration.preparation,
  }), configuration);
}

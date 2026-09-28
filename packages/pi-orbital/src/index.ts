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

export default function orbitalExtension(pi: ExtensionAPI): void {
  const orbitalConfiguration = createOrbitalConfiguration();
  let provider: Provider;
  let images: Images | undefined;
  let problem: string | undefined;
  try {
    const e2b = orbitalConfiguration.e2b();
    provider = createE2BProvider(e2b);
    images = createE2BImages({ ...e2b, cacheDirectory: orbitalConfiguration.cacheDirectory });
  } catch (cause) {
    problem = cause instanceof Error ? cause.message : "Remote configuration is unavailable.";
    provider = unavailableProvider(problem);
  }
  const configuration = createPiConfiguration(pi, problem, orbitalConfiguration.settings);
  registerOrbitalPi(pi, createOrbital({ provider, images }), configuration.options, configuration.command);
}

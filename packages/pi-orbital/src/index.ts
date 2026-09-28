import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOrbital, createE2BProvider, createE2BImages, type Provider } from "@henriquebastosnet/orbital";
import { imageCacheDirectory } from "@henriquebastosnet/orbital/settings/node";
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
  const apiKey = process.env.E2B_API_KEY;
  const problem = !apiKey ? "E2B_API_KEY is required for Orbital remote operations." : undefined;
  const provider = problem ? unavailableProvider(problem) : createE2BProvider({ apiKey: apiKey! });
  const images = problem ? undefined : createE2BImages({ apiKey: apiKey!,
    cacheDirectory: imageCacheDirectory() });
  const configuration = createPiConfiguration(pi, problem);
  registerOrbitalPi(pi, createOrbital({ provider, images }), configuration.options, configuration.command);
}

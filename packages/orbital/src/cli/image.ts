#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOrbital } from "../hangar/index.js";
import { createE2BImages } from "../e2b/images.js";
import { createE2BProvider } from "../e2b/provider.js";
import { OrbitalError } from "../operations.js";
import { orbitalSettingsSchema } from "../configuration/settings.js";
import { createNodeSettings, imageCacheDirectory } from "../configuration/node.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    image: { type: "string" }, preparation: { type: "string" }, refresh: { type: "boolean" },
    "cache-directory": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    process.stdout.write("Usage: orbital-image [--image REFERENCE] [--preparation FILE] [--refresh] [--cache-directory DIRECTORY]\n\nPrepare the Orbital base or cache Bash preparation. Builds run on E2B. E2B_API_KEY is required.\n");
    return;
  }
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new OrbitalError("not_started", "missing_api_key", "E2B_API_KEY is required.");
  let image = values.image;
  if (image === undefined) {
    const settings = createNodeSettings({ schema: { image: orbitalSettingsSchema.image } });
    const snapshot = await settings.refresh();
    const diagnostics = snapshot.diagnostics.filter(item => item.key === undefined || item.key === "image");
    if (diagnostics.length) throw new OrbitalError("not_started", "configuration",
      diagnostics.map(item => item.message).join(" "));
    image = snapshot.effective.image;
  }
  const preparation = values.preparation === undefined ? undefined : await readFile(values.preparation, "utf8");
  const cacheDirectory = values["cache-directory"] === undefined ? imageCacheDirectory() : resolve(values["cache-directory"]);
  const orbital = createOrbital({ provider: createE2BProvider({ apiKey }), images: createE2BImages({ apiKey, cacheDirectory }) });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await orbital.prepare({ image, preparation, refresh: values.refresh }, {
      signal: controller.signal,
      onProgress: event => { process.stderr.write(`${event.phase}\n`); },
      onOutput: chunk => { process.stderr.write(chunk); },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

await main().catch((cause: unknown) => {
  const failure = cause instanceof OrbitalError
    ? { outcome: cause.outcome, code: cause.code, message: cause.message, evidence: cause.evidence }
    : { message: cause instanceof Error ? cause.message : "Image preparation failed." };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createOrbital } from "../hangar/index.js";
import { createE2BImages } from "../e2b/images.js";
import { createE2BProvider } from "../e2b/provider.js";
import { OrbitalError } from "../operations.js";
import { createOrbitalConfiguration } from "../configuration/node.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    image: { type: "string" }, preparation: { type: "string" }, refresh: { type: "boolean" },
    "cache-directory": { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    process.stdout.write("Usage: orbital-image [--image REFERENCE] [--preparation FILE] [--refresh] [--cache-directory DIRECTORY]\n\nPrepare the Orbital base or cache Bash preparation. Builds run on E2B. E2B_API_KEY is required.\n");
    return;
  }
  const configuration = createOrbitalConfiguration();
  const e2b = configuration.e2b();
  const image = await configuration.image(values.image);
  const preparation = values.preparation === undefined ? undefined : await readFile(values.preparation, "utf8");
  const cacheDirectory = values["cache-directory"] === undefined ? configuration.cacheDirectory : resolve(values["cache-directory"]);
  const orbital = createOrbital({ provider: createE2BProvider(e2b), images: createE2BImages({ ...e2b, cacheDirectory }) });
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

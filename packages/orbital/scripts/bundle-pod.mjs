import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = resolve(root, "guest/pod");
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const [source, destination] of [
  ["src/orbital-runner.mjs", "orbital-runner.mjs"],
  ["src/renew.mjs", "renew.mjs"],
  ["runtime/package.json", "package.json"],
  ["runtime/package-lock.json", "package-lock.json"],
]) {
  await copyFile(resolve(root, "../pod", source), resolve(target, destination));
}

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function imageCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_CACHE_HOME;
  const root = configured && isAbsolute(configured) ? configured : join(homedir(), ".cache");
  return join(root, "orbital", "images");
}

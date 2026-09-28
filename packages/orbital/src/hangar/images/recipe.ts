import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { Template } from "e2b";

const cpuCount = 2;
const memoryMB = 1024;
const systemPackagesCommand = "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ripgrep fd-find && ln -sf /usr/bin/fdfind /usr/local/bin/fd && rm -rf /var/lib/apt/lists/*";
const installCommand = "cd /opt/orbital && npm ci --omit=dev";
const linkCommand = "ln -sf /opt/orbital/node_modules/node/bin/node /usr/local/bin/node && ln -sf /opt/orbital/pod/orbital-runner.mjs /usr/local/bin/orbital-runner && chmod 755 /opt/orbital/pod/orbital-runner.mjs && chown -R user:user /home/user/.orbital";

export const runtimeCheckCommand = "node --version | rg '^v22\\.15\\.0$' && node --check /opt/orbital/pod/orbital-runner.mjs && node -e 'import(\"/opt/orbital/pod/renew.mjs\").then(m => { if (typeof m.renew !== \"function\") process.exit(1) })' && sudo -n true && command -v rg && command -v fd && command -v git && command -v python3 && command -v bash && test -d /opt/orbital/pod && test -d /home/user/.orbital/jobs && test -x /usr/local/bin/orbital-runner && test -w /home/user/.orbital/jobs";

const payloadPaths = [
  "pod/orbital-runner.mjs",
  "pod/renew.mjs",
  "pod/package.json",
  "pod/package-lock.json",
] as const;

async function packageRoot(): Promise<string> {
  const root = resolve(import.meta.dirname, "../../..");
  await readFile(resolve(root, "guest/pod/package-lock.json"));
  return root;
}

export async function orbitalRecipe(): Promise<{
  sourceHash: string;
  template: ReturnType<typeof Template>;
  cpuCount: number;
  memoryMB: number;
}> {
  const root = await packageRoot();
  const guestRoot = resolve(root, "guest");
  const payload = await Promise.all(payloadPaths.map((path) => readFile(resolve(guestRoot, path))));
  const template = Template({ fileContextPath: guestRoot });
  template.fromBaseImage()
    .runCmd(systemPackagesCommand, { user: "root" })
    .makeDir(["/opt/orbital", "/opt/orbital/pod", "/home/user/.orbital/jobs"], { user: "root" })
    .copy("pod/package.json", "/opt/orbital/package.json", { user: "root" })
    .copy("pod/package-lock.json", "/opt/orbital/package-lock.json", { user: "root" })
    .copy("pod/orbital-runner.mjs", "/opt/orbital/pod/orbital-runner.mjs", { user: "root", mode: 0o755 })
    .copy("pod/renew.mjs", "/opt/orbital/pod/renew.mjs", { user: "root", mode: 0o644 })
    .runCmd(installCommand, { user: "root" })
    .runCmd(linkCommand, { user: "root" })
    .runCmd(runtimeCheckCommand, { user: "user" });
  const sourceHash = hashBaseRecipe(await Template.toJSON(template, false), { cpuCount, memoryMB },
    payloadPaths.map((path, index) => ({ path, bytes: payload[index]! })));
  return { sourceHash, template, cpuCount, memoryMB };
}

export function hashBaseRecipe(templateJSON: string, resources: { cpuCount: number; memoryMB: number },
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): string {
  const digest = createHash("sha256");
  digest.update("orbital-base-recipe:v1");
  digest.update(templateJSON);
  digest.update(JSON.stringify({ cpuCount: resources.cpuCount, memoryMB: resources.memoryMB }));
  for (const { path, bytes } of files) {
    digest.update(path);
    digest.update(String(bytes.length));
    digest.update(bytes);
  }
  return digest.digest("hex");
}

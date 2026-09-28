import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export function checkedState() {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0")
    .filter(path => /^(packages\/|tests\/|scripts\/|package(?:-lock)?\.json$|tsconfig(?:\.[^/]*)?\.json$|env-dev\.tpl$)/.test(path)
      && !path.endsWith(".md")
      && !/(^|\/)(dist|guest|node_modules)\//.test(path)).sort();
  const hash = createHash("sha256");
  for (const path of files) if (existsSync(path)) hash.update(path).update("\0").update(readFileSync(path));
  const manifests = ["package.json", "packages/orbital/package.json", "packages/pod/package.json",
    "packages/pi-orbital/package.json"].filter(existsSync)
    .map(path => ({ path, ...JSON.parse(readFileSync(path, "utf8")) as { name?: string; version?: string;
      dependencies?: Record<string, string> } }));
  return { revision: git("rev-parse", "HEAD"), sourceHash: hash.digest("hex"),
    dirtyDiffHash: createHash("sha256").update(git("diff", "HEAD", "--binary")).digest("hex"),
    node: process.version, platform: process.platform, architecture: process.arch,
    packages: manifests.map(({ path, name, version, dependencies }) => ({ path, name, version, dependencies })) };
}

export function saveReceipt(name: string, result: Record<string, unknown>, directory?: string) {
  const location = directory ?? resolve("test-output", `${new Date().toISOString().replaceAll(":", "-")}-${name}`);
  mkdirSync(location, { recursive: true });
  const receipt = { case: name, recordedAt: new Date().toISOString(), ...checkedState(), ...result };
  writeFileSync(resolve(location, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  writeFileSync(resolve(location, "report.md"), `# 1 ${name}\n\nStatus: ${String(result.status)}.\n\nSee receipt.json for assertions, inputs, and cleanup.\n`);
  console.log(JSON.stringify({ status: result.status, receipt: resolve(location, "receipt.json") }));
  return location;
}

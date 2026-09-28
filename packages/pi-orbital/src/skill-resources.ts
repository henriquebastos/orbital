import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const maxSkillBytes = 100_000;
const maxAssetBytes = 5_000_000;

function within(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function safeRelative(value: string): string {
  if (!value || isAbsolute(value) || value.split(/[\\/]/).some(part => !part || part === "." || part === ".." || !/^[a-zA-Z0-9_.-]+$/.test(part))) {
    throw new Error("The skill name or asset path is not permitted.");
  }
  return value;
}

async function roots(requested: readonly string[]): Promise<string[]> {
  const defaults = [resolve(getAgentDir(), "skills"), resolve(homedir(), ".agents/skills")];
  const found = await Promise.all([...requested, ...defaults].map(async path => {
    try { return await realpath(path); } catch { return undefined; }
  }));
  return [...new Set(found.filter((value): value is string => !!value))];
}

async function namedSkill(name: string, requested: readonly string[]): Promise<string> {
  const safe = safeRelative(name);
  for (const root of await roots(requested)) {
    try {
      const directory = await realpath(resolve(root, safe));
      if (!within(root, directory)) continue;
      const marker = await realpath(resolve(directory, "SKILL.md"));
      if (!within(directory, marker) || !(await stat(marker)).isFile()) continue;
      return directory;
    } catch { /* Try another configured root. */ }
  }
  throw new Error(`Named skill ${name} was not found in an allowed skill root.`);
}

export async function listSkills(requested: readonly string[] = []): Promise<string[]> {
  const names = new Set<string>();
  async function scan(root: string, directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      try {
        const actual = await realpath(path);
        if (!within(root, actual)) continue;
        const marker = await realpath(resolve(actual, "SKILL.md"));
        if (within(actual, marker) && (await stat(marker)).isFile()) names.add(name);
      } catch { /* A grouping directory may have no SKILL.md. */ }
      await scan(root, path, depth + 1);
    }
  }
  for (const root of await roots(requested)) await scan(root, root, 1);
  return [...names].sort();
}

export async function readSkill(name: string, requested: readonly string[] = []): Promise<string> {
  const directory = await namedSkill(name, requested);
  const file = await realpath(resolve(directory, "SKILL.md"));
  if (!within(directory, file) || (await stat(file)).size > maxSkillBytes) {
    throw new Error("The named skill instructions are not permitted or exceed the size limit.");
  }
  return readFile(file, "utf8");
}

export async function readSkillAsset(name: string, asset: string, requested: readonly string[] = []): Promise<Uint8Array> {
  const directory = await namedSkill(name, requested);
  const file = await realpath(resolve(directory, safeRelative(asset)));
  if (!within(directory, file) || !(await stat(file)).isFile()) {
    throw new Error("The asset is outside the named skill or is not a file.");
  }
  if ((await stat(file)).size > maxAssetBytes) throw new Error("The skill asset exceeds the size limit.");
  return readFile(file);
}

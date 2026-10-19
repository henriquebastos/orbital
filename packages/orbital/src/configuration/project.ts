import { lstat, readdir, readFile, readlink, stat as rootStat } from "node:fs/promises";
import { join } from "node:path";
import { OrbitalError } from "../operations.js";

type Entry = { path: string; mode: number } & (
  | { type: "directory" }
  | { type: "file"; content: string }
  | { type: "link"; target: string }
);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Package the project directory, not the checkout. Its deterministic script uses the image cache and recovery path.
export async function projectPreparation(projectDirectory: string, destination = "/opt/orbital/project"): Promise<string> {
  const entries: Entry[] = [];
  async function visit(path: string): Promise<void> {
    const absolute = join(projectDirectory, path);
    const stat = path === "." ? await rootStat(absolute) : await lstat(absolute);
    const common = { path, mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      entries.push({ ...common, type: "link", target: await readlink(absolute) });
    } else if (stat.isDirectory()) {
      entries.push({ ...common, type: "directory" });
      for (const name of (await readdir(absolute)).sort()) await visit(path === "." ? name : `${path}/${name}`);
    } else if (stat.isFile()) {
      entries.push({ ...common, type: "file", content: (await readFile(absolute)).toString("base64") });
    } else {
      throw new OrbitalError("not_started", "configuration", "Project directories can contain only files, directories, and symbolic links.");
    }
  }
  try {
    await visit(".");
  } catch (cause) {
    if (cause instanceof OrbitalError) throw cause;
    throw new OrbitalError("not_started", "configuration", "Cannot read the project directory.");
  }
  // Only build is invoked by the generated script. start and resume are reserved names for a
  // later lifecycle: they are copied and must already be executable, but nothing runs them here.
  for (const name of ["build", "start", "resume"]) {
    const entry = entries.find(item => item.path === name);
    if (entry && entry.type !== "link" && (entry.type !== "file" || !(entry.mode & 0o111))) {
      throw new OrbitalError("not_started", "configuration", `The project ${name} entry point must be executable.`);
    }
  }
  const payload = Buffer.from(JSON.stringify({ destination, entries }), "utf8").toString("base64");
  return `set -euo pipefail
sudo -n rm -rf -- ${quote(destination)}
sudo -n install -d -o "$(id -u)" -g "$(id -g)" -- ${quote(destination)}
python3 - <<'ORBITAL_PROJECT'
import base64
import json
from pathlib import Path

bundle = json.loads(base64.b64decode("${payload}"))
root = Path(bundle["destination"])
for entry in bundle["entries"]:
    path = root / entry["path"]
    if entry["type"] == "directory":
        path.mkdir(exist_ok=True)
    elif entry["type"] == "link":
        path.symlink_to(entry["target"])
    else:
        path.write_bytes(base64.b64decode(entry["content"]))
        path.chmod(entry["mode"])
for entry in reversed(bundle["entries"]):
    if entry["type"] == "directory":
        (root / entry["path"]).chmod(entry["mode"])
ORBITAL_PROJECT
cd ${quote(destination)}
if [ -e ./build ] || [ -L ./build ]; then
  exec ./build
fi
`;
}

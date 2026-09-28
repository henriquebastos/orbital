import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { saveReceipt } from "../support/receipts.js";

const root = resolve(".");
const pi = resolve("node_modules/.bin/pi");
const directory = mkdtempSync(resolve(tmpdir(), "orbital-install-"));
const checks: string[] = [];
const env = { ...process.env, XDG_CONFIG_HOME: resolve(directory, "config"),
  E2B_API_KEY: "", ORBITAL_IMAGE: "install-fixture",
  ORBITAL_AUTO_ON: "false", ORBITAL_PI_CALLS_FILE: "" };
let failure: string | undefined;
const packageArchives: Array<{ name: string; filename: string; integrity: string }> = [];

function run(command: string, args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: "utf8",
    timeout: 180_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}\n${result.error ?? ""}`);
  return result.stdout;
}

function verifyInstall(kind: string, spec: string, extra: NodeJS.ProcessEnv = {}) {
  const cwd = resolve(directory, kind);
  const agent = resolve(cwd, "agent");
  mkdirSync(cwd);
  const settings = { ...extra, PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: resolve(cwd, "config") };
  run(pi, ["install", spec], cwd, settings);
  const saved = JSON.parse(readFileSync(resolve(agent, "settings.json"), "utf8")) as { packages: string[] };
  assert.ok(saved.packages.some(item => resolve(agent, item) === spec),
    `${kind}: Pi must persist the installed source`);
  writeFileSync(resolve(cwd, "host-sentinel"), "HOST_ONLY");
  const output = run(pi, ["--offline", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--extension", resolve(directory, "model.ts"),
    "--provider", "orbital-fixture", "--model", "probe", "--tools", "orbital,bash",
    "--mode", "json", "--session", resolve(cwd, "session.jsonl"), "--print", "run installation fixture"], cwd,
  { ...settings, ORBITAL_PI_CALLS: JSON.stringify([
    { name: "bash", arguments: { command: "printf LOCAL_OK > local-result" } },
    { name: "orbital", arguments: { action: "create_and_attach" } },
    { name: "bash", arguments: { command: "printf REMOTE_SHOULD_NOT_RUN > host-sentinel" } },
  ]) });
  const results = output.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
    type: string; toolName?: string; isError?: boolean; result?: { content?: { text?: string }[] };
  }).filter(event => event.type === "tool_execution_end");
  assert.deepEqual(results.map(event => [event.toolName, event.isError]),
    [["bash", false], ["orbital", true], ["bash", true]], JSON.stringify(results));
  assert.equal(readFileSync(resolve(cwd, "local-result"), "utf8"), "LOCAL_OK");
  assert.match(results[1]?.result?.content?.[0]?.text ?? "", /E2B_API_KEY is required/);
  assert.equal(readFileSync(resolve(cwd, "host-sentinel"), "utf8"), "HOST_ONLY");
  checks.push(`${kind}: local Bash worked without provider settings; explicit remote creation failed and later Bash stayed remote`);
  return agent;
}

try {
  writeFileSync(resolve(directory, "model.ts"),
    `export { registerFixedModel as default } from ${JSON.stringify(resolve(root, "tests/support/fixed-model.ts"))};\n`);
  function pack(name: string) {
    const packed = JSON.parse(run("npm", ["pack", "--workspace", name, "--ignore-scripts", "--json",
      "--pack-destination", directory], root)) as { name: string; filename: string; integrity: string; files: { path: string }[] }[];
    assert.equal(packed.length, 1);
    const archive = packed[0]!;
    assert.equal(archive.name, name);
    assert.ok(archive.files.some(file => file.path === "LICENSE"), `${name}: MIT license missing`);
    assert.ok(archive.files.some(file => file.path === "dist/index.js"), `${name}: compiled entry missing`);
    assert.equal(archive.files.some(file => /^(test-output|tests|docs\/evidence)\//.test(file.path)), false);
    packageArchives.push({ name, filename: archive.filename, integrity: archive.integrity });
    return { archive, path: resolve(directory, archive.filename) };
  }
  const orbital = pack("@henriquebastosnet/orbital");
  const piPackage = pack("@henriquebastosnet/pi-orbital");
  for (const path of ["dist/cli/image.js", "guest/pod/package.json", "guest/pod/package-lock.json",
    "guest/pod/orbital-runner.mjs", "guest/pod/renew.mjs"]) {
    assert.ok(orbital.archive.files.some(file => file.path === path), `Orbital archive omits ${path}`);
  }
  assert.ok(piPackage.archive.files.some(file => file.path === "src/index.ts"));

  const libraryCwd = resolve(directory, "library");
  mkdirSync(libraryCwd);
  run("npm", ["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund",
    orbital.path], libraryCwd);
  assert.equal(existsSync(resolve(libraryCwd, "node_modules/@earendil-works/pi-coding-agent")), false);
  assert.equal(existsSync(resolve(libraryCwd, "node_modules/@henriquebastosnet/pi-orbital")), false);
  const guest = resolve(libraryCwd, "node_modules/@henriquebastosnet/orbital/guest/pod");
  for (const path of ["package.json", "package-lock.json", "orbital-runner.mjs", "renew.mjs"]) {
    assert.ok(existsSync(resolve(guest, path)), `Standalone Orbital omits ${path}`);
  }
  run(process.execPath, ["--input-type=module", "-e",
    "const [api, settings, node] = await Promise.all([import('@henriquebastosnet/orbital'), import('@henriquebastosnet/orbital/settings'), import('@henriquebastosnet/orbital/settings/node')]);"
    + " if (typeof api.createOrbital !== 'function' || typeof settings.resolveSettings !== 'function'"
    + " || typeof settings.orbitalSettingsSchema !== 'object' || typeof node.createNodeSettings !== 'function') process.exit(1);"], libraryCwd);
  assert.match(run(resolve(libraryCwd, "node_modules/.bin/orbital-image"), ["--help"], libraryCwd), /orbital-image/);
  checks.push("standalone Orbital: plain Node imports, guest assets, and image binary work without Pi");

  const consumer = resolve(directory, "consumer");
  mkdirSync(consumer);
  run("npm", ["install", "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund",
    orbital.path, piPackage.path], consumer);
  const installedPi = resolve(consumer, "node_modules/@henriquebastosnet/pi-orbital");
  assert.ok(existsSync(resolve(installedPi, "dist/index.js")));
  verifyInstall("archive-consumer", installedPi);
  verifyInstall("workspace", resolve(root, "packages/pi-orbital"));
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
saveReceipt("pi-install", { status: failure ? "failed" : "passed", checks, failure, packageArchives,
  piVersion: JSON.parse(readFileSync(resolve(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version,
  real: ["Pi install CLI", "Pi automatic extension discovery and tool dispatch", "npm dependency installation", "npm package archives"],
  substituted: ["fixed model responses"],
  cleanup: "Removed all temporary packages, Pi settings, and sessions. No hosted resources created.", skips: [] });
process.exitCode = failure ? 1 : 0;

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { checkedState, saveReceipt } from "../support/receipts.js";

const sourceRoot = resolve(import.meta.dirname, "../..");
const selected = process.argv[2] === "--case" ? process.argv[3] : undefined;
const startedAt = Date.now();
const sourceAtStart = checkedState();
const temporaryRoot = await mkdtemp(join(tmpdir(), "orbital-sensitivity-"));
const snapshot = join(temporaryRoot, "snapshot");

interface Case {
  name: string;
  source: string;
  from: string;
  to: string;
  test: string;
  pattern: string;
  expectedFailure: RegExp;
  environment?: (root: string) => Record<string, string>;
}

const cases: Case[] = [
  {
    name: "host_bash",
    source: "packages/pi-orbital/src/extension.ts",
    from: 'name: "bash",\n    label: "bash",',
    to: 'name: "host_bash",\n    label: "bash",',
    test: "packages/pi-orbital/tests/real-pi.test.ts",
    pattern: "real Pi creates an orb, attaches, and runs a command in its workspace",
    expectedFailure: /\+ 'REMOTE_ONLY'\s+- 'HOST_ONLY'/,
  },
  {
    name: "pty_host_bash",
    source: "packages/pi-orbital/src/extension.ts",
    from: 'name: "bash",\n    label: "bash",',
    to: 'name: "host_bash",\n    label: "bash",',
    test: "packages/pi-orbital/tests/pty.test.ts",
    pattern: "real Pi PTY keeps a remote orb across a follow-up user turn",
    expectedFailure: /\+ 'REMOTE_PTY'\s+- 'HOST_ONLY'/,
  },
  {
    name: "suppress_renewal",
    source: "packages/pod/src/orbital-runner.mjs",
    from: 'if (request.mode === "ordinary" && !renewalInFlight && performance.now() >= nextRenewAt) {',
    to: 'if (false && request.mode === "ordinary" && !renewalInFlight && performance.now() >= nextRenewAt) {',
    test: "packages/pod/tests/runner.test.mjs",
    pattern: "silent ordinary work keeps renewing until it finishes",
    expectedFailure: /renewals during silent work/,
    environment: (root) => ({ ORBITAL_RUNNER_PATH: resolve(root, "packages/pod/src/orbital-runner.mjs") }),
  },
  {
    name: "replay_unknown_command",
    source: "packages/orbital/src/workspace.ts",
    from: 'if (error instanceof OrbitalError) throw error;\n      throw new OrbitalError("uncertain", "transport", "The command outcome is unknown. Inspect the orb before retrying.");',
    to: 'if (error instanceof OrbitalError) throw error;\n      await this.provider.exec(this.orb, { ...request, orbCwd: this.orbCwd }, { ...this.observer, ...observer }).catch(() => undefined);\n      throw new OrbitalError("uncertain", "transport", "The command outcome is unknown. Inspect the orb before retrying.");',
    test: "packages/orbital/tests/contracts/orbital.test.ts",
    pattern: "unknown command and write failures remain uncertain and are never replayed",
    expectedFailure: /2 !== 1/,
  },
  {
    name: "ignore_malformed_latest_binding",
    source: "packages/pi-orbital/src/binding.ts",
    from: 'return { kind: "invalid", entryId: entry.id };',
    to: 'continue;',
    test: "packages/pi-orbital/tests/real-pi.test.ts",
    pattern: "Pi rejects a corrupt saved binding before any host or orb command",
    expectedFailure: /"isError":false[\s\S]*false !== true/,
  },
];

const chosen = selected ? cases.filter((item) => item.name === selected) : cases;
if (!chosen.length) throw new Error(`Unknown sensitivity case: ${selected}`);

interface RunResult { exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; output: string }

async function run(root: string, item: Case): Promise<RunResult> {
  const args = ["--import", "tsx", "--test", "--test-reporter=spec", `--test-name-pattern=${item.pattern}`, item.test];
  const environment = { ...process.env, ...item.environment?.(root) };
  delete environment.E2B_API_KEY;
  delete environment.OP_SA_ORBITAL_DEV;
  delete environment.ORBITAL_IMAGE;
  const build = spawnSync("npm", ["run", "build"], { cwd: root, env: environment, encoding: "utf8",
    timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  if (build.status !== 0) return { exitCode: build.status, signal: build.signal, timedOut: build.error?.name === "ETIMEDOUT",
    output: `Package build failed:\n${build.stdout}\n${build.stderr}\n${build.error ?? ""}` };
  const child = spawn(process.execPath, args, { cwd: root, env: environment, detached: true,
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-20_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* The test process already exited. */ }
  }, 45_000);
  try {
    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => done({ exitCode, signal }));
    });
    return { ...result, timedOut, output };
  } finally {
    clearTimeout(timer);
  }
}

async function linkDependencies(root: string): Promise<void> {
  const target = join(root, "node_modules");
  await mkdir(join(target, "@henriquebastosnet"), { recursive: true });
  for (const entry of await readdir(join(sourceRoot, "node_modules"), { withFileTypes: true })) {
    if (entry.name === "@henriquebastosnet") continue;
    await symlink(join(sourceRoot, "node_modules", entry.name), join(target, entry.name),
      entry.isDirectory() ? "dir" : "file");
  }
  for (const name of ["orbital", "pi-orbital"]) {
    await symlink(`../../packages/${name}`, join(target, "@henriquebastosnet", name), "dir");
  }
}

function replaceExactlyOnce(source: string, from: string, to: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + from.length) >= 0) {
    throw new Error("The deliberate defect did not match its source exactly once.");
  }
  return source.slice(0, first) + to + source.slice(first + from.length);
}

const results: Record<string, unknown>[] = [];
let failure: string | undefined;
let cleanup = false;
try {
  await mkdir(join(snapshot, "tests"), { recursive: true });
  for (const file of ["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.json"]) {
    await cp(join(sourceRoot, file), join(snapshot, file));
  }
  for (const directory of ["packages/orbital", "packages/pi-orbital", "packages/pod", "tests/support"]) {
    await cp(join(sourceRoot, directory), join(snapshot, directory), { recursive: true });
  }
  await linkDependencies(snapshot);

  for (const item of chosen) {
    const args = ["node", "--import", "tsx", "--test", "--test-reporter=spec", `--test-name-pattern=${item.pattern}`, item.test];
    const baseline = await run(snapshot, item);
    const record: Record<string, unknown> = { case: item.name, source: item.source,
      testCommand: args.join(" "), baseline: { exitCode: baseline.exitCode,
        timedOut: baseline.timedOut, output: baseline.output.slice(-4000) } };
    results.push(record);
    if (baseline.exitCode !== 0 || baseline.timedOut ||
      !baseline.output.includes(`✔ ${item.pattern}`) || !baseline.output.includes("pass 1")) {
      throw new Error(`${item.name}: baseline did not pass`);
    }
    const copy = join(temporaryRoot, item.name);
    await cp(snapshot, copy, { recursive: true, dereference: false, verbatimSymlinks: true });
    const file = join(copy, item.source);
    const original = await readFile(file, "utf8");
    const sourceHash = createHash("sha256").update(original).digest("hex");
    await writeFile(file, replaceExactlyOnce(original, item.from, item.to));
    const mutation = await run(copy, item);
    record.sourceHash = sourceHash;
    record.mutation = { from: item.from, to: item.to };
    record.mutated = { exitCode: mutation.exitCode, timedOut: mutation.timedOut,
      expectedFailureSeen: item.expectedFailure.test(mutation.output), output: mutation.output.slice(-8000) };
    if (mutation.exitCode === 0 || mutation.timedOut ||
      !mutation.output.includes(`✖ ${item.pattern}`) || !item.expectedFailure.test(mutation.output)) {
      throw new Error(`${item.name}: the existing test did not fail at the intended assertion`);
    }
  }
} catch (cause) {
  failure = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  process.exitCode = 1;
} finally {
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
    cleanup = true;
  } catch (cause) {
    failure ??= cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    process.exitCode = 1;
  }
  saveReceipt("sensitivity", { status: failure ? "failed" : "passed", sourceHashAtStart: sourceAtStart.sourceHash,
    durationMs: Date.now() - startedAt, selectedCases: chosen.map((item) => item.name),
    results, cleanup: { temporaryCopiesRemoved: cleanup, name: basename(temporaryRoot) }, failure,
    skips: [] });
}

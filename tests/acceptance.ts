import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkedState, saveReceipt } from "./support/receipts.js";

const directory = resolve("test-output", `${new Date().toISOString().replaceAll(":", "-")}-acceptance`);
const image = process.env.ORBITAL_IMAGE;
if (!image || !process.env.E2B_API_KEY) {
  saveReceipt("acceptance", { status: "blocked", reason: "ORBITAL_IMAGE and E2B_API_KEY are required.",
    cleanup: "No allocation created", skips: [] }, directory);
  process.exit(1);
}
mkdirSync(directory, { recursive: true });
const sourceAtStart = checkedState();
const startedAt = Date.now();
const runs: Record<string, unknown>[] = [];
let failure: string | undefined;

async function run(name: string, args: string[], timeoutMs: number, command = process.execPath): Promise<string[]> {
  console.log(JSON.stringify({ stage: name, state: "started" }));
  const child = spawn(command, args, { env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let timedOut = false;
  const capture = (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const stop = (signal: NodeJS.Signals) => {
    try { process.kill(-child.pid!, signal); } catch { /* The stage has already exited. */ }
  };
  const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); }, timeoutMs);
  const killTimer = setTimeout(() => stop("SIGKILL"), timeoutMs + 15_000);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => { clearTimeout(timer); clearTimeout(killTimer); });
  writeFileSync(resolve(directory, `${name}.log`), output);
  const receipts = output.split("\n").flatMap(line => {
    try { const item = JSON.parse(line) as { receipt?: string }; return item.receipt ? [item.receipt] : []; }
    catch { return []; }
  });
  runs.push({ name, command: [command, ...args], ...result, timedOut, receipts });
  writeFileSync(resolve(directory, "progress.json"), JSON.stringify({ image, sourceAtStart, runs }, null, 2) + "\n");
  if (result.code !== 0 || timedOut) throw new Error(`${name} failed. See ${name}.log and its cleanup receipt.`);
  return receipts;
}

try {
  await run("build", ["run", "build"], 120_000, "npm");
  await run("typecheck", ["run", "typecheck"], 120_000, "npm");
  await run("local", ["run", "test:unit"], 240_000, "npm");
  await run("install", ["--import", "tsx", "tests/integration/pi-install.ts"], 600_000);
  const simulation = await run("simulation", ["--import", "tsx", "packages/orbital/tests/contracts/simulation.ts"], 60_000);
  if (!simulation[0]) throw new Error("Simulation did not save a replay receipt.");
  await run("replay", ["--import", "tsx", "packages/orbital/tests/contracts/simulation.ts", "--replay", simulation[0]], 60_000);
  await run("sensitivity", ["--import", "tsx", "tests/sensitivity/run.ts"], 240_000);
  await run("linux", ["--import", "tsx", "tests/integration/linux-hosted.ts"], 180_000);
  await run("lifetime", ["--import", "tsx", "tests/integration/lifetime.ts"], 600_000);
  await run("hosted", ["--import", "tsx", "tests/integration/pi-flow.ts", "--case", "all"], 1_800_000);
  await run("routing", ["--import", "tsx", "tests/integration/routing.ts"], 600_000);
  if (checkedState().sourceHash !== sourceAtStart.sourceHash) throw new Error("Source changed during acceptance. Run the gate again against stable code.");
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
}
saveReceipt("acceptance", { status: failure ? "failed" : "passed", image, sourceAtStart, runs, failure,
  durationMs: Date.now() - startedAt, cleanup: "See each hosted receipt for exact allocation deletion. A timed-out stage has unverified cleanup.",
  real: ["Pi executable and PTY", "E2B SDK", "baked Orbital runner", "Linux processes", "public HTTP ingress"],
  substituted: ["fixed model responses", "provider effects in local tests", "labeled transport faults"], skips: [] }, directory);
process.exitCode = failure ? 1 : 0;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createOrbital, OrbitalError } from "@henriquebastosnet/orbital";
import { checkedState, saveReceipt } from "../../../../tests/support/receipts.js";
import { SimulatedProvider } from "../../../../tests/support/provider.js";

type Step = { at: number; operation: "command" | "write" | "edit" | "cancel"; fault: "none" | "before" | "after" };
const args = process.argv.slice(2);
const replay = args[0] === "--replay" ? JSON.parse(readFileSync(args[1]!, "utf8")) as { sourceHash: string; seed: number; schedule: Step[] } : undefined;
if (replay && replay.sourceHash !== checkedState().sourceHash) throw new Error("Replay source hash differs from the recorded source. Restore the recorded code before replay.");
const seedIndex = args.indexOf("--seed");
const seed = replay?.seed ?? Number(seedIndex >= 0 ? args[seedIndex + 1] : 42);
if (!Number.isSafeInteger(seed)) throw new Error("The seed must be an integer.");
let random = seed >>> 0;
const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random; };
const operations = ["command", "write", "edit", "cancel"] as const;
const faults = ["none", "before", "after"] as const;
const schedule: Step[] = replay?.schedule ?? [
  ...operations.flatMap(operation => faults.map(fault => ({ operation, fault }))),
  ...Array.from({ length: 36 }, () => ({ operation: operations[(next() >>> 16) % operations.length]!, fault: faults[(next() >>> 16) % faults.length]! })),
].map((step, index) => ({ at: index * 100, ...step }));
const provider = new SimulatedProvider();
const orbital = createOrbital({ provider });
const request = { orbId: "simulation-session", image: "simulation-image", idleTimeoutMs: 50 };
const trace: Record<string, unknown>[] = [];
let failure: string | undefined;
try {
  await orbital.create(request);
  for (const [index, step] of schedule.entries()) {
    provider.fault = undefined;
    // Advancing external time expires the provider lease without running application code.
    provider.orbs[0]!.state = "sleeping";
    const workspace = await orbital.openWorkspace({ orbId: request.orbId, orbCwd: "/home/user" });
    assert.equal((await orbital.inspect({ orbId: request.orbId }))?.state, "running");
    const path = `fixture-${index}`;
    if (step.operation === "edit") await workspace.writeFile(path, Buffer.from("before"));
    const baseline = provider.effects.length;
    let outcome: string = "completed";
    if (step.operation === "command") provider.fault = step.fault === "before" ? "reject" : step.fault === "after" ? "lose_command" : undefined;
    if (step.operation === "write" || step.operation === "edit") provider.fault = step.fault === "before" ? "reject" : step.fault === "after" ? "lose_write" : undefined;
    try {
      if (step.operation === "command") await workspace.exec({ command: `effect-${index}` });
      else if (step.operation === "cancel") await workspace.exec({ command: `effect-${index}` }, { signal: AbortSignal.abort() });
      else if (step.operation === "edit") await workspace.edit({ path, oldText: "before", newText: "after" });
      else await workspace.writeFile(path, Buffer.from("after"));
    } catch (error) {
      assert.ok(error instanceof OrbitalError);
      outcome = error.outcome;
    }
    const expected = step.operation === "cancel" || step.fault === "before" ? "not_started"
      : step.fault === "after" ? "uncertain" : "completed";
    assert.equal(outcome, expected);
    const effects = provider.effects.slice(baseline);
    assert.equal(effects.length, expected === "not_started" ? 0 : 1, "A possibly admitted mutation must not be replayed.");
    if (step.operation === "write" || step.operation === "edit") {
      if (step.operation === "write" && expected === "not_started") await assert.rejects(workspace.readFile(path), { code: "missing_file" });
      else assert.equal(Buffer.from(await workspace.readFile(path)).toString(), expected === "not_started" ? "before" : "after");
    }
    assert.equal(provider.orbs.length, 1);
    trace.push({ ...step, outcome, effects });
  }
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
saveReceipt("simulation", { status: failure ? "failed" : "passed", seed, schedule, trace, failure,
  mode: "deterministic", substituted: ["provider state and effects", "virtual time", "fault admission and response order"],
  assertions: ["same resource", "demand wake", "known pre-execution failure", "uncertain mutation", "no replay", "file effect"],
  cleanup: "In-memory allocations discarded", skips: [] });
process.exitCode = failure ? 1 : 0;

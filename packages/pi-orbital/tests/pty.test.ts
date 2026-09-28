import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const pi = resolve("node_modules/.bin/pi");
const extension = resolve("packages/pi-orbital/tests/fixture-extension.ts");
const driver = resolve("packages/pi-orbital/tests/pty.expect");

test("real Pi PTY keeps a remote orb across a follow-up user turn", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "orbital-pi-pty-"));
  const hostMarker = resolve(directory, "marker");
  const remoteMarker = resolve(directory, "orb", "marker");
  const session = resolve(directory, "session.jsonl");
  writeFileSync(hostMarker, "HOST_ONLY");
  const environment: NodeJS.ProcessEnv = { ...process.env,
    TERM: "xterm-256color",
    PI_CODING_AGENT_DIR: resolve(directory, "agent"),
    ORBITAL_PI_FIXTURE_ROOT: directory,
    ORBITAL_PI_BIN: pi,
    ORBITAL_PI_EXTENSION: extension,
    ORBITAL_PI_SESSION: session,
    ORBITAL_PI_CALLS: JSON.stringify([
      { name: "orbital", arguments: { action: "create_and_attach" } },
      { name: "bash", arguments: { command: 'printf REMOTE_PTY > marker; printf "PTY_OUT_%s" "$(cat marker)"' } },
      null,
      { name: "read", arguments: { path: "marker" } },
      null,
    ]),
  };
  delete environment.E2B_API_KEY;
  const child = spawn("expect", [driver], { cwd: directory, env: environment, detached: true,
    stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
  let exited = false;
  let driverExitCode: number | null | undefined;
  const stop = () => {
    if (!exited && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* The PTY driver exited. */ }
    }
    if (driverExitCode !== 0) {
      const piPid = Number(output.match(/__PTY_CHILD_PID__(\d+)/)?.[1]);
      if (Number.isSafeInteger(piPid) && piPid > 0) {
        try { process.kill(piPid, "SIGKILL"); } catch { /* The Pi child exited. */ }
      }
    }
  };
  const watchdog = setTimeout(stop, 40_000);
  try {
    const code = await new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("close", (value) => { exited = true; driverExitCode = value; done(value); });
    });
    assert.equal(code, 0, output.slice(-5000));
    assert.match(output, /__FIRST_REMOTE_OUTPUT__/, output.slice(-5000));
    assert.match(output, /__FOLLOWUP_TURN_DONE__/, output.slice(-5000));
    assert.equal(readFileSync(hostMarker, "utf8"), "HOST_ONLY");
    assert.equal(readFileSync(remoteMarker, "utf8"), "REMOTE_PTY");
    const saved = readFileSync(session, "utf8");
    assert.match(saved, /Create the orb and run the marker command/);
    assert.match(saved, /Read the marker from the same orb/);
    const entries = saved.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
      type: string; id?: string; customType?: string; data?: unknown;
      message?: { role?: string; toolName?: string; content?: { text?: string }[]; details?: { orbId?: string } };
    });
    const binding = [...entries].reverse().find(entry => entry.customType === "orbital.binding");
    assert.deepEqual(binding?.data, { version: 1, route: "remote", allocation: "attached", orbCwd: "/home/user" });
    const attached = entries.find(entry => entry.message?.role === "toolResult" && entry.message.toolName === "orbital");
    const orb = JSON.parse(readFileSync(resolve(directory, "snapshot.json"), "utf8")) as { orbId: string };
    assert.equal(orb.orbId, entries[0]?.id);
    assert.equal(attached?.message?.details?.orbId, orb.orbId);
    const readResult = entries.find((entry) => entry.type === "message" &&
      entry.message?.role === "toolResult" && entry.message.toolName === "read");
    assert.match(JSON.stringify(readResult), /REMOTE_PTY/);
  } finally {
    clearTimeout(watchdog);
    stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

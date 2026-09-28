import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createOrbital, OrbitalError, type OrbSnapshot, type Provider } from "@henriquebastosnet/orbital";
import { registerOrbitalPi } from "../src/extension.js";
import { registerFixedModel } from "../../../tests/support/fixed-model.js";

export default function fixtureExtension(pi: ExtensionAPI): void {
  const root = process.env.ORBITAL_PI_FIXTURE_ROOT;
  if (!root) throw new Error("ORBITAL_PI_FIXTURE_ROOT is required.");
  const orbRoot = join(root, "orb");
  const snapshotPath = join(root, "snapshot.json");
  const localPath = (remotePath: string): string => {
    if (!remotePath.startsWith("/home/user")) throw new Error(`Invalid remote path: ${remotePath}`);
    return resolve(orbRoot, `.${remotePath.slice("/home/user".length)}`);
  };
  const provider: Provider = {
    async resolve(orbId) {
      if (process.env.ORBITAL_PI_FAULT === "lookup") throw new Error("Fixture lookup is unavailable.");
      if (!existsSync(snapshotPath)) return undefined;
      const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as OrbSnapshot;
      return snapshot.orbId === orbId ? snapshot : undefined;
    },
    async create(request) {
      if (process.env.ORBITAL_PI_PROVIDER_TRACE) appendFileSync(process.env.ORBITAL_PI_PROVIDER_TRACE,
        JSON.stringify({ operation: "create", orbId: request.orbId }) + "\n");
      if (process.env.ORBITAL_PI_CREATE_DELAY) await new Promise(done => setTimeout(done, 100));
      mkdirSync(orbRoot, { recursive: true });
      const snapshot: OrbSnapshot = { orbId: request.orbId, resourceId: randomUUID(),
        image: request.image, state: "running", idleTimeoutMs: request.idleTimeoutMs };
      writeFileSync(snapshotPath, JSON.stringify(snapshot));
      if (process.env.ORBITAL_PI_FAULT === "creation") {
        throw new OrbitalError("uncertain", "fixture_creation_lost", "The allocation reply was lost.");
      }
      return snapshot;
    },
    async resume() {},
    async delete() { rmSync(snapshotPath, { force: true }); },
    url(orb, port) { return `https://${orb.resourceId}.fixture.invalid:${port}`; },
    async exec(_orb, request, observer) {
      const jobId = randomUUID();
      const run = spawnSync("/bin/bash", ["-c", request.command.replaceAll("/home/user", orbRoot)], {
        cwd: localPath(request.orbCwd), encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: orbRoot, ...request.env }, timeout: request.timeoutMs,
      });
      const physicalRoot = realpathSync(orbRoot);
      const stdout = (run.stdout ?? "").replaceAll(physicalRoot, "/home/user").replaceAll(orbRoot, "/home/user");
      const stderr = (run.stderr ?? "").replaceAll(physicalRoot, "/home/user").replaceAll(orbRoot, "/home/user");
      if (stdout) observer?.onOutput?.(stdout);
      if (stderr) observer?.onOutput?.(stderr);
      const outputPath = `/home/user/.orbital/output-${jobId}`;
      mkdirSync(dirname(localPath(outputPath)), { recursive: true });
      writeFileSync(localPath(outputPath), stdout + stderr);
      if (process.env.ORBITAL_PI_FAULT === "command" && request.command.includes("LOST_EFFECT")) {
        throw new OrbitalError("uncertain", "fixture_result_lost", "The remote command response was lost.",
          { jobId, outputPath, partialOutput: stdout });
      }
      return { kind: request.mode === "background" ? "background" : run.error ? "timed_out" : "exited", jobId,
        stdout: stdout.slice(0, 65_536), stderr: stderr.slice(0, 65_536),
        outputPath, exitCode: run.status ?? undefined };
    },
    async readFile(_orb, path) { return readFileSync(localPath(path)); },
    async writeFile(_orb, path, content) {
      mkdirSync(dirname(localPath(path)), { recursive: true });
      writeFileSync(localPath(path), content);
      if (process.env.ORBITAL_PI_FAULT === "write" && path.endsWith("/fault.txt")) {
        throw new OrbitalError("uncertain", "fixture_result_lost", "The remote write response was lost.", { path });
      }
    },
    async stat(_orb, path) {
      const stat = statSync(localPath(path));
      return { kind: stat.isDirectory() ? "directory" : "file", size: stat.size };
    },
  };
  registerOrbitalPi(pi, createOrbital({ provider }), { image: "fixture-image", idleTimeoutMs: 60_000,
    autoOn: process.env.ORBITAL_AUTO_ON === "true",
    skillRoots: process.env.ORBITAL_SKILL_ROOTS?.split(delimiter).filter(Boolean) });
  pi.registerCommand("fixture-tree", { description: "Select a fixture branch.",
    async handler(args, ctx) { await ctx.navigateTree(args.trim(), { summarize: false }); } });
  if (process.env.ORBITAL_PI_TRACE) {
    pi.on("session_start", (event, ctx) => {
      appendFileSync(process.env.ORBITAL_PI_TRACE!, JSON.stringify({ reason: event.reason,
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
        entries: ctx.sessionManager.getBranch()
          .filter(entry => entry.type === "custom").map(entry => ({ type: entry.customType, data: entry.data })) }) + "\n");
    });
  }
  registerFixedModel(pi);
}

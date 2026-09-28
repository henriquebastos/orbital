import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Sandbox, SandboxNotFoundError } from "e2b";
import { createE2BImages } from "@henriquebastosnet/orbital";
import { createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";

const configuration = createOrbitalConfiguration();
const { apiKey } = configuration.e2b();
const { reference: image } = await createE2BImages({ apiKey, cacheDirectory: configuration.cacheDirectory })
  .ensure({ image: await configuration.image() });
const baked = process.argv.includes("--baked");
const source = await readFile(resolve(import.meta.dirname, "../src/orbital-runner.mjs"));
const testSource = await readFile(resolve(import.meta.dirname, "runner.test.mjs"));
const sourceHash = createHash("sha256").update(source).update(testSource).digest("hex");
const receiptDirectory = resolve("test-output", `${new Date().toISOString().replaceAll(":", "-")}-runner-linux`);
const sandbox = await Sandbox.create(image, {
  apiKey,
  timeoutMs: 60_000,
  envs: { E2B_API_KEY: apiKey },
  lifecycle: { onTimeout: "pause", autoResume: true },
});
let result;
let failure;
let cleanup = {};
try {
  const testPath = "/home/user/orbital-runner.test.mjs";
  const sourcePath = "/home/user/orbital-runner.mjs";
  await sandbox.files.write(testPath, testSource);
  if (!baked) await sandbox.files.write(sourcePath, source);
  const command = `ORBITAL_RUNNER_PATH=${baked ? "/usr/local/bin/orbital-runner" : sourcePath} node --test ${testPath}`;
  const commandResult = await sandbox.commands.run(command, { timeoutMs: 45_000 });
  result = { exitCode: commandResult.exitCode, stdout: commandResult.stdout, stderr: commandResult.stderr };
} catch (error) {
  if (error?.result) {
    result = { exitCode: error.result.exitCode, stdout: error.result.stdout, stderr: error.result.stderr };
  } else {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
} finally {
  try {
    cleanup.killed = await sandbox.kill();
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await Sandbox.getInfo(sandbox.sandboxId, { apiKey }); }
      catch (error) {
        if (error instanceof SandboxNotFoundError) { cleanup.missingAfterKill = true; break; }
        throw error;
      }
      await new Promise((done) => setTimeout(done, 200));
    }
  } catch (error) {
    cleanup.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
}
const passed = result?.exitCode === 0 && !failure && cleanup.killed === true && cleanup.missingAfterKill === true;
await mkdir(receiptDirectory, { recursive: true });
await writeFile(resolve(receiptDirectory, "receipt.json"), JSON.stringify({
  case: "runner-linux", recordedAt: new Date().toISOString(), status: passed ? "passed" : "failed",
  image, baked, sandboxId: sandbox.sandboxId, sourceHash, result, failure, cleanup,
}, null, 2) + "\n");
await writeFile(resolve(receiptDirectory, "report.md"), `# 1 runner-linux\n\nStatus: ${passed ? "passed" : "failed"}.\n\nSee receipt.json for test output and cleanup.\n`);
if (result?.stdout) process.stdout.write(result.stdout);
if (result?.stderr) process.stderr.write(result.stderr);
process.stdout.write(`Receipt: ${resolve(receiptDirectory, "receipt.json")}\n`);
if (!passed) process.exitCode = 1;

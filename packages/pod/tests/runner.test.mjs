import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const runner = process.env.ORBITAL_RUNNER_PATH ?? resolve(import.meta.dirname, "../src/orbital-runner.mjs");

async function waitForStatus(path, predicate, limitMs = 5000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(await readFile(path, "utf8"));
      if (predicate(status)) return status;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForRenewals(root, count, limitMs = 1500) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    try {
      const calls = (await readFile(join(root, "renewals"), "utf8")).trim().split("\n").length;
      if (calls >= count) return calls;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${count} renewals`);
}

async function launch(t, request, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "orbital-runner-"));
  const renewalModule = join(root, "renew.mjs");
  await writeFile(renewalModule,
    "import { appendFile } from 'node:fs/promises'; let calls = 0; export async function renew() { calls++; await appendFile(process.env.ORBITAL_RENEW_LOG, 'renew\\n'); if (calls > Number(process.env.ORBITAL_FAIL_RENEW_AFTER ?? Infinity)) throw new Error('fixture renewal failure'); if (calls > Number(process.env.ORBITAL_STALL_RENEW_AFTER ?? Infinity)) await new Promise(() => {}); }\n");
  const id = randomUUID();
  const job = join(root, id);
  await mkdir(job);
  await writeFile(join(job, "request.json"), JSON.stringify({
    version: 1,
    idleTimeoutMs: 300,
    ...request,
    command: typeof request.command === "function" ? request.command(root) : request.command,
  }));
  if (options.stdoutToFull) await symlink("/dev/full", join(job, "stdout"));
  if (options.preCancel) await writeFile(join(job, "cancel"), "");
  const child = spawn(process.execPath, [runner, "run", id], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      ORBITAL_JOBS_DIR: root,
      ORBITAL_RENEW_MODULE: pathToFileURL(renewalModule).href,
      ORBITAL_RENEW_LOG: join(root, "renewals"),
      ORBITAL_RENEW_INTERVAL_MS: "70",
      ...(options.failRenewAfter === undefined ? {} : { ORBITAL_FAIL_RENEW_AFTER: String(options.failRenewAfter) }),
      ...(options.stallRenewAfter === undefined ? {} : { ORBITAL_STALL_RENEW_AFTER: String(options.stallRenewAfter) }),
      E2B_API_KEY: "test-key",
      HOST_ONLY_SECRET: "host-secret",
    },
  });
  child.unref();
  t.after(async () => {
    try {
      const status = JSON.parse(await readFile(join(job, "status.json"), "utf8"));
      if (status.pgid) process.kill(-status.pgid, "SIGKILL");
    } catch {}
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { id, job, root, child };
}

test("background job starts and keeps a durable output and exit receipt", async (t) => {
  const { job } = await launch(t, {
    mode: "background",
    command: "printf 'hello'; printf 'warning' >&2",
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "completed");
  assert.equal(status.exitCode, 0);
  assert.equal(await readFile(join(job, "stdout"), "utf8"), "hello");
  assert.equal(await readFile(join(job, "stderr"), "utf8"), "warning");
  const combined = await readFile(join(job, "combined"), "utf8");
  assert.match(combined, /hello/);
  assert.match(combined, /warning/);
});

test("cancellation stops the command process group and its ordinary descendants", async (t) => {
  const { id, job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `bash -lc 'sleep 2; touch ${join(root, "late-marker")}' & wait`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  await waitForStatus(join(job, "status.json"), (value) => value.state === "started");
  const cancel = spawn(process.execPath, [runner, "cancel", id], {
    env: { ...process.env, ORBITAL_JOBS_DIR: root },
  });
  const cancelled = await new Promise((resolveCancel) => cancel.once("exit", resolveCancel));
  assert.equal(cancelled, 0);
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "cancelled", JSON.stringify(status));
  assert.equal(status.scopeStopped, true);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("remote timeout stops descendants and keeps partial output after the launcher disconnects", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    executionTimeoutMs: 200,
    command: (root) => `printf 'before-timeout'; bash -lc 'while [ ! -f ${join(root, "release")} ]; do sleep .05; done; touch ${join(root, "late-marker")}' & wait`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "timed_out", JSON.stringify(status));
  assert.equal(status.scopeStopped, true);
  assert.equal(await readFile(join(job, "combined"), "utf8"), "before-timeout");
  await writeFile(join(root, "release"), "");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("silent ordinary work keeps renewing until it finishes", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `while [ ! -f ${join(root, "release")} ]; do sleep .05; done`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  await waitForStatus(join(job, "status.json"), (value) => value.state === "started");
  await new Promise((resolveWait) => setTimeout(resolveWait, 280));
  const during = (await readFile(join(root, "renewals"), "utf8")).trim().split("\n").length;
  assert.ok(during >= 3, `renewals during silent work: ${during}`);
  await writeFile(join(root, "release"), "");
  await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  const after = (await readFile(join(root, "renewals"), "utf8")).trim().split("\n").length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 220));
  const later = (await readFile(join(root, "renewals"), "utf8")).trim().split("\n").length;
  assert.equal(later, after);
});

test("background mode never renews while its service remains alive", async (t) => {
  const { job, root } = await launch(t, {
    mode: "background",
    command: (root) => `while [ ! -f ${join(root, "release")} ]; do sleep .05; done`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  await waitForStatus(join(job, "status.json"), (value) => value.state === "started");
  await new Promise((resolveWait) => setTimeout(resolveWait, 220));
  await assert.rejects(readFile(join(root, "renewals")), { code: "ENOENT" });
  await writeFile(join(root, "release"), "");
  await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
});

test("ordinary completion stops orphaned descendants in its process group", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `bash -lc 'while [ ! -f ${join(root, "release")} ]; do sleep .05; done; touch ${join(root, "late-marker")}' & printf ready`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "completed", JSON.stringify(status));
  assert.equal(status.scopeStopped, true);
  await writeFile(join(root, "release"), "");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("one completed job does not stop another job's renewal", async (t) => {
  const request = {
    mode: "ordinary",
    command: (root) => `while [ ! -f ${join(root, "release")} ]; do sleep .05; done`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  };
  const first = await launch(t, request);
  const second = await launch(t, request);
  await waitForStatus(join(first.job, "status.json"), (value) => value.state === "started");
  await waitForStatus(join(second.job, "status.json"), (value) => value.state === "started");
  await writeFile(join(first.root, "release"), "");
  await waitForStatus(join(first.job, "status.json"), (value) => value.state === "finished");
  const before = (await readFile(join(second.root, "renewals"), "utf8")).trim().split("\n").length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 240));
  const after = (await readFile(join(second.root, "renewals"), "utf8")).trim().split("\n").length;
  assert.ok(after > before, `remaining job renewal count: ${before} to ${after}`);
  await writeFile(join(second.root, "release"), "");
  await waitForStatus(join(second.job, "status.json"), (value) => value.state === "finished");
});

test("a cancellation marker before launch prevents command execution", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `touch ${join(root, "unexpected")}`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { preCancel: true });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "cancelled");
  assert.equal(status.scopeStopped, true);
  await assert.rejects(readFile(join(root, "unexpected")), { code: "ENOENT" });
});

test("the command gets selected environment values but no renewal key or host secret", async (t) => {
  const { job } = await launch(t, {
    mode: "background",
    command: "printf '%s|%s|%s' \"$SELECTED\" \"${E2B_API_KEY-unset}\" \"${HOST_ONLY_SECRET-unset}\"",
    cwd: "/tmp",
    sandboxId: "sandbox-test",
    env: { SELECTED: "chosen", E2B_API_KEY: "injected-key" },
  });
  await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(await readFile(join(job, "stdout"), "utf8"), "chosen|unset|unset");
});

test("a renewal failure stops the active process group before reporting failure", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `printf ready; bash -lc 'while [ ! -f ${join(root, "release")} ]; do sleep .05; done; touch ${join(root, "late-marker")}' & wait`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { failRenewAfter: 1 });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "failed", JSON.stringify(status));
  assert.equal(status.errorCode, "renewal_failed");
  assert.equal(status.scopeStopped, true);
  assert.match(await readFile(join(job, "combined"), "utf8"), /ready/);
  await writeFile(join(root, "release"), "");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("a denied first renewal prevents command execution", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `touch ${join(root, "unexpected")}`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { failRenewAfter: 0 });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "failed");
  assert.equal(status.errorCode, "renewal_failed");
  assert.equal(status.phase, "pre_execution");
  await assert.rejects(readFile(join(root, "unexpected")), { code: "ENOENT" });
});

test("remote timeout still stops work while renewal is stalled", async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    executionTimeoutMs: 300,
    command: (root) => `bash -lc 'while [ ! -f ${join(root, "release")} ]; do sleep .05; done; touch ${join(root, "late-marker")}' & wait`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { stallRenewAfter: 1 });
  await waitForRenewals(root, 2);
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished", 1200);
  assert.equal(status.outcome, "timed_out", JSON.stringify(status));
  assert.equal(status.scopeStopped, true);
  assert.equal(await waitForRenewals(root, 2), 2);
  await writeFile(join(root, "release"), "");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("cancellation still stops work while renewal is stalled", async (t) => {
  const { id, job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `bash -lc 'while [ ! -f ${join(root, "release")} ]; do sleep .05; done; touch ${join(root, "late-marker")}' & wait`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { stallRenewAfter: 1 });
  await waitForRenewals(root, 2);
  const cancel = spawn(process.execPath, [runner, "cancel", id], {
    env: { ...process.env, ORBITAL_JOBS_DIR: root },
  });
  assert.equal(await new Promise((resolveCancel) => cancel.once("exit", resolveCancel)), 0);
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished", 1200);
  assert.equal(status.outcome, "cancelled", JSON.stringify(status));
  assert.equal(status.scopeStopped, true);
  assert.equal(await waitForRenewals(root, 2), 2);
  await writeFile(join(root, "release"), "");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

test("an output write failure stops ordinary descendants and records failure", { skip: process.platform !== "linux" }, async (t) => {
  const { job, root } = await launch(t, {
    mode: "ordinary",
    command: (root) => `printf 'partial-output' >&2; sleep .1; printf 'write-fails'; sleep 2; touch ${join(root, "late-marker")}`,
    cwd: "/tmp",
    sandboxId: "sandbox-test",
  }, { stdoutToFull: true });
  const status = await waitForStatus(join(job, "status.json"), (value) => value.state === "finished");
  assert.equal(status.outcome, "failed", JSON.stringify(status));
  assert.equal(status.errorCode, "output_write_failed");
  assert.equal(status.phase, "execution");
  assert.equal(status.scopeStopped, true);
  assert.match(await readFile(join(job, "combined"), "utf8"), /partial-output/);
  await new Promise((resolveWait) => setTimeout(resolveWait, 2200));
  await assert.rejects(readFile(join(root, "late-marker")), { code: "ENOENT" });
});

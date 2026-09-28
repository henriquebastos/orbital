import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Template } from "e2b";
import { createE2BImageEffects } from "../../src/e2b/images.js";

test("remote lookup prefers ready builds across pages and distinguishes absence from failure", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  let aliasStatus = 200;
  let mode = "ready";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url!;
    requests.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/templates/aliases/")) {
      response.writeHead(aliasStatus).end(JSON.stringify({ templateID: "raw-id" }));
    } else if (path === "/templates/raw-id?limit=100") {
      if (mode === "gone") { response.writeHead(404).end("{}"); return; }
      if (mode === "ready") response.setHeader("X-Next-Token", "page two");
      response.end(JSON.stringify({ templateID: "raw-id", builds: mode === "empty" ? [] : [
        { buildID: "failed", status: "error" }, { buildID: "pending", status: mode === "invalid" ? "bogus" : "building" },
      ] }));
    } else if (path.endsWith("nextToken=page%20two")) {
      response.end(JSON.stringify({ templateID: "raw-id", builds: [{ buildID: buildId, status: "ready" }] }));
    } else response.writeHead(500).end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-primitives-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const effects = createE2BImageEffects({ apiKey: "test-only", cacheDirectory: directory,
      apiUrl: `http://127.0.0.1:${address.port}` });
    const found = await effects.findBuild("orbital-base-hash");
    assert.deepEqual(found, { status: "ready", artifact: { reference: `orbital-base-hash:${buildId}`,
      templateId: "raw-id", buildId, kind: "template" } });
    mode = "pending";
    assert.equal((await effects.findBuild("orbital-base-hash"))?.status, "building");
    for (mode of ["empty", "gone", "invalid"]) {
      await assert.rejects(effects.findBuild("orbital-base-hash"), { code: "image_lookup_failed" });
    }
    aliasStatus = 404;
    assert.equal(await effects.findBuild("orbital-base-hash"), undefined);
    for (aliasStatus of [401, 403, 429, 500]) {
      await assert.rejects(effects.findBuild("orbital-base-hash"), { code: "image_lookup_failed" });
    }
    assert.ok(requests.every(request => request.startsWith("GET ")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("submission returns build identity without waiting; waiting never submits", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  const requests: string[] = [];
  let status = "ready";
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      request.resume();
      response.writeHead(202).end(JSON.stringify({ templateID: "raw-id", buildID: buildId }));
    } else {
      response.end(JSON.stringify({ templateID: "raw-id", buildID: buildId, status, logEntries: [] }));
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-build-primitives-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const effects = createE2BImageEffects({ apiKey: "test-only", cacheDirectory: directory,
      apiUrl: `http://127.0.0.1:${address.port}` });
    const artifact = await effects.submitBuild("orbital-base-hash", {
      sourceHash: "hash", template: Template().fromBaseImage(), cpuCount: 2, memoryMB: 1024,
    });
    assert.equal(artifact.reference, `orbital-base-hash:${buildId}`);
    assert.deepEqual(requests, ["POST /v3/templates", `POST /v2/templates/raw-id/builds/${buildId}`]);
    requests.length = 0;
    await effects.waitForBuild(artifact);
    assert.equal(requests.length, 1);
    assert.ok(requests[0]!.startsWith(`GET /templates/raw-id/builds/${buildId}/status`));
    status = "error";
    await assert.rejects(effects.waitForBuild(artifact), { code: "base_build_failed" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(effects.waitForBuild(artifact, { signal: controller.signal }), { code: "base_build_cancelled" });
    assert.equal(requests.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

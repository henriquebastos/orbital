import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Template } from "e2b";
import { createE2BImageEffects } from "../../src/e2b/images.js";
import { createImageRegistry } from "../../src/e2b/image-registry.js";

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
    const found = await effects.findReusableBuild("orbital-base-hash");
    assert.deepEqual(found, { status: "ready", artifact: { name: "orbital-base-hash", templateId: "raw-id", buildId } });
    mode = "pending";
    assert.equal((await effects.findReusableBuild("orbital-base-hash"))?.status, "building");
    for (mode of ["empty", "gone", "invalid"]) {
      await assert.rejects(effects.findReusableBuild("orbital-base-hash"), { code: "image_lookup_failed" });
    }
    aliasStatus = 404;
    assert.equal(await effects.findReusableBuild("orbital-base-hash"), undefined);
    for (aliasStatus of [401, 403, 429, 500]) {
      await assert.rejects(effects.findReusableBuild("orbital-base-hash"), { code: "image_lookup_failed" });
    }
    assert.ok(requests.every(request => request.startsWith("GET ")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("availability pages the raw template build list and requires a ready build", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  let mode = "ready";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url!;
    requests.push(path);
    response.setHeader("content-type", "application/json");
    if (path === "/templates/raw-id?limit=100") {
      if (mode === "gone") { response.writeHead(404).end("{}"); return; }
      response.setHeader("X-Next-Token", "page two");
      response.end(JSON.stringify({ templateID: "raw-id", builds: [{ buildID: "other", status: "ready" }] }));
    } else if (path.endsWith("nextToken=page%20two")) {
      response.end(JSON.stringify({ templateID: "raw-id", builds: mode === "absent" ? [] : [{ buildID: buildId, status: mode }] }));
    } else response.writeHead(500).end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const effects = createE2BImageEffects({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    const artifact = { name: "orbital-base-hash", templateId: "raw-id", buildId };
    assert.equal(await effects.available(artifact), true);
    assert.deepEqual(requests, ["/templates/raw-id?limit=100", "/templates/raw-id?limit=100&nextToken=page%20two"]);
    mode = "gone";
    assert.equal(await effects.available(artifact), false);
    mode = "absent";
    assert.equal(await effects.available(artifact), false);
    mode = "building";
    await assert.rejects(effects.available(artifact), { code: "image_not_ready" });
    assert.equal(requests.some(path => path.includes("/builds/") || path.includes("/snapshots") || path.includes("/aliases/")), false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("a captured snapshot becomes an artifact named by its canonical name with the raw template ID", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url!);
    requests.push(path);
    response.setHeader("content-type", "application/json");
    if (path === "/templates/aliases/team/orbital-v2-prepared-abc") response.end(JSON.stringify({ templateID: "raw-id", public: false }));
    else if (path === "/templates/team/orbital-v2-prepared-abc/tags") {
      response.end(JSON.stringify([{ tag: "default", buildID: buildId, createdAt: "2026-09-26T00:00:00Z" }]));
    } else response.writeHead(500).end("{}");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const registry = createImageRegistry({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    const artifact = await registry.captured("team/orbital-v2-prepared-abc:default");
    assert.deepEqual(artifact, { name: "team/orbital-v2-prepared-abc", templateId: "raw-id", buildId });
    assert.deepEqual(requests, ["/templates/aliases/team/orbital-v2-prepared-abc", "/templates/team/orbital-v2-prepared-abc/tags"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("image effects resolve the current resource selection before each owned recipe", async () => {
  let resources = { cpuCount: 2, memoryMB: 1024, minFreeDiskMb: 0 };
  const effects = createE2BImageEffects({ apiKey: "test-only", resources: () => resources });
  const small = await effects.recipe();
  resources = { cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 20480 };
  const large = await effects.recipe();
  assert.equal(large.cpuCount, 8);
  assert.equal(large.memoryMB, 8192);
  assert.equal(large.minFreeDiskMb, 20480);
  assert.notEqual(small.sourceHash, large.sourceHash);
});

test("submission returns build identity without waiting; waiting never submits", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  const requests: string[] = [];
  let status = "ready";
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "POST") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        bodies.push(JSON.parse(body));
        response.writeHead(202).end(JSON.stringify({ templateID: "raw-id", buildID: buildId }));
      });
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
      sourceHash: "hash", template: Template().fromBaseImage(), cpuCount: 8, memoryMB: 8192, minFreeDiskMb: 20480,
    });
    assert.deepEqual(artifact, { name: "orbital-base-hash", templateId: "raw-id", buildId });
    assert.equal(bodies[0]?.cpuCount, 8);
    assert.equal(bodies[0]?.memoryMB, 8192);
    assert.equal(bodies[0]?.minFreeDiskMb, 20480);
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

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createImages, type ImageEffects, type ImageSeed } from "../../src/hangar/images/preparation.js";
import { OrbitalError } from "../../src/operations.js";
import { createE2BImages } from "../../src/e2b/images.js";
import { ImageRecords, type ImageArtifact } from "../../src/hangar/images/records.js";

const base: ImageArtifact = { reference: "base:one", templateId: "base", buildId: "one", kind: "template" };

async function fixture(run: (ctx: { effects: ImageEffects; records: ImageRecords;
  captured: ImageArtifact[]; calls: string[]; directory: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orbital-images-"));
  const calls: string[] = [];
  const captured: ImageArtifact[] = [];
  let generation = 0;
  const effects: ImageEffects = {
    scope: "test-scope",
    async available(artifact) { calls.push(`available:${artifact.reference}`); return artifact.reference !== "deleted"; },
    async external(reference) { calls.push(`external:${reference}`); return { ...base, reference }; },
    async recipe() { calls.push("recipe"); return { sourceHash: "recipe-one", template: {}, cpuCount: 2, memoryMB: 1024 }; },
    async buildBase() { calls.push("build"); return base; },
    async createSeed(_base, attemptId) {
      calls.push("seed");
      const seed: ImageSeed = {
        id: `seed-${attemptId}`,
        async writeScript() { calls.push("write"); },
        async runScript() { calls.push("run"); },
        async checkRuntime() { calls.push("check"); },
        async capture() {
          calls.push("capture");
          generation += 1;
          const artifact: ImageArtifact = { reference: `snapshot-${generation}`, templateId: `snapshot-${generation}`,
            buildId: `build-${generation}`, kind: "snapshot" };
          captured.push(artifact);
          return artifact;
        },
        async delete() { calls.push("delete"); },
      };
      return seed;
    },
  };
  const records = new ImageRecords(directory, effects.scope);
  try { await run({ effects, records, captured, calls, directory }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("a ready preparation is reused and a deleted artifact is rebuilt", async () => fixture(async ({ effects, records, calls }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({ preparation: "echo one" });
  assert.equal(first.reused, false);
  const second = await images.ensure({ preparation: "echo one" });
  assert.equal(second.reference, first.reference);
  assert.equal(second.reused, true);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  effects.available = async (artifact) => artifact.reference !== first.reference;
  const third = await images.ensure({ preparation: "echo one" });
  assert.notEqual(third.reference, first.reference);
  assert.equal(calls.filter((call) => call === "seed").length, 2);
}));

test("failed refresh preserves the previous ready image", async () => fixture(async ({ effects, records }) => {
  const images = createImages(effects, records);
  const original = await images.ensure({ preparation: "echo one" });
  const priorCreateSeed = effects.createSeed;
  effects.createSeed = async (...args) => {
    const seed = await priorCreateSeed(...args);
    seed.runScript = async () => { throw new OrbitalError("failed", "script_failed", "Script failed.", { exitCode: 7 }); };
    return seed;
  };
  await assert.rejects(images.ensure({ preparation: "echo one", refresh: true }),
    (cause) => cause instanceof OrbitalError && cause.outcome === "failed" && cause.evidence.exitCode === 7);
  const again = await images.ensure({ preparation: "echo one" });
  assert.equal(again.reference, original.reference);
  assert.equal(again.reused, true);
}));

test("an uncertain seed result is retained and blocks replay", async () => fixture(async ({ effects, records, calls }) => {
  effects.createSeed = async () => {
    calls.push("seed");
    throw new OrbitalError("uncertain", "seed_create_unknown", "Lost creation response.");
  };
  const images = createImages(effects, records);
  await assert.rejects(images.ensure({ preparation: "echo one" }),
    (cause) => cause instanceof OrbitalError && cause.code === "seed_create_unknown");
  await assert.rejects(images.ensure({ preparation: "echo one" }),
    (cause) => cause instanceof OrbitalError && cause.code === "image_attempt_unresolved");
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  const keys = await records.keys();
  assert.equal(keys.length, 1); // The base remains ready.
}));

test("external image refresh without a script fails before provider mutation", async () => fixture(async ({ effects, records, calls }) => {
  const images = createImages(effects, records);
  await assert.rejects(images.ensure({ image: "custom:v1", refresh: true }),
    (cause) => cause instanceof OrbitalError && cause.code === "external_refresh_unsupported");
  assert.deepEqual(calls, []);
}));

test("script bytes and base build identity change the preparation key", async () => fixture(async ({ effects, records }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({ preparation: "echo one" });
  const whitespace = await images.ensure({ preparation: "echo one\n" });
  assert.notEqual(whitespace.cacheKey, first.cacheKey);
  const previousExternal = effects.external;
  effects.external = async (reference) => ({ ...(await previousExternal(reference)), buildId: "two" });
  const changedBase = await images.ensure({ image: "custom:v1", preparation: "echo one" });
  assert.notEqual(changedBase.cacheKey, first.cacheKey);
}));

test("failed base refresh leaves its previous ready record", async () => fixture(async ({ effects, records }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({});
  assert.equal(first.reused, false);
  effects.buildBase = async () => { throw new OrbitalError("failed", "base_build_failed", "Build failed."); };
  await assert.rejects(images.ensure({ refresh: true }),
    (cause) => cause instanceof OrbitalError && cause.code === "base_build_failed");
  const after = await images.ensure({});
  assert.equal(after.reference, first.reference);
  assert.equal(after.reused, true);
}));

test("concurrent observers share one preparation through the ready receipt", async () => fixture(async ({ effects, records, calls }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const priorCreateSeed = effects.createSeed;
  effects.createSeed = async (...args) => {
    const seed = await priorCreateSeed(...args);
    seed.runScript = async () => { await gate; calls.push("run"); };
    return seed;
  };
  const images = createImages(effects, records);
  const first = images.ensure({ preparation: "echo one" }, { onProgress() {} });
  const second = images.ensure({ preparation: "echo one" }, { onProgress() {} });
  try {
    for (let count = 0; count < 100 && !calls.includes("seed"); count++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls.filter((call) => call === "seed").length, 1);
  } finally { release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.reference, b.reference);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
}));

test("malformed attempt state fails closed before another seed", async () => fixture(async ({ effects, records, calls, directory }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({ preparation: "echo one" });
  const attempt = await records.attempt(first.cacheKey);
  assert.ok(attempt);
  effects.available = async (artifact) => artifact.kind === "template";
  await writeFile(join(directory, "test-scope", "attempt", `${first.cacheKey}.json`),
    JSON.stringify({ ...attempt, state: "unexpected" }));
  await assert.rejects(images.ensure({ preparation: "echo one" }), /invalid state/);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  await writeFile(join(directory, "test-scope", "attempt", `${first.cacheKey}.json`), "null");
  await assert.rejects(images.ensure({ preparation: "echo one" }), /invalid identity/);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
}));

test("an interrupted capture with a known ready artifact publishes without rerunning the script", async () => fixture(async ({ effects, records, calls, directory }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({ preparation: "echo one" });
  const record = await records.ready(first.cacheKey);
  const attempt = await records.attempt(first.cacheKey);
  assert.ok(record && attempt);
  await rm(join(directory, "test-scope", "ready", `${first.cacheKey}.json`));
  await records.writeAttempt({ ...attempt, state: "uncertain", stage: "captured", cleanup: "unknown" });
  const recovered = await images.ensure({ preparation: "echo one" });
  assert.equal(recovered.reference, first.reference);
  assert.equal(recovered.reused, true);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  assert.equal((await records.ready(first.cacheKey))?.artifact.reference, first.reference);
}));

test("a forbidden base verification keeps the build for recovery", async () => fixture(async ({ effects, records, calls }) => {
  let forbidden = true;
  effects.available = async () => {
    if (forbidden) {
      forbidden = false;
      throw new OrbitalError("not_started", "image_lookup_failed", "Image lookup was forbidden.", { statusCode: 403 });
    }
    return true;
  };
  const images = createImages(effects, records);
  await assert.rejects(images.ensure({}),
    (cause) => cause instanceof OrbitalError && cause.code === "image_lookup_failed" && cause.evidence.statusCode === 403);
  const recovered = await images.ensure({});
  assert.equal(recovered.reference, base.reference);
  assert.equal(recovered.reused, true);
  assert.equal(calls.filter((call) => call === "build").length, 1);
}));

test("a forbidden captured-image verification recovers without rerunning preparation", async () => fixture(async ({ effects, records, calls }) => {
  const images = createImages(effects, records);
  await images.ensure({});
  const priorAvailable = effects.available;
  let forbidden = true;
  effects.available = async (artifact) => {
    if (artifact.kind === "snapshot" && forbidden) {
      forbidden = false;
      throw new OrbitalError("not_started", "image_lookup_failed", "Image lookup was forbidden.", { statusCode: 403 });
    }
    return priorAvailable(artifact);
  };
  await assert.rejects(images.ensure({ preparation: "echo one" }),
    (cause) => cause instanceof OrbitalError && cause.code === "image_lookup_failed" && cause.evidence.statusCode === 403);
  const recovered = await images.ensure({ preparation: "echo one" });
  assert.equal(recovered.reused, true);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  assert.equal(calls.filter((call) => call === "run").length, 1);
}));

test("owned base refresh waits for an in-flight base build", async () => fixture(async ({ effects, records, calls }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  effects.buildBase = async () => {
    calls.push("build");
    if (calls.filter((call) => call === "build").length === 1) await gate;
    return base;
  };
  const images = createImages(effects, records);
  const first = images.ensure({});
  const refresh = images.ensure({ refresh: true });
  try {
    for (let count = 0; count < 100 && !calls.includes("build"); count++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls.filter((call) => call === "build").length, 1);
  } finally { release(); }
  await Promise.all([first, refresh]);
  assert.equal(calls.filter((call) => call === "build").length, 2);
}));

test("ready receipts are atomic JSON records with the resolved base and attempt", async () => fixture(async ({ effects, records }) => {
  const images = createImages(effects, records);
  const result = await images.ensure({ preparation: "echo one" });
  const record = await records.ready(result.cacheKey);
  assert.equal(record?.artifact.reference, result.reference);
  assert.equal(record?.base.buildId, "one");
  assert.ok(record?.attemptId);
  assert.equal((await records.attempt(result.cacheKey))?.cleanup, "deleted");
}));

test("image lookup treats only HTTP 404 as missing", async () => {
  let responseStatus = 404;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(responseStatus, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: responseStatus, message: "test status" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-image-sdk-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const images = createE2BImages({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}`,
      cacheDirectory: directory, requestTimeoutMs: 2_000 });
    const exact = "custom:123e4567-e89b-12d3-a456-426614174000";
    for (const image of ["custom:default", exact]) {
      await assert.rejects(images.ensure({ image }),
        (cause) => cause instanceof OrbitalError && cause.code === "image_missing");
    }
    responseStatus = 403;
    for (const image of ["custom:default", exact]) {
      await assert.rejects(images.ensure({ image }),
        (cause) => cause instanceof OrbitalError && cause.code === "image_lookup_failed");
    }
    assert.ok(paths.some((path) => path.includes("/tags")));
    assert.ok(paths.some((path) => path.includes("/templates/aliases/")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("snapshot overrides resolve exact builds through snapshot and tag APIs", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  const snapshotId = "team/prepared:default";
  const exact = `team/prepared:${buildId}`;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url?.startsWith("/snapshots?")) {
      response.end(JSON.stringify([{ snapshotID: snapshotId, names: ["team/prepared"] }]));
    } else if (request.url?.includes("/tags")) {
      response.end(JSON.stringify([{ tag: "default", buildID: buildId, createdAt: "2026-09-26T00:00:00Z" }]));
    } else {
      response.writeHead(500).end(JSON.stringify({ message: "Unexpected build status lookup" }));
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-snapshot-sdk-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const images = createE2BImages({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}`,
      cacheDirectory: directory, requestTimeoutMs: 2_000 });
    for (const image of [exact, snapshotId, "prepared:default", `prepared:${buildId}`]) {
      const result = await images.ensure({ image });
      assert.equal(result.reference, exact);
      assert.equal(result.reused, true);
    }
    assert.equal(paths.filter((path) => path.includes("/builds/")).length, 0);
    assert.ok(paths.some((path) => path.startsWith("/snapshots?")));
    assert.ok(paths.some((path) => path.includes("/tags")));
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("historical exact builds use the raw template build list", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  const paths: string[] = [];
  let denyMetadata = false;
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    paths.push(path);
    response.setHeader("content-type", "application/json");
    if (path.startsWith("/snapshots?")) response.end("[]");
    else if (path.startsWith("/templates/legacy?")) response.writeHead(404).end("{}");
    else if (path === "/templates/aliases/legacy") response.end(JSON.stringify({ templateID: "rawid", public: false }));
    else if (path.startsWith("/templates/rawid?")) {
      if (denyMetadata) response.writeHead(403).end("{}");
      else response.end(JSON.stringify({ templateID: "rawid", builds: [{ buildID: buildId, status: "ready" }] }));
    } else response.writeHead(400).end("{}");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-historical-build-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const images = createE2BImages({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}`,
      cacheDirectory: directory, requestTimeoutMs: 2_000 });
    const result = await images.ensure({ image: `legacy:${buildId}` });
    assert.equal(result.reference, `legacy:${buildId}`);
    assert.equal(paths.some((path) => path.includes("/builds/")), false);
    denyMetadata = true;
    await assert.rejects(images.ensure({ image: `legacy:${buildId}` }),
      (cause) => cause instanceof OrbitalError && cause.code === "image_lookup_failed" && cause.evidence.statusCode === 403);
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

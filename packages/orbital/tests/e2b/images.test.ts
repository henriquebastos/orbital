import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { baseRecordKey, createImages, PREPARATION_CONTRACT_VERSION, type ImageEffects, type ImageSeed } from "../../src/lifecycle/images/preparation.js";
import { OrbitalError } from "../../src/operations.js";
import { createE2BImages } from "../../src/e2b/images.js";
import { artifactReference, ImageRecords, type ImageArtifact } from "../../src/lifecycle/images/records.js";

const base: ImageArtifact = { name: "base", templateId: "base-template", buildId: "one" };
const baseReference = artifactReference(base);

async function fixture(run: (ctx: { effects: ImageEffects; records: ImageRecords;
  captured: ImageArtifact[]; calls: string[]; directory: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "orbital-images-"));
  const calls: string[] = [];
  const captured: ImageArtifact[] = [];
  let generation = 0;
  const effects: ImageEffects = {
    scope: "test-scope",
    async available(artifact) { calls.push(`available:${artifactReference(artifact)}`); return artifact.name !== "deleted"; },
    async external(reference) { calls.push(`external:${reference}`); return { ...base, name: reference }; },
    async recipe() { calls.push("recipe"); return { sourceHash: "recipe-one", template: {}, cpuCount: 2, memoryMB: 1024 }; },
    async findReusableBuild(name) { calls.push(`find:${name}`); return undefined; },
    async submitBuild() { calls.push("build"); return base; },
    async waitForBuild() { calls.push("wait"); },
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
          const artifact: ImageArtifact = { name: `snapshot-${generation}`, templateId: `snapshot-template-${generation}`,
            buildId: `build-${generation}` };
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
  assert.equal(first.reference, "snapshot-1:build-1");
  assert.equal(first.baseReference, baseReference);
  const second = await images.ensure({ preparation: "echo one" });
  assert.equal(second.reference, first.reference);
  assert.equal(second.reused, true);
  assert.equal(calls.filter((call) => call === "seed").length, 1);
  effects.available = async (artifact) => artifactReference(artifact) !== first.reference;
  const third = await images.ensure({ preparation: "echo one" });
  assert.notEqual(third.reference, first.reference);
  assert.equal(calls.filter((call) => call === "seed").length, 2);
}));

test("independent caches discover the same remote base without submitting a build", async () => fixture(async ({ effects, records, calls, directory }) => {
  const names: string[] = [];
  effects.findReusableBuild = async (name) => { names.push(name); return { artifact: base, status: "ready" }; };
  const first = await createImages(effects, records).ensure({});
  const other = await createImages(effects, new ImageRecords(join(directory, "other-host"), effects.scope)).ensure({});
  assert.equal(first.reference, "base:one");
  assert.equal(other.reference, first.reference);
  assert.equal(first.reused && other.reused, true);
  assert.deepEqual(names, ["orbital-base-recipe-one", "orbital-base-recipe-one"]);
  assert.equal(calls.includes("build"), false);
  assert.equal(calls.includes("wait"), false);
}));

test("a pending remote build is recorded before waiting and is not submitted again", async () => fixture(async ({ effects, records, calls }) => {
  effects.findReusableBuild = async () => ({ artifact: base, status: "building" });
  effects.waitForBuild = async (artifact) => {
    assert.equal(artifact.buildId, "one");
    calls.push("wait");
    throw new OrbitalError("uncertain", "base_build_cancelled", "Wait cancelled.");
  };
  const images = createImages(effects, records);
  await assert.rejects(images.ensure({}), { code: "base_build_cancelled" });
  const recovered = await images.ensure({});
  assert.equal(recovered.reference, "base:one");
  assert.equal(recovered.reused, true);
  assert.equal(calls.includes("build"), false);
  assert.equal(calls.filter(call => call === "wait").length, 1);
}));

test("lookup failures do not submit builds or publish ready records", async () => fixture(async ({ effects, records, calls }) => {
  effects.findReusableBuild = async () => { throw new OrbitalError("not_started", "image_lookup_failed", "Forbidden."); };
  await assert.rejects(createImages(effects, records).ensure({}), { code: "image_lookup_failed" });
  assert.equal(calls.includes("build"), false);
  assert.deepEqual(await records.keys(), []);
}));

test("simultaneous remote misses can build twice without overwriting either host's exact result", async () => fixture(async ({ effects, records, directory }) => {
  let release!: () => void;
  const bothLookups = new Promise<void>(resolve => { release = resolve; });
  let lookups = 0;
  let builds = 0;
  effects.findReusableBuild = async () => {
    if (++lookups === 2) release();
    await bothLookups;
    return undefined;
  };
  effects.submitBuild = async name => ({ name, templateId: base.templateId, buildId: String(++builds) });
  const [first, second] = await Promise.all([
    createImages(effects, records).ensure({}),
    createImages(effects, new ImageRecords(join(directory, "second-host"), effects.scope)).ensure({}),
  ]);
  assert.equal(builds, 2);
  assert.notEqual(first.reference, second.reference);
  assert.equal(first.reused || second.reused, false);
}));

test("a failed remote build permits a new submission; refresh bypasses discovery", async () => fixture(async ({ effects, records, calls }) => {
  effects.findReusableBuild = async () => { calls.push("find"); return { artifact: base, status: "error" }; };
  const images = createImages(effects, records);
  assert.equal((await images.ensure({})).reused, false);
  assert.equal((await images.ensure({ refresh: true })).reused, false);
  assert.equal(calls.filter(call => call === "find").length, 1);
  assert.equal(calls.filter(call => call === "build").length, 2);
  assert.equal(calls.filter(call => call === "wait").length, 2);
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

test("the base record key includes the contract version so older records are unreachable", async () => fixture(async ({ effects, records }) => {
  const recipe = await effects.recipe();
  const result = await createImages(effects, records).ensure({});
  assert.equal(PREPARATION_CONTRACT_VERSION, 3);
  assert.equal(result.cacheKey, baseRecordKey(effects.scope, recipe));
  assert.deepEqual(await records.keys(), [result.cacheKey]);
  const versionTwoKey = createHash("sha256")
    .update(JSON.stringify(["base", effects.scope, recipe.sourceHash, recipe.cpuCount, recipe.memoryMB])).digest("hex");
  assert.notEqual(result.cacheKey, versionTwoKey);
  assert.equal((await records.ready(result.cacheKey))?.contractVersion, 3);
}));

test("ready records require the structured artifact shape", async () => fixture(async ({ effects, records, directory }) => {
  const result = await createImages(effects, records).ensure({});
  const record = await records.ready(result.cacheKey);
  assert.ok(record);
  assert.deepEqual(record.artifact, base);
  const path = join(directory, "test-scope", "ready", `${result.cacheKey}.json`);
  const { name: _name, ...nameless } = base;
  await writeFile(path, JSON.stringify({ ...record, artifact: nameless }));
  await assert.rejects(records.ready(result.cacheKey), /invalid artifact/);
  await writeFile(path, JSON.stringify({ ...record, artifact: { ...base, kind: "template" } }));
  await assert.rejects(records.ready(result.cacheKey), /invalid artifact/);
  await writeFile(path, JSON.stringify({ ...record, artifact: { ...base, reference: "base:one" } }));
  await assert.rejects(records.ready(result.cacheKey), /invalid artifact/);
  await writeFile(path, JSON.stringify({ ...record, base: nameless }));
  await assert.rejects(records.ready(result.cacheKey), /invalid artifact/);
}));

test("failed base refresh leaves its previous ready record", async () => fixture(async ({ effects, records }) => {
  const images = createImages(effects, records);
  const first = await images.ensure({});
  assert.equal(first.reused, false);
  effects.submitBuild = async () => { throw new OrbitalError("failed", "base_build_failed", "Build failed."); };
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
  effects.available = async (artifact) => artifact.name === base.name;
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
  const published = await records.ready(first.cacheKey);
  assert.ok(published);
  assert.equal(artifactReference(published.artifact), first.reference);
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
  assert.equal(recovered.reference, baseReference);
  assert.equal(recovered.reused, true);
  assert.equal(calls.filter((call) => call === "build").length, 1);
}));

test("a forbidden captured-image verification recovers without rerunning preparation", async () => fixture(async ({ effects, records, calls }) => {
  const images = createImages(effects, records);
  await images.ensure({});
  const priorAvailable = effects.available;
  let forbidden = true;
  effects.available = async (artifact) => {
    if (artifact.name.startsWith("snapshot-") && forbidden) {
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
  effects.submitBuild = async () => {
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
  assert.ok(record);
  assert.equal(artifactReference(record.artifact), result.reference);
  assert.equal(record.base.buildId, "one");
  assert.ok(record.attemptId);
  assert.equal((await records.attempt(result.cacheKey))?.cleanup, "deleted");
}));

// An HTTP stub for the E2B template API. Each handler receives the decoded request path.
async function withTemplateApi(handle: (path: string, response: import("node:http").ServerResponse) => void,
  run: (ctx: { apiUrl: string; paths: string[]; directory: string }) => Promise<void>): Promise<void> {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "");
    paths.push(path);
    response.setHeader("content-type", "application/json");
    handle(path, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const directory = await mkdtemp(join(tmpdir(), "orbital-image-api-"));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await run({ apiUrl: `http://127.0.0.1:${address.port}`, paths, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

test("image lookup treats only HTTP 404 as missing", async () => {
  let responseStatus = 404;
  await withTemplateApi((_path, response) => {
    response.writeHead(responseStatus).end(JSON.stringify({ code: responseStatus, message: "test status" }));
  }, async ({ apiUrl, paths, directory }) => {
    const images = createE2BImages({ apiKey: "test-only", apiUrl, cacheDirectory: directory, requestTimeoutMs: 2_000 });
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
    assert.ok(paths.every((path) => path.startsWith("/templates/")));
    assert.ok(paths.some((path) => path.startsWith("/templates/aliases/custom")));
    assert.ok(paths.some((path) => path.startsWith("/templates/custom?")));
    assert.equal(paths.some((path) => path.includes("/tags")), false);
  });
});

test("an alias with a tag resolves through the alias, tags, and template build list", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  await withTemplateApi((path, response) => {
    if (path === "/templates/aliases/prepared") response.end(JSON.stringify({ templateID: "raw-id", public: false }));
    else if (path === "/templates/prepared/tags") {
      response.end(JSON.stringify([{ tag: "default", buildID: buildId, createdAt: "2026-09-26T00:00:00Z" }]));
    } else if (path.startsWith("/templates/raw-id?")) {
      response.end(JSON.stringify({ templateID: "raw-id", builds: [{ buildID: buildId, status: "ready" }] }));
    } else response.writeHead(500).end(JSON.stringify({ message: `Unexpected ${path}` }));
  }, async ({ apiUrl, paths, directory }) => {
    const images = createE2BImages({ apiKey: "test-only", apiUrl, cacheDirectory: directory, requestTimeoutMs: 2_000 });
    const tagged = await images.ensure({ image: "prepared:default" });
    assert.equal(tagged.reference, `prepared:${buildId}`);
    assert.equal(tagged.reused, true);
    assert.deepEqual(paths.splice(0), ["/templates/aliases/prepared", "/templates/prepared/tags",
      "/templates/raw-id?limit=100", "/templates/raw-id?limit=100"]);
    const pinned = await images.ensure({ image: `prepared:${buildId}` });
    assert.equal(pinned.reference, `prepared:${buildId}`);
    assert.equal(paths.some((path) => path.includes("/tags")), false);
    assert.equal(paths.some((path) => path.includes("/snapshots") || path.includes("/builds/")), false);
  });
});

test("a canonical snapshot name resolves through the alias API with the same request shape", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  await withTemplateApi((path, response) => {
    if (path === "/templates/aliases/team/prepared") response.end(JSON.stringify({ templateID: "raw-id", public: false }));
    else if (path === "/templates/team/prepared/tags") {
      response.end(JSON.stringify([{ tag: "default", buildID: buildId, createdAt: "2026-09-26T00:00:00Z" }]));
    } else if (path.startsWith("/templates/raw-id?")) {
      response.end(JSON.stringify({ templateID: "raw-id", builds: [{ buildID: buildId, status: "ready" }] }));
    } else response.writeHead(500).end(JSON.stringify({ message: `Unexpected ${path}` }));
  }, async ({ apiUrl, paths, directory }) => {
    const images = createE2BImages({ apiKey: "test-only", apiUrl, cacheDirectory: directory, requestTimeoutMs: 2_000 });
    for (const image of ["team/prepared", "team/prepared:default", `team/prepared:${buildId}`]) {
      const result = await images.ensure({ image });
      assert.equal(result.reference, `team/prepared:${buildId}`);
      assert.equal(result.reused, true);
    }
    assert.ok(paths.includes("/templates/aliases/team/prepared"));
    assert.ok(paths.includes("/templates/team/prepared/tags"));
    assert.ok(paths.every((path) => path.startsWith("/templates/")));
    assert.equal(paths.some((path) => path.includes("/snapshots") || path.includes("/builds/")), false);
  });
});

test("a raw template ID resolves only with a build ID tag", async () => {
  const buildId = "123e4567-e89b-12d3-a456-426614174000";
  let denyMetadata = false;
  await withTemplateApi((path, response) => {
    if (path.startsWith("/templates/aliases/")) response.writeHead(404).end("{}");
    else if (path.startsWith("/templates/rawid?")) {
      if (denyMetadata) response.writeHead(403).end("{}");
      else response.end(JSON.stringify({ templateID: "rawid", builds: [{ buildID: buildId, status: "ready" }] }));
    } else response.writeHead(400).end("{}");
  }, async ({ apiUrl, paths, directory }) => {
    const images = createE2BImages({ apiKey: "test-only", apiUrl, cacheDirectory: directory, requestTimeoutMs: 2_000 });
    const result = await images.ensure({ image: `rawid:${buildId}` });
    assert.equal(result.reference, `rawid:${buildId}`);
    await assert.rejects(images.ensure({ image: "rawid:default" }),
      (cause) => cause instanceof OrbitalError && cause.code === "image_missing");
    assert.equal(paths.some((path) => path.includes("/tags") || path.includes("/builds/")), false);
    denyMetadata = true;
    await assert.rejects(images.ensure({ image: `rawid:${buildId}` }),
      (cause) => cause instanceof OrbitalError && cause.code === "image_lookup_failed" && cause.evidence.statusCode === 403);
  });
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createOrbital, OrbitalError, type Images, type PrepareRequest } from "@henriquebastosnet/orbital";
import { SimulatedProvider } from "../../../../tests/support/provider.js";

function imageManager(reference = "prepared-image") {
  const requests: PrepareRequest[] = [];
  const images: Images = {
    async ensure(request) {
      requests.push({ ...request });
      return { reference, baseReference: request.image ?? "default-base", cacheKey: "cache-key", reused: false };
    },
  };
  return { images, requests };
}

const request = { orbId: "session-1", idleTimeoutMs: 60_000 };

test("unsupported idle timeouts fail before image preparation or provider lookup", async () => {
  const manager = imageManager();
  const orbital = createOrbital({ provider: {} as never, images: manager.images });
  for (const idleTimeoutMs of [1, 2]) {
    await assert.rejects(orbital.create({ ...request, idleTimeoutMs }), { code: "invalid_create" });
  }
  assert.deepEqual(manager.requests, []);
});

test("the default image is prepared only when a new orb needs allocation", async () => {
  const provider = new SimulatedProvider();
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  const first = await orbital.create(request);
  const second = await orbital.create(request);
  assert.equal(first.resourceId, second.resourceId);
  assert.equal(first.image, "prepared-image");
  assert.deepEqual(first.creationIntent, {});
  assert.deepEqual(manager.requests, [{ image: undefined, preparation: undefined }]);
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("an explicit image works without an image manager", async () => {
  const provider = new SimulatedProvider();
  const orbital = createOrbital({ provider });
  const created = await orbital.create({ ...request, image: "existing-image" });
  assert.equal(created.image, "existing-image");
  assert.deepEqual(created.creationIntent, { image: "existing-image" });
  await assert.rejects(orbital.create({ ...request, orbId: "default" }),
    { outcome: "not_started", code: "image_manager_unavailable" });
  await assert.rejects(orbital.create({ ...request, orbId: "script", image: "existing-image", preparation: "true" }),
    { outcome: "not_started", code: "image_manager_unavailable" });
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("preparation hashes the exact script bytes and retries without another image effect", async () => {
  const provider = new SimulatedProvider();
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  const script = "printf 'héllo'\r\n";
  const first = await orbital.create({ ...request, image: "base-image", preparation: script });
  assert.deepEqual(first.creationIntent, { image: "base-image",
    preparationHash: createHash("sha256").update(script, "utf8").digest("hex") });
  assert.equal(first.image, "prepared-image");
  assert.deepEqual(manager.requests, [{ image: "base-image", preparation: script }]);
  assert.equal((await orbital.create({ ...request, image: "base-image", preparation: script })).resourceId, first.resourceId);
  await assert.rejects(orbital.create({ ...request, image: "base-image", preparation: script.replace("\r\n", "\n") }),
    { outcome: "not_started", code: "conflict" });
  assert.equal(manager.requests.length, 1);
  assert.deepEqual(provider.effects, ["create:allocation-1"]);
});

test("a default creation reuses an existing orb even when a new default image is available", async () => {
  const provider = new SimulatedProvider();
  const manager = imageManager("default-v1");
  await createOrbital({ provider, images: manager.images }).create(request);
  const upgraded = imageManager("default-v2");
  const reused = await createOrbital({ provider, images: upgraded.images }).create(request);
  assert.equal(reused.image, "default-v1");
  assert.deepEqual(upgraded.requests, []);
  assert.equal(provider.orbs.length, 1);
});

test("legacy metadata permits the original explicit image but rejects default and prepared requests", async () => {
  const provider = new SimulatedProvider();
  provider.orbs.push({ orbId: request.orbId, resourceId: "legacy", image: "legacy-image",
    state: "running", idleTimeoutMs: request.idleTimeoutMs });
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  assert.equal((await orbital.create({ ...request, image: "legacy-image" })).resourceId, "legacy");
  for (const options of [{}, { image: "legacy-image", preparation: "true" }]) {
    await assert.rejects(orbital.create({ ...request, ...options }),
      { outcome: "not_started", code: "legacy_creation_intent_unknown" });
  }
  assert.deepEqual(manager.requests, []);
  assert.deepEqual(provider.effects, []);
});

test("a failed or cancelled preparation cannot submit an allocation", async () => {
  const provider = new SimulatedProvider();
  const failed = createOrbital({ provider, images: { async ensure() { throw new Error("build failed"); } } });
  await assert.rejects(failed.create(request), /build failed/);
  const controller = new AbortController();
  const cancelled = createOrbital({ provider, images: {
    async ensure() {
      controller.abort();
      return { reference: "prepared-image", baseReference: "base", cacheKey: "key", reused: false };
    },
  } });
  await assert.rejects(cancelled.create(request, { signal: controller.signal }),
    { outcome: "not_started", code: "cancelled" });
  assert.deepEqual(provider.effects, []);
});

test("creation captures the caller's request before provider lookup awaits", async () => {
  const provider = new SimulatedProvider();
  let finishLookup!: () => void;
  provider.resolve = async () => { await new Promise<void>(done => { finishLookup = done; }); return undefined; };
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  const mutable = { ...request, image: "original-base", preparation: "echo original" };
  const pending = orbital.create(mutable);
  mutable.image = "changed-base";
  mutable.preparation = "echo changed";
  finishLookup();
  const created = await pending;
  assert.deepEqual(manager.requests, [{ image: "original-base", preparation: "echo original" }]);
  assert.equal(created.creationIntent?.image, "original-base");
  assert.equal(created.creationIntent?.preparationHash,
    createHash("sha256").update("echo original").digest("hex"));
});

test("prepare warms an image without contacting the provider", async () => {
  const manager = imageManager("warm-image");
  const orbital = createOrbital({ provider: {} as never, images: manager.images });
  const prepared = await orbital.prepare({ image: "base-image", preparation: "echo ready", refresh: true });
  assert.equal(prepared.reference, "warm-image");
  assert.deepEqual(manager.requests, [{ image: "base-image", preparation: "echo ready", refresh: true }]);
  await assert.rejects(createOrbital({ provider: {} as never }).prepare(),
    (error) => error instanceof OrbitalError && error.code === "image_manager_unavailable");
});

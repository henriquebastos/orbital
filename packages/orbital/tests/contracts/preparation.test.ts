import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createOrbital, OrbitalError, type Images, type OrbSnapshot, type PrepareRequest } from "@henriquebastosnet/orbital";
import { assertCreationMatches } from "../../src/lifecycle/creation.js";
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

const request = { orbId: "session-1", leaseWindowMs: 60_000 };

test("unsupported lease windows fail before image preparation or provider lookup", async () => {
  const manager = imageManager();
  const provider = new SimulatedProvider();
  provider.resolve = async () => { throw new Error("Unexpected lookup"); };
  const orbital = createOrbital({ provider, images: manager.images });
  for (const leaseWindowMs of [1, 2]) {
    await assert.rejects(orbital.create({ ...request, leaseWindowMs }), { code: "invalid_create" });
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

test("an Orb that appears during preparation is attached and the prepared image is unused", async () => {
  const provider = new SimulatedProvider();
  const concurrent: OrbSnapshot = { orbId: request.orbId, resourceId: "concurrent", image: "prepared-elsewhere",
    state: "sleeping", leaseWindowMs: request.leaseWindowMs, creationIntent: {} };
  let lookups = 0;
  provider.resolve = async () => (lookups += 1) === 1 ? undefined : concurrent;
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  const attached = await orbital.create(request);
  assert.equal(lookups, 2);
  assert.equal(attached.resourceId, "concurrent");
  assert.equal(attached.image, "prepared-elsewhere");
  assert.equal(attached.state, "running");
  assert.equal(manager.requests.length, 1);
  assert.deepEqual(provider.effects, ["resume:concurrent"]);
});

test("a conflicting Orb that appears during preparation rejects the allocation", async () => {
  const provider = new SimulatedProvider();
  const concurrent: OrbSnapshot = { orbId: request.orbId, resourceId: "concurrent", image: "other-image",
    state: "sleeping", leaseWindowMs: request.leaseWindowMs, creationIntent: { image: "other-image" } };
  let lookups = 0;
  provider.resolve = async () => (lookups += 1) === 1 ? undefined : concurrent;
  const orbital = createOrbital({ provider, images: imageManager().images });
  await assert.rejects(orbital.create(request), { outcome: "not_started", code: "conflict" });
  assert.equal(lookups, 2);
  assert.deepEqual(provider.effects, []);
});

test("creation intent mismatches on image, preparation hash, and lease window are conflicts", () => {
  const hash = "a".repeat(64);
  const orb: OrbSnapshot = { orbId: request.orbId, resourceId: "existing", image: "prepared-image",
    state: "running", leaseWindowMs: 60_000, creationIntent: { image: "base-image", preparationHash: hash } };
  assertCreationMatches(orb, { image: "base-image", preparationHash: hash }, 60_000);
  const mismatches: Array<[Parameters<typeof assertCreationMatches>[1], number]> = [
    [{ image: "prepared-image", preparationHash: hash }, 60_000],
    [{ image: "base-image", preparationHash: "b".repeat(64) }, 60_000],
    [{ image: "base-image" }, 60_000],
    [{ image: "base-image", preparationHash: hash }, 30_000],
  ];
  for (const [intent, leaseWindowMs] of mismatches) {
    assert.throws(() => assertCreationMatches(orb, intent, leaseWindowMs), { outcome: "not_started", code: "conflict" });
  }
  // @ts-expect-error An Orb without saved creation intent is not representable, so no legacy branch exists.
  const legacy: OrbSnapshot = { orbId: request.orbId, resourceId: "legacy", image: "legacy-image",
    state: "running", leaseWindowMs: 60_000 };
  assert.equal(legacy.creationIntent, undefined);
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
  // Only the first lookup blocks. The second lookup, after image work, returns at once.
  let finishLookup: (() => void) | undefined;
  provider.resolve = async () => {
    if (!finishLookup) await new Promise<void>(done => { finishLookup = done; });
    return undefined;
  };
  const manager = imageManager();
  const orbital = createOrbital({ provider, images: manager.images });
  const mutable = { ...request, image: "original-base", preparation: "echo original" };
  const pending = orbital.create(mutable);
  mutable.image = "changed-base";
  mutable.preparation = "echo changed";
  finishLookup!();
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

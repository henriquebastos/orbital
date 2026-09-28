import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { OrbitalError } from "../../src/operations.js";
import type { OrbSnapshot } from "../../src/orb.js";
import { createE2BProvider } from "../../src/e2b/provider.js";

const orb: OrbSnapshot = {
  orbId: "session-1",
  resourceId: "sandbox-1",
  image: "orbital-image:v1",
  state: "sleeping",
  idleTimeoutMs: 60_000,
  sandboxDomain: "region.e2b.app",
};

test("the adapter rejects an unenforced background timeout before launch", async () => {
  const provider = createE2BProvider({ apiKey: "test-only" });
  await assert.rejects(provider.exec(orb, { command: "service", orbCwd: "/home/user", mode: "background", timeoutMs: 100 }, { signal: AbortSignal.abort() }), { outcome: "not_started", code: "invalid_timeout" });
});

test("native URLs use the passively observed sandbox domain and require a valid port", () => {
  const provider = createE2BProvider({ apiKey: "test-only" });
  assert.equal(provider.url(orb, 3000), "https://3000-sandbox-1.region.e2b.app");
  assert.equal(provider.url(orb, 8080), "https://8080-sandbox-1.region.e2b.app");
  assert.throws(() => provider.url(orb, 0), (error) =>
    error instanceof OrbitalError && error.outcome === "not_started");
  assert.throws(() => provider.url(orb, 65_536), (error) =>
    error instanceof OrbitalError && error.outcome === "not_started");
});

test("invalid creation policy fails before an E2B request", async () => {
  const provider = createE2BProvider({ apiKey: "test-only" });
  for (const idleTimeoutMs of [0, 2]) {
    await assert.rejects(
      provider.create({ orbId: "session-1", image: "base", idleTimeoutMs }),
      (error) => error instanceof OrbitalError && error.outcome === "not_started" && error.code === "invalid_create",
    );
  }
});

test("a lost E2B create response stays uncertain and is sent once", async () => {
  let creates = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") {
      creates += 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}`,
      requestTimeoutMs: 2_000 });
    await assert.rejects(
      provider.create({ orbId: "lost-response", image: "test-image", idleTimeoutMs: 30_000 }),
      (cause) => cause instanceof OrbitalError && cause.outcome === "uncertain" &&
        cause.code === "create_unknown" && cause.evidence.orbId === "lost-response",
    );
    assert.equal(creates, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an E2B rate limit rejects creation without a retry", async () => {
  let creates = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") {
      creates += 1;
      response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      response.end(JSON.stringify({ code: 429, message: "test rate limit" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}`,
      requestTimeoutMs: 2_000 });
    await assert.rejects(
      provider.create({ orbId: "rate-limited", image: "test-image", idleTimeoutMs: 30_000 }),
      (cause) => cause instanceof OrbitalError && cause.outcome === "not_started" && cause.code === "create_rejected",
    );
    assert.equal(creates, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("a lost file-write response is uncertain and the SDK sends one write", async () => {
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/v2/sandboxes/sandbox-1/connect") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sandboxID: "sandbox-1", envdVersion: "0.6.10",
        envdAccessToken: "test-token" }));
      return;
    }
    if (request.method === "POST" && request.url?.startsWith("/files?")) {
      writes += 1;
      request.socket.destroy();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const previousSandboxUrl = process.env.E2B_SANDBOX_URL;
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.E2B_SANDBOX_URL = baseUrl;
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: baseUrl, requestTimeoutMs: 2_000 });
    await assert.rejects(
      provider.writeFile(orb, "/tmp/mutation", new TextEncoder().encode("one write")),
      (cause) => cause instanceof OrbitalError && cause.outcome === "uncertain" &&
        cause.code === "write_unknown" && cause.evidence.path === "/tmp/mutation",
    );
    assert.equal(writes, 1);
  } finally {
    if (previousSandboxUrl === undefined) delete process.env.E2B_SANDBOX_URL;
    else process.env.E2B_SANDBOX_URL = previousSandboxUrl;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("lookup rejects duplicate Orb IDs across running and paused sandboxes", async () => {
  const entries = ["running", "paused"].map((state, index) => ({
    sandboxID: `sandbox-${index + 1}`,
    templateID: "template-1",
    metadata: { orbital_v2_orb_id: "same-id", orbital_v2_image: "image-1",
      orbital_v2_idle_timeout_ms: "30000" },
    state,
    startedAt: "2026-09-24T00:00:00Z",
    endAt: "2026-09-24T00:01:00Z",
    cpuCount: 2,
    memoryMB: 1024,
    envdVersion: "0.6.10",
  }));
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(entries));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(provider.resolve("same-id"), (cause) =>
      cause instanceof OrbitalError && cause.code === "duplicate_orb" &&
      cause.evidence.resourceIds instanceof Array && cause.evidence.resourceIds.length === 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("lookup rejects malformed saved creation intent", async () => {
  const invalid = ["not-json", "[]", '{"image":""}', '{"preparationHash":"short"}', '{"unknown":true}'];
  let index = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ sandboxID: "sandbox-1", templateID: "prepared-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "prepared-image",
          orbital_v2_idle_timeout_ms: "30000", orbital_v2_creation_intent: invalid[index++] },
        state: "running", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }]));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    for (const _ of invalid) {
      await assert.rejects(provider.resolve("session-1"),
        { outcome: "not_started", code: "invalid_metadata" });
    }
    assert.equal(index, invalid.length);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("a second provider create matches saved selectors instead of the prepared artifact", async () => {
  const hash = "a".repeat(64);
  let creates = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ sandboxID: "sandbox-1", templateID: "prepared-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "prepared-image",
          orbital_v2_idle_timeout_ms: "30000",
          orbital_v2_creation_intent: JSON.stringify({ image: "base-image", preparationHash: hash }) },
        state: "running", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }]));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") creates += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    const request = { orbId: "session-1", image: "prepared-image", idleTimeoutMs: 30_000,
      creationIntent: { image: "base-image", preparationHash: hash } };
    assert.deepEqual((await provider.resolve("session-1"))?.creationIntent, request.creationIntent);
    assert.equal((await provider.create(request)).resourceId, "sandbox-1");
    await assert.rejects(provider.create({ ...request, creationIntent: { image: "prepared-image", preparationHash: hash } }),
      { outcome: "not_started", code: "orb_conflict" });
    assert.equal(creates, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("legacy provider metadata accepts the original explicit image only", async () => {
  let creates = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ sandboxID: "sandbox-1", templateID: "legacy-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "legacy-image",
          orbital_v2_idle_timeout_ms: "30000" },
        state: "running", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }]));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") creates += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    const request = { orbId: "session-1", image: "legacy-image", idleTimeoutMs: 30_000 };
    assert.equal((await provider.create(request)).resourceId, "sandbox-1");
    await assert.rejects(provider.create({ ...request, creationIntent: {} }),
      { outcome: "not_started", code: "legacy_creation_intent_unknown" });
    assert.equal(creates, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("cancellation during the second provider lookup prevents allocation and wake", async () => {
  let controller: AbortController;
  let existing = false;
  let creates = 0;
  let connects = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      controller.abort();
      const entries = existing ? [{ sandboxID: "sandbox-1", templateID: "base-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "base-image",
          orbital_v2_idle_timeout_ms: "30000" },
        state: "paused", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }] : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(entries));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") creates += 1;
    if (request.method === "POST" && request.url?.endsWith("/connect")) connects += 1;
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    for (existing of [false, true]) {
      controller = new AbortController();
      await assert.rejects(provider.create({ orbId: "session-1", image: "base-image", idleTimeoutMs: 30_000 },
        { signal: controller.signal }), { outcome: "not_started", code: "cancelled_before_create" });
    }
    assert.equal(creates, 0);
    assert.equal(connects, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

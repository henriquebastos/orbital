import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Sandbox } from "e2b";

import { OrbitalError } from "../../src/operations.js";
import type { OrbSnapshot } from "../../src/orb.js";
import { createE2BProvider } from "../../src/e2b/provider.js";
import { createOrbital } from "../../src/lifecycle/index.js";

const orb: OrbSnapshot = {
  orbId: "session-1",
  resourceId: "sandbox-1",
  image: "orbital-image:v1",
  state: "sleeping",
  leaseWindowMs: 60_000,
  sandboxDomain: "region.e2b.app",
  creationIntent: { image: "orbital-image:v1" },
};

test("creation sends the complete instance environment to E2B without metadata secrets", async (t) => {
  t.mock.method(Sandbox, "list", () => { throw new Error("Allocation must not look up existing sandboxes"); });
  const calls: Array<{ envs: Record<string, string>; metadata: Record<string, string> }> = [];
  t.mock.method(Sandbox, "create", async (_image: string, options: typeof calls[number]) => {
    calls.push(options);
    return { async getInfo() { return { sandboxId: "sandbox-1", metadata: options.metadata, state: "running", cpuCount: 8, memoryMB: 8192 };  } };
  });
  const provider = createE2BProvider({ apiKey: "provider-key" });
  const request = { orbId: "env-orb", image: "base", leaseWindowMs: 60000, creationIntent: { image: "base" } };
  const environments: Array<Record<string, string>> = [
    { E2B_API_KEY: "instance-key", GH_TOKEN: "test-token", SANDBOX_URL: "https://sandbox.test", EMPTY: "" },
    { E2B_API_KEY: "instance-key", "custom.name": "custom-value" }];
  for (const env of environments) {
    const result = await provider.create({ ...request, env });
    assert.deepEqual(calls.at(-1)?.envs, env);
    assert.deepEqual(result.resources, { cpuCount: 8, memoryMB: 8192 });
    assert.doesNotMatch(JSON.stringify([result, calls.at(-1)?.metadata]), /provider-key|test-token|instance-key|custom-value/);
  }
});

test("creation requires an explicitly supplied renewal key before any E2B request", async (t) => {
  t.mock.method(Sandbox, "list", () => { throw new Error("Unexpected network access"); });
  const provider = createE2BProvider({ apiKey: "provider-key" });
  const environments: Array<Record<string, string> | undefined> = [undefined, {}, { E2B_API_KEY: "" }, { E2B_API_KEY: " " }];
  for (const env of environments) {
    await assert.rejects(provider.create({ orbId: "env-orb", image: "base", leaseWindowMs: 60000, creationIntent: { image: "base" }, env }),
      { outcome: "not_started", code: "missing_renewal_key" });
  }
});

test("runner renewal diagnostics reach callers without arbitrary guest fields", async (t) => {
  const lastSuccessAt = "2026-09-29T03:00:29.000Z";
  const expected = { category: "timeout", durationMs: 5004, attempt: 8, lastSuccessAt, httpStatus: 504 };
  let renewal: unknown = { ...expected, message: "SECRET_MESSAGE", stack: "SECRET_STACK",
    headers: { authorization: "SECRET_HEADER" }, cause: { token: "SECRET_CAUSE" } };
  t.mock.method(Sandbox, "connect", async () => ({
    files: {
      async makeDir() {}, async write() {}, async rename() {},
      async exists(path: string) { return path.endsWith("/status.json"); },
      async read() { return JSON.stringify({ state: "finished", outcome: "failed", errorCode: "renewal_failed",
        phase: "execution", scopeStopped: true, renewal }); },
    },
    commands: { async run() {} },
  }));
  const provider = createE2BProvider({ apiKey: "test-only" });
  async function failure() {
    let evidence;
    await assert.rejects(provider.exec(orb, { command: "true", orbCwd: "/home/user" }), cause => {
      assert.ok(cause instanceof OrbitalError);
      assert.equal(cause.code, "renewal_failed");
      assert.doesNotMatch(JSON.stringify(cause.evidence), /SECRET_/);
      evidence = cause.evidence.renewal;
      return true;
    });
    return evidence;
  }
  assert.deepEqual(await failure(), expected);
  renewal = { category: "network", httpStatus: 999, durationMs: -1, attempt: "SECRET_ATTEMPT", lastSuccessAt: "SECRET_TIME" };
  assert.deepEqual(await failure(), { category: "network" });
  for (renewal of [undefined, null, "SECRET_VALUE", { category: "SECRET_CATEGORY" }]) {
    assert.equal(await failure(), undefined);
  }
});

test("command overrides may include the renewal key", async () => {
  const provider = createE2BProvider({ apiKey: "test-only" });
  await assert.rejects(provider.exec(orb, { command: "true", orbCwd: "/home/user",
    env: { E2B_API_KEY: "command-key" } }, { signal: AbortSignal.abort() }),
  { outcome: "not_started", code: "cancelled_before_exec" });
});

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
  for (const leaseWindowMs of [0, 2]) {
    await assert.rejects(
      provider.create({ orbId: "session-1", image: "base", leaseWindowMs, creationIntent: { image: "base" } }),
      (error) => error instanceof OrbitalError && error.outcome === "not_started" && error.code === "invalid_create",
    );
  }
});

test("a lost E2B create response stays uncertain and is sent once", async () => {
  let creates = 0;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
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
      provider.create({ orbId: "lost-response", image: "test-image", leaseWindowMs: 30_000, env: { E2B_API_KEY: "test-key" },
        creationIntent: { image: "test-image" } }),
      (cause) => cause instanceof OrbitalError && cause.outcome === "uncertain" &&
        cause.code === "create_unknown" && cause.evidence.orbId === "lost-response",
    );
    assert.equal(creates, 1);
    assert.deepEqual(paths, ["POST /v2/sandboxes"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("an E2B rate limit rejects creation without a retry", async () => {
  let creates = 0;
  const server = createServer((request, response) => {
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
      provider.create({ orbId: "rate-limited", image: "test-image", leaseWindowMs: 30_000, env: { E2B_API_KEY: "test-key" },
        creationIntent: { image: "test-image" } }),
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
      orbital_v2_lease_window_ms: "30000" },
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
          orbital_v2_lease_window_ms: "30000", orbital_v2_creation_intent: invalid[index++] },
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

test("provider create allocates without a lookup and saves the creation intent", async () => {
  const hash = "a".repeat(64);
  const paths: string[] = [];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ sandboxID: "sandbox-existing", templateID: "other-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "other-image",
          orbital_v2_lease_window_ms: "30000", orbital_v2_creation_intent: JSON.stringify({ image: "other-image" }) },
        state: "running", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }]));
      return;
    }
    if (request.method === "POST" && request.url === "/v2/sandboxes") {
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ sandboxID: "sandbox-new", templateID: "prepared-image", envdVersion: "0.6.10",
          envdAccessToken: "test-token", domain: "e2b.app" }));
      });
      return;
    }
    if (request.method === "GET" && request.url === "/sandboxes/sandbox-new") {
      const metadata = (JSON.parse(bodies[0] ?? "{}") as { metadata?: Record<string, string> }).metadata ?? {};
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ sandboxID: "sandbox-new", templateID: "prepared-image", metadata,
        state: "running", startedAt: "2026-09-24T00:00:00Z", endAt: "2026-09-24T00:01:00Z",
        cpuCount: 2, memoryMB: 1024, envdVersion: "0.6.10" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const provider = createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` });
    const creationIntent = { image: "base-image", preparationHash: hash };
    const created = await provider.create({ orbId: "session-1", image: "prepared-image", leaseWindowMs: 30_000,
      env: { E2B_API_KEY: "test-key" }, creationIntent });
    assert.equal(created.resourceId, "sandbox-new");
    assert.deepEqual(created.creationIntent, creationIntent);
    assert.deepEqual(paths, ["POST /v2/sandboxes", "GET /sandboxes/sandbox-new"]);
    assert.equal(bodies.length, 1);
    assert.equal((JSON.parse(bodies[0]!) as { metadata: Record<string, string> }).metadata.orbital_v2_creation_intent,
      JSON.stringify(creationIntent));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("lookup rejects a sandbox without saved creation intent", async () => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ sandboxID: "sandbox-1", templateID: "legacy-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "legacy-image",
          orbital_v2_lease_window_ms: "30000" },
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
    await assert.rejects(provider.resolve("session-1"), (cause) =>
      cause instanceof OrbitalError && cause.outcome === "not_started" && cause.code === "invalid_metadata" &&
      cause.evidence.resourceId === "sandbox-1");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("cancellation during the lifecycle's second lookup prevents allocation and wake", async () => {
  let controller: AbortController;
  let existing = false;
  let lookups = 0;
  let creates = 0;
  let connects = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/v2/sandboxes")) {
      lookups += 1;
      // The Orb appears only on the second lookup, where cancellation lands.
      const second = lookups % 2 === 0;
      if (second) controller.abort();
      const entries = existing && second ? [{ sandboxID: "sandbox-1", templateID: "base-image",
        metadata: { orbital_v2_orb_id: "session-1", orbital_v2_image: "base-image",
          orbital_v2_lease_window_ms: "30000", orbital_v2_creation_intent: JSON.stringify({ image: "base-image" }) },
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
    const orbital = createOrbital({ provider: createE2BProvider({ apiKey: "test-only", apiUrl: `http://127.0.0.1:${address.port}` }) });
    for (existing of [false, true]) {
      controller = new AbortController();
      await assert.rejects(orbital.create({ orbId: "session-1", image: "base-image", leaseWindowMs: 30_000, env: { E2B_API_KEY: "test-key" } },
        { signal: controller.signal }), { outcome: "not_started", code: "cancelled" });
    }
    assert.equal(lookups, 4);
    assert.equal(creates, 0);
    assert.equal(connects, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
});

test("the lifecycle admits the renewal key before any lookup or reuse", async () => {
  const provider = createE2BProvider({ apiKey: "test-only" });
  let resolved = 0;
  provider.resolve = async () => { resolved++; return undefined; };
  const orbital = createOrbital({ provider });
  await assert.rejects(orbital.create({ orbId: "pi-session", image: "base", leaseWindowMs: 60_000, env: {} }),
    { outcome: "not_started", code: "missing_renewal_key" });
  assert.equal(resolved, 0);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const pi = resolve("node_modules/.bin/pi");
const extension = resolve("packages/pi-orbital/tests/fixture-extension.ts");

test("a new Pi session runs workspace tools locally by default", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const sentinel = resolve(dir, "host-sentinel");
    writeFileSync(sentinel, "HOST_ONLY");
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "bash", "--mode", "json", "--no-session", "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir,
        ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([{ name: "bash", arguments: { command: `printf changed > '${sentinel}'` } }]) },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stdout, /No orb is attached/);
    assert.equal(readFileSync(sentinel, "utf8"), "changed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi creates an orb, attaches, and runs a command in its workspace", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const hostMarker = resolve(dir, "marker");
    writeFileSync(hostMarker, "HOST_ONLY");
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach", orbCwd: "/home/user" } },
          { name: "bash", arguments: { command: "printf REMOTE_ONLY > marker" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.equal(results.length, 2, JSON.stringify(results));
    assert.equal(results[0]?.isError, false, JSON.stringify(results));
    assert.equal(results[1]?.isError, false, JSON.stringify(results));
    assert.match(results[0]?.result?.content?.[0]?.text ?? "", /Attached to/);
    assert.equal(readFileSync(hostMarker, "utf8"), "HOST_ONLY");
    assert.equal(readFileSync(resolve(dir, "orb", "marker"), "utf8"), "REMOTE_ONLY");
    const session = readFileSync(resolve(dir, "session.jsonl"), "utf8");
    assert.match(session, /"customType":"orbital.binding"/);
    assert.match(session, /"allocation":"attached","orbCwd":"\/home\/user"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi writes and reads remote files without changing the host file", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    writeFileSync(resolve(dir, "note.txt"), "HOST_NOTE");
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,write,read", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "write", arguments: { path: "note.txt", content: "REMOTE_NOTE" } },
          { name: "read", arguments: { path: "note.txt" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["write", false], ["read", false]], JSON.stringify(results));
    assert.match(results[2]?.result?.content?.[0]?.text ?? "", /REMOTE_NOTE/);
    assert.equal(readFileSync(resolve(dir, "orb", "note.txt"), "utf8"), "REMOTE_NOTE");
    assert.equal(readFileSync(resolve(dir, "note.txt"), "utf8"), "HOST_NOTE");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi edits remote text and reports an exact-match failure", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,write,edit,read", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "write", arguments: { path: "note.txt", content: "alpha\n" } },
          { name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "alpha", newText: "beta" }] } },
          { name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "alpha", newText: "gamma" }] } },
          { name: "read", arguments: { path: "note.txt" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["write", false], ["edit", false], ["edit", true], ["read", false]], JSON.stringify(results));
    assert.match(results[4]?.result?.content?.[0]?.text ?? "", /beta/);
    assert.equal(readFileSync(resolve(dir, "orb", "note.txt"), "utf8"), "beta\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real Pi searches and lists the orb instead of the host", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    writeFileSync(resolve(dir, "host-only.txt"), "HOST_TOKEN");
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,write,grep,find,ls", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "write", arguments: { path: "remote.txt", content: "BEFORE\nREMOTE_TOKEN\nAFTER\n" } },
          { name: "grep", arguments: { pattern: "REMOTE_TOKEN", context: 1 } },
          { name: "find", arguments: { pattern: "*.txt" } },
          { name: "ls", arguments: { path: "." } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["write", false], ["grep", false], ["find", false], ["ls", false]], JSON.stringify(results));
    for (const result of results.slice(2)) {
      assert.match(result.result?.content?.[0]?.text ?? "", /remote\.txt|REMOTE_TOKEN/);
      assert.doesNotMatch(result.result?.content?.[0]?.text ?? "", /host-only\.txt|HOST_TOKEN/);
    }
    assert.match(results[2]?.result?.content?.[0]?.text ?? "", /BEFORE[\s\S]*REMOTE_TOKEN[\s\S]*AFTER/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new Pi user shell executes locally by default", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const marker = resolve(dir, "host-sentinel");
    writeFileSync(marker, "HOST_ONLY");
    const run = spawn(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--mode", "rpc", "--no-session"], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: dir, ORBITAL_PI_FIXTURE_ROOT: dir },
    });
    let stderr = "";
    run.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    run.stdin.write(`${JSON.stringify({ id: "shell", type: "bash", command: `printf changed > '${marker}'` })}\n`);
    const response = await new Promise<string>((done, fail) => {
      let buffer = "";
      const timer = setTimeout(() => fail(new Error(`No RPC response. ${stderr}`)), 10_000);
      run.stdout.setEncoding("utf8").on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; id?: string };
          if (event.type === "response" && event.id === "shell") {
            clearTimeout(timer);
            done(line);
          }
        }
      });
      run.once("error", fail);
    });
    run.kill();
    assert.equal(readFileSync(marker, "utf8"), "changed");
    assert.doesNotMatch(response, /No orb is attached/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new Pi process restores the selected orb directory for user shell", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const session = resolve(dir, "session.jsonl");
    const first = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash", "--mode", "json", "--session", session,
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "bash", arguments: { command: "mkdir project" } },
          { name: "orbital", arguments: { action: "select_directory", orbCwd: "project" } },
          { name: "bash", arguments: { command: "printf REMOTE > marker" } },
        ]) },
    });
    assert.equal(first.status, 0, first.stderr);
    const initialResults = first.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(initialResults.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["bash", false], ["orbital", false], ["bash", false]], JSON.stringify(initialResults));
    assert.equal(readFileSync(resolve(dir, "orb", "project", "marker"), "utf8"), "REMOTE");
    const saved = readFileSync(session, "utf8");
    assert.match(saved, /"allocation":"attached","orbCwd":"\/home\/user\/project"/);
    const firstHeader = JSON.parse(saved.split("\n")[0]!) as { id: string };
    const second = spawn(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--mode", "rpc", "--session", session], {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_TRACE: resolve(dir, "trace.jsonl") },
    });
    second.stdin.write(`${JSON.stringify({ id: "shell", type: "bash", command: "pwd; cat marker" })}\n`);
    const response = await new Promise<string>((done, fail) => {
      let buffer = "";
      const timer = setTimeout(() => { second.kill(); fail(new Error("No RPC shell response.")); }, 10_000);
      second.stdout.setEncoding("utf8").on("data", chunk => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type: string; id?: string };
          if (event.type === "response" && event.id === "shell") {
            clearTimeout(timer);
            done(line);
          }
        }
      });
      second.once("error", fail);
    });
    second.kill();
    assert.match(response, /\/home\/user\/project/,
      `first=${firstHeader.id} trace=${readFileSync(resolve(dir, "trace.jsonl"), "utf8")}`);
    assert.match(response, /REMOTE/);
    assert.doesNotMatch(response, /No orb is attached/);
    assert.equal(readFileSync(resolve(dir, "snapshot.json"), "utf8").includes("resourceId"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi reads a named host skill and copies only its allowed asset into the orb", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const skill = resolve(dir, "skills", "sample");
    mkdirSync(resolve(skill, "scripts"), { recursive: true });
    writeFileSync(resolve(skill, "SKILL.md"), "---\nname: sample\ndescription: Fixture skill\n---\nUSE_SKILL_FIXTURE\n");
    writeFileSync(resolve(skill, "scripts", "hello.sh"), "printf ASSET_FROM_HOST\n");
    writeFileSync(resolve(dir, "host-sentinel"), "HOST_ONLY");
    symlinkSync(resolve(dir, "host-sentinel"), resolve(skill, "scripts", "escape"));
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,orbital_skill,read", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_SKILL_ROOTS: resolve(dir, "skills"),
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "orbital_skill", arguments: { action: "read", name: "sample" } },
          { name: "orbital_skill", arguments: { action: "copy_asset", name: "sample",
            asset: "scripts/hello.sh", destination: "asset.sh" } },
          { name: "read", arguments: { path: "asset.sh" } },
          { name: "orbital_skill", arguments: { action: "copy_asset", name: "sample",
            asset: "scripts/escape", destination: "escape" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["orbital_skill", false], ["orbital_skill", false], ["read", false],
        ["orbital_skill", true]], JSON.stringify(results));
    assert.match(results[1]?.result?.content?.[0]?.text ?? "", /USE_SKILL_FIXTURE/);
    assert.match(results[3]?.result?.content?.[0]?.text ?? "", /ASSET_FROM_HOST/);
    assert.match(results[4]?.result?.content?.[0]?.text ?? "", /outside the named skill|not permitted/);
    assert.equal(readFileSync(resolve(dir, "orb", "asset.sh"), "utf8"), "printf ASSET_FROM_HOST\n");
    assert.equal(readFileSync(resolve(dir, "host-sentinel"), "utf8"), "HOST_ONLY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi requires an explicit create after deletion and replaces the public URL", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "orbital", arguments: { action: "url", port: 3000 } },
          { name: "orbital", arguments: { action: "delete" } },
          { name: "bash", arguments: { command: "pwd" } },
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "orbital", arguments: { action: "url", port: 3000 } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; toolName?: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => [event.toolName, event.isError]),
      [["orbital", false], ["orbital", false], ["orbital", false], ["bash", true],
        ["orbital", false], ["orbital", false]], JSON.stringify(results));
    assert.match(results[3]?.result?.content?.[0]?.text ?? "", /missing|not_started/);
    assert.notEqual(results[1]?.result?.content?.[0]?.text, results[5]?.result?.content?.[0]?.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi reports uncertain command and write outcomes with remote evidence", () => {
  for (const fault of ["command", "write"] as const) {
    const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
    try {
      const call = fault === "command"
        ? { name: "bash", arguments: { command: "printf LOST_EFFECT >> effect.txt" } }
        : { name: "write", arguments: { path: "fault.txt", content: "REMOTE_WRITE" } };
      const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
        "--tools", `orbital,${call.name}`, "--mode", "json", "--session", resolve(dir, "session.jsonl"),
        "--print", "run fixture"], {
        cwd: dir, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
          ORBITAL_PI_FAULT: fault, ORBITAL_PI_CALLS: JSON.stringify([
            { name: "orbital", arguments: { action: "create_and_attach" } }, call,
          ]) },
      });
      assert.equal(run.status, 0, run.stderr);
      const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
        type: string; result?: { content?: { text?: string }[] }; isError?: boolean;
      }).filter(event => event.type === "tool_execution_end");
      assert.equal(results[1]?.isError, true, JSON.stringify(results));
      const message = results[1]?.result?.content?.[0]?.text ?? "";
      assert.match(message, /Orbital uncertain \[fixture_result_lost\]/);
      assert.match(message, fault === "command" ? /jobId.*outputPath.*partialOutput/ : /path.*fault\.txt/);
      assert.equal(readFileSync(resolve(dir, "orb", fault === "command" ? "effect.txt" : "fault.txt"), "utf8"),
        fault === "command" ? "LOST_EFFECT" : "REMOTE_WRITE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("Pi returns remote PNG bytes as image content", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4WQAAAAASUVORK5CYII=";
    const command = `python3 -c 'import base64; open("pixel.png", "wb").write(base64.b64decode("${png}"))'`;
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash,read", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "bash", arguments: { command } },
          { name: "read", arguments: { path: "pixel.png" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; result?: { content?: { type: string; mimeType?: string; data?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => event.isError), [false, false, false], JSON.stringify(results));
    assert.equal(results[2]?.result?.content?.[0]?.type, "image");
    assert.equal(results[2]?.result?.content?.[0]?.mimeType, "image/png");
    assert.equal(results[2]?.result?.content?.[0]?.data, png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi parses complete remote grep output beyond the provider preview", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash,grep", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "bash", arguments: { command: "python3 -c 'print(\"MATCH\" + \"x\" * 70000)' > huge.txt" } },
          { name: "grep", arguments: { pattern: "MATCH", path: "huge.txt" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => event.isError), [false, false, false], JSON.stringify(results));
    assert.match(results[2]?.result?.content?.[0]?.text ?? "", /huge\.txt:1: MATCH/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi accepts background Bash and bounds ordinary output", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const run = spawnSync(pi, ["--offline", "--no-extensions", "--no-skills",
      "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--provider", "orbital-fixture", "--model", "probe",
      "--tools", "orbital,bash", "--mode", "json", "--session", resolve(dir, "session.jsonl"),
      "--print", "run fixture"], {
      cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([
          { name: "orbital", arguments: { action: "create_and_attach" } },
          { name: "bash", arguments: { command: "printf BG > launched.txt", mode: "background" } },
          { name: "bash", arguments: { command: "printf BAD", mode: "background", timeout: 1 } },
          { name: "bash", arguments: { command: "python3 -c 'print(\"x\" * 60000)'" } },
        ]) },
    });
    assert.equal(run.status, 0, run.stderr);
    const results = run.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.deepEqual(results.map(event => event.isError), [false, false, true, false], JSON.stringify(results));
    assert.match(results[1]?.result?.content?.[0]?.text ?? "", /Started background job.*Full output:/);
    assert.match(results[2]?.result?.content?.[0]?.text ?? "", /background_timeout/);
    const output = results[3]?.result?.content?.[0]?.text ?? "";
    assert.match(output, /Output truncated/);
    assert.match(output, /Full output: \/home\/user/);
    assert.ok(Buffer.byteLength(output) < 51_000);
    assert.equal(readFileSync(resolve(dir, "orb", "launched.txt"), "utf8"), "BG");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi rejects a corrupt saved binding before any host or orb command", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "orbital-pi-"));
  try {
    const session = resolve(dir, "session.jsonl");
    const sentinel = resolve(dir, "host-sentinel");
    writeFileSync(sentinel, "HOST_ONLY");
    const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates",
      "--no-themes", "--no-context-files", "--no-approve", "--extension", extension,
      "--provider", "orbital-fixture", "--model", "probe", "--tools", "orbital,bash",
      "--mode", "json", "--session", session, "--print", "run fixture"];
    const initial = spawnSync(pi, args, { cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([{ name: "orbital", arguments: { action: "create_and_attach" } }]) } });
    assert.equal(initial.status, 0, initial.stderr);
    const lines = readFileSync(session, "utf8").trimEnd().split("\n").map(line => {
      const entry = JSON.parse(line) as { type: string; customType?: string; data?: unknown };
      if (entry.type === "custom" && entry.customType === "orbital.binding") entry.data = { orbCwd: 5 };
      return JSON.stringify(entry);
    });
    writeFileSync(session, `${lines.join("\n")}\n`);
    const command = `printf CHANGED > '${sentinel}'`;
    const resumed = spawnSync(pi, args, { cwd: dir, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(dir, "agent"), ORBITAL_PI_FIXTURE_ROOT: dir,
        ORBITAL_PI_CALLS: JSON.stringify([{ name: "bash", arguments: { command } }]) } });
    assert.equal(resumed.status, 0, resumed.stderr);
    const results = resumed.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line) as {
      type: string; result?: { content?: { text?: string }[] }; isError?: boolean;
    }).filter(event => event.type === "tool_execution_end");
    assert.equal(results[0]?.isError, true, JSON.stringify(results));
    assert.match(results[0]?.result?.content?.[0]?.text ?? "", /invalid_binding/);
    assert.equal(readFileSync(sentinel, "utf8"), "HOST_ONLY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

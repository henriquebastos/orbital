import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOrbitalConfiguration } from "../../src/configuration/orbital.js";
import { projectPreparation } from "../../src/configuration/project.js";
import { OrbitalError } from "../../src/operations.js";

const canExecute = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;

test("project preparation copies the whole directory and executes only build through its shebang", { skip: !canExecute }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-project-bundle-"));
  const source = join(directory, "source");
  const destination = join(directory, "guest project");
  const bin = join(directory, "bin");
  try {
    await mkdir(join(source, "nested"), { recursive: true });
    await mkdir(bin);
    await mkdir(destination);
    await writeFile(join(destination, "stale"), "not part of the selected project");
    await writeFile(join(bin, "sudo"), '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n', { mode: 0o755 });
    await writeFile(join(source, "settings.json"), "{}\n");
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await writeFile(join(source, "ignored.txt"), "copied despite ignore rules");
    await writeFile(join(source, "nested", "binary ' $file"), Buffer.from([0, 255, 13, 10]), { mode: 0o640 });
    await symlink("nested/binary ' $file", join(source, "relative-link"));
    await symlink("/outside/the/project", join(source, "external-link"));
    await writeFile(join(source, "build"), '#!/usr/bin/env python3\nfrom pathlib import Path\nPath("built").write_text(Path("settings.json").read_text())\n', { mode: 0o755 });
    for (const name of ["start", "resume", "run"]) {
      await writeFile(join(source, name), `#!/bin/sh\ntouch ${name}-called\n`, { mode: 0o755 });
    }
    const script = await projectPreparation(source, destination);
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(await readFile(join(destination, "built"), "utf8"), "{}\n");
    assert.equal(await readFile(join(destination, "ignored.txt"), "utf8"), "copied despite ignore rules");
    assert.deepEqual(await readFile(join(destination, "nested", "binary ' $file")), Buffer.from([0, 255, 13, 10]));
    assert.equal((await lstat(join(destination, "nested", "binary ' $file"))).mode & 0o777, 0o640);
    assert.equal(await readlink(join(destination, "relative-link")), "nested/binary ' $file");
    assert.equal(await readlink(join(destination, "external-link")), "/outside/the/project");
    for (const name of ["stale", "start-called", "resume-called", "run-called"]) {
      await assert.rejects(lstat(join(destination, name)), { code: "ENOENT" });
    }
    await rm(join(source, "build"));
    const copyOnly = spawnSync("bash", ["-c", await projectPreparation(source, destination)], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(copyOnly.status, 0, copyOnly.stderr);
    await assert.rejects(lstat(join(destination, "built")), { code: "ENOENT" });
    await writeFile(join(source, "build"), "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const failed = spawnSync("bash", ["-c", await projectPreparation(source, destination)], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(failed.status, 17, failed.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preparation identity includes every file, path, and mode but not modification timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-project-identity-"));
  try {
    const file = join(directory, "settings.json");
    await writeFile(file, "{}");
    const originalMode = (await lstat(file)).mode & 0o777;
    const original = await projectPreparation(directory);
    await utimes(file, new Date(0), new Date(0));
    assert.equal(await projectPreparation(directory), original);
    await writeFile(file, '{"cpuCount":2}');
    const changed = await projectPreparation(directory);
    assert.notEqual(changed, original);
    await writeFile(file, "{}");
    assert.equal(await projectPreparation(directory), original);
    await rename(file, join(directory, "renamed.json"));
    assert.notEqual(await projectPreparation(directory), original);
    await rename(join(directory, "renamed.json"), file);
    if (process.platform !== "win32") {
      await chmod(file, 0o700);
      assert.notEqual(await projectPreparation(directory), original);
      await chmod(file, originalMode);
    }
    assert.equal(await projectPreparation(directory), original);
    await writeFile(join(directory, ".hidden"), "included");
    assert.notEqual(await projectPreparation(directory), original);
    await writeFile(join(directory, "build"), "PRIVATE_CONTENT", { mode: 0o644 });
    if (process.platform !== "win32") await assert.rejects(projectPreparation(directory), { code: "configuration" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preparation packages the default project directory when it exists and skips it when absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-project-default-"));
  const config = join(directory, "config");
  const cwd = join(directory, "backend");
  const repository = join(cwd, ".orbital");
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(config, { recursive: true });
    await writeFile(join(config, "settings.json"), '{"memoryMB":2048}');
    const configuration = createOrbitalConfiguration({ directory: config, cwd, environment: {} });
    assert.equal(configuration.projectDirectory, repository);
    const [absent, resources] = await Promise.all([configuration.preparation(), configuration.resources()]);
    assert.equal(absent, undefined);
    assert.equal(resources.memoryMB, 2048);
    // A directory that holds only an executable build is packaged. No settings.json is needed.
    await mkdir(repository);
    await writeFile(join(repository, "build"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const buildOnly = await configuration.preparation();
    assert.equal(buildOnly, await projectPreparation(repository));
    assert.match(buildOnly!, /exec \.\/build/);
    assert.equal(configuration.settings.snapshot().project, undefined);
    await writeFile(join(repository, "settings.json"), '{"memoryMB":8192}');
    const [preparation, withProject] = await Promise.all([configuration.preparation(), configuration.resources()]);
    assert.equal(preparation, await projectPreparation(repository));
    assert.equal(withProject.memoryMB, 8192);
    await writeFile(join(repository, "settings.json"), "INVALID_REPOSITORY");
    const results = await Promise.allSettled([configuration.preparation(), configuration.resources()]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.equal(result.reason.code, "configuration");
    }
    await rm(join(repository, "settings.json"));
    await mkdir(join(repository, "settings.json"));
    await assert.rejects(configuration.preparation(), { code: "configuration" });
    await rm(join(repository, "settings.json"), { recursive: true });
    await rm(repository, { recursive: true });
    assert.equal(await configuration.preparation(), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("preparation requires an explicitly selected project directory to exist", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orbital-project-explicit-"));
  const cwd = join(directory, "backend");
  const explicit = join(directory, "shared-project");
  try {
    await mkdir(cwd, { recursive: true });
    for (const options of [
      { environment: { ORBITAL_PROJECT_DIR: explicit } },
      { environment: { ORBITAL_PROJECT_DIR: "../shared-project" } },
      { projectDirectory: explicit, environment: {} },
    ]) {
      const configuration = createOrbitalConfiguration({ directory, cwd, ...options });
      assert.equal(configuration.projectDirectory, explicit);
      await assert.rejects(configuration.preparation(), (error: unknown) => {
        assert.ok(error instanceof OrbitalError);
        assert.equal(error.code, "configuration");
        assert.match(error.message, new RegExp(explicit.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      });
    }
    await mkdir(explicit);
    await writeFile(join(explicit, "build"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const configuration = createOrbitalConfiguration({ directory, cwd, environment: { ORBITAL_PROJECT_DIR: explicit } });
    assert.equal(await configuration.preparation(), await projectPreparation(explicit));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

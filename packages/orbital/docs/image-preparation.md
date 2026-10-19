# 1 Image preparation

Orbital caches tools before it allocates a workspace. Repository checkout stays an explicit workspace operation.
Pi supplies the image manager automatically. Library callers supply both adapters:

```ts
import { createOrbital, createE2BProvider, createE2BImages } from "@henriquebastosnet/orbital";
import { createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";

const configuration = createOrbitalConfiguration();
const e2b = configuration.e2b();
const orbital = createOrbital({
  provider: createE2BProvider(e2b),
  images: createE2BImages({ ...e2b, cacheDirectory: configuration.cacheDirectory, resources: configuration.resources }),
});
```

The library does not discover settings, scripts, repositories, or credentials.
The optional Node helper supplies the default cache directory from XDG_CACHE_HOME or the home directory.
The image adapter receives that directory explicitly.
It also accepts `resources`: CPU count, memory in MiB, and an optional `minFreeDiskMb` target, or a function that resolves them.
The owned recipe validates these values and includes them in its content hash before remote lookup.
An explicit image retains its own resources. Existing Orbs are never resized.

`minFreeDiskMb` requests minimum free space after the base build, not total disk capacity.
Omitting it uses the E2B team default. Zero requests no additional growth.
Growth is best-effort, so inspect actual free space after creation. E2B enforces account-specific resource limits.

## 1a API and sequence

| Operation | Result |
| --- | --- |
| `orbital.prepare()` | Establish the owned base without a user Orb. |
| `orbital.prepare({ preparation })` | Cache successful Bash preparation over that base. |
| `orbital.prepare({ preparation, refresh: true })` | Create a replacement preparation generation for future allocations. |
| `orbital.prepare({ refresh: true })` | Rebuild the owned base. |
| `orbital.create({ orbId, leaseWindowMs, preparation? })` | Reuse a matching Orb or prepare an image and allocate a new Orb. |

All image requests accept an optional `image` override. It must identify an existing compatible E2B image.
An override is not a Docker image name. Refresh without preparation requires the owned base recipe.

`preparation` contains UTF-8 Bash source. It is not a path. Missing content and an empty string mean no preparation.
Nonempty content uses exact bytes for identity, including comments and whitespace.

Creation follows this order:

- Resolve the Orb ID and compare its saved creation intent and lease window.
- If the Orb exists and matches, wake it when needed and return it.
- Otherwise, resolve the base and look for a ready preparation image.
- On a miss, prepare a temporary seed, check the runtime, capture the image, and publish its receipt.
- Resolve the Orb ID again. An Orb that a concurrent creation allocated meanwhile is attached and the prepared image is unused.
- Allocate the live Orb with its own identity, lease window, and renewal credential. The provider only allocates. It does not look up, compare, or resume.
- Return the Orb. The caller can now clone repositories and install project dependencies.

Preparation returns `{ reference, baseReference, cacheKey, reused }`.
`cacheKey` is the local record key of an owned result. An external image has no record, so its key is derived from the pinned build.
Normal creation does not require callers to manage image references.
The existing observer reports progress and preparation output.

### Composable operations

`createE2BImageEffects(config)` exposes provider operations without running the orchestration or creating cache records.
Lookup, submission, and waiting do not require a cache directory. Preparation seeds require one for their logs.

| Primitive | Contract |
| --- | --- |
| `orbitalRecipe()` | Read the bundled recipe and payload and return its content hash and build inputs. No network calls. |
| `hashBaseRecipe(templateJSON, resources, files)` | Hash explicit inputs without reading files or contacting E2B. File order and exact bytes matter. |
| `baseImageName(sourceHash)` | Derive the stable `orbital-base-{sourceHash}` name. |
| `effects.findReusableBuild(name)` | Read remote state. Return a ready build, otherwise a pending or failed build. Only a missing alias returns `undefined`. |
| `effects.submitBuild(name, recipe, observer?)` | Submit one build and return its identity without waiting for completion. |
| `effects.waitForBuild(artifact, observer?)` | Poll that exact build. Never submit or delete an image. |
| `effects.external(reference)` | Resolve an explicit reference to an exact ready build. |
| `effects.available(artifact)` | Check the recorded artifact without building. |
| `effects.createSeed(base, attemptId)` | Create a preparation seed with separate write, execute, check, capture, and delete operations. |

`createImages(effects, records)` composes these operations with durable local receipts.
`createE2BImages(config)` supplies the E2B effects and `ImageRecords` implementation.
Callers can use the primitives directly or supply their own composition and record location.

The default composition checks its local receipt, then looks up the content-addressed name in E2B.
It reuses a ready build, waits for a pending build, or submits after confirmed absence or a terminal failed build.
Lookup errors stop the flow. They never count as absence.
Each allocation uses an exact build reference, not a mutable tag.

## 1b Explicit checkout

```ts
import { readFile } from "node:fs/promises";

const preparation = await readFile("./orbital-tools.sh", "utf8");
const orb = await orbital.create({ orbId: "hamsterdan-42", leaseWindowMs: 60000, preparation });
const home = await orbital.openWorkspace({ orbId: orb.orbId, orbCwd: "/home/user" });
const checkout = await home.exec({
  command: "git clone --depth 1 https://github.com/henriquebastos/hamsterdan.git",
  timeoutMs: 120000,
});
if (checkout.kind !== "exited" || checkout.exitCode !== 0) throw new Error("Checkout failed.");
```

The filename and checkout command are caller choices. Orbital does not automatically read `.agents/setup`.
Use ordinary workspace commands for dependency installation, updates, and services.
Orbital does not run readiness or resume hooks.

### 1b1 Project directories

The Node configuration selects `<cwd>/.orbital/settings.json` when present. Otherwise it selects `<config-directory>/<cwd-name>/settings.json`, where the configuration directory defaults to `~/.config/orbital`.
An empty settings object still selects that directory. Invalid selected settings fail rather than falling back. Repository and private project files never merge.

Both project locations use the same structure:

```text
settings.json
build
start
resume
...supporting files and directories
```

`configuration.preparation()` packages the selected directory as deterministic Bash source for the existing preparation API. No selected directory means no project preparation.
All files are copied into `/opt/orbital/project`, including settings, hidden files, and files excluded by Git ignore rules. This replaces any previous contents at that guest path. Symbolic links are preserved without copying their targets. Special files, such as sockets and FIFOs, are rejected.
Paths, file contents, link targets, and Unix permission modes contribute to cache identity. Modification timestamps do not. Keep credentials outside the project directory. Everything copied can become part of the image.
An optional executable `build` runs with `/opt/orbital/project` as its working directory. Its shebang selects the interpreter. A nonzero exit fails preparation. Without `build`, preparation copies files only.
`start` and `resume` are reserved optional executables and are copied but not run. There is no automatic `run` hook. Pod lifecycle dispatch remains future work.
The copied `settings.json` is the project source file, not a snapshot of global defaults, environment overrides, or resolved secrets.

## 1c Command

Use the installed `orbital-image` executable, or run it with `npx --package @henriquebastosnet/orbital orbital-image`.

```sh
orbital-image
orbital-image --preparation ./orbital-tools.sh
orbital-image --preparation ./orbital-tools.sh --refresh
```

The command reads shared settings and environment overrides. `--image` overrides the resolved image value for this invocation.
`--cache-directory` selects a different local cache. The default is `$XDG_CACHE_HOME/orbital/images` or `~/.cache/orbital/images`.
It prints the result as JSON on stdout and progress on stderr. Ctrl-C requests cancellation.
The source command `npm run image:build -- ...` uses this same implementation.
The CLI and Pi automatically use the selected project directory for new images and allocations. Project preparation applies over the resolved base, including an explicit image override. Existing orbs are not changed.
`--preparation FILE` replaces automatic project preparation with the supplied Bash source. The lower-level library API still accepts explicit source and does not discover project files itself.

## 1d Cache and lifetime contract

The owned recipe contains the runner, renewal module, pinned Node package, shared tools, users, paths, and permissions.
The recipe digest includes its declared commands and guest files. E2B builds and stores the result.

Preparation runs as `user` with passwordless sudo, in `/home/user`, with Bash error and pipeline checks.
The temporary seed has a 30-minute kill lease. The script has a 20-minute deadline.
The seed receives no Orbital renewal credential or user Orb identity.
Preparation does not accept user environment variables in this version.

Successful preparation and runtime checks must precede capture and cache publication.
Scripts must wait for installation work. Unmanaged background jobs are unsupported.
Changing external downloads does not change the script hash. Use explicit refresh when those inputs need an update.

An existing Orb stores creation intent separately from its allocated image reference.
An unchanged default request reuses that Orb after a base upgrade or cache refresh.
A changed script or image selector conflicts with the existing Orb. Use another Orb ID or recreate it deliberately.
Every Orb saves its creation intent. A sandbox without one is invalid metadata and is not reachable through Orbital.

Provider-only library construction still supports explicit-image creation without preparation.
Default-image creation and `prepare()` require the Images adapter.

## 1e Module boundaries

| Module | Responsibility |
| --- | --- |
| `lifecycle/creation.ts` | Validate image inputs and compare creation intent. |
| `lifecycle/index.ts` | Own Orb reuse. Resolve before image work, resolve again after preparation, and allocate only when no Orb exists. |
| `lifecycle/images/preparation.ts` | Order cache lookup, preparation, publication, and cleanup. |
| `e2b/image-registry.ts` | Resolve one reference, which may name a captured snapshot, a template alias, a tag, or a build, to one pinned build. |
| `e2b/images.ts` | Build bases, execute preparation seeds, and capture images. |
| `lifecycle/images/records.ts` | Store attempt and ready receipts atomically. |
| `e2b/recipe.ts` | Define the owned base from the bundled Pod files. |
| `cli/image.ts` | Read explicit inputs and call the shared preparation API. |
| `e2b/provider.ts` | Operate live Orbs and execute ordinary workspace jobs. |

Settings selects an optional image override. It does not build images or allocate Orbs.
The image manager does not decide what code a project needs or when that code changes.

## 1f Failures and recovery

Image failures report `not_started`, `failed`, or `uncertain`, with a stage and the available attempt evidence.
A known script failure publishes no image. A failed refresh preserves the previous ready image.
If final Orb allocation fails, the prepared image remains available.

The cache keeps ready records, the current attempt per cache key, the latest state of each attempt by ID, and script logs. Raw provider credentials are not stored in those records.
A ready record from another preparation contract version is not reused. The preparation key covers the base build, the script, and the contract version. Resources belong to the base.
Cache scope includes a fingerprint of the credential and the provider endpoint. Credential rotation starts a separate local cache scope.
Remote base discovery permits reuse across installations and credentials with access to the same E2B image.
Prepared-script images still use the local cache and are not discovered across hosts.

An interrupted attempt with a recorded artifact can recover after a read-only check confirms that the artifact is ready.
An uncertain attempt without a recorded artifact stops automatic preparation. Its generation name and any known seed ID remain available for investigation.
This version has no automatic reconciliation for that case. Preserve the attempt records when investigating it.
Unconfirmed seed deletion appears in the attempt record and the `seed_cleanup_unknown` progress event.

Requests within one image manager serialize matching cache work. Separate processes and hosts have no shared coordination guarantee.
Two hosts can both observe a missing image and submit builds. E2B exposes no documented atomic claim operation.
Orbital does not retry an uncertain submission. Later callers can reuse a visible ready build under the shared name.
The local cache is not a global image registry. Refresh retains old image generations rather than deleting artifacts that an Orb may still use.

Pi conservatively retains its requested allocation state after a creation failure, including preparation failure.
Use explicit `create_and_attach` to retry after a known failure. Uncertain image attempts still require the recovery checks above.

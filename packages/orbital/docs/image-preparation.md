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
  images: createE2BImages({ ...e2b, cacheDirectory: configuration.cacheDirectory }),
});
```

The library does not discover settings, scripts, repositories, or credentials.
The optional Node helper supplies the default cache directory from XDG_CACHE_HOME or the home directory.
The image adapter receives that directory explicitly.

## 1a API and sequence

| Operation | Result |
| --- | --- |
| `orbital.prepare()` | Establish the owned base without a user Orb. |
| `orbital.prepare({ preparation })` | Cache successful Bash preparation over that base. |
| `orbital.prepare({ preparation, refresh: true })` | Create a replacement preparation generation for future allocations. |
| `orbital.prepare({ refresh: true })` | Rebuild the owned base. |
| `orbital.create({ orbId, idleTimeoutMs, preparation? })` | Reuse a matching Orb or prepare an image and allocate a new Orb. |

All image requests accept an optional `image` override. It must identify an existing compatible E2B image.
An override is not a Docker image name. Refresh without preparation requires the owned base recipe.

`preparation` contains UTF-8 Bash source. It is not a path. Missing content and an empty string mean no preparation.
Nonempty content uses exact bytes for identity, including comments and whitespace.

Creation follows this order:

- Resolve the Orb ID and compare its saved creation intent and idle timeout.
- If the Orb exists and matches, wake it when needed and return it.
- Otherwise, resolve the base and look for a ready preparation image.
- On a miss, prepare a temporary seed, check the runtime, capture the image, and publish its receipt.
- Allocate the live Orb with its own identity, idle policy, and renewal credential.
- Return the Orb. The caller can now clone repositories and install project dependencies.

Preparation returns `{ reference, baseReference, cacheKey, reused }`.
These fields help callers inspect the cache. Normal creation does not require callers to manage image references.
The existing observer reports progress and preparation output.

### Composable operations

`createE2BImageEffects(config)` exposes provider operations without running the orchestration or creating cache records.
Lookup, submission, and waiting do not require a cache directory. Preparation seeds require one for their logs.

| Primitive | Contract |
| --- | --- |
| `orbitalRecipe()` | Read the bundled recipe and payload and return its content hash and build inputs. No network calls. |
| `hashBaseRecipe(templateJSON, resources, files)` | Hash explicit inputs without reading files or contacting E2B. File order and exact bytes matter. |
| `baseImageName(sourceHash)` | Derive the stable `orbital-base-{sourceHash}` name. |
| `effects.findBuild(name)` | Read remote state. Return a ready build, otherwise a pending or failed build. Only a missing alias returns `undefined`. |
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
const orb = await orbital.create({ orbId: "hamsterdan-42", idleTimeoutMs: 60000, preparation });
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
Pi does not select preparation by a project file convention. To use a CLI-prepared image in Pi, select its returned reference as the image override.

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
Legacy Orbs remain attachable. Creation can reuse one only with its matching explicit image and no preparation.

Provider-only library construction still supports explicit-image creation without preparation.
Default-image creation and `prepare()` require the Images adapter.

## 1e Module boundaries

| Module | Responsibility |
| --- | --- |
| `hangar/creation.ts` | Validate image inputs and compare creation intent. |
| `hangar/index.ts` | Resolve existing Orbs before image work and allocate after preparation. |
| `hangar/images/preparation.ts` | Order cache lookup, preparation, publication, and cleanup. |
| `e2b/images.ts` | Build bases, execute preparation seeds, and capture images. |
| `hangar/images/records.ts` | Store attempt and ready receipts atomically. |
| `hangar/images/recipe.ts` | Define the owned base from the bundled Pod files. |
| `cli/image.ts` | Read explicit inputs and call the shared preparation API. |
| `e2b/provider.ts` | Operate live Orbs and execute ordinary workspace jobs. |

Settings selects an optional image override. It does not build images or allocate Orbs.
The image manager does not decide what code a project needs or when that code changes.

## 1f Failures and recovery

Image failures report `not_started`, `failed`, or `uncertain`, with a stage and the available attempt evidence.
A known script failure publishes no image. A failed refresh preserves the previous ready image.
If final Orb allocation fails, the prepared image remains available.

The cache keeps current records, per-attempt history, and script logs. Raw provider credentials are not stored in those records.
Cache scope includes a fingerprint of the credential and the provider endpoint. Credential rotation starts a separate local cache scope.
Remote base discovery permits reuse across installations and credentials with access to the same E2B image.
Prepared-script images still use the local cache and are not discovered across hosts.

An interrupted attempt with a recorded artifact can recover after a read-only check confirms that the artifact is ready.
An uncertain attempt without a recorded artifact stops automatic preparation. Its generation name and any known seed ID remain available for investigation.
This version has no automatic reconciliation for that case. Preserve the attempt history when investigating it.
Unconfirmed seed deletion appears in the attempt record and the `seed_cleanup_unknown` progress event.

Requests within one image manager serialize matching cache work. Separate processes and hosts have no shared coordination guarantee.
Two hosts can both observe a missing image and submit builds. E2B exposes no documented atomic claim operation.
Orbital does not retry an uncertain submission. Later callers can reuse a visible ready build under the shared name.
The local cache is not a global image registry. Refresh retains old image generations rather than deleting artifacts that an Orb may still use.

Pi conservatively retains its requested allocation state after a creation failure, including preparation failure.
Use explicit `create_and_attach` to retry after a known failure. Uncertain image attempts still require the recovery checks above.

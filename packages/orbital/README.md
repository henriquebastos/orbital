# 1 Orbital

Orbital manages Orbs, workspace operations, images, and image preparation caches.
An Orb is a microVM with Orbital's Pod installed. The E2B adapter supplies the VM operations.

The npm package is not published yet. Build it from a checkout of this repository:

```sh
npm ci
npm run build
```

Run these commands from the repository root. Workspace callers can then import `@henriquebastosnet/orbital`.

Use Node 22.19.0 or later. This package has no Pi dependency.
For Pi, install [pi-orbital](https://github.com/henriquebastos/orbital/tree/main/packages/pi-orbital#readme).

## 1a Library use


The library does not depend on Pi or automatically read configuration files.
Callers supply a provider, an orb ID, and explicit operation parameters:

```ts
import { createOrbital, createE2BProvider, createE2BImages } from "@henriquebastosnet/orbital";
import { createOrbitalConfiguration } from "@henriquebastosnet/orbital/settings/node";

const configuration = createOrbitalConfiguration();
const e2b = configuration.e2b();
const orbital = createOrbital({
  provider: createE2BProvider(e2b),
  images: createE2BImages({ ...e2b, cacheDirectory: configuration.cacheDirectory, resources: configuration.resources }),
});
await orbital.create({ orbId: "my-workspace", leaseWindowMs: 60000, env: configuration.env(["E2B_API_KEY"]) });
const workspace = await orbital.openWorkspace({ orbId: "my-workspace", orbCwd: "/home/user" });
await workspace.exec({ command: "pwd" });
```

The Node configuration owns credential resolution, image overrides, and saved settings:

```ts
const settings = configuration.settings;
const { effective, diagnostics } = await settings.refresh();
if (diagnostics.length) throw new Error("Repair the reported Orbital settings.");
await orbital.create({ orbId: "my-workspace", ...effective,
  preparation: await configuration.preparation(), env: configuration.env(effective.forwardEnv) });
```

`configuration.e2b()` returns validated provider configuration or throws before remote work.
`configuration.image(override?)` resolves an explicit value, environment override, or saved value, in that order.
`configuration.resources()` resolves `cpuCount`, `memoryMB`, and `minFreeDiskMb` for an owned image build.
Pass those values or a resolver to `createE2BImages({ resources })`. Defaults are 2 CPUs, 1024 MiB RAM, and the provider's free-disk target.
Environment overrides are `ORBITAL_CPU_COUNT`, `ORBITAL_MEMORY_MB`, and `ORBITAL_MIN_FREE_DISK_MB`.
Resource changes select a different owned image for new Orbs. They do not resize existing Orbs or explicit image overrides.
`configuration.env(names)` resolves the selected host variable names and never saves their values.
It rejects missing variables and requires an explicitly selected, nonempty `E2B_API_KEY` for renewal.
`forwardEnv` stores names only. `ORBITAL_FORWARD_ENV` accepts a comma-separated list, including an empty list.
Settings precedence, from lowest to highest, is:

- Global: `~/.config/orbital/settings.json`.
- One project: `<cwd>/.orbital/settings.json` when present. Otherwise `~/.config/orbital/<project-directory-name>/settings.json`.
- Environment overrides.

An absolute `XDG_CONFIG_HOME` replaces `~/.config`. Each defined list fully replaces the previous list.
`cwd` defaults to the process startup directory and can be supplied to `createOrbitalConfiguration()`. Its final directory name selects the private project file. No ancestor directories are searched.
Directories with the same name share a private project directory. For a checkout named `backend`, use `~/.config/orbital/backend/settings.json`.
The selected project directory supplies all project settings and files. Repository and private directories never merge. An empty repository settings object still selects the repository directory. Invalid selected settings fail without fallback.
`configuration.preparation()` reads every file in the selected directory and returns deterministic Bash preparation, or `undefined` when no project is selected. Pass it to `orbital.prepare()` or `orbital.create()`.
The CLI and Pi use project preparation automatically. The directory is copied to `/opt/orbital/project`, including `settings.json`, hidden files, and ignored files. Symbolic links are preserved without following their targets.
An executable `build` runs there through its shebang. Optional `start` and `resume` executables are copied but are not invoked yet. No `run` hook is defined.
Every file path, content, and Unix permission mode contributes to image identity. Keep credentials outside the project directory.
The default list is empty. Include `E2B_API_KEY` explicitly before creating an Orb.
`settings.set(key, value)` and `settings.unset(key)` edit global saved values after refresh. They do not change project files. Unsetting does not remove project or environment overrides.
Credentials are never included in saved settings or settings snapshots.
The settings adapter does not perform Orbital operations. A CLI or another agent integration can reuse either interface independently.


### 1a1 Instance environment

Pass `env` to `orbital.create()` to set the instance environment. E2B supplies it to commands after creation and reconnect.
The runner passes its complete environment to commands and their descendants. No variable names are reserved or filtered.
The provider requires an explicit, nonempty `env.E2B_API_KEY` for renewal. It never copies its own API key into the instance.
This checks presence, not validity. An invalid renewal key prevents ordinary commands from starting. The lifecycle checks for the key before it looks up or reuses an Orb.

The environment is separate from the image recipe, image cache, Orb metadata, and creation intent.
Reusing an existing Orb keeps its original environment. A later `create()` call does not compare or replace those values.
`workspace.exec({ command, env })` applies command-specific overrides without changing the instance environment.
Those explicit overrides remain in the command's job request. Instance variables are not copied into job requests.
Commands can read and print inherited secrets. Orbital does not mask their output.

## 1b Images

The first creation without an image override prepares the Orbital base in the caller's E2B account.
Later creations reuse that image. Run `orbital-image` to prepare it explicitly.
The package includes the build recipe and the Pod payload. Local Docker is not required.

```sh
npm run image:build
```

The base pins Node 22.15.0 and E2B SDK 2.51.0. It includes Bash, Git, GitHub CLI (`gh`), ripgrep, fd, and the command runner.
Cache expensive tools with optional Bash preparation. Check out repositories through workspace commands after Orb creation.
See [image preparation](docs/image-preparation.md) for the API and cache lifecycle, and [the base image](docs/base-image.md) for runtime details.

## 1c Code ownership

| Module | Owns |
| --- | --- |
| `src/lifecycle/` | Orb creation and management, image preparation, cache identity, and local image records. |
| `src/orb.ts` | Orb identity, state, creation intent, and demand decisions. |
| `src/workspace.ts` | Commands and file operations in a selected Orb directory. |
| `src/configuration/` | Shared settings, precedence, validation, and local settings storage. |
| `src/e2b/` | E2B adapters for live Orbs, image identity, the base recipe, and image operations. |
| `src/provider.ts` | The provider contract for external Orb operations. Its `create` only allocates. The lifecycle owns reuse. |
| `src/operations.ts` | Progress, cancellation, and operation errors. |
| `src/cli/image.ts` | The image preparation command. |

The build stages Pod source and its guest dependency lockfile into `guest/pod`.
Installed Orbital archives contain those files and do not require a sibling Pod checkout.
See [verification](https://github.com/henriquebastos/orbital/blob/main/docs/verification.md) for the shared test commands.

Available under the [MIT license](LICENSE).

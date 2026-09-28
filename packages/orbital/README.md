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
  images: createE2BImages({ ...e2b, cacheDirectory: configuration.cacheDirectory }),
});
await orbital.create({ orbId: "my-workspace", idleTimeoutMs: 60000 });
const workspace = await orbital.openWorkspace({ orbId: "my-workspace", orbCwd: "/home/user" });
await workspace.exec({ command: "pwd" });
```

The Node configuration owns credential resolution, image overrides, and saved settings:

```ts
const settings = configuration.settings;
const { effective, diagnostics } = await settings.refresh();
if (diagnostics.length) throw new Error("Repair the reported Orbital settings.");
await orbital.create({ orbId: "my-workspace", ...effective });
```

`configuration.e2b()` returns validated provider configuration or throws before remote work.
`configuration.image(override?)` resolves an explicit value, environment override, or saved value, in that order.
`settings.set(key, value)` and `settings.unset(key)` edit saved values after refresh. Unsetting does not remove environment overrides.
Credentials are never included in saved settings or settings snapshots.
The settings adapter does not perform Orbital operations. A CLI or another agent integration can reuse either interface independently.


## 1b Images

The first creation without an image override prepares the Orbital base in the caller's E2B account.
Later creations reuse that image. Run `orbital-image` to prepare it explicitly.
The package includes the build recipe and the Pod payload. Local Docker is not required.

```sh
npm run image:build
```

The base pins Node 22.15.0 and E2B SDK 2.51.0. It includes Bash, Git, ripgrep, fd, and the command runner.
Cache expensive tools with optional Bash preparation. Check out repositories through workspace commands after Orb creation.
See [image preparation](docs/image-preparation.md) for the API and cache lifecycle, and [the base image](docs/base-image.md) for runtime details.

## 1c Code ownership

| Module | Owns |
| --- | --- |
| `src/hangar/` | Orb creation and management, image preparation, cache identity, and local image records. |
| `src/orb.ts` | Orb identity, state, creation intent, and demand decisions. |
| `src/workspace.ts` | Commands and file operations in a selected Orb directory. |
| `src/configuration/` | Shared settings, precedence, validation, and local settings storage. |
| `src/e2b/` | E2B adapters for live Orbs and image operations. |
| `src/provider.ts` | The provider contract for external Orb operations. |
| `src/operations.ts` | Progress, cancellation, and operation errors. |
| `src/cli/image.ts` | The image preparation command. |

The build copies Pod source and its guest dependency lockfile into `guest/pod`.
Installed Orbital archives contain those files and do not require a sibling Pod checkout.
See [verification](https://github.com/henriquebastos/orbital/blob/main/docs/verification.md) for the shared test commands.

Available under the [MIT license](LICENSE).

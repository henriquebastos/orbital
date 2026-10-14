# 1 Pi Orbital

This package connects Pi workspace tools to Orbital. Pi reasoning, skills, and session files stay on the host.
Each Pi session supplies its Orb ID and saves its route and remote directory in that session.

## 1a Install

Use Node 22.19.0 or later and Pi. This version is tested with `@earendil-works/pi-coding-agent@0.87.0`.
The npm packages are not published yet. From a local checkout, run these commands at the repository root:

```sh
npm ci
npm run build
pi install "$PWD/packages/pi-orbital"
```

Pi loads this package's TypeScript extension. Build Orbital first because the extension imports its compiled public exports.
The workspace supplies the Orbital dependency and its bundled Pod files.
Local installation retains the package directory. Keep the checkout and its dependencies in place.
Do not install the repository root as a Pi package.

Set `E2B_API_KEY` in the environment that starts Pi. Local tools work without that key.
The first remote allocation builds the Orbital base in your E2B account when its cache has no ready image.
Later allocations reuse that image. E2B runs the build. Local Docker is not required.
An optional `ORBITAL_IMAGE` or saved `image` selects an existing compatible image.
See [image preparation](https://github.com/henriquebastos/orbital/blob/main/packages/orbital/docs/image-preparation.md) for the API and cache contract.

## 1b Work in an Orb


New sessions use local tools by default. Use these commands to select remote routing:

```text
/orb on
/orb off
/orb status
```

`/orb on` selects remote routing. The first workspace tool creates or wakes the session orb.
`/orb off` restores local tools and retains the orb, its files, and its selected directory.
Turning Orbital on again reuses that orb. Commands and services already running in the orb continue after `/orb off`.
Slash-command route changes are rejected during an agent turn or a foreground shell operation.
The agent can use `orbital` to change routes between workspace operations during its turn.
The tool runs sequentially and rejects route changes while another tracked operation is active.
Route and status results include the active working directory and the retained remote directory.

The `orbital` tool supports routing, settings, and explicit resource actions:

| Action | Inputs | Behavior |
| --- | --- | --- |
| `set_route` | `route`: `local` or `remote` | Select routing for subsequent workspace tools and user shell commands. Retain the orb and its directory. |
| `status` | None | Show route, allocation, directories, activity, and readiness without contacting the provider. |
| `settings_get` | None | Show cached settings, their sources, and diagnostics. |
| `settings_set` | `name`, `value` | Validate and save a global setting. |
| `settings_unset` | `name` | Remove a global setting without removing project or environment overrides. |
| `settings_refresh` | None | Reload settings from disk. |
| `create_and_attach` | Optional `orbCwd` | Create or find this session's orb and validate its directory. The default is `/home/user`. |
| `select_directory` | `orbCwd` | Validate, select, and save a remote directory. An invalid selection preserves the previous directory. |
| `inspect` | None | Read provider state without waking the orb. |
| `url` | `port` | Return the public native E2B URL. This does not start a listener. |
| `delete` | None | Delete this session's orb explicitly. |

While remote routing is on, `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls` operate inside the orb.
Pi user shell commands use the same route. Remote errors never cause a fallback to the host.
A missing retained orb requires explicit recovery. Ordinary tool demand never creates a replacement.
A shell command's `cd` does not change the selected directory.

Ordinary Bash commands renew the orb while they run, even after Pi exits.
An optional `timeout` uses seconds and stops the managed processes remotely.
Use `mode: "background"` for a service. The service survives Pi exit and does not prevent automatic sleep.
The runner keeps capturing the service's output to the job files after the launching shell exits.
Use distinct ports for distinct services. The application controls any authentication it needs.

Resume the same Pi session file to restore its orb and directory:

```sh
pi --session /absolute/path/to/session.jsonl
```

The `orbital_skill` tool reads a named host skill and copies a named asset into the orb.
It confines host access to configured skill directories. Workspace tools do not fall back to host files.

### 1b1 Instance environment

Choose host variable names with `forwardEnv` or `ORBITAL_FORWARD_ENV`. Orbital reads their values from Pi's environment at Orb creation.
No variables are forwarded by default. Include `E2B_API_KEY` explicitly because the runner requires it for renewal.
The host also needs that key to access E2B. Orbital never adds it to the instance automatically.
Values belong to the instance, not the image. Orbital does not include them in settings, session bindings, or Orb metadata.

With `E2B_API_KEY` already exported, load a GitHub token and select both names:

```sh
export GH_TOKEN="$(gh auth token)"
export ORBITAL_FORWARD_ENV=GH_TOKEN,E2B_API_KEY
pi
```

The environment selector is a comma-separated list. Orbital trims surrounding whitespace and removes duplicate names.
A selected variable must exist in Pi's environment. Empty values are passed unchanged, except that the required renewal key must be nonempty.
Missing variables prevent creation. Diagnostics show names, not values.
The earlier `ORBITAL_ENV` JSON-map setting is no longer supported.

Alternatively, save a list of names in global settings, a private project file, or `<Pi startup directory>/.orbital/settings.json`:

```json
{"forwardEnv": ["GH_TOKEN", "E2B_API_KEY"]}
```

Precedence is global settings, then one selected project, then the environment selector. Repository settings select the project when present; otherwise private settings do. Each defined list replaces the previous list completely.
An absent setting inherits the previous list. `[]` or an empty environment selector forwards nothing and therefore cannot supply the renewal key.
There are no list-composition rules or ancestor-directory searches. Review a project's forwarding list before creating its Orb.

The default image includes `gh`. After selecting remote routing, run these commands inside the Orb:

```sh
gh auth setup-git
gh repo clone https://github.com/OWNER/REPO.git
```

E2B supplies the instance environment to the runner. Commands and their descendants inherit it without loading a file.
This includes both agent Bash tools and Pi user shell commands. Background services keep their inherited values.
The library's `workspace.exec({ command, env })` can override variables for one command without changing the instance environment.

Existing Orbs retain their original environment. Changing `forwardEnv` affects new allocations, not reattachment or resume.
Restart Pi after changing its parent-shell environment. Existing Orbs also retain their runner version.
Custom images must include the updated runner and `gh` to support this workflow.
Services already running in the image, or launched independently by a service manager, do not automatically inherit these values.
Commands can read or print every inherited variable, including `E2B_API_KEY`. Orbital does not mask command output.

### 1b2 Settings

Orbital stores shared defaults in `$XDG_CONFIG_HOME/orbital/settings.json`.
When XDG_CONFIG_HOME is absent, it uses `~/.config/orbital/settings.json`.
Private project settings live in `<startup-directory-name>/settings.json` below the global configuration directory. For a checkout named `backend`, use `~/.config/orbital/backend/settings.json`.
Repository settings come from `.orbital/settings.json` in Pi's startup directory. If that file exists, the entire repository project directory wins, including when its settings object is empty. Otherwise, Pi selects the private project directory. They never merge, and an invalid selected file does not trigger fallback.
Selected project values override global defaults. Environment overrides have the highest priority. Directories with the same name share a private project directory.
For a new allocation, Pi copies all selected project files into `/opt/orbital/project` through image preparation. An executable `build` runs in that directory. Its shebang selects the interpreter. An absent `build` means copy-only preparation.
Files named `start` and `resume` are reserved optional executables but are not invoked yet. There is no `run` hook. Hidden files and ignored files are included; symbolic links are preserved rather than followed. Every input file contributes to image identity, so keep secrets outside this directory.
The project directory is packaged only for a new allocation. Allocation uses the refreshed project settings. Existing orbs are not updated, rebuilt, or initialized again.
Pi preferences live beside the global settings file in `pi.json`.
Settings commands edit global defaults only. Edit project files directly, then use `/orb settings refresh`. The settings report shows both project paths and the source of each effective value.

| Setting | Default | Environment override | Applies to |
| --- | --- | --- | --- |
| `image` | Unset: prepare Orbital base | `ORBITAL_IMAGE` | Next allocation |
| `leaseWindowMs` | `60000` | `ORBITAL_LEASE_WINDOW_MS` | Next allocation |
| `cpuCount` | `2` | `ORBITAL_CPU_COUNT` | Owned image for a new orb |
| `memoryMB` | `1024` | `ORBITAL_MEMORY_MB` | Owned image for a new orb |
| `minFreeDiskMb` | E2B team default | `ORBITAL_MIN_FREE_DISK_MB` | Owned image for a new orb |
| `forwardEnv` | `[]` | `ORBITAL_FORWARD_ENV` | Next allocation |
| `autoOn` | `false` | `ORBITAL_AUTO_ON` | New sessions |
| `skillRoots` | `[]` | `ORBITAL_SKILL_ROOTS` | Next skill read |

Environment overrides do not change saved values. Existing orbs retain their image and timeout.
Auto-on seeds new sessions. A saved session route takes precedence, including a saved off state.
The E2B key stays in `E2B_API_KEY` and is never saved in these files.

Use Pi commands to inspect or change settings:

```text
/orb settings
/orb settings set image my-template
/orb settings set leaseWindowMs 90000
/orb settings set cpuCount 8
/orb settings set memoryMB 8192
/orb settings set minFreeDiskMb 20480
/orb settings set forwardEnv ["GH_TOKEN","E2B_API_KEY"]
/orb settings set autoOn true
/orb settings set skillRoots ["/absolute/path/to/skills"]
/orb settings unset image
/orb settings refresh
```

The output shows global values, project values, effective values, their sources, and validation problems.
`set` and `unset` edit global settings only. Edit project settings in their file, then run `/orb settings refresh`.
Use `unset` with any setting name to remove its global value.
Settings changes do not switch routes or perform provider operations.
The agent uses the same settings implementation through the `orbital` tool, regardless of the current route.
Tool values use native JSON types: strings for image references, numbers for timeouts and resources, booleans for `autoOn`, and string arrays for environment names and skill roots.
CPU count must be at least 1. Memory must be at least 128 MiB. Both must be integers.
`minFreeDiskMb` is a nonnegative integer target for free space after the base build, not total disk capacity. Growth is best-effort.
Resource changes affect new orbs built from the owned base. They never resize an attached orb or an explicit image.
Status reports `configuredResources`; `inspect` reports actual CPU and memory from E2B. Measure disk usage inside the orb.
E2B enforces account limits. Orbital does not claim a fixed catalog of available machines.

```jsonl
{"action":"set_route","route":"remote"}
{"action":"settings_set","name":"forwardEnv","value":["GH_TOKEN","E2B_API_KEY"]}
{"action":"settings_get"}
```

Each line is a separate tool call. Supply variable names in `forwardEnv`, never secret values.
Invalid tool actions fail without saving the rejected value.
External file edits take effect after `refresh` or restart. Parent-shell environment changes require a restart.
Booleans accept `true` or `false`. The timeout accepts a decimal integer of at least 3 milliseconds.
Skill roots are absolute paths. Environment roots use the platform path delimiter, such as `:` on macOS and Linux.
An empty `ORBITAL_SKILL_ROOTS` supplies no extra roots. Pi's own skill directory and `~/.agents/skills` remain available.

Malformed files cannot be edited by these commands. Repair the reported file, then refresh.
Writes are atomic and detect already-changed files. Simultaneous edits from separate processes can still conflict.
Status and settings return structured custom messages in Pi JSON and RPC modes.
In text print mode, these reports use stderr, which Pi reserves for extension output.


## 1c Limits


The managed process scope is the command's process group and its ordinary descendants.
Processes that deliberately create another session or process group can escape that scope.
Explicit cancellation and timeout report uncertainty if termination cannot be confirmed.
Transport loss does not cancel or replay a command. Full output remains in the orb.

The default lease window is 60 seconds. Set `ORBITAL_LEASE_WINDOW_MS` to change the window for new orbs.
Each existing orb keeps its original timeout for command renewal.
Native E2B HTTP wake can impose a five-minute lease. HTTP connections can need reconnection after sleep.
Background process existence does not protect HTTP work from sleep.

The orb receives the shared E2B key for renewal. Its owner has passwordless sudo and can access that key.
Commands inherit the key. Instance values are not included in Orbital metadata or session bindings.
Explicit command overrides are stored in the job request. Commands can also write inherited secrets into files or output.

This version supports one orb per Pi session, branch restoration, and restart of a saved session.
Concurrent first demand in one process shares an allocation attempt. Creation across multiple Pi processes has no coordination guarantee.
Arbitrary host subprocesses from other extensions and durable host workflows are outside this version.
The Orbital dependency provides `orbital-image` for image preparation. There is no general workspace CLI in this version.


## 1d Development

Run shared checks from the repository root.
See [verification](https://github.com/henriquebastos/orbital/blob/main/docs/verification.md) and [releases](https://github.com/henriquebastos/orbital/blob/main/docs/releasing.md).
This package depends on Orbital's public exports. Pi preferences, tool routing, and session conventions stay in this package.

Available under the [MIT license](LICENSE).

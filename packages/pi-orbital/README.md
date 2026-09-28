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
Route changes are rejected during an agent turn or a foreground shell operation.

The `orbital` tool also supports explicit resource actions:

| Action | Inputs | Behavior |
| --- | --- | --- |
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
Use distinct ports for distinct services. The application controls any authentication it needs.

Resume the same Pi session file to restore its orb and directory:

```sh
pi --session /absolute/path/to/session.jsonl
```

The `orbital_skill` tool reads a named host skill and copies a named asset into the orb.
It confines host access to configured skill directories. Workspace tools do not fall back to host files.

### 1b1 Settings

Orbital stores shared defaults in `$XDG_CONFIG_HOME/orbital/settings.json`.
When XDG_CONFIG_HOME is absent, it uses `~/.config/orbital/settings.json`.
Pi preferences live beside that file in `pi.json`.

| Setting | Default | Environment override | Applies to |
| --- | --- | --- | --- |
| `image` | Unset: prepare Orbital base | `ORBITAL_IMAGE` | Next allocation |
| `idleTimeoutMs` | `60000` | `ORBITAL_IDLE_TIMEOUT_MS` | Next allocation |
| `autoOn` | `false` | `ORBITAL_AUTO_ON` | New sessions |
| `skillRoots` | `[]` | `ORBITAL_SKILL_ROOTS` | Next skill read |

Environment overrides do not change saved values. Existing orbs retain their image and timeout.
Auto-on seeds new sessions. A saved session route takes precedence, including a saved off state.
The E2B key stays in `E2B_API_KEY` and is never saved in these files.

Use Pi commands to inspect or change settings:

```text
/orb settings
/orb settings set image my-template
/orb settings set idleTimeoutMs 90000
/orb settings set autoOn true
/orb settings set skillRoots ["/absolute/path/to/skills"]
/orb settings unset image
/orb settings refresh
```

The output shows saved values, effective values, their sources, and validation problems.
Use `unset` with any setting name to remove its saved value.
Settings changes do not switch routes or perform provider operations.
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

The default idle timeout is 60 seconds. Set `ORBITAL_IDLE_TIMEOUT_MS` to change the timeout for new orbs.
Each existing orb keeps its original timeout for command renewal.
Native E2B HTTP wake can impose a five-minute lease. HTTP connections can need reconnection after sleep.
Background process existence does not protect HTTP work from sleep.

The orb receives the shared E2B key for renewal. Its owner has passwordless sudo and can access that key.
The runner omits the key from command environments. Session records and receipts do not store it.

This version supports one orb per Pi session, branch restoration, and restart of a saved session.
Concurrent first demand in one process shares an allocation attempt. Creation across multiple Pi processes has no coordination guarantee.
Arbitrary host subprocesses from other extensions and durable host workflows are outside this version.
The Orbital dependency provides `orbital-image` for image preparation. There is no general workspace CLI in this version.


## 1d Development

Run shared checks from the repository root.
See [verification](https://github.com/henriquebastos/orbital/blob/main/docs/verification.md) and [releases](https://github.com/henriquebastos/orbital/blob/main/docs/releasing.md).
This package depends on Orbital's public exports. Pi preferences, tool routing, and session conventions stay in this package.

Available under the [MIT license](LICENSE).

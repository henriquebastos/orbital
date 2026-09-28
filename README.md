# 1 Orbital

Orbital manages remote workspaces. An Orb is a microVM with Orbital's Pod installed.
The Pi extension routes workspace tools to an Orb while reasoning and session files stay on the host.

## 1a Packages

| Package | Purpose |
| --- | --- |
| [orbital](packages/orbital/README.md) | Orb and image management, workspace operations, shared settings, and the `orbital-image` command. |
| [pod](packages/pod/README.md) | Private guest runtime. Orbital bundles its files into the image payload. |
| [pi-orbital](packages/pi-orbital/README.md) | Pi tool routing, session binding, and Pi preferences. Depends on Orbital. |

The npm packages are not published yet. Install the Pi extension from a local checkout:

```sh
git clone https://github.com/henriquebastos/orbital.git
cd orbital
npm ci
npm run build
pi install "$PWD/packages/pi-orbital"
```

Use Node 22.19.0 or later and Pi. Set `E2B_API_KEY` in the environment that starts Pi to enable remote operations.
See each package's guide for usage and configuration.

## 1b Development

Use Node 22.19.0 or later. Run workspace commands from the repository root:

```sh
npm ci
npm run build
npm run test:local
npm run test:install
```

The build assembles Pod's guest payload, compiles Orbital, then compiles Pi Orbital.
The root TypeScript configuration checks package source, package tests, and shared test infrastructure.
Each public package has a source-only build configuration.

Package-specific tests and documentation live beside their package.
Root tests cover installations, cross-package hosted behavior, and verification evidence.
See [verification](docs/verification.md) for hosted checks and [releases](docs/releasing.md) for coordinated publication.
See [development environment](docs/development.md) for direnv, CI, and remote VM setup.

## 1c License

Available under the [MIT license](LICENSE).

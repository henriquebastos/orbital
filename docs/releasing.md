# 1 Release Orbital

The workspace publishes two packages at the same version: `@henriquebastosnet/orbital` and `@henriquebastosnet/pi-orbital`.
The root workspace and Pod package are private. The source repository is `https://github.com/henriquebastos/orbital`.
Publishing a stable GitHub Release starts the **Publish to npm** workflow for its tag.
Draft releases, prereleases, and tag pushes alone do not publish packages.

## 1a Prepare a version

Update the root manifest and all three workspace manifests to the release version.
Set Pi Orbital's `@henriquebastosnet/orbital` dependency to that exact version.
Run `npm install --package-lock-only` to update the workspace lockfile.
Pod's separate runtime lockfile changes only when guest dependencies change.

Install Node 22.19.0 or later, `expect`, and `ripgrep` on a POSIX host.
Set `E2B_API_KEY`, then build a current test image:

```sh
npm ci
npm run image:build
```

Set `ORBITAL_IMAGE` to the returned `reference`. Run the release checks:

```sh
npm run test:preparation
npm run test:acceptance
npm publish --workspace @henriquebastosnet/orbital --dry-run --access public
npm publish --workspace @henriquebastosnet/pi-orbital --dry-run --access public
```

Require passed receipts and verified hosted cleanup. Inspect both archives before publication.
Orbital must contain compiled exports and `guest/pod` files. Pi Orbital must contain its extension entry point and Orbital dependency.
A dry run does not check publish authentication or reserve package names.

Commit the checked release state and create its version tag, such as `v0.1.0`.
Check that the worktree is clean and the tag points to the tested commit before pushing it.
Use ordinary pushes. Resolve history conflicts before continuing.

## 1b First publication

Each package must exist on npm before you can configure its trusted publisher.
Bootstrap the first version once with local npm authentication. Later releases use GitHub OIDC.
Confirm GitHub access and npm ownership for both scoped package names.
An anonymous 404 response does not prove that a name is available.
Sign in with `npm login`, confirm `npm whoami`, and publish from the tagged checkout.
Complete npm's authentication prompts.

```sh
npm publish --workspace @henriquebastosnet/orbital --access public
npm view @henriquebastosnet/orbital@0.1.0 version
npm publish --workspace @henriquebastosnet/pi-orbital --access public
npm view @henriquebastosnet/pi-orbital@0.1.0 version
```

Publish Orbital first so the Pi package's dependency is available.
Use the selected release version in the verification commands.
The private Pod package ships inside Orbital's guest payload and needs no npm publication.

## 1c Later releases with OIDC

Configure each public package's trusted publisher for GitHub owner `henriquebastos`, repository `orbital`, and workflow `publish.yml`.
Leave the optional environment name empty unless the workflow uses a matching environment.
Allow direct `npm publish` for that trusted publisher.

Add the `E2B_API_KEY` Actions secret and set the `ORBITAL_IMAGE` repository variable to a current compatible image.
Create a GitHub Release for the checked version tag, then publish the release.
The tag must include `.github/workflows/publish.yml` and match all workspace package versions.

The workflow checks coordinated versions, tests installed image preparation, runs acceptance, and saves verification evidence.
It publishes Orbital, then Pi Orbital.
If publication stops after Orbital succeeds, rerun the failed workflow after fixing the cause.
The workflow skips an existing version only when npm records the same Git commit.
An existing version from another or unknown commit stops publication.

The workflow uses Node 22.19.0, npm 11.5.1, and OIDC without an npm token.
See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for account setup.
The [npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites) explain the first-publication requirement.

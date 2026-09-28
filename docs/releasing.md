# 1 Release Orbital

The workspace publishes two packages at the same version: `@henriquebastosnet/orbital` and `@henriquebastosnet/pi-orbital`.
The root workspace and Pod package are private. The source repository is `https://github.com/henriquebastos/orbital`.

## 1a Prepare a version

Update the root manifest and all three workspace manifests to the release version.
Set Pi Orbital's `@henriquebastosnet/orbital` dependency to that exact version.
Run `npm install --package-lock-only` to update the workspace lockfile.
Pod's separate runtime lockfile changes only when guest dependencies change.

Install Node 22.19.0 or later and `expect` on a POSIX host.
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
Run **Publish to npm** with the existing version tag as its `tag` input.
The workflow must be present on the default branch.

The workflow checks coordinated versions, tests installed image preparation, runs acceptance, and saves verification evidence.
It publishes Orbital, then Pi Orbital. Push events do not publish packages.
If publication stops after Orbital succeeds, inspect npm before retrying. npm does not permit republishing an existing version.

The workflow uses Node 22.19.0, npm 11.5.1, and OIDC without an npm token.
See [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/) for account setup.

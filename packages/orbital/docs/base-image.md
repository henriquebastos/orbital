# 1 Orbital E2B image

Set `E2B_API_KEY`, then run `npm run image:build` from this repository, or `orbital-image` from an installed package.
The command uses the same preparation path as automatic creation and prints a JSON image receipt.
Add `--preparation FILE` to cache Bash preparation, or `--refresh` to build a new generation.
For npm scripts, place these arguments after `--`.

The base identity includes the recipe commands, resource profile, runner, renewal module, and pinned package manifests.
The build checks Node 22.15.0, the renewal module import, passwordless sudo, and workspace tools.
The package ships the recipe and guest files. No source checkout or local Docker is required for the installed command.
See [the preparation contract](image-preparation.md) for cache and refresh behavior.

`idleTimeoutMs` is an integer of at least 3 milliseconds. It sets the sandbox's initial automatic pause timeout and the guest runner's renewal window for ordinary commands. The runner renews before one third of that window passes. Background services do not renew the sandbox.

E2B gives an automatically resumed sandbox at least five minutes before its next timeout. Orbital does not shorten that provider lease after HTTP wake. An exact idle delay after native wake is not guaranteed.

The image stores no provider credential. Sandbox creation passes `E2B_API_KEY` to the guest runner for direct renewal. The runner removes that variable from Bash child environments. The user owns the sandbox and has passwordless sudo, so the key is accessible inside the orb under the accepted first-version policy.

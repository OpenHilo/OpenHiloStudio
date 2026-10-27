# Pinned OpenHilo dependencies

These eleven archives contain the compiler, runtime, contracts and executors from [OpenHilo](https://github.com/OpenHilo/OpenHilo). They install through the root lockfile; no adjacent checkout, private application, model credentials or npm publication is required.

## Source provenance

`manifest.json` records:

- `sourceRepository` and `sourceCommit`: the exact upstream revision used for the build.
- `patches`: any explicit, hash-checked changes applied to that revision (currently empty).
- `archiveCommit`: the same upstream revision, identifying the base source; apply the listed patches before building.
- `packages`: archive SHA-256 values, package versions and source directories. The npm lockfile also records each archive's integrity.

Core implementation remains maintained in OpenHilo. This pin uses the committed OpenHilo implementation without local patches. The dependency archives retain their own MIT copyright and redistribution notices.

## Rebuild from public source

With Node 22 or 24, npm, Git and Python 3, run:

```sh
npm run check:core-source
```

The command creates a temporary directory and a fresh home, clones the public repository anonymously, checks out the pinned commit, verifies any declared patches, installs locked dependencies, builds and runs the core offline tests, then packs all eleven dependencies. It compares every packaged file byte and permission with the bundled archives. Declared CLI executable bits are normalized before packing; archive timestamps and compression metadata are not compared. Logs and `result.json` remain in the printed temporary directory. Installed or bundled packages are never replaced.

The pinned commit must be available on the remote before this public-source check can run. A local-only dependency update can be tested from its checkout and bundled archives before it is pushed. Network access is needed for public Git and dependency downloads. No private checkout or account configuration is used.

## Upgrade procedure

Select and review an upstream version. Once it includes the patches, use that public commit and remove those patches. Otherwise keep every necessary change explicit and hash-checked. Build, test and pack the selected version; replace the eleven archives and update the manifest, lockfile and generated notices. Run the Studio suites, independent consumers and public-source reproduction before activating a separate release. Do not edit installed packages in place or downgrade to omit local fixes.

Historical identifiers such as `.itt.impl.json`, `@openhilo/itt-contracts`, `intentorch.deployment`, executor identities and persisted keys remain compatibility contracts. Product wording uses OpenHilo; saved-state identity changes require a separate migration.

# Pinned OpenHilo dependencies

These eleven archives contain the compiler, runtime, contracts and executors from [OpenHilo](https://github.com/OpenHilo/OpenHilo). They install through the root lockfile; no adjacent checkout, private application, model credentials or npm publication is required.

## Source provenance

`manifest.json` records:

- `sourceRepository` and `sourceCommit`: the exact publicly available upstream revision used for the build.
- `patches`: currently empty. Cancellation, nested recovery and memory-observer fixes are included in the pinned upstream commit.
- `archiveCommit`: the same upstream revision, identifying the source of all bundled archives.
- `packages`: archive SHA-256 values, package versions and source directories. The npm lockfile also records each archive's integrity.

Core implementation remains maintained in OpenHilo. Studio builds these dependencies directly from the declared commit without carrying a separate runtime patch set. The dependency archives retain their own MIT copyright and redistribution notices.

## Rebuild from public source

With Node 22 or 24, npm, Git and Python 3, run:

```sh
npm run check:core-source
```

The command creates a temporary directory and a fresh home, clones the public repository anonymously, checks out the pinned commit, verifies any declared patches (none for the current pin), installs locked dependencies, builds and runs the core offline tests, then packs all eleven dependencies. It compares every packaged file byte and permission with the bundled archives. Declared CLI executable bits are normalized before packing; archive timestamps and compression metadata are not compared. Logs and `result.json` remain in the printed temporary directory. Installed or bundled packages are never replaced.

Network access is needed for public Git and dependency downloads. No private checkout or account configuration is used.

## Upgrade procedure

Select and review an upstream version. Once it includes the patches, use that public commit and remove those patches. Otherwise keep every necessary change explicit and hash-checked. Build, test and pack the selected version; replace the eleven archives and update the manifest, lockfile and generated notices. Run the Studio suites, independent consumers and public-source reproduction before activating a separate release. Do not edit installed packages in place or downgrade to omit local fixes.

Historical identifiers such as `.itt.impl.json`, `@openhilo/itt-contracts`, `intentorch.deployment`, executor identities and persisted keys remain compatibility contracts. Product wording uses OpenHilo; saved-state identity changes require a separate migration.

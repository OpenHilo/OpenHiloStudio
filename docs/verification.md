# Testing and supported environments

OpenHilo Studio supports Node 22 and 24 on macOS and Linux. The [Studio verification workflow](https://github.com/OpenHilo/OpenHiloStudio/actions/workflows/ci.yml) runs the full matrix and checks that the bundled OpenHilo dependencies can be reproduced from public source. Open a workflow run to see the result for a particular commit.

## Run the checks

Start with the build and test commands in [Contributing](../CONTRIBUTING.md). Tests use temporary data directories and scripted providers; you do not need model credentials or an existing Studio deployment.

| Command | What it checks |
| --- | --- |
| `npm test` | Builds packages, then runs backend, integration and frontend suites |
| `npm run test:types` | Public server and composition TypeScript contracts |
| `npm run check:boundaries` | Workspace dependency boundaries and public entry points |
| `npm run check:packages -- --pack` | Package metadata and the contents of actual npm archives |
| `npm run check:consumers` | Fresh installations of Generic, Codex, SDK and routed compositions using those archives |
| `npm run check:core-source` | Anonymous rebuild of the pinned OpenHilo source and patches, comparing packaged file bytes and permissions |
| `npm run check:notices` | Dependency license inventories and redistribution notices |
| `npm run check:export` | Distributable source files and pinned archive integrity |
| `npm run check:privacy` | Recognizable secrets, personal paths, runtime data and unsafe archive members |

Consumer and source-reproduction checks need network access to download public dependencies. They do not call a model provider. The offline test guard is a regression aid, not an operating-system sandbox. Privacy scanning is also a guard rather than proof that a repository contains no sensitive material.

## Behavior covered

The suites exercise real compilation, SQLite storage, Git publication, subprocess workers and Bash/Python execution. They cover:

- Generation clarification, continued revision, compilation feedback, explicit publication approval and interrupted publication recovery.
- Typed inputs, namespaced workflow identity, nested call navigation, structured values and AI routing settings.
- Human pause/resume and failed AI/Code-step recovery without repeating completed checkpointed effects.
- Active-time budgets that exclude user-answer waits, live SSE output, cancellation and shutdown while a Code effect is in progress.
- Duplicate/stale submissions, path and symlink containment, corrupt data, Host/Origin checks and configuration projection.

## Limits and manual checks

Windows is not in the tested matrix; local examples require Bash and Python. Offline suites cannot establish model quality, account availability, billing behavior or accessibility on every browser and device. Before changing provider integrations, test live output, a mid-run question, Human suspension across a restart, failed-step recovery and Stop using a fresh data home and your own account.

For UI changes, check keyboard navigation, desktop and narrow-screen layouts, long histories and large values. The Vite build can report a large-chunk warning; slower devices may take longer to load the editor and diagram views. See [input/output display](value-display.md) for viewer behavior and [Security](../SECURITY.md) for deployment limits.

## Dependency advisories

The lockfile enforces DOMPurify 3.4.17 through a root override while Monaco pins an older version. If you install the Studio tarball in another project, retain `"overrides": {"dompurify": "3.4.17"}` in that project's root manifest until the upstream dependency is updated. npm applies overrides from the consumer root only; the independent consumer checks verify this setting.

Run `npm audit` before releasing dependency updates. A zero-advisory result is specific to the advisory database at that time and is not a guarantee that software has no vulnerabilities.

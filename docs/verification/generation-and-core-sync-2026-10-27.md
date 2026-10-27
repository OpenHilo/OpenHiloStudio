# Generation compiler alignment and core dependency update

## Changes

- Generation and compiler-repair prompts receive the host's actual source layout. The compatibility file compiler and closed module compiler retain their distinct entry identities; changing compilers does not migrate published workflows or saved runs.
- Generic generation guidance distinguishes execution success from a completed business outcome, asks for retrieved evidence for current claims, represents unknown and partial results explicitly, and avoids assuming that generation-time tools are available during execution.
- Direct system calls and supervised workers use one internal workflow catalogue. Deep module namespaces remain distinct, ambiguous short names fail explicitly, and symbolic-link entries are excluded. Schedule target resolution uses the same catalogue.
- Bundled OpenHilo archives are pinned to public commit `e66e33efcabe93d4ca4638c14e3a0cee311cb21a`. Its compiler supports bounded shared JSON type aliases and preserves original source locations. The source manifest contains no additional core patch. Lockfile integrity and dependency notices match the archives.

## Verification

Local verification on 2026-10-27 used Node 24 on macOS arm64:

- Full offline suite: 360 Node tests and 232 Jest tests passed.
- Public TypeScript contracts, package boundaries, package metadata and dependency notice checks passed.
- All 11 installed OpenHilo packages matched the pinned archive file contents and SHA-256 values.
- Regression coverage includes initial and repair prompt layout, shared optional/nullable nested AI output contracts, namespace identity in direct and worker queries, ambiguous-name rejection and symlink exclusion.
- Existing integration coverage includes failed-step recovery without repeating completed effects, Human pause/resume, answer waits excluded from AI active time, live events, cancellation and stopping suspended work.

The offline suite uses scripted providers and isolated data. It does not establish that every generated workflow finds all relevant evidence or uses correct business statistics. Prompt guidance is not a runtime guarantee: review generated consumers and test incomplete evidence, cross-source attribution and aggregation semantics for the intended application. This dependency update does not claim those application-level quality concerns are resolved.

## Reproduce and CI

Run `npm test`, `npm run test:types`, `npm run check:boundaries`, `npm run check:packages -- --pack`, `npm run check:notices`, `npm run check:export` and `npm run check:privacy`.

The [Studio verification workflow](https://github.com/OpenHilo/OpenHiloStudio/actions/workflows/ci.yml) additionally checks independent package consumers on Linux and macOS with Node 22/24, and reconstructs the bundled core archives from public source. Check the run associated with the commit containing this record for its final result.

The pinned core's [validation run](https://github.com/OpenHilo/OpenHilo/actions/runs/40552102614) passed on Node 22 and 24. These checks do not publish npm packages, restart deployed servers, or replay existing user runs.

# Nested AI output validation upgrade

Verified locally on macOS arm64 with Node 24 on 2026-10-27. The core pin is recorded in `vendor/openhilo/manifest.json`; installation uses bundled archives and does not require an adjacent source checkout.

Typed AI outputs now retain nested structure through the OpenHilo compiler and executor boundary. A missing field or wrong nested type fails at the AI step with a field path instead of reaching downstream Code. No Studio-specific business rules or replacement defaults are introduced. Historical workflows without nested metadata keep their previous semantics until recompiled.

## Results

- Full offline suite: 354 Node tests and 232 Jest tests passed.
- The subsequently added API regression and existing core-upgrade compatibility suite: 9 tests passed. Coverage includes malformed nested AI output, recovery without repeating completed effects, timeout behavior, live events and stopping work.
- Four independent archive consumers passed: generic, Codex, SDK and routed execution. Dependencies used the audited lockfile and populated cache; this does not claim fresh remote registry resolution.
- Export validation checks archive SHA-256 values, lockfile integrity, distributable contents and documentation links.
- The core pin now refers to a committed source revision with no extra patch. Local package-content and targeted compatibility checks were repeated before this commit. Remote source reproduction and CI for the new commit require a subsequent Git push and were not claimed here.

## Reproduce

Run `npm run test:offline`, `npm run check:export` and `npm run check:consumers`. With a populated cache, independent installation can use `npm run check:consumers -- --offline --locked-dependencies --cache <absolute-cache-directory>`. The targeted API test is `tests/integration/core-upgrade-compatibility.test.cjs`.

These checks use isolated data and do not restart a deployed server, replay user runs, or publish packages.

## CI follow-up

The first pushed revision passed Linux Node 22/24 tests, types and package checks, and the public core-source reconstruction job. The notice check then detected stale integrity hashes for the six updated core archives. Regenerating all eight notice/inventory artifacts updates only archive integrity and lockfile hashes; license texts and runtime behavior are unchanged. Local `check:notices` and `check:export` passed after regeneration. Check the GitHub Actions run for the final revision for the complete matrix result.

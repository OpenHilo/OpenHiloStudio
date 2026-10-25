# Changelog

## 0.1.0 — 2026-10-25

Initial source release.

- Workflow generation with clarification, continued draft conversation, compilation feedback, explicit review and direct execution.
- Typed run inputs, live output, nested execution inspection, saved child definitions and a shared structured input/output viewer.
- Human inbox, durable pause/resume, explicit stop and eligible failed-step checkpoint recovery without replaying completed effects.
- Active AI time budgets, paused timing during questions, and provider-confirmed cancellation that bypasses failure handlers.
- Shared entities, namespace-qualified schedules/history and editable AI routing rules with accurate unsaved-change detection.
- Public server/worker composition and deployment lifecycle; applications can extend the host without duplicating Runtime or IPC.
- Standalone source build, Node 22/24 offline suites, independent package consumers, public-source dependency reproduction and archive-aware privacy checks.
- Reviewed dependency pins and redistribution notices; user-facing OpenHilo naming with persisted protocol compatibility retained.

Install this release from source. Pinned core dependencies can be rebuilt using the [dependency provenance guide](vendor/openhilo/README.md). npm packages are not published with this source release.

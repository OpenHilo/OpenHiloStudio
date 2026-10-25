# @openhilo/platform-services

Reusable services behind OpenHilo Studio. Paths, execution ports, AI adapters, clocks and lifecycle ownership are explicit; importing the package does not start a service or open a personal data home.

| Area | Public entries |
| --- | --- |
| Generation and review | `generation-session`, `generation-service`, `generation-server`, `generation-pipeline`, `generation-storage` |
| Source publication | `publication`, `worktree-pool`, `workflow-files`, `brain-snapshot` |
| Execution host | `worker-supervisor`, `worker-system-host`, `worker-protocol`, `worker-run-path` |
| Human and AI questions | `human-history`, `human-submission`, `ai-questions`, `worker-questions` |
| Storage and schedules | `entity-store`, `entity-service`, `schedule-service`, `scheduler`, `run-history`, `filter-service`, `stats-service` |
| Configuration | `deployment-config`, `file-config`, `configuration-service` |

Use only entries declared in `package.json` exports. Each exported declaration documents its concrete API. The compiler and runtime remain dependencies of the separate OpenHilo core.

Generation retains policy and executor identity, conversation history and reviewed candidate receipts. Publication validates source/artifact digests and rejects stale approvals. It is a local coordinated publication protocol, not a transaction across arbitrary external side effects. Workspace leases and interrupted publication state must be preserved for inspection; do not delete them to clear an error.

Worker supervision owns processes and connects system operations to explicit services. Scheduler clocks are injected. Entities persist in an explicit SQLite location. Read [workflow behavior](../../docs/workflows.md) and [local operation](../../docs/operations.md) before composing a deployment.

Configuration and layout migration APIs accept explicit source and destination paths. Inspect the migration report before applying changes; migration does not start the destination deployment. Stop writers and back up data before any migration. A copy/hash check is not an online database snapshot.

See [Server](../../apps/server/README.md) for complete compositions and `examples/entities.cjs` for a small data example. Build with `npm run build` at the repository root; `npm test` includes these services' tests under disposable homes.

## Application-owned legacy configuration

The `deployment-config` entry reads and writes the versioned configuration envelope,
preserving unknown namespaces and inactive wrapper data. Its default converter and
`migrate-config` CLI require explicit `application` and `ai_execution` selections;
they do not infer a business application or an AI provider from missing values.
The read-only migration inspector reports `missing_selection` for those records.

For an existing application's legacy data, use `createDeploymentConfigCodec` in
that application's own package. Declare its domain/adapter field ownership,
optional historical selector defaults, and any legacy field fallbacks there.
Use the returned read, write and copy-migration functions consistently. Supply
its read function and defaults through the inspector's `configuration` option
when inspecting that application's data. Do not use another application's defaults
for an unknown source. The codec performs no registration, execution or live migration.

Unknown namespace payloads remain stored but are not flattened into the public
configuration view. Existing configuration format/version identifiers and saved
workflow metadata remain compatible; application-specific validation and migration
belong to the selected application's package.

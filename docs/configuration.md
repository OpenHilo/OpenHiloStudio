# Configuration

Choose a provider preset and a data directory before starting Studio. The launcher reads `config.json` from that directory and loads the matching composition module to connect providers and local services.

Choose a preset under `apps/server/examples`:

| Preset | Executor | Setup |
| --- | --- | --- |
| `codex-local` | Installed Codex app-server | Authenticate the CLI separately; configure executable, optional model/effort and sandbox |
| `sdk-local` | OpenAI or Anthropic SDK | Choose a supported model and reference its API key through `api_key_env` |
| `routed-local` | Task-category/level routing | Explicit routes to Codex or SDK profiles; use its example configuration |

Each preset has `config.example.json`, `composition.cjs` and `worker.cjs`. `init` copies the selected configuration into a new home. Use the matching composition on every start. Codex-only and SDK-only presets display a read-only startup snapshot. The routed preset supports editing in Settings: expand a task type, then a level, to change its model, reasoning effort, sandbox, or active-time limit. You can add/remove types and levels and select each type’s default level. Save validates the rules and preserves other deployment fields. Concurrent edits are rejected instead of silently overwritten. Changes take effect after a coordinated restart when work is idle; the page distinguishes saved rules from the currently active rules.

AI attempts default to a **12-hour active-time budget**. Codex and SDK presets accept `ai.execution.timeout_ms` in their configuration. User-answer waits are excluded by the task host. Live output reports provider-visible messages and tool progress, not hidden reasoning. A heartbeat does not guarantee forward progress. Use the explicit Stop action when abandoning work; Human-paused runs also support Stop.

Routed requests retain the configured routing identity. The routed preset archives validated configuration revisions in the private deployment home’s `.ai-routing` directory. Existing runs resume with their original revision even after new routing is activated, and completed steps are not replayed. Include these revisions in backups. Credential values are never included; provider authentication must still be available. Missing or altered revisions fail closed. Older runs can be preserved by starting this version once with their original configuration before saving new rules.

The default route handles functions without an AI type and workflow generation. Explicit missing type/level combinations are errors, not silent fallbacks. Model suggestions come from the local Codex model cache and are not a guarantee of account access. Reasoning controls expose the low/medium/high settings currently supported by the OpenHilo Codex adapter; routing labels such as `max` do not imply a model’s `max` reasoning mode.

Install and authenticate Codex before using the Codex preset. For SDK providers, set the environment variable named by `api_key_env` before starting the server. Keep credentials in the service user's provider setup or environment.

The Codex preset's read-only Settings page shows the active model selection, reasoning effort, sandbox, executable and active-time limit. Edit `ai.execution` in the deployment home's `config.json`, then stop and restart the server when work is idle. Omitted `model` and `effort` use the Codex CLI's configured defaults; the page labels them **CLI default**, not a resolved model name. Omitted `cli_path` uses `codex` from the server's PATH, `sandbox` defaults to `workspace-write`, and `timeout_ms` defaults to `43200000` (12 hours).

For example, this selection explicitly sets reasoning effort and sandbox while retaining the CLI's model default:

```json
{
  "adapter": "codex",
  "cli_path": "codex",
  "effort": "low",
  "sandbox": "workspace-write",
  "timeout_ms": 43200000
}
```

Replace only the `ai.execution` object, preserving the rest of the deployment configuration. To select a particular model, add a `model` string supported by your Codex account.

## Compatibility names

Studio uses OpenHilo product wording. `.itt.json` / `.itt.impl.json`, the public `@openhilo/itt-contracts` package, TypeScript type names, API fields such as `ittPath`, `intentorch.*` deployment/executor IDs, worker environment variables and browser draft keys are compatibility identifiers. They are retained so saved runs and external consumers continue to work. Legacy command aliases remain available. Migration code preserves opaque legacy application/provider settings; it does not install or load those implementations. New deployments must use one of the explicit generic presets above.

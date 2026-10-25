# SDK local preset

Run OpenHilo Studio with an OpenAI or Anthropic API key. This preset supports workflow generation, AI and Code execution, durable Human tasks and schedules.

Follow the [root installation guide](../../../../README.md), substituting this directory's `config.example.json` and `composition.cjs` in the init/start commands. Edit model/provider settings before initialization. For existing homes edit `config.json` only while coordinating a safe restart; do not rerun init.

Read [configuration](../../../../docs/configuration.md), [operation and backups](../../../../docs/operations.md) and [security](../../../../SECURITY.md). AI execution uses a configurable 12-hour active-time default; answering user questions is excluded from active time. The Settings page for this preset is read-only and reflects the startup configuration.

Starting the server does not submit a model request. Creating or running an AI workflow uses your configured account and may incur charges. Automated tests use scripted providers and do not contact a model service.

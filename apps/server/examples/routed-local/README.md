# Routed AI local preset

Route different workflow tasks to Codex or SDK models by task type and level. This preset includes the editable routing settings page, durable Human tasks and schedules.

Follow the [root installation guide](../../../../README.md), substituting this directory's `config.example.json` and `composition.cjs` in the init/start commands. Edit model/provider settings before initialization. For existing homes use Settings to edit type/level routing and coordinate a safe restart to activate changes; do not rerun init.

Read [configuration](../../../../docs/configuration.md), [operation and backups](../../../../docs/operations.md) and [security](../../../../SECURITY.md). AI execution uses a configurable 12-hour active-time default; answering user questions is excluded from active time. Settings supports collapsible type and level editors, explicit Save, and separate saved/active configurations. Existing runs retain their archived routing revision on resume. Back up `.ai-routing` with the deployment home.

Starting the server does not submit a model request. Creating or running an AI workflow uses your configured account and may incur charges. Automated tests use scripted providers and do not contact a model service.

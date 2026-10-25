# Workflows and recovery

Create workflow starts a generation session in an owned workspace. Answer any AI questions, then review the generated TypeScript. Continue with AI refines the same draft and conversation; changed candidates require a fresh review. Publication installs the reviewed source and compiled workflows, and provides a Run entry for each published entry point. Publication itself does not run them.

Inputs are rendered from their schema and validated before starting. A run records its own source/compiled snapshots. Editing the library does not silently replace an existing run's definition.

Activity shows invocations in order, their inputs, results, errors and provider-visible output. Execution shows the observed path; selecting a nested call switches to that call's execution and saved definition. Repeated calls and recursive frames have distinct identities. Missing historical snapshots are reported rather than replaced with today's library source.

Human requests persist across process lifetimes. Submit the declared output fields; the saved answer is bound to that task and loop iteration. Browser inbox drafts are stored locally for the same origin. AI clarification questions belong to a live AI attempt and are distinct from durable Human nodes.

For an eligible failed AI or Code step, explicit recovery uses the recorded JSONL checkpoint, call stack, variables and workflow snapshot. Completed steps are not rerun. Stale or duplicate recovery requests are rejected. Repairing an external script used by a Code node can permit retry; editing a saved inline workflow is not a supported repair mechanism. A failed step may have caused external effects before failure, so inspect those effects before retrying it. Older aborted runs without a recovery checkpoint cannot be resumed by inventing one.

Stop ends running or Human-paused work. Closed Human requests cannot be answered. Check the terminal state before assuming tools have exited. Starting a new run is a separate action and executes from the beginning.

## Flexible schedules

Regular schedules preserve their cron expression. A flexible schedule (`flexible: true` or `scheduleFlexibleIntent`) instead selects one execution time per matching day to distribute load; its minute and hour must each be a single number, such as `0 9 * * 1-5`. The day, month and weekday fields are preserved. The assigned time can differ from the preferred time.

Use a regular schedule for periodic or multiple daily times such as `*/5 * * * *` or `0 9,17 * * 1-5`. Flexible creation, clock edits and re-enabling reject those expressions rather than silently reducing their frequency. Previously saved flexible schedules remain readable and retain their assigned times; inspect any older periodic expression, disable the schedule, then set `flexible: false` before re-enabling it to restore the original frequency. Do not assume an older assigned time preserved the original frequency.

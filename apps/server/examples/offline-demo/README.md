# Offline workflow walkthrough

Try the complete workflow lifecycle without a model account. AI responses are scripted; TypeScript compilation, Git publication, SQLite, subprocess workers, Human pause/resume and Bash execution use the real services.

## Run

From a built checkout with Node 22 or 24, Git, Bash, Python 3 and a working SQLite binding:

```sh
npm run demo
```

The demo creates a new temporary data directory, completes the walkthrough and prints the directory and run IDs. It keeps the files for inspection and does not use your Studio deployment. Each invocation creates its own directory.

For a custom project that installs the local package archives, install `@openhilo/code-local` alongside the server and run:

```sh
node node_modules/@openhilo/server/examples/offline-demo/run.cjs
```

Use locally built archives; these workspace packages are not currently published to npm. If SQLite cannot load, build a compatible native binding as described in the [installation guide](../../../../README.md#run-locally).

## What happens

1. A generation session asks for the report format. The scripted provider produces a TypeScript error, receives real compiler diagnostics and repairs the draft.
2. The draft waits for publication approval. The host closes and reopens, then publishes the approved source and compiled workflow without repeating generation.
3. The workflow creates a SQLite entity, asks an AI clarification question and pauses at a Human node. An invalid boolean answer is rejected. A valid answer resumes in a new worker, and Bash writes the report.
4. The demo checks recorded outputs and confirms that completed steps were not executed again.
5. A persisted schedule starts another run using a manual clock. Closing the host while AI waits for an answer cancels the run and produces no second report. Confirmed cancellation is terminal; it is not an eligible failed-step recovery.

The demo uses Fastify's in-process request API and does not open a listening port. Its manual scheduler accepts only `* * * * *`; use a provider preset for normal cron scheduling. The scripted AI implements this report example only.

## Inspect or extend it

| File | Purpose |
| --- | --- |
| `host.cjs` | Supplies explicit paths, a manual clock and demo identity to the local deployment host |
| `worker.cjs` | Composes execution and restores the correct deployment identity |
| `ai.cjs` | Scripted AI for generation and execution |
| `run.cjs` | Drives API requests and verifies the results |

Inspect `result.json`, `brain/demo/report.ts`, `intents/demo/report/`, `sessions/`, `runs/`, `workspaces/report/report.txt` and `entities.db` in the printed directory to follow the workflow from source to results.

`initializeDemo` accepts an empty absolute directory. `openDemo` reopens it after checking the deployment identity. The host reuses `@openhilo/server/local-deployment`; a custom deployment supplies its own executor, worker module, clock and application policy.

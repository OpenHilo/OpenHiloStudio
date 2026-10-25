# Generation contracts

Policy contracts and generic instructions for generating TypeScript workflows. Depends only on `@openhilo/ai-contracts`; no business application, SDK, database or process runner is loaded.

A `GenerationPolicy` has a namespace and version, prepares JSON state once, validates restored state, and builds prompts for subsequent generation and repair attempts. Optional diagnostic data is separate from the generated prompt. Implementations may classify through an injected `AiTaskExecutor`; the generic policy does not classify or call an AI during preparation.

`genericGenerationPolicy` supplies executor declaration conventions, typed input/output guidance, workspace rules, questions and task completion format without a business taxonomy or level policy. The compiler remains the authority on supported syntax; these instructions are not a guarantee that model-generated code will compile.

Generated executor names describe the action and object, followed by the executor suffix for Human, AI or Code. These are prompt conventions; the compiler validates the generated workflow.

Entity modeling is optional and driven by the requested persistence needs. The prompt distinguishes registered class schemas and stored entities from ordinary TypeScript values, and generation tools from runtime system calls. Hosts can supply `GenerationPromptInput.systemMethods` (positional parameter names and output kinds); platform sessions use the compiler's operation catalogue and preserve it in repair prompts. Available tools still determine whether schema registration is possible. The current `define_class` tool writes immediately, outside source approval; rejecting generated source does not roll that registration back.

Use `@openhilo/platform-services/generation-session` to manage the lifecycle. It persists policy identity even before preparation, serializes only policy JSON data, and requires the same identity/version when rebinding after restart. Policy callbacks, credentials and executor instances are never serialized. Compiler repair retains the selected policy and its state.

`prepare` receives an optional second `{ signal }` context. Hosted sessions supply
their shutdown signal so asynchronous preparation, including AI classification,
can drain on close. Policies should forward it to their owned work; callers using
the older one-argument form remain supported. This live context is not persisted.

Build with `npm run build --workspace @openhilo/generation-contracts`. The root generation integration test exercises this real generic prompt through clarification, a TypeScript diagnostic, repair and review while forbidding business imports.

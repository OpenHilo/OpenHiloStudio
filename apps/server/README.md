# @openhilo/server

OpenHilo Studio's HTTP API, worker host and local deployment launcher. `createServer` accepts explicit service ports; it does not select a provider, discover a data home or start workers by itself.

Use the [root quick start](../../README.md) for a complete local installation. Provider compositions are bundled under `examples/codex-local`, `examples/sdk-local` and `examples/routed-local`. The [offline demo](examples/offline-demo/README.md) exercises real local services with scripted AI.

## Public composition

```ts
import { createServer, type ServerOptions } from '@openhilo/server';

export async function serve(options: ServerOptions) {
  const app = await createServer(options);
  await app.listen({ host: '127.0.0.1', port: 3000 });
  return app; // Close with await app.close().
}
```

The host supplies paths, workers, generation, configuration, entities, filters, schedules, scheduler and broadcaster ports. `@openhilo/server/local-deployment` assembles the standard local host; `@openhilo/server/worker-launch` creates its worker launcher. The package's exported declarations describe the exact contracts.

The `openhilo-server` CLI supports `init --home ABS --config ABS` and `start --home ABS --composition ABS [--studio ABS] [--host ADDRESS] [--port NUMBER]`. `intentorch-server` is retained as a command alias. Paths are explicit. Initialization refuses an existing directory; shutdown drains owned work.

Runtime events use JSONL and SSE. Recovery and Human submission are explicit, identity-checked operations. Generation supports clarification, continued draft conversation, review and publication. Stop applies to active and Human-paused workflows. Refer to [workflow semantics](../../docs/workflows.md), [configuration](../../docs/configuration.md) and [operations](../../docs/operations.md).

The frontend is a separate package. Serving its built directory does not change its provider configuration. Bind to loopback and read [SECURITY.md](../../SECURITY.md) before changing access.

## Browser access boundary

`createServer` and `createLocalDeployment` accept `allowedHosts?: readonly string[]` for additional trusted DNS hostnames, without a scheme, port or wildcard. Localhost and IPv4/IPv6 literals remain accepted. For example, a trusted host can set `allowedHosts: ['studio.example']`. Host validation applies to reads as well as writes and does not trust `X-Forwarded-Host`.

Browser mutations must be same-origin or match an explicit `corsOrigin` entry. Use exact origins such as `corsOrigin: ['https://studio.example']` only when a trusted browser frontend or TLS proxy requires them. `corsOrigin: true` opts into any HTTP(S) browser origin and is unsuitable for a restricted deployment. Reverse proxies must supply an allowed Host and use a matching explicit origin when the external scheme differs from the internal HTTP service. Native clients without browser origin headers still work; this is not authentication.

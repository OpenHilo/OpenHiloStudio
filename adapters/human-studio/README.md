# @openhilo/human-studio

`StudioHumanExecutor` makes a Runtime-owned human task available to Studio integrations through an optional notification callback.

```ts
import { StudioHumanExecutor } from '@openhilo/human-studio';

const humanExecutor = new StudioHumanExecutor({
  notify: task => publishTaskNotification(task),
});
```

`present(task, host)` awaits `notify(task)` and returns. Without a callback it returns immediately. Runtime owns the durable pending record and accepts subsequent submissions; this adapter does not submit outputs or create a pending promise. Notification errors propagate. An already-aborted presentation skips notification. The default executor ID is `studio`.

This package depends only on human contracts, with no React, Runtime, or HTTP dependency. Use it in a server composition root; the UI consumes the host's human-task API.

Build with `npm run build --workspace @openhilo/human-studio`; run `npm test --workspace @openhilo/human-studio` after building dependencies.

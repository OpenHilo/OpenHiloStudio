# Contributing

Use Node 22 or 24, npm, Git, Bash and Python 3. Install and build only in a development checkout, never in a directory serving running workflows.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run test:types
npm run check:boundaries
npm run check:packages -- --pack
npm run check:notices
npm run check:export
npm run check:privacy
npm run check:consumers
npm run check:core-source
```

`npm test` builds dependencies, then runs module, integration and frontend tests under temporary directories with a live-provider/network regression guard. The guard is not an OS sandbox. Test fixtures use local scripted providers; no model credentials are needed. Do not point tests at an existing deployment home. Use a fresh data directory for browser checks and live-provider testing. Live-provider tests require your own configured account and may incur charges.

The five packages use public package exports, not cross-package source imports. Keep core implementation changes in OpenHilo, then refresh reviewed archives and their hashes here. `npm run check:packages -- --pack` inspects temporary npm archives without publishing. `npm run check:consumers` installs those archives in a fresh consumer and exercises their public composition.

For UI changes, add behavior-focused regression coverage and check desktop and narrow-screen layouts, keyboard interaction and long text. For run or generation recovery changes, verify that completed effects are not repeated.

Third-party notices are generated from the root lockfile and reviewed license supplements. After dependency changes, run `npm run notices:update`, inspect the changes, rebuild Studio so the browser includes the same notices, and rerun the checks. Do not edit generated notices to hide a dependency.

Pull requests should explain the observed problem, resulting behavior and checks performed. Never include personal run logs, prompts, database copies, credentials, local deployment paths or browser screenshots with private content.

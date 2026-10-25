# Local operation

Use a new, explicitly chosen data home for a first installation. `init` refuses an existing directory. For subsequent starts, reuse the same home and composition with `start`; never initialize over existing work.

The home contains configuration, a Git-backed workflow source directory, published definitions, generation sessions and worktree ownership, run snapshots/events, workspaces, entity SQLite storage, schedules and saved filters. Back up the complete home, including source Git metadata and worktrees. Source-code Git history and a workflow's runtime Git data serve different purposes.

Keep exactly one owning server for a home. The local host holds an exclusive SQLite transaction in `.studio-owner.sqlite` before opening writable application resources; another owner, including one using a different port or a symlink to the same home, is rejected. This file contains no application data and remains after shutdown. Its operating-system lock is released on successful shutdown or process exit, so a crashed owner does not require deleting stale PID files. Use a local filesystem with working SQLite file locks. Do not remove or replace the ownership file while any server is running.

Ctrl+C or SIGTERM stops admission and drains owned work before releasing ownership. Uncooperative tools can delay shutdown; wait for actual exit. A failed drain retains ownership until the process exits. Do not remove PID locks, leases or database files to force another server to start. Before upgrading from a version without ownership enforcement, stop the old server first.

For upgrades, first stop work safely and stop all writers; make a consistent full backup; build the new release in a separate checkout; then start it with the existing home. Keep the previous runtime and backup for rollback. Check checkpoint compatibility before downgrading; newer serialized state may not be readable by an older runtime. Never run two versions against the same writable home.

For a non-mutating startup check, request `/api/stats`. Source checkout changes do not update or restart an existing deployment. The launcher does not install a background service or automatically replay old tasks. Schedules use the host's IANA timezone and a process-local, best-effort clock; sleeping/stopped hosts do not replay all missed triggers.

In frontend development, `npm run dev --workspace @openhilo/studio` starts Vite. Configure its `/api` proxy to a separate test server before use; do not connect development tools to a production home. The shipped development proxy targets port 3000.

Custom DNS names require an explicit `allowedHosts` entry in the composition options. Requests from the same localhost/IP origin, including a phone using the host's IP on a deliberately trusted network, do not need a CORS exception. Separate browser origins and TLS reverse proxies need exact trusted origin configuration; see [server browser access](../apps/server/README.md#browser-access-boundary). The service still has no account authentication, so these settings do not authorize exposing it publicly.

## SQLite binding troubleshooting

Run this from the repository root with the same Node 22 or 24 executable that will start the server:

```sh
node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); console.log(db.prepare("select sqlite_version() as version").get()); db.close();'
```

The locked better-sqlite3 13.0.3 includes native prebuilds, so `--ignore-scripts` does not prevent normal installation on supported platforms. If the check fails because a package file is missing after an interrupted install, correct the download/disk-space problem and repeat `npm ci --ignore-scripts --no-audit --no-fund` in a stopped development checkout.

If a prebuild is unavailable or incompatible, compile a binding from the installed source. Install Python 3 and a C/C++ build toolchain first: Xcode Command Line Tools on macOS (`xcode-select --install`), or Python 3, make and a C++ compiler on Linux (for example `build-essential` on Debian/Ubuntu). With Python 3.12 or newer, use node-gyp 10 or newer; the command below pins node-gyp 12.4.0.

```sh
npm exec --yes --package=node-gyp@12.4.0 -- node-gyp rebuild \
  --directory node_modules/better-sqlite3 --release --force_build=1
```

This downloads build tooling and matching Node headers as needed; it does not change the project's dependencies. An offline build can use an already installed node-gyp 12.4.0 and append `--nodedir=/absolute/path/to/matching-node-distribution` when that directory includes Node headers. `npm rebuild better-sqlite3` is insufficient for this version: it disables npm's implicit gyp build and has no install script. The explicit `--force_build=1` also prevents a present prebuild from turning compilation into a no-op.

Verify the newly compiled file directly:

```sh
node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:", {nativeBinding: "./node_modules/better-sqlite3/build/Release/better_sqlite3.node"}); console.log(db.prepare("select sqlite_version() as version").get()); db.close();'
```

The default loader prefers a prebuild over a compiled file. If an incompatible prebuild is still present, move its directory aside once (keep it for inspection; do not overwrite an existing backup):

```sh
node -e 'const fs = require("node:fs"); const p = "node_modules/better-sqlite3/prebuilds"; if (fs.existsSync(p)) { if (fs.existsSync(p + ".disabled")) throw Error("Inspect the existing prebuilds.disabled backup first"); fs.renameSync(p, p + ".disabled"); }'
```

Repeat the first, default-loader check before starting Studio. A subsequent `npm ci` replaces node_modules, so repeat the source-build procedure if that platform still needs it. None of these steps requires deleting or reinitializing a deployment home or its databases.

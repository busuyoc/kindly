# 86 — GUI Sandbox Spec (W30)

Date: 2026-04-22.
Status: **stable — v1.0 minimum baseline.** Review before GA.

**Related specs:**
- [84-gui-framework.md](./84-gui-framework.md) — why Electron
- [85-ipc-protocol.md](./85-ipc-protocol.md) — the `kindly serve` wire
- [82-json-api.md](./82-json-api.md) — command envelopes carried over serve

---

## 1. Core invariant

> **The GUI never touches the device filesystem directly. Every mutation
> goes through `kindly serve` over stdin/stdout JSON-IPC.**

This is the single load-bearing rule. Everything below follows from it.

Two long-running child processes sit behind this boundary:

- **`kindly serve`** (request/response, bidirectional) — all commands the GUI
  invokes on the user's behalf. Wire: [`docs/85-ipc-protocol.md`](./85-ipc-protocol.md).
- **`kindly watch`** (push-only stream) — tail-f of `.kindly/history.jsonl`
  so the UI can reflect new mutations live. Wire: `$watch_protocol: 1`
  (see `kindly watch --help`).

Both are the same trust-boundary shape: a Bun child process owns the
filesystem, the GUI owns rendering. Neither grants the renderer any extra
capability.

```
┌───────────────────────────────────────────────────────────────────────┐
│  Electron main process (Node)                                        │
│  - spawns `kindly serve` + `kindly watch` as children                │
│  - pipes stdin/stdout JSON lines                                     │
│  - manages window lifecycle, tray, auto-update                       │
│  - NO direct fs access to /Volumes/Kindle or koreader/               │
│                                                                      │
│  ┌─────────────────────────────────────────┐                         │
│  │  Renderer (React, sandboxed)            │                         │
│  │  - contextBridge / IPC to main          │                         │
│  │  - NO nodeIntegration                   │                         │
│  │  - NO remote content                    │                         │
│  │  - renders JSON from serve responses    │                         │
│  └─────────────────────────────────────────┘                         │
└──────┬──────────────────────────────────────────┬─────────────────────┘
       │ stdin/stdout ($serve_protocol: 1)        │ stdout ($watch_protocol: 1)
┌──────▼──────────────────────────────┐  ┌────────▼────────────────────┐
│  kindly serve (Bun child process)   │  │  kindly watch (Bun child)   │
│  - owns all filesystem I/O          │  │  - tails .kindly/history    │
│  - secret filter, safe-write, etc.  │  │  - push-only stream         │
│  - command whitelist                │  │  - fs.watch on .kindly/     │
└──────┬──────────────────────────────┘  └────────┬────────────────────┘
       │ filesystem                               │ filesystem (read-only)
       └───────────────────┬──────────────────────┘
┌──────────────────────────▼────────────────────────────────────────────┐
│  /Volumes/Kindle                                                      │
│  koreader/settings.reader.lua, plugins/, patches/, .kindly/           │
└───────────────────────────────────────────────────────────────────────┘
```

Why this matters: every security property kindly has — secret denylist, path
validation, safe-write atomicity, symlink rejection, archive integrity
checking — lives inside the CLI. If the GUI bypasses the CLI and reads
`settings.reader.lua` directly, it bypasses all of those guards. The GUI is
a rendering layer for JSON; the CLI is the security boundary.

---

## 2. Electron configuration

These settings are non-negotiable at v1.0. They match the decision in
[84-gui-framework.md](./84-gui-framework.md) §6.

### 2.1 Renderer sandbox

```js
// main.ts — BrowserWindow creation
const win = new BrowserWindow({
  webPreferences: {
    sandbox: true,
    nodeIntegration: false,
    contextIsolation: true,
    preload: path.join(__dirname, "preload.js"),
  },
});
```

- `sandbox: true` — renderer runs in a Chromium sandbox. No `require()`, no
  `fs`, no `child_process`, no `process.env`.
- `nodeIntegration: false` — renderer cannot access Node APIs even if sandbox
  is somehow bypassed.
- `contextIsolation: true` — preload script runs in a separate JS context.
  The renderer only sees what `contextBridge.exposeInMainWorld()` provides.

### 2.2 Preload surface

The preload script exposes a narrow API to the renderer:

```ts
// preload.ts
contextBridge.exposeInMainWorld("kindly", {
  request: (argv: string[]) => ipcRenderer.invoke("kindly:request", argv),
  onHello: (cb: (hello: unknown) => void) =>
    ipcRenderer.on("kindly:hello", (_e, data) => cb(data)),
});
```

The renderer calls `window.kindly.request(["pull", "--mount", "..."])` and
gets back the serve response envelope. It never sees raw file paths, process
handles, or Node APIs.

### 2.3 Main process IPC handler

```ts
// main.ts
ipcMain.handle("kindly:request", async (_event, argv: string[]) => {
  // validate argv is string[]
  // forward to kindly serve via stdin
  // return the JSON response
});
```

The main process validates that `argv` is a `string[]` before forwarding.
No other IPC channels are exposed.

### 2.4 Content Security Policy

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'
```

- `connect-src 'none'` — the renderer cannot make network requests. All data
  comes via IPC from main, which comes from `kindly serve`.
- No `eval`, no inline scripts, no remote URLs.

### 2.5 No remote content

```ts
// main.ts — block all navigation and new windows
win.webContents.on("will-navigate", (e) => e.preventDefault());
win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
```

The GUI loads `file://` from the app bundle. There is no reason to ever
navigate to a remote URL.

---

## 3. What the GUI can do

These are the operations the GUI performs, grouped by trust level.

### 3.1 Via `kindly serve` (full CLI security model)

| Operation | Serve command | Mutates device? |
|-----------|---------------|-----------------|
| Read settings | `pull --json` | no |
| Preview changes | `diff --json` | no |
| Apply settings | `apply --json` | yes |
| Device health | `doctor --json` | no |
| List plugins | `plugin list --json` | no |
| Describe plugin | `plugin describe <name> --json` | no |
| Import setup | `setup import <path> --json` | yes |
| Export setup | `setup export --json` | yes (writes file) |
| Inspect setup | `setup inspect <file> --json` | no |
| List templates | `setup templates --json` | no |
| View history | `history --json` | no |
| View entry detail | `history show <N> --json` | no |
| Rollback | `rollback --to <N> --json` | yes |
| Snapshot | `snapshot --json` | yes (writes archive) |
| Restore | `restore <archive> --json` | yes |

Every mutating operation goes through the CLI's safe-write pipeline, secret
filtering, and pre-mutation safety snapshot.

### 3.2 Main process only (no serve)

| Operation | Implementation | Notes |
|-----------|---------------|-------|
| Spawn `kindly serve` | `child_process.spawn()` | One process per device session |
| Spawn `kindly watch` | `child_process.spawn()` | One process per device session; parallel to serve |
| Kill child on window close | `child.kill()` | Clean shutdown via stdin EOF preferred |
| Read app config | Local `settings.json` in Electron's `userData` | Window size, theme, last-used mount |
| Auto-update | `electron-updater` | Checks GitHub Releases |

`watch` is separate from `serve` because its protocol is push-only
(unidirectional events, not request/response). Multiplexing both onto one
connection would complicate serve's framing for marginal benefit — one extra
child process is cheap.

### 3.3 Renderer (React)

The renderer only:
- Calls `window.kindly.request(argv)` and renders the response.
- Stores UI state in React state / local storage (theme, collapsed panels).
- Never reads files, never writes files, never makes network requests.

---

## 4. Trust boundaries

```
UNTRUSTED        │ TRUSTED
                 │
  .kset files    │
  from strangers ─┤
                 │  kindly serve
  YAML from      │  ├─ isSafeRelativePath()
  user           ─┤  ├─ lstatSync() symlink check
                 │  ├─ Zod manifest validation
  Lua from       │  ├─ SHA-256 integrity check
  device         ─┤  ├─ secret denylist
                 │  ├─ safe-write + verify
                 │  └─ command whitelist
                 │
                 │  Electron main
                 │  ├─ argv validation (string[])
                 │  └─ serve lifecycle
                 │
                 │  Electron renderer
                 │  └─ renders JSON only
```

Untrusted input enters at three points:
1. **`.kset` archives from strangers** — validated by `unpackSetup()`: path
   safety, symlink rejection, manifest schema, hash integrity, undeclared
   file rejection.
2. **YAML from the user** (`kindly.yaml`) — parsed by the `yaml` library,
   values merged via `mergeYamlIntoLua()` which preserves secrets.
3. **Lua from the device** (`settings.reader.lua`) — parsed by the
   restricted Lua parser (no code execution, no barewords).

The GUI never handles any of these directly. It sends an argv to serve,
serve runs the command, and the GUI gets back a JSON envelope.

---

## 5. What the GUI must NOT do

These are explicit prohibitions, not implied by the sandbox — they're
listed so a future contributor doesn't add them by mistake.

1. **Never read `settings.reader.lua` directly.** It contains plaintext
   passwords and PINs. Use `kindly pull --json` which filters secrets.

2. **Never write to the device filesystem.** Use `kindly apply` or
   `kindly setup import` which go through safe-write + backup.

3. **Never shell out to arbitrary commands.** The main process spawns
   exactly one child: `kindly serve`. No `exec()`, no `spawn()` with
   user-supplied command strings.

4. **Never load remote content in the renderer.** No CDN scripts, no
   analytics, no update-check URLs in the webview. Auto-update runs in
   main via `electron-updater`, which fetches from GitHub Releases.

5. **Never expose Node APIs to the renderer.** The preload surface is
   `{ request, onHello }`. No `fs`, no `path`, no `child_process`.

6. **Never store device secrets in Electron's userData.** The GUI may
   cache non-sensitive state (window position, theme, last mount path).
   It must never persist settings values that could contain credentials.

7. **Never bypass the serve command whitelist.** If a new command is
   needed, add it to `COMMAND_WHITELIST` in `src/cli/serve.ts` and to
   the IPC protocol spec. Don't fall back to one-shot `spawn("kindly", ...)`.

---

## 6. Threat model

### 6.1 Threats the sandbox addresses

| Threat | Mitigation |
|--------|-----------|
| Renderer XSS reads device files | Sandbox + contextIsolation. Renderer has no `fs` access; IPC only returns filtered JSON. |
| Malicious `.kset` escapes via symlink | `lstatSync()` + reject in `unpackSetup()`. GUI never unpacks archives itself. |
| `.kset` plants code in plugin dir | Manifest hash verification. Plugins are data files to KOReader, not executed by kindly. |
| Secrets leak to GUI state | `pull --json` filters via classify.ts denylist. GUI never sees raw Lua. |
| GUI writes corrupt settings | All writes go through safe-write pipeline with post-write Lua re-parse verification. |
| Electron auto-update serves malware | Code-signed binaries + GitHub Releases as the only update source. |

### 6.2 Threats the sandbox does NOT address

| Threat | Why not | Mitigation path |
|--------|---------|-----------------|
| Malicious plugin Lua runs on KOReader | kindly installs plugins but doesn't execute them. KOReader `dofile()`s them. | v0.11 W32: known-hash verification against catalog. Warns on mismatch. |
| Compromised `kindly` binary | If the serve process is malicious, the sandbox is moot. | Code signing + reproducible builds (post-v1.0). |
| Physical device access | Someone with the Kindle can read `settings.reader.lua` directly. | Out of scope. The threat model is the software pipeline, not physical security. |
| Secrets in settings that aren't in the denylist | New upstream credential fields bypass filtering. | Periodic denylist audit against KOReader source. `kindly doctor` (v0.11 W34) could flag unknown keys with secret-like names. |

---

## 7. Serve process lifecycle

### 7.1 Spawn

Main process spawns serve on app launch (or on first device detection):

```ts
const serve = spawn("kindly", ["serve"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, KINDLY_TRACE: "0" },
});
```

Stderr from serve is logged to Electron's main-process log for debugging.
It is never forwarded to the renderer.

### 7.2 Device swap

`kindly serve` inherits `cwd` and mount state at spawn time. If the user
unplugs one Kindle and plugs in another, the GUI must:

1. Close stdin on the current serve process (clean shutdown).
2. Wait for exit.
3. Spawn a new serve process.

Alternatively, each request can include `--mount <path>` to override per
request, but a fresh process is cleaner — it avoids stale state in the
serve process's module cache.

The same lifecycle applies to `kindly watch`: kill on device swap, respawn
pointing at the new `.kindly/` directory.

### 7.3 Crash recovery

If serve exits unexpectedly (non-zero, signal):

1. GUI shows a transient error ("kindly process exited unexpectedly").
2. GUI attempts to respawn serve once.
3. If respawn also fails, GUI shows a persistent error with "restart app"
   guidance.

No automatic retry loop — two failures in a row indicates a real problem
(corrupt settings file, missing binary, disk full).

Watch-process crashes are less severe (no in-flight request state to lose),
so the GUI can silently respawn. When respawning, pass `--from N` where N
is the last `entry.index` the GUI rendered — that replays any entries
appended during the gap without requiring a separate `history --json` fetch.

---

## 8. Relationship to v0.11 security work

This spec defines the **boundary**; v0.11 adds **depth**:

| W30 (this doc) | v0.11 |
|----------------|-------|
| GUI never touches device | W31: expanded suspicious-key warnings on import |
| Secrets filtered at serve boundary | W34: doctor flags unknown secret-like keys |
| Archives validated on unpack | W32: plugin hash verification against catalog |
| Manifest schema enforced | W33: author/source metadata for trust signals |

The sandbox is the wall; v0.11 items are the sensors on the wall.

# 84 — GUI Framework Decision (W25)

Date: 2026-04-22.
Status: **decided — Electron.**

---

## 1. Candidates

Three frameworks evaluated for the kindly GUI (v1.0):

| | Tauri 2 | Electron | Bun + system webview |
|---|---------|----------|---------------------|
| Shell language | Rust | Node.js / TS | Bun (TS) |
| Renderer | System webview | Chromium (bundled) | System webview |
| Bundle size (macOS) | ~8–15 MB | ~90–120 MB | ~5–10 MB (no runtime) |
| Bundle size (Windows) | ~5–12 MB | ~85–110 MB | ~5–10 MB |
| Startup time | ~200–400 ms | ~500–1200 ms | ~100–300 ms |
| TS fit | Frontend only; shell is Rust. Commands cross FFI. | Full-stack TS. Main + renderer both JS/TS. | Full-stack TS. Single runtime. |
| Sandbox | Strict: shell capabilities are allowlisted in `tauri.conf.json`. Renderer can't touch OS by default. | Loose: renderer can `require('child_process')` unless explicitly disabled. contextBridge + preload is the boundary. | No built-in sandbox. App is trusted code. |
| Maturity | Stable (2.x since late 2024). Large ecosystem, active core team. | Battle-tested (10+ years). Massive ecosystem. | Experimental. `Bun.serve()` + `webview` crate bindings exist but no stable API. No packaging story. |
| macOS signing/notarization | Built-in via `tauri-cli`. | `electron-builder` / `electron-forge`. Well-documented. | Manual. No tooling. |
| Windows packaging | MSI/NSIS via `tauri-cli`. | NSIS/Squirrel via `electron-builder`. | Manual. |
| Linux packaging | AppImage/deb via `tauri-cli`. | AppImage/deb/snap via `electron-builder`. | Manual. |
| Auto-update | Built-in updater. | `electron-updater` (mature). | Nothing. |

Sources: Tauri 2.x docs (tauri.app), Electron docs (electronjs.org), Bun GitHub (oven-sh/bun), bundle size measurements from community benchmarks (2025 data).

---

## 2. Deciding constraint

> Claudiu is a solo developer. He owns React and TypeScript end-to-end. He does not know Rust and does not want to learn it under deadline pressure for this project. The ability to debug any layer of the stack — main process, renderer, build pipeline, OS integration — at 11 PM without context-switching to a foreign language is a hard requirement.

This constraint eliminates Tauri. The shell layer (Rust) is where all OS interactions live: file system access, child process spawning (`kindly serve`), tray icon, auto-update, window management. These are exactly the surfaces where bugs appear late and under pressure. A solo developer who can't read, debug, or extend the shell layer doesn't own the stack — the framework owns them.

This is not a hypothetical risk. Tauri's issue tracker has a steady stream of platform-specific regressions (macOS webview rendering differences, Windows NSIS signing edge cases, Linux webview version mismatches) that require Rust-level diagnosis. For a team with a Rust developer, these are routine. For Claudiu, each one is a full stop.

---

## 3. Bun + webview assessment

All-TypeScript, smallest bundle, fastest startup. On paper it's the ideal middle path. In practice:

- **No packaging story.** There is no `bun build --compile` equivalent that bundles a webview. You'd roll your own with `pkg` or a custom wrapper — uncharted territory.
- **No auto-update.** Would need to be built from scratch.
- **System webview divergence.** macOS (WebKit), Windows (WebView2/Edge), Linux (WebKitGTK) all render differently. Electron solved this by bundling Chromium. Tauri solved it with a mature abstraction layer and years of edge-case fixes. Bun+webview has neither.
- **No signing/notarization integration.** macOS code signing for a webview-based app requires specific entitlements that no Bun tooling handles.
- **Community.** A handful of proof-of-concept repos. No production apps at this scale.

Verdict: interesting for a future where Bun's desktop story matures. Not viable for a shippable v1.0 today.

---

## 4. Electron: honest downsides

The choice is Electron, but it comes with real costs. Documenting them so they don't surprise us later:

**Bundle size.** ~100 MB on macOS (Chromium + Node). This is 10× Tauri. For a tool that configures an e-reader, this feels heavy. Mitigation: Electron already ships with a Chromium that users likely have cached (VS Code, Discord, Obsidian all use Electron). Disk space on a desktop in 2026 is not the constraint it was in 2015. The bundle size is an aesthetic objection, not a functional one.

**Startup time.** ~700–1000 ms cold start on an M-series Mac. Noticeable but not painful for an app you open once per reading session. `kindly serve` (W26) is the hot path — it stays running. The GUI is a shell around it.

**Memory.** ~80–150 MB RSS for a minimal Electron app. For a single-window config tool used episodically, this is fine. It would be a problem for a tray-resident always-on app; kindly is not that.

**Security surface.** Chromium is a large attack surface. Electron's contextBridge + nodeIntegration:false + sandbox:true brings this under control for a local-only tool that doesn't load remote content. kindly's GUI loads zero external URLs — it renders local state from `kindly serve` JSON. The Chromium surface is theoretical, not practical.

**Maintenance burden.** Electron major versions ship ~quarterly. Staying current matters for security patches. The upgrade cadence is a real ongoing cost. Mitigation: kindly is a simple app — one window, no native modules, no complex IPC beyond `kindly serve` stdio. Electron upgrades for simple apps are typically painless.

---

## 5. Architecture fit

kindly's GUI architecture (from the roadmap) is:

```
┌─────────────────────────────┐
│  Electron renderer (React)  │  ← renders catalog, diff, history, settings
│  localhost fetch / IPC      │
└──────────┬──────────────────┘
           │ stdin/stdout JSON lines
┌──────────▼──────────────────┐
│  kindly serve               │  ← long-running CLI process (W26)
│  (Bun subprocess)           │
└──────────┬──────────────────┘
           │ filesystem
┌──────────▼──────────────────┐
│  /Volumes/Kindle            │  ← mounted device
└─────────────────────────────┘
```

The GUI never touches the device directly. It talks exclusively to `kindly serve` over JSON-IPC. This means:

- **Main process** (Electron/Node): spawns `kindly serve` as a child process, pipes stdin/stdout. Handles window lifecycle, tray, auto-update. All TypeScript.
- **Renderer** (React): fetches state from main via contextBridge or IPC. Renders the Ninite-style plugin grid, taxonomy-grouped settings, diff previews, history timeline. All TypeScript + React.
- **No native modules.** `kindly serve` is a Bun binary; Electron's Node main process just spawns it. No `node-gyp`, no platform-specific compilation.

This is the simplest possible Electron app: a thin Node main that manages a subprocess and a window, plus a React renderer that displays JSON. Electron's power (Chromium rendering, cross-platform windowing, packaging, auto-update) is fully leveraged. Electron's complexity (native modules, deep Node integration, multi-window orchestration) is entirely avoided.

---

## 6. Decision

**Electron.** Specifically:

- Electron 34+ (current stable at time of writing)
- `electron-forge` for packaging and distribution (replaced `electron-builder` as the recommended path)
- React + TypeScript in the renderer
- `contextBridge` + `nodeIntegration: false` + `sandbox: true` in the renderer
- `kindly serve` spawned as a child process from main, communicating over stdin/stdout JSON lines
- No native modules

**Revisit trigger:** if Bun ships a stable desktop/webview story with packaging and signing before kindly v1.0 ships, re-evaluate. The `kindly serve` boundary means the GUI layer is replaceable without touching the engine.

---

## 7. What this doc is NOT

- Not a commitment to ship Electron tomorrow. W26–W30 are framework-agnostic (IPC protocol, library extraction, serve mode). The GUI starts at v1.0.
- Not a rejection of Tauri for all projects. Tauri is the better framework for a team with Rust experience. This decision is for this project and this developer.
- Not an endorsement of Electron's defaults. The security configuration (sandbox, CSP, no remote content) must be locked down from day one — Electron's permissive defaults are a known footgun.

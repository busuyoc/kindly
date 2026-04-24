# Open questions

Decisions to make before writing much code. Each needs a pick.

## 1. Language / runtime

- **Rust** — robust, single binary, best Lua interop via `mlua`. Slower to iterate. Claudiu hasn't used it heavily.
- **Go** — easy to ship, good CLI ergonomics, `gopher-lua` exists. Middle ground.
- **TypeScript/Bun** — fastest iteration for Claudiu (his stack). Lua parsing would be via a hand-rolled parser or `fengari` (JS Lua VM). Lua interop weakest.

**Leaning:** start with **Bun/TS** for speed. If Lua codec becomes painful, reevaluate.

## 2. Profile format

- **YAML** — familiar, forgiving with nesting, comments, anchors. Whitespace sensitivity annoys some.
- **TOML** — flatter, unambiguous, no YAML gotchas. Awkward for deeply nested SimpleUI modules.
- **KDL** — pretty, but niche.

**Leaning:** **YAML**, because the hard use case (SimpleUI modules) is deeply nested.

## 3. Secrets

- `env` vars (simple, no extra file)
- companion `.secrets.yaml` gitignored
- `op://` 1Password CLI refs
- SOPS / age encryption

**Leaning:** support env + file-based for v1, ship with doc for 1Password for power users.

## 4. Plugin source of truth

For plugins not in KOReader core (simpleui, zlibrary, localsend):

- Hardcoded registry in binary (curated, we approve what gets in)
- User-extensible registry file (flexible, risk of bad URLs)
- Inline `source:` per plugin in profile (most flexible, most verbose)

**Leaning:** ship with curated registry; allow `source:` override per plugin for custom builds.

## 5. SimpleUI schema lock-in

SimpleUI updates frequently (weekly releases). Our typed schema will drift.

- Maintain a version map: `simpleui@1.4 → key foo`, `simpleui@1.5 → key bar`.
- Or: pass-through raw mode where users specify raw `G_reader_settings` keys.

**Leaning:** typed schema for common knobs + raw escape hatch for everything else.

## 6. Reading state / per-book metadata

Sync highlights? Reading positions? `.sdr/` folders?

**Leaning:** **out of scope v1**. Focus on setup, not book state. (Reading position already synced via kosync plugin.)

## 7. Distribution

- Homebrew tap (`brew install claudiu/tap/korea`)
- Cargo / npm / go install (depending on language)
- GitHub releases prebuilt binaries

**Leaning:** GH releases + Homebrew from day one.

## 8. Scope of "apply"

When `korea apply` is run:
- Download missing plugins? **yes**
- Remove plugins not in profile? **opt-in flag** (`--prune`)
- Modify settings not mentioned in profile? **no** — profile is additive unless explicitly `disabled`/`unset`
- Restart KOReader? Can't — it's on the device, not our process. User restarts manually.

## 9. Name

`korea` is fine but confusable with the country. Alternatives:
- `korea-studio` (longer but clear)
- `koread` (drops the last letter)
- `konfig`
- `readerd`

**Leaning:** ship as `korea` (the CLI), project named "korea" or "KOReader Studio" informally.

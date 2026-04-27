# Compiled binary distribution

`bun build --compile` produces a single self-contained executable so
ordinary users can run kindly without installing Bun, without cloning
the repo, and without Docker.

## Targets

| Target           | Status        | Size     | Tested? |
|------------------|---------------|----------|---------|
| `darwin-arm64`   | primary       | ~62 MB   | yes     |
| `darwin-x64`     | supported     | ~66 MB   | yes (Rosetta) |
| `linux-x64`      | supported     | ~98 MB   | CI      |
| `windows-x64`    | best-effort   | ~114 MB  | no      |

Windows is cross-compiled but the maintainer cannot validate it. The
README labels it "untested cross-compile; please file issues if you
try it."

## How to build

```bash
./scripts/build-binary.sh                # host target
./scripts/build-binary.sh linux-x64      # explicit
./scripts/build-binary.sh windows-x64    # cross-compile
```

Output lands in `dist/kindly-<target>[.exe]`. CI builds all four on
tag push and uploads them to a GitHub release (see
`.github/workflows/release.yml`).

## Asset embedding (Slice 7)

The binary needs three data files at runtime:
- `data/schemas/settings.reader.lua.v1.json` — 557-key schema
- `data/taxonomy/settings.v1.json`           — category/label/hint
- `data/classify/settings.v1.json`           — 3-axis classify rules

These are imported as `with { type: "json" }` in
`src/schema/settings.ts`, `src/taxonomy/mapper.ts`, and
`src/schema/classify.ts`. Bun bundles them into the binary at
compile time. The previous `import.meta.dir + readText` pattern
resolves to `/$bunfs/root/data/...` inside a compiled binary, which
ENOENTs.

The optional `path` override on `loadSchema(path?)` and
`loadTaxonomy(path?)` still goes through `readText` for runtime
overrides (used by `doctor --schema=<path>` and tests).

`data/taxonomy/settings.v1.categories.yaml` is build-time only
(consumed by `scripts/build-taxonomy.ts`); it does not need to be
bundled.

## What the binary still needs

A mounted Kindle (or any directory passing the `koreader/` presence
check). The binary does not ship a fake mount; testing without
hardware uses `--mount=<dir>` against `tests/fixtures/kindle/`.

## What's NOT done

- **Code-signing / notarization.** macOS gatekeeper warning is
  expected; users right-click → Open or `xattr -d
  com.apple.quarantine kindly-darwin-*`. Defer until a user base
  warrants the maintenance cost.
- **Package-manager submissions** (homebrew, winget, etc.). Same
  reason.
- **Auto-update.** Users re-download from GitHub Releases.
- **Universal macOS binary.** Two artifacts, one per arch.

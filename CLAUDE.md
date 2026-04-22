# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is kindly

Declarative backup & restore for KOReader settings on e-ink devices (primarily Kindle). A single YAML file describes the complete KOReader configuration; `kindly pull` reads device → YAML, `kindly apply` merges YAML → device with atomic writes and verification. Non-destructive: secrets, ephemerals, and untracked keys are never wiped.

## Commands

```bash
bun test                          # run all 817+ tests (bun:test)
bun run src/cli.ts <command>      # run CLI locally
```

No build step — Bun interprets TypeScript directly. No linter configured.

## Architecture

**Runtime:** Bun + TypeScript (strict). Dependencies: `yaml`, `zod`. No compilation — `noEmit: true`.

**Layered module structure:**

- `src/cli.ts` — dispatcher. Maps `kindly <cmd>` to handler, catches errors, renders output, manages `--json` envelopes.
- `src/commands/*.ts` — 10 commands (pull, apply, diff, init, doctor, snapshot, restore, rollback, history, setup). Each exports `run<Cmd>(argv, env) → Promise<number>` + a `<cmd>Help` string.
- `src/lua/reader.ts` + `writer.ts` — parse and serialize KOReader's Lua dump format. Byte-exact roundtrip is a hard invariant (23 commits dedicated to this).
- `src/schema/` — key classification (SECRET/EPHEMERAL/USER), YAML↔Lua conversion, diff computation, validation against the 557-key schema.
- `src/taxonomy/` — maps keys → category, label, control_hint, severity. Used for grouped diffs and change-impact hints.
- `src/setup/` — Setup manifests (Zod-validated), lean `.kset.yaml` and fat `.kset` archives, compat gating (KOReader version + device family), canonical hashing.
- `src/fs/safeWrite.ts` — 6-step atomic write pipeline (archive → write .tmp → fsync → rename .old → rename .tmp → verify re-parse).
- `src/device/kindle.ts` — mount detection (macOS `/Volumes/Kindle`, Linux `/mnt/us`), validated by `koreader/` presence.
- `src/cli/env.ts` — injectable `CliEnv` (stdout/stderr/mount/clock). Commands never call `process.exit`.
- `src/types/errors.ts` — `KindlyError` with stable string code + remediation list. Error codes are in `ErrorCodes` registry.

**Data files (not generated at build time, committed):**

- `data/schemas/settings.reader.lua.v1.json` — 557-key KOReader schema (types + evidence)
- `data/taxonomy/settings.v1.json` — category/label/hint per key
- `data/taxonomy/settings.v1.categories.yaml` — category definitions

**Scripts (ad-hoc, run manually):**

- `scripts/extract-schema.ts` — regenerate settings schema from KOReader source
- `scripts/build-taxonomy.ts` — regenerate taxonomy JSON
- `scripts/extract-plugin-meta.ts` — extract plugin metadata for catalog

## Key patterns

**Command result pattern:** every command has `execute*()` (returns typed Result) + `render*()` (prints). Enables `--json` mode without duplicating logic.

**Testability:** commands take `CliEnv` with `StringWriter` for output capture, `mountOverride` for fake Kindle dirs, injectable `now()` for deterministic timestamps. Tests build a fake Kindle in a tmpdir with a real Lua fixture at `tests/fixtures/kindle/settings.reader.lua`.

**Merge semantics:** `mergeYamlIntoLua()` does shallow merge — YAML keys override, device keys not in YAML are preserved. Nested tables (e.g. `kosync`) are sub-merged so updating one nested key doesn't delete siblings.

**Secret/ephemeral filtering:** hardcoded denylist in `src/schema/classify.ts`. Secrets are never pulled or overwritten. Ephemerals are excluded by default (`--full` keeps them).

**Flag parsing:** custom parser in `src/cli/args.ts`. No short flags. Supports `--flag`, `--flag=value`, `--no-flag`. Unknown flags → `ArgError`.

## Conventions

- Exit codes: 0 = success, 1 = runtime error, 2 = arg validation error.
- Error codes are string literals (not numeric), registered in `ErrorCodes`.
- YAML output is alphabetically sorted for diffability.
- `.kindly/` on device holds backups, pre-import snapshots, history.jsonl, trace.jsonl.
- `settings.reader.lua` contains secrets (PIN codes, passwords) in plaintext — schema and pull filter these by default.

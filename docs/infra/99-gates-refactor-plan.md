# 99 — Gates Refactor Implementation Plan

**Branch:** `gates-refactor`
**Baseline commit:** `77da17d84b9bf168040c2df4fb6f29d1c0a1718e` (main, 2026-04-24)
**Plan authored:** 2026-04-24
**Owner:** Claudiu (solo)
**Status at write:** Step 0 in progress.

This is the execution plan for the architectural refactor discussed in the
day-4 design session. It is the authoritative source if context is lost —
the memory file `project_kindly_gates_refactor.md` points here.

## Goal

Introduce a producers-plus-gates layer (`src/gates/`) so that:

1. The 12 currently-inline policy gates in `src/lib/importSetup.ts` become
   declarative registry entries, each a ~40-LOC module.
2. `src/lib/apply.ts` gains gate parity (currently has zero gates — S89 lives
   in this gap).
3. Classification collapses from a four-class enum into three orthogonal
   axes (exfil / change / hygiene) driven by `data/classify/settings.v1.json`.
4. The YAML input shape normalizer (S89 fix) lands as a first-class gate,
   not a bolt-on patch.
5. Two independent safety-net helpers ship alongside: `src/fs/safeRead.ts`
   (callsite provenance labeling) and `src/cli/sanitize.ts` (control-byte
   stripping at render layer).

Non-goals for this refactor:

- Not a security sprint. Closes S89 structurally; other findings need their
  own tracks (filesystem symlink handling is already safe; sanitize closes ~7;
  the long tail stays as one-off patches).
- Not a flatten of `src/commands/setup.ts` (1313 LOC). That's track 9,
  deferred.
- Not a migration of CLI flag names. `--accept-sensitive` etc. stay stable.

## Core rule

**Every commit leaves `bun test` green.** Broken tests do not cross commit
boundaries. If a step breaks, fix-in-place or revert before moving on.

## Worked example — why registry, not refactor flavor

S89 motivates the refactor structurally (apply has no gates, and the
YAML-merge trust model is upside-down). **S340/S341** is the sharper
maintainability example:

Two of the 14 inline gates in `importSetup.ts` forgot the `!opts.dryRun`
check. They block on `--dry-run` when they shouldn't. Worse: two sibling
gates that both consume `sensitiveHits` (the input) have OPPOSITE dry-run
semantics, and the divergence is entirely implicit in control flow:

| Site                                      | dry-run behavior | Rationale                                     |
|-------------------------------------------|------------------|-----------------------------------------------|
| `importSetup.ts:594` STRICT_SENSITIVE     | fires always     | CI preflight needs it to block the preview    |
| `importSetup.ts:605` SENSITIVE_REQUIRES_ACK | skips in dry-run | user needs to preview without consent gate    |

Both behaviors are correct. The problem is they read as
`if (opts.strictImports && ...)` vs `if (!opts.dryRun && ...)` and a new
gate author has to rediscover the distinction every time. S340/S341 are
the predictable failure mode of that implicitness.

Post-refactor, each gate declares:

```ts
firesIn: "always" | "non-dry-run" | "strict-imports-only"
```

The field is required at registration. You cannot add a gate without
answering "does this fire in dry-run?" — which is exactly the question
the current inline pattern lets you skip silently.

**S340/S341 cannot exist in the post-refactor architecture.** That's the
concrete maintainability payoff — not "it's prettier" or "it scales
better," but "a specific class of bug becomes unrepresentable." S89 is
the other side of the same coin: the apply path has zero gates because
the current style made it easy to ship `executeApply` without thinking
through which gates apply; the registry makes gate-set-per-boundary an
explicit declaration (`appliesAt: ("import" | "apply")[]`).

## Progress tracker

Update this table as steps complete. Date format: YYYY-MM-DD.

| Step | Title                                           | Status      | Commit   | Date      |
|------|-------------------------------------------------|-------------|----------|-----------|
| 0    | Branch + plan doc                               | ✅ done     | d95f207  | 2026-04-24|
| 1    | `src/fs/safeRead.ts` + label migration          | ✅ done     | cfba788  | 2026-04-24|
| 1a   | safeRead derived-from-mount → REJECT symlinks   | ✅ done     | 841279e  | 2026-04-24|
| 2    | `src/cli/sanitize.ts` + wiring                  | ✅ done     | 103ec9a  | 2026-04-24|
| 3    | `data/classify/settings.v1.json` + projections  | ✅ done     | 0136ed4  | 2026-04-24|
| 4    | `src/gates/` scaffold                           | in-progress | —        | —         |
| 5    | Proof gate: MANIFEST_HASH_ASSERT                | queued      | —        | —         |
| 6    | CONSENT gates (3)                               | queued      | —        | —         |
| 7    | INTEGRITY gates (2)                             | queued      | —        | —         |
| 8    | COMPAT + SHAPE gates (2)                        | queued      | —        | —         |
| 9    | DESTRUCTION + DUAL gates (3)                    | queued      | —        | —         |
| 10   | Finalize `importSetup.ts`                       | ✅ partial  | 9920b38  | 2026-04-24|
| 11   | YAML_SHAPE_NORMAL gate (S89 fix)                | ✅ done     | d40cfa4  | 2026-04-24|
| 12   | Apply gate parity                               | ✅ mvp      | (next)   | 2026-04-24|
| 12b  | Apply SENSITIVE/DESTRUCTIVE gates + provenance  | deferred    | —        | —         |
| 13   | Provenance marker phase 1                       | queued      | —        | —         |
| 14   | history.jsonl gate events                       | queued      | —        | —         |
| 15   | doctor integration                              | queued      | —        | —         |
| 16   | Architecture drift test                         | queued      | —        | —         |

**Baseline test count as of Step 2 merge: 1216 pass / 0 fail / 1 skip.**
All subsequent steps hold green-commit invariant against this number.

## Parallelism

Steps 1 and 2 are independent of each other and of the main refactor.
They run as worktree agents in parallel. Step 3 can run on the main
working tree in parallel with the agents.

Steps 4-16 are sequential.

## The 12 gates (inventory result)

| # | Gate ID                          | Category    | Fires                 | Bypass                                        | Error                       |
|---|----------------------------------|-------------|-----------------------|-----------------------------------------------|-----------------------------|
| 1 | MANIFEST_HASH_ASSERT             | IDENTITY    | always (when flagged) | `--expect-hash` omit                          | MANIFEST_HASH_MISMATCH      |
| 2 | PLUGINS_REQUIRE_ACK              | CONSENT     | always                | `--accept-plugins`, `--skip-plugins`          | FAT_REQUIRES_ACK            |
| 3 | PATCHES_REQUIRE_ACK              | CONSENT     | always                | `--accept-patches`, `--skip-patches`          | FAT_REQUIRES_ACK            |
| 4 | STRICT_PLUGIN_HASH_CHECK         | INTEGRITY   | strict-imports        | none                                          | STRICT_IMPORT_BLOCKED       |
| 5 | STRICT_SCANNER_FINDINGS          | INTEGRITY   | strict-imports        | none                                          | STRICT_IMPORT_BLOCKED       |
| 6 | COMPAT_INCOMPATIBLE              | COMPAT      | always                | `--force`                                     | COMPAT_INCOMPATIBLE         |
| 7 | SCHEMA_VIOLATION                 | SHAPE       | always (under strict) | `--allow-unknown-keys` (unknowns only)        | SCHEMA_VIOLATION            |
| 8 | STRICT_REPLACE_REMOVAL_CAP       | DESTRUCTION | strict-imports        | none                                          | STRICT_IMPORT_BLOCKED       |
| 9 | STRICT_SENSITIVE_CHANGES         | CONSENT     | strict-imports        | none                                          | STRICT_IMPORT_BLOCKED       |
| 10| SENSITIVE_REQUIRES_ACK           | CONSENT     | non-dry-run           | `--accept-sensitive`, `--accept-key=<...>`    | SENSITIVE_REQUIRES_ACK      |
| 11| EXTRA_PLUGIN_PATHS_DUAL          | DUAL        | non-dry-run           | `--accept-plugins`                            | FAT_REQUIRES_ACK            |
| 12| YAML_SHAPE_NORMAL (new)          | SHAPE       | always                | none                                          | YAML_SHAPE_BLOCKED (new)    |

Apply side (Step 12) enables:
- YAML_SHAPE_NORMAL (always)
- SENSITIVE_REQUIRES_ACK (non-dry-run)
- DESTRUCTIVE_YAML_SHAPE (non-dry-run, new — mass USER-key removal)

## Architecture

### Producers (pure functions over ctx)

`src/gates/producers/` — one file per producer. Each produces a named data
artifact that gates can consume.

```
manifestIdentity    → { hash, id, bytes }
sensitiveHits       → string[]                    (wraps changeHitsSensitive)
pluginHashReport    → PluginHashReport | null
scanReport          → ScanReport | null
compatResult        → CompatResult | null
schemaFindings      → ValidationReport | null
replaceWarnings     → ReplaceWarnings | null
normalizedYaml      → Record<string, LuaValue>    (S89 rejection logic)
changes             → Change[]
isReplaceMode       → boolean
```

Producers are pure and memoizable. Same ctx → same output. No side effects.

### Gate definition

```typescript
export interface GateDefinition {
  id: string;
  category: "IDENTITY" | "CONSENT" | "INTEGRITY" | "COMPAT"
          | "SHAPE" | "DESTRUCTION" | "DUAL";
  appliesAt: ("import" | "apply")[];
  requires: (keyof typeof PRODUCERS)[];
  firesIn: "always" | "non-dry-run" | "strict-imports-only";
  bypassFlags: string[];
  errorCode: keyof typeof ErrorCodes;
  check: (ctx: GateContext) => GateResult;
}

export type GateResult =
  | { kind: "pass" }
  | { kind: "block"; message: string; details?: unknown }
  | { kind: "bypass"; byFlag: string };
```

### Orchestrator

```typescript
runGates(appliesAt, ctx, opts) → GateReport

interface GateReport {
  fired: Array<{ id: string; result: GateResult; boundary: string }>;
  blocked: boolean;
  blockingGates: string[];
}
```

Consumer pattern:

```typescript
const gateReport = runGates("import", ctx, { dryRun, strictImports });
if (gateReport.blocked) {
  // Orchestrator already collected messages; rethrow the first blocking
  // gate's error to preserve the current user-facing behavior.
  throw firstBlocking(gateReport);
}
```

### Classification data model

`data/classify/settings.v1.json`:

```json
{
  "$schema_version": 1,
  "keys": {
    "zlibrary_password": {"exfil": "secret",  "change": "none",                 "hygiene": "persistent"},
    "extra_plugin_paths": {"exfil": "normal", "change": "sensitive-code-exec",  "hygiene": "persistent"},
    "kosync.userkey":     {"exfil": "secret", "change": "none",                 "hygiene": "persistent"}
  },
  "rules": [
    {"suffix": "_initial_default_setup_done", "set": {"hygiene": "ephemeral"}},
    {"regex": "^simpleui_defaults_v\\d+$",    "set": {"hygiene": "ephemeral"}}
  ]
}
```

Exports from `src/schema/classify.ts` after Step 3:
- `exfilClass(key)` → `"secret" | "normal"`
- `changeClass(key)` → `"none" | "sensitive-network" | "sensitive-ssh" | "sensitive-code-exec" | "sensitive-fs" | "sensitive-debug" | "destructive"`
- `hygieneClass(key)` → `"persistent" | "ephemeral"`
- `classifyKey(key)` → legacy compatibility wrapper (kept for Steps 3-10 transition)

## Per-step detail

### Step 0 — setup

Files:
- `docs/infra/99-gates-refactor-plan.md` (this file)
- Memory: `project_kindly_gates_refactor.md` pointer in `~/.claude/memory/`

DoD: branch exists, plan doc committed, memory entry indexed.

### Step 1 — safeRead (PARALLEL AGENT + CORRECTION)

Files:
- NEW `src/fs/safeRead.ts`
- NEW `tests/fs/safeRead.test.ts`
- Labels added at ~98 callsites across `src/` (see agent prompt)

Exports:
```typescript
export type PathProvenance =
  | "user-provided"       // argv, --mount, --file, positional — user consented
  | "derived-from-mount"  // join(mount.root, ...)            — mount-content is UNTRUSTED
  | "derived-from-cwd"    // .kindly/ local tree              — host is TCB
  | "extracted-archive";  // tmpdir post tar-extract          — UNTRUSTED

export function readText(path: string, prov: PathProvenance): string
export function readBytes(path: string, prov: PathProvenance): Buffer
export function exists(path: string, prov: PathProvenance): boolean
export function statFollow(path: string, prov: PathProvenance): Stats
export function statNoFollow(path: string, prov: PathProvenance): Stats
export function copyFile(src: string, srcProv: PathProvenance, dst: string, dstProv: PathProvenance): void
```

**Behavior — CORRECTED after initial design review**:

The first draft of this step treated `derived-from-mount` as "preserve current
behavior (follow symlinks)." Review correctly identified this as a hole. The
mount is attacker-plantable content (USB-writable, historically-pwned via
KOReader RCE, or shared hardware). A `settings.reader.lua → ~/.ssh/id_rsa`
symlink on the Kindle filesystem would exfiltrate host secrets through
LuaParseError message leak (S281 class) or via pull writing the attacker's
value into `kindly.yaml`. Closes **S211 / S241 / S242 / S243** (Batch K).

Correct behavior by provenance:

| Provenance             | Symlink follow  | Rationale                              |
|------------------------|-----------------|----------------------------------------|
| `user-provided`        | ✓ follow        | User typed the path; their consent     |
| `derived-from-cwd`     | ✓ follow        | Host is the TCB                        |
| `derived-from-mount`   | ✗ REJECT        | Mount-content is untrusted data        |
| `extracted-archive`    | ✗ REJECT        | Untrusted (tar)                        |

Mount symlink rejection uses `lstatSync` at the boundary with a structured
error ("refusing to follow symlink at mount-derived path — mount is treated
as untrusted data"). The user's escape hatch for legitimate symlinked
Kindle content is a future `--trust-mount` flag (out of scope for Step 1);
if the need surfaces, record as a deferred item.

Existing explicit symlink rejections in `src/setup/unpack.ts` consolidate via
the `extracted-archive` helper.

**If the agent shipped with the initial flawed design (follow on
derived-from-mount), a remediation commit after Agent 1 completion must:
flip the `derived-from-mount` branch to reject, update tests, re-run
suite.** Callsite labels don't change — the enforcement moves up.

DoD: suite green, `tests/fs/safeRead.test.ts` passes with per-provenance
coverage including mount-symlink-reject, all callsites labeled.

### Step 2 — sanitize (PARALLEL AGENT)

Files:
- NEW `src/cli/sanitize.ts`
- NEW `tests/cli/sanitize.test.ts`
- Modified `src/cli/log.ts`, `src/cli/json.ts`, `src/types/errors.ts`
- Modified renderer sites in `src/commands/setup.ts`, `src/commands/plugin.ts`

Exports:
```typescript
export function sanitizeForTerminal(s: string): string
export function writeRaw(writer: Writer, s: string): void  // escape hatch
```

Strips bare ANSI escape bytes except whitelisted color SGR codes (30-37,
40-47, 90-97, 100-107, 0, 1, 22). Strips lone `\r` (preserves `\r\n`).
Default-on via `StreamWriter.write`.

DoD: suite green, 4 new tests pass, control bytes in user strings are
rendered inert.

### Step 3 — classify data file

Files:
- NEW `data/classify/settings.v1.json` (generated from current Sets)
- NEW `scripts/build-classify.ts`
- MOD `src/schema/classify.ts` — rewrite as projections
- MOD `tests/schema/classify.test.ts` — 12 assertions migrate to per-axis

Keep `classifyKey()` wrapper so consumer sites don't need changes yet.

DoD: data file committed, projections pass existing tests via compat
wrapper, 12 test assertions migrated to new per-axis functions.

### Step 4 — gates scaffold

Files:
- NEW `src/gates/{registry,context,orchestrator}.ts`
- NEW `src/gates/producers/index.ts`
- NEW `src/gates/definitions/index.ts`
- NEW `tests/gates/orchestrator.test.ts`

Scaffold only. No gates registered. Orchestrator with empty registry
returns "passed everything" report.

DoD: types exported, orchestrator callable, 2-3 scaffold tests pass.

### Step 5 — proof gate: MANIFEST_HASH_ASSERT

Smallest gate, no producers. Port first as shape-check.

Files:
- NEW `src/gates/definitions/identity.ts`
- MOD `src/gates/registry.ts` — register MANIFEST_HASH_ASSERT
- MOD `src/lib/importSetup.ts` — replace inline throw (lines 358-370)

Gate impl:
```typescript
{
  id: "MANIFEST_HASH_ASSERT",
  category: "IDENTITY",
  appliesAt: ["import"],
  requires: [],  // reads options directly
  firesIn: "always",
  bypassFlags: [],
  errorCode: "MANIFEST_HASH_MISMATCH",
  check: (ctx) => {
    if (!ctx.opts.expectHash) return { kind: "pass" };
    const actual = hashBytes(ctx.manifestBytes);
    return actual === ctx.opts.expectHash
      ? { kind: "pass" }
      : { kind: "block", message: `expected ${ctx.opts.expectHash} but Setup hashes to ${actual}` };
  },
}
```

**STOP CONDITION**: if `tests/cli/setupImportExpectHash.test.ts` needs
modification to pass, the gate abstraction is wrong. Rework before
porting other gates.

DoD: suite green, inline throw removed from importSetup.ts:358.

### Steps 6-9 — gate migration

Grouped by category. Each step is one commit:

| Step | Gates migrated                                    | Producers added                       |
|------|---------------------------------------------------|---------------------------------------|
| 6    | PLUGINS/PATCHES_REQUIRE_ACK, SENSITIVE_REQUIRES_ACK | sensitiveHits                       |
| 7    | STRICT_PLUGIN_HASH_CHECK, STRICT_SCANNER_FINDINGS | pluginHashReport, scanReport          |
| 8    | COMPAT_INCOMPATIBLE, SCHEMA_VIOLATION             | compatResult, schemaFindings          |
| 9    | STRICT_REPLACE_REMOVAL_CAP, STRICT_SENSITIVE_CHANGES, EXTRA_PLUGIN_PATHS_DUAL | changes, replaceWarnings |

Each step: suite stays green. Existing test files (setupImportSensitive,
setupScanner, setupImportReplace, setupImportExtraPluginPaths,
setupImportExpectHash) pass unchanged because error codes and behaviors
are preserved.

### Step 10 — finalize importSetup.ts

After gates 1-11 are registered, `executeSetupImport` becomes a thin
orchestrator:

```typescript
export function executeSetupImport(opts, env) {
  const loaded = loadSetup(path);
  const ctx = buildImportContext(loaded, opts, env);
  const gateReport = runGates("import", ctx, { dryRun: opts.dryRun, strictImports: opts.strictImports });
  if (gateReport.blocked) throw firstBlocking(gateReport);
  // ... rest: snapshot, write, install, history ...
}
```

Target: importSetup.ts drops from 764 LOC to ~200 LOC.

DoD: importSetup.ts under 250 LOC, full suite green.

### Step 11 — YAML_SHAPE_NORMAL (S89 fix)

New producer + new gate. Producer owns the shape rejection:

```typescript
// src/gates/producers/normalizedYaml.ts
export function normalizedYaml(ctx) {
  const raw = yamlToLua(ctx.yamlSource);
  // Reject if any top-level key is exfilClass === "secret":
  //   YAML must not contain SECRET-class keys at all (they only exist on device).
  // Reject if any known-parent-of-secret path (kosync) has non-object value:
  //   non-object at a secret-parent wipes nested secrets on merge.
  // Reject if any nested secret path has literal null:
  //   explicit secret wipe.
  //
  // If any rejection fires, throw YamlShapeError(kind, path, actual).
  // The gate wraps this into GateResult.block.
  return normalized;
}
```

Gate registered with `appliesAt: ["import", "apply"]`.

Tests: 7 new tests in `tests/gates/yamlShape.test.ts` — one per S89
variant from memory file `project_kindly_s89_yaml_null_wipes_secrets.md`.

DoD: all 7 S89 variants now block with structured error; existing
apply/import paths green.

### Step 12 — apply gate parity

Files:
- MOD `src/lib/apply.ts` — route through orchestrator
- NEW `src/gates/definitions/destruction.ts` — add DESTRUCTIVE_YAML_SHAPE
- MOD `src/commands/apply.ts` — add `--accept-sensitive`, `--accept-key`, `--accept-destructive` flags
- NEW `tests/cli/applyGates.test.ts` — 6 tests

Apply's gate list:
- YAML_SHAPE_NORMAL (already shared from Step 11)
- SENSITIVE_REQUIRES_ACK (now fires on apply too)
- DESTRUCTIVE_YAML_SHAPE (new: YAML removes >5 USER keys vs device)

Existing `tests/cli/apply*.test.ts` may need fixture updates to avoid
tripping the new gates. Add `// pre-gate-parity baseline` comments.

This is the test-churn step. Budget a full day.

DoD: suite green, new tests pass, apply blocks crafted malicious YAML.

### Step 13 — provenance marker phase 1

`kindly pull` writes a YAML header:

```yaml
# kindly-provenance: sha256:<device-settings-hash> ts:<iso>
# ...
```

`normalizedYaml` producer reads the header, logs presence to ctx.
**No auto-bypass yet** — observe in practice first.

DoD: pulled YAMLs have header; gate records presence; behavior unchanged.

### Step 14 — history.jsonl gate events

New entry type `"policy:gate"`:

```json
{"cmd": "policy:gate", "ts": "2026-04-24T...", "entry": {
  "gate_id": "SENSITIVE_REQUIRES_ACK",
  "boundary": "import",
  "result": "bypassed",
  "bypass_flag": "--accept-sensitive",
  "context_summary": {"sensitive_count": 3, "domains": ["ssh", "network"]}
}}
```

Orchestrator emits one entry per gate firing (pass, bypass, block).

DoD: `tests/history/gateEvents.test.ts` passes (3 cases: pass/bypass/block).

### Step 15 — doctor integration

`src/lib/doctor.ts` gains new check category `gates`:

- `gates.registered` — info, count per boundary
- `gates.recent_bypasses` — warning if bypass count > 3 in last 30 days
- `gates.coverage` — info summary

DoD: `kindly doctor` surfaces gate info; fixture-based tests pass.

### Step 16 — architecture drift test

`tests/arch/gatesOnly.test.ts`:

```typescript
test("no KindlyError throws outside src/gates/ except whitelisted", () => {
  const grepped = greppedThrowsOutsideGates();
  const nonWhitelisted = grepped.filter(hit => !WHITELIST.has(`${hit.file}:${hit.line}`));
  expect(nonWhitelisted).toEqual([]);
});
```

Whitelist lives in test file, each entry has a comment explaining why.

DoD: test passes today; fails on any future inline policy throw outside gates/.

## Resume instructions (if context is lost)

1. `git checkout gates-refactor`
2. `cat docs/infra/99-gates-refactor-plan.md` — this file
3. Read progress table (top of this file); identify next queued step
4. `git log --oneline gates-refactor ^main` — see what's committed
5. Read memory: `project_kindly_gates_refactor.md`
6. Continue from next queued step

## Critical decisions (already made)

- **Directory name**: `src/gates/`, not `src/policy/`. Producers stay in
  owning modules; only gate definitions + orchestrator live under gates/.
- **Classify data location**: `data/classify/settings.v1.json`, matches
  existing `data/schemas/`, `data/taxonomy/`, `data/catalog/` pattern.
- **Apply's trust default**: phase 1 enables YAML_SHAPE_NORMAL only
  (zero-FP); SENSITIVE + DESTRUCTIVE gates fire only when user passes
  `--untrusted-yaml`. Provenance auto-bypass is phase 2.
- **Escape hatch for imperative gates**: deferred. All 12 current gates
  are pure predicates. Extend `GateResult` with `{kind: "prompt", ...}`
  when first non-pure gate appears.
- **`setup.ts` flatten**: deferred to track 9. Independent of gate work.

## Open decisions (to resolve mid-refactor)

- Whether producers memoize within a single run (default yes, but not
  load-bearing for correctness).
- Which `DESTRUCTIVE_YAML_SHAPE` threshold — start at 5 USER keys, tune
  from observed apply runs.
- Whether `kindly pull` provenance header should include per-key hashes
  or just the whole-file hash (phase 2 decision).

# 93 — Lua static scanner: W36 (plugins) + W37 (patches)
### *Contract for v0.11.1. Rationale in 87-security-matrices.md §2.2 A3/A4.*

Date: 2026-04-23.
Status: spec (code will cite this file).

---

## 1. Problem

Fat Setups ship `plugins/*.koplugin/**/*.lua` (A3) and `patches/*.lua` (A4).
W32 verifies those files against catalog hashes, but a novel plugin has no
catalog entry and a MALFORMED verdict doesn't describe *what the novel code
does*. A reviewer accepting an `UNCATALOGUED` plugin today has no signal
beyond the filename.

W36+W37 add a lexical scan that flags a short list of dangerous call
patterns — the kind that distinguish "reading config" from "shelling out
to busybox". The scanner is not a decompiler and not an AST analyzer; it's
a smoke detector wired into the import preview.

---

## 2. Threat model

### 2.1 What we catch

These are the Lua constructs that, if present, move a plugin from "could
misbehave" to "could run arbitrary code / exfiltrate / persist":

| Pattern | Category | Why it matters |
|---------|----------|----------------|
| `os.execute` | shell | arbitrary shell command |
| `io.popen` | shell | arbitrary shell, captures stdout |
| `loadstring` / `load(<not-a-string-literal>)` | dynamic-load | Lua source built at runtime from network/disk |
| `dofile(<not-a-string-literal>)` | dynamic-load | execute Lua at attacker-chosen path |
| `require("socket")` / `require("socket.http")` | network | raw sockets outside KOReader's networkmanager |
| `require("ssl")` / `require("ssl.https")` | network | same, TLS variant |
| `require("ffi")` | native-code | LuaJIT FFI → call arbitrary C / syscalls |
| `package.loadlib` | native-code | load `.so` / `.dll` into process |
| `debug.setfenv` / `debug.getregistry` / `debug.sethook` | reflection | tamper with other plugins' state |
| `os.remove(<absolute path>)` / `os.rename(<absolute path>)` | fs-outside-scope | file ops outside `koreader/` |
| `io.open(<absolute path>, "w" or "a" or "r+")` | fs-outside-scope | same for io-layer writes |

### 2.2 What we explicitly don't catch (and why)

- **Obfuscation bypasses.** `_G["os"]["execute"]`, string-built call
  names, `load(string.char(...))`, base-N encoded bodies. Any of these
  defeat lexical scanning. A capable AST walker would catch the first two
  and still lose the third. The backstop is the reviewer and the W32
  catalog hash — if a new `statistics.koplugin` ships with a
  base64-decoded payload that its stock version doesn't have, the
  *hash mismatch* is what protects us, not the scanner.
- **Data-only exploits.** A plugin that writes an attacker-chosen URL
  into `settings.reader.lua` is caught by the SENSITIVE gate (W31), not
  here. Overlap with W31 is fine; layers.
- **Indirect shell via library wrappers.** `util.execute(cmd)` where
  `util.execute = os.execute` at the top of the file *will* match
  because the assignment itself is an `os.execute` occurrence. Chains
  across files (requires → re-exports → call) are punted; the reviewer
  reads the whole shipped bundle.

The scanner is worth shipping even knowing these gaps because the median
attacker writes unobfuscated Lua — the A3/A4 threat model in docs/87 is
"someone posts a zip on a forum", not "nation-state Lua crypter".

---

## 3. Scan algorithm

Lexical, not AST. Rationale:

1. There is no first-class Lua parser on the Bun/TS side. Shipping one
   for this alone is a net loss.
2. Any parser we adopt has to handle every syntax KOReader uses,
   including LuaJIT-isms. Error = scanner crashes on a legit plugin =
   worse than missing a finding.
3. Lexical scan is O(bytes) and trivial to bound (see §7).

The scanner:

1. **Strip comments** — long-bracket `--[[...]]` and line `-- ...`.
   Comments mentioning `os.execute` in a TODO must not match.
2. **Strip string literals** — short (`"..."`, `'...'`) and long-bracket
   (`[[...]]`, `[==[...]==]`). A string containing `os.execute` is data,
   not a call. (Caveat: `loadstring("os.execute('rm')")` loses this
   argument — but the `loadstring` itself is already a finding, so the
   conclusion is the same.)
3. **Walk the residue with a small set of regexes** (§4). Each regex
   returns match + line number.
4. **Classify the call sites** by pattern → category (see 2.1 table).

Nothing recursive, nothing context-sensitive beyond "not inside a string
or comment." Implementation fits in ~150 LOC.

---

## 4. Pattern catalog (the actual regexes)

All patterns anchor on a word boundary so `myos.execute` doesn't
false-positive on `os.execute`. The exact regex for each call type lives
in `src/setup/luaScan.ts` (§6); the spec-level catalog:

- `\bos\.execute\s*\(`
- `\bio\.popen\s*\(`
- `\bloadstring\s*\(`
- `\bload\s*\(\s*[^"'[]` — `load("literal")` passes; anything else flags
- `\bdofile\s*\(\s*[^"'[]` — same rule as `load`
- `\brequire\s*\(\s*["'](socket|socket\.http|ssl|ssl\.https|ffi)["']\s*\)`
- `\bpackage\.loadlib\s*\(`
- `\bdebug\.(setfenv|getregistry|sethook|setupvalue|upvaluejoin)\b`
- `\bos\.(remove|rename)\s*\(\s*["']/` — absolute path starts with `/`
- `\bio\.open\s*\(\s*["']/[^"']+["']\s*,\s*["'][waW+]` — abs path + write mode

Escape hatches for known-benign legacy: `load(foo)` where `foo` is a
module-local variable is probably fine but we flag it anyway and let
the reviewer judge. A finding is not a block; see §5.

---

## 5. Verdict shape + integration

The scanner output piggybacks on `PluginHashReport` (W32). A new field
next to the existing `verdicts`:

```ts
type ScanFinding = {
    plugin: string;              // plugin folder name ("statistics.koplugin")
    file: string;                // path relative to the plugin folder
    line: number;                // 1-indexed
    category: ScanCategory;      // "shell" | "dynamic-load" | "network" |
                                 // "native-code" | "reflection" |
                                 // "fs-outside-scope"
    snippet: string;             // ≤80 chars of the offending line, trimmed
};

type ScanReport = {
    findings: ScanFinding[];     // empty when nothing flagged
    filesScanned: number;
    bytesScanned: number;
    suppressedByCatalog: number; // .lua FILES skipped because their
                                 // containing plugin had a catalog MATCH
                                 // verdict (§5.2). Counts files, not
                                 // findings or plugins.
};
```

### 5.1 Where findings attach

- **W36:** scan every `*.lua` under every plugin folder shipped in a fat
  Setup (recurse — a plugin may have `lib/`, `ui/`, etc).
- **W37:** scan every `patches/*.lua` the Setup ships.
- Both funnel into the same `ScanReport`. The `plugin` field
  distinguishes them (patches use a sentinel name `"(patch)"`).

### 5.2 Catalog suppression (the load-bearing decision)

A finding on a file whose sha256 appears in the catalog as a MATCH is
*suppressed* (counted in `suppressedByCatalog`, not emitted). Rationale:

- The catalog curators already read the file. If `statistics.koplugin`
  legitimately uses `io.popen` to ask the kernel how many bytes the
  reader flushed, we accept it on their say-so. The curator reviewed
  it; we don't need to re-scold the user.
- Novelty is the threat. A tampered `statistics.koplugin` has a
  different hash → doesn't match → findings fire. A novel
  `evil.koplugin` is UNCATALOGUED → findings fire.
- Suppression pairs naturally with W32's existing verdict taxonomy. The
  three noisy verdicts (MISMATCH, UNCATALOGUED, MALFORMED_STRUCTURE)
  all leave scanner findings visible; the quiet verdict (MATCH) silences
  them.

This collapses the "hard block vs warn-only vs whitelist" design space
into one answer: **the catalog is the whitelist, and W32 already
enforces it.**

### 5.3 --strict-imports coupling

Under `--strict-imports` (W34e), any non-zero `findings.length` throws
`STRICT_IMPORT_BLOCKED` — same error code, additional message. CI is
supposed to refuse surprising code, and "a plugin you're about to
install has an `os.execute` we didn't suppress" is exactly that surprise.

### 5.4 No gate outside strict mode

A finding in a normal `--accept-plugins` import prints a warning
block. It does **not** add a third acceptance flag. Rationale: `--accept-plugins`
already means "I reviewed the Lua". We don't want the user to learn a
ritual of `--accept-plugins --accept-scanner-findings --accept-sensitive`
that trains them to click-through. The warning block is loud; no flag.

---

## 6. File layout

- `src/setup/luaScan.ts` — pure function `scanLuaSource(source: string): ScanMatch[]`
  and the comment/string stripper. Unit-tested against pattern families.
- `src/catalog/scanPipeline.ts` — `scanShippedLuaFiles(manifest, files,
  hashReport): ScanReport`. Knows about catalog suppression.
- `src/types/results.ts` — `ScanReport` on `SetupImportResult` alongside
  `pluginHashReport`.
- Rendering: extend `renderPluginHashReport` in `src/commands/setup.ts`
  to print a `findings:` block.

No new command. No new flag. No new error code (reuse
`STRICT_IMPORT_BLOCKED`).

---

## 7. Performance bounds

Bounds already established by W34c (archive extraction caps):

- **Total Lua bytes scanned ≤ `DEFAULT_MAX_UNCOMPRESSED_BYTES` (500 MiB).**
  In practice a fat Setup with 50 plugins is ≤ 2 MiB. Worst-case pathological
  Setup stays under the 500 MiB cap.
- **Per-file timeout:** none. Regex engine is linear; stripping is one
  forward pass. A 500 MiB file would take ~2s, still bounded.
- **Memory:** one pass, no AST. Peak is two copies of the largest file
  (raw + stripped). For a 1 MiB file that's 2 MiB RAM.
- **Short-circuit on already-done work:** if a plugin's verdict is MATCH,
  skip the scan entirely — the suppression would discard findings anyway.
  Saves cycles on legitimate bundled plugins, which will be the common
  case.

No streaming needed at v0.11.1 sizes. Revisit if someone ships a
multi-MiB plugin.

---

## 8. UX

### 8.1 `kindly setup inspect --vs-device` (W11)

Findings on the current Setup appear under `contents:` like:

```
  scanner findings: 3 across 2 file(s)
    [shell]         plugins/weather.koplugin/main.lua:42
      -- os.execute("curl -s " .. url .. " | tee /tmp/w")
    [dynamic-load]  plugins/weather.koplugin/main.lua:58
      -- loadstring(resp)()
    [network]       patches/2-api-override.lua:9
      -- local http = require("socket.http")
```

Categories colored red in TTY mode (reuse the existing `paint("red", ...)`).

### 8.2 `kindly setup import`

Same block, emitted immediately after the W32 hash report. `--dry-run`
shows it; a real import shows it and proceeds unless `--strict-imports`
kicks in.

### 8.3 `--json` envelope

`data.scanReport: ScanReport` on setup inspect + setup import. No
renaming, no schema version bump needed — it's a new optional field.

---

## 9. Tuning validated by FP survey

The bundled-plugin inventory in `docs/93-lua-dangerous-calls-inventory.md`
resolved every open question in favor of the spec as written. Summary:

- **95 hits across 17 plugins, 0 suspicious.** Every dangerous call
  serves a documented purpose (sshd lifecycle, NTP sync, template
  compilation, OPDS/Calibre sync, PTY management).
- **28 hits in `recommended` plugins** — confirms hard-block is wrong;
  catalog suppression is right.
- **Q1 (`io.popen` noise):** only 3 hits across catalogued plugins
  (systemstat, timesync). Suppression absorbs them. **No `severity`
  field on `ScanFinding`.**
- **Q2 (`io.open` absolute vs relative):** all 20 writes go to
  well-scoped paths (export dirs, PID files, download targets). The
  abs-path-only filter in §4 stays as-is.
- **Q3 (`require("ffi")` bundled):** yes — opds and timesync are both
  recommended. Catalog trust carries it. **No whitelist table needed.**
- **`dofile(<non-literal>)`:** 0 hits. Both real `dofile` uses pass
  string literals. The non-literal filter is correctly tuned.
- **`package.loadlib` and `debug.getregistry`:** 0 hits. Zero-FP coverage
  — keep them in the catalog.

The survey also exercised one robustness case worth calling out:
`autostandby/main.lua:178` contains a commented-out `os.execute`.
§3's comment-stripping step must handle this — verified by the unit
tests on `scanLuaSource` (`luaScan.test.ts`).

**Real-world value demonstration:** `localsend` alone contributes 19
dangerous-call hits (10 `os.execute` + 9 `io.popen`) for its
self-update mechanism. Without the scanner, a reviewer sees just
"UNCATALOGUED localsend". With it, they see exactly what it's doing
and can make an informed accept/reject call.

---

## 10. Non-goals

- Decompiling bytecode. If a fat Setup ships `*.luac`, we refuse the
  whole import with a new code `SETUP_BYTECODE_REFUSED`. Spec'd later
  if the FP survey shows this case exists; otherwise left as a "flag
  the byte signature `\x1bLua`" one-liner in luaScan.
- Catching exfiltration patterns (`io.write` to anything). Too noisy
  on plugins that log to their own files.
- Detecting prototype-pollution-style attacks via `_G`. Legitimate
  plugins mutate globals constantly (the KOReader convention). We'd
  need semantic analysis to tell harm from normal use.

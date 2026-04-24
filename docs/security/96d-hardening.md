# 96d — Confirmed defenses, threat model, and v0.11.2 hardening plan (§2–§9)

> Split from the original 96-red-team-v0.11.1.md.
> Other parts: [96a](96a-findings-core.md) (S1–S51), [96b](96b-findings-extended.md) (S52–S67), [96c](96c-findings-probes.md) (S68–S88), [96e](96e-koreader-live.md) (§10–§11).
> This file contains the actionable hardening plan (§8) — load this when implementing fixes.

## 2. Bonus finding (false alarm, for the record)

Defender flagged `settings.kosync.password_md5` in the manifest as a
leaked credential. Verified: `password_md5` does not exist in the real
KOReader `kosync.koplugin`. The real credential is `kosync.userkey`,
which **is** in `SECRET_PATHS` (src/schema/classify.ts:38) and is
correctly filtered. Test fixture was an invented field name; defender
pattern-matched on the suspicious name.

Real filter verified end-to-end with a `kosync.userkey` fixture:
`filtered 2 secret(s)`, credential absent from exported manifest.
**No gap — withdrawn.**

---

## 3. Confirmed defenses (as of e8ce545)

| Attack | Defense | Status |
|--------|---------|--------|
| Plugin catalog impersonation + tampering | W32 known_hashes + W34e strict gate | Fixed today |
| Settings-only SENSITIVE keys (ota_server, extra_plugin_paths, …) | W31 SENSITIVE gate | Shipped |
| Secret keys in manifest | classify.ts SECRET_KEYS + SECRET_PATHS | Shipped, verified |
| Fat archive without explicit flag | `--accept-plugins` / `--accept-patches` gate | Shipped |
| Unobfuscated shell / network / dynamic-load | W36/W37 lexical scanner | Shipped |
| Archive path-traversal / absolute paths / symlinks (S8) | W34b: `isSafeRelativePath` + declared-or-reject + `lstatSync` symlink reject | Shipped, re-verified |
| Network-endpoint redirection (calibre_wireless_url, ota_server, http_proxy, trans_server, zlibrary_base_url, opds_servers, kosync.custom_server) (S10) | W31 SENSITIVE gate, domain=`network` | Shipped, re-verified |
| Partial shadow — extra file inside catalog-match plugin dir (S11) | `verify.ts` per-file compare → `extra` verdict → MISMATCH | Shipped, verified |
| replace-mode removals of SENSITIVE keys (S18) | W31 gate fires for removal direction too, exit 3 | Shipped, verified |
| ANSI escapes inside settings *values* (S25) | Settings-value renderer JSON-escapes C0 control chars | Shipped, verified (contrast with S7 meta-field gap) |
| Lua-writer string-escape injection (S30) | `lua/writer.ts` double-escapes embedded quotes | Shipped, verified |
| Export slug path-traversal (S31) | Slug sanitizer strips `../`, null bytes, etc. | Shipped, verified |
| Fat `.kset` declaration bomb — 50k phantom entries (S32) | Structural guard: declared ∩ archive + hash-recompute | Shipped, verified via implicit guard (no explicit ceiling) |
| Manifest hash-lie (S33) | `unpack.ts:138-144` recomputes `hashBytes(buf)` and compares | Shipped, verified |
| YAML billion-laughs (S35) | `yaml` library's default `maxAliasCount` | Shipped, parser-level |
| Newline/CR injection in settings values (S37) | `lua/writer.ts` escapes `\n`/`\r` as literal backslash-n/r | Shipped, verified |
| `kindly pull` SECRET leak (attempted) | `executePull` routes through `luaToYaml → filterForYaml` (classify.ts:228), strips all 10 SECRET_KEYS + both SECRET_PATHS before YAML gen; PullResult carries `droppedSecrets: string[]` — key names only | Shipped, verified 2026-04-23 with every secret slot populated; zero survival in YAML or JSON output |
| Compat-gate spoofing (attempted) | `checkCompat` takes `detected` from `readKoreaderVersion(mount)` + `detectDeviceFamily(mount)` — device-sourced ground truth, manifest cannot override | Shipped, verified 2026-04-23; fail-open on unknown-device is not attacker-controllable (manifest has no path to influence `detected`) |
| Log injection via manifest-controlled ANSI into history.jsonl / trace.jsonl (attempted) | `appendHistoryEntry` only receives setup_id hash + counts + paths from `importSetup.ts:740-752`; trace stores argv_hash (SHA-256[:12]) not raw argv; manifest strings never reach either writer | Shipped, verified 2026-04-23; `--label` is user-typed (self-inflicted, not attacker vector) and JSON.stringify-escaped on write |
| Attack surface in `plugin` / `watch` / `init` commands (attempted) | `plugin.ts` — read-only catalog browse; `watch.ts` — read-only tail of history.jsonl; `init.ts` — writes a hardcoded preset to cwd, no device touch; none import classify.ts because none write device state on attacker-controlled input | Shipped, verified 2026-04-23 via code audit; no attacker-controllable path/YAML/archive/fetch surface |
| YAML type-coercion bypass of SENSITIVE key-name match (F-probe, attempted) | `classify.ts` uses `Set.has(key)` on strings — YAML type tags, flow style, and homoglyphs all resolve to distinct JS string keys. F1 `"false"` (string) → Lua string → truthy in Lua and in §8.1's proposed `value !== false` check — correctly no bypass. F2 `!!bool false` flow-style → JS `false` → §8.1 gate would correctly fire. F3 Cyrillic `plugins_disаbled` → new dead key invisible to KOReader (which also does exact Lua-table lookup). Strict equality matches KOReader's own matching semantic | Shipped, verified 2026-04-23 via third-AI E/F/G probe; no normalization needed |
| Compression-bomb parity on restore path (G-probe, attempted) | `restore.ts:81` calls `assertSafeArchive(archivePath)` → `enforceSizeCaps` (archive bytes + uncompressed bytes + ratio) **before** the safety-snapshot step (:115) and **before** `extractTarGz` (:136). `extractTarGz` re-runs `enforceSizeCaps` internally (belt-and-suspenders). A bomb tar is rejected at :81, never triggering snapshot or extraction | Shipped, verified 2026-04-23 via third-AI G-probe; correct call order |
| S50/S52 primitives on `setup import --archive` path (attempted) | `setup/unpack.ts:86-88` lstat-checks manifest.yaml for symlink; `:113` rejects undeclared entries; `:127-132` lstat-checks every declared file with `isSymbolicLink()` + `!st.isFile()` → catches symlinks AND non-regular-files (FIFO/chardev/socket/block-dev). Duplicate-entry symlink-write-through tested live: BSD tar unlink-first default refuses to follow pre-existing symlink on regular-file overwrite — host file unchanged. Defense-in-depth: residual symlink still caught by post-extract lstat | Shipped, verified 2026-04-23 via code audit + live dup-entry probe; meaningfully better defended than restore/rollback — §8.7 scope does not extend here |
| `setup export` symlink-follow into packed `.kset` (attempted) | `collectPluginDirs` / `collectPatches` (`setup/files.ts:121-131`, `:85-89`) use `Dirent.isFile()` / `isDirectory()` which reports symlinks as neither — filter silently skips them. Comment at `files.ts:131`: "Symlinks and specials are intentionally skipped." A compromised mount with symlinks pointing at host files cannot transit into an exported `.kset` | Shipped, verified 2026-04-23 via code audit; producer-side smuggle-path closed |
| `safeWrite` symlink at `.old` or `.tmp` (H-probe, attempted) | `safeWrite.ts:103` rename replaces directory entry, not target (POSIX semantics); `:84` `unlinkSync` removes any planted symlink; `:85` `openSync(tmpPath, "wx")` uses `O_CREAT\|O_EXCL` which refuses to follow symlinks on both BSD and Linux. Live probe planted `<final>.old → /tmp/victim`, `<final>.tmp → /tmp/victim-tmp`; ran `kindly apply`; both victim files untouched, symlinks replaced by regular files | Shipped, verified 2026-04-23 via third-AI H-probe; no symlink-follow on either rename path |
| doctor/watch crash via pathological settings values (I-probe, attempted) | Ran `kindly doctor` against 10 MB string value, 100-level nested table, invalid UTF-8 bytes `\xfe\xff\x80`, 64 KB key name. All four completed in <1s with no crash/OOM/hang. Lua parser (`src/lua/reader.ts`) is iterative, not recursive — deep nesting doesn't blow the stack. Invalid UTF-8 passes through as raw bytes (Node/Bun strings are UTF-16 internally; parser treats as opaque). `kindly pull` on the 10 MB fixture emitted the full YAML without issue | Shipped, verified 2026-04-23 via third-AI I-probe; doctor and pull are robust to pathological input |
| `TMPDIR` hijack of `setup import` extraction stage (K-probe, attempted) | `setup/unpack.ts:139` uses Node `fs.mkdtempSync(join(tmpdir(), "kindly-unpack-"))` which creates the stage dir with mode `0700` by default on POSIX — other-UID processes cannot read, even when `TMPDIR` points at an attacker-controlled dir with mode `0777`. `:149-151` `rmSync(stage, { recursive: true, force: true })` in `finally` bounds the stage lifetime. Live probe: scaffolded `/tmp/audit-K/attacker-tmp`, built `stash-probe.kset` (988 B, 2 plugin files with "SENSITIVE_LUA_BYTES_v_VICTIM_SECRET_STASH_12345" + "VICTIM_ACCESS_TOKEN_deadbeefcafe0001"), ran a 0.01s polling watcher against `kindly-unpack-*` while executing `TMPDIR=/tmp/audit-K/attacker-tmp kindly setup import stash-probe.kset --accept-plugins`. Watcher harvested zero files — `mkdtempSync`'s 0700 prevents cross-UID read, and `rmSync` closes the window | Shipped, verified 2026-04-23 via live TMPDIR hijack probe; incidentally mitigates S53 for extraction tmpdirs only (not for `.kindly/backups/` which is the real plaintext-SECRET exposure) |
| YAML 1.1 bool coercion of `plugins_disabled.<name>: no` (other-AI N1-probe, attempted) | `yaml` library (eemeli/yaml) defaults to YAML 1.2 — `no`/`yes`/`on`/`off` parse as strings, not booleans. Live: `parsed.plugins_disabled.terminal` = string `"no"`. The §8.1-proposed falsy check (`value === false`) would correctly *skip* this hit (string `"no"` is truthy in JS). Lua writer emits as quoted `"no"`; KOReader's `plugins_disabled.terminal = "no"` is truthy → terminal stays disabled. No semantic mismatch between gate logic and KOReader's table-lookup truthiness | Shipped, verified 2026-04-23 via third-AI N1-probe; YAML 1.2 mode + strict equality check is coherent end-to-end |
| Unicode normalization bypass of SENSITIVE key-name match (other-AI N2-probe, attempted) | All 22 entries in `SENSITIVE_KEYS` (classify.ts:45-74) are pure ASCII (`/^[\x00-\x7f]+$/`). `Set.has()` uses strict byte-equal `===`. An attacker key like NFD `"café"` vs. NFC `"café"` would differ under `===`, but no ASCII SENSITIVE key has an NFD decomposition form — the mismatch is structurally impossible. KOReader's Lua does byte-equal table lookup, so gate and runtime stay aligned | Shipped, verified 2026-04-23 via third-AI N2-probe; ASCII-only SENSITIVE set makes normalization collisions unreachable |
| NUL-byte in Lua settings key name bypassing SENSITIVE/SECRET gate (V1-probe, attempted) | `src/lua/reader.ts:181` (`String.fromCharCode(n)`) passes decimal escape `\000` through to a JS string; `Object.keys()` preserves the NUL verbatim. `filterForYaml` / `classify.ts`'s `Set.has()` at lines 45-74 uses strict byte-equal `===`, so `"extra_plugin_paths\0evil"` does NOT match `"extra_plugin_paths"`. No downstream C-string truncation vector exists (all kindly is JS/Lua). yaml lib emits as `"evil\\0key"` quoted key; KOReader's Lua loader accepts NUL in string literals — key persists on device but is inert (no truncation consumer) | Shipped, verified 2026-04-24 via live probe; NUL-in-key parses cleanly but cannot collide with any existing SENSITIVE/SECRET name because byte-equal check matches KOReader's own Lua-table lookup semantic |
| Compression-bomb parity on `setup import --archive` path (other-AI U-probe, attempted) | `src/setup/unpack.ts:45` (`unpackSetup`) calls `extractTarGz({ archivePath, destRoot: stage })` at :83; `archive.ts:202` (`extractTarGz`) runs `enforceSizeCaps` at :211 **before** `spawnSync("tar", ["-xzf", …])` at :219. Default caps (100 MiB archive, 500 MiB uncompressed, 100:1 ratio) apply — `unpackSetup` does not override. The staging dir (`mkdtempSync` at :81) is empty when created, so bomb check fires before any bytes are extracted into it. `finally` at :149 cleans the staging dir even on failure | Shipped, verified 2026-04-24 via third-AI U-probe; setup import correctly mirrors restore's G-probe call order |
| `doctor --json` / `history --json` / `snapshot --json` / `setup export --json` SECRET leak (other-AI O-probe, attempted) | `doctor --json` emits `secretsPresent` as an array of key **names** only (`["kosync.userkey", "zlibrary_password"]`), never values; check-data payloads carry counts/versions/sample key names. `history --json` emits `backup_path` (kindly-generated absolute path, fs-layout exposure but not attacker-influenced) + user-typed `label` + counts, no SECRET values. `snapshot --json` emits `archivePath`/`includedPaths`/`bytesWritten`, no buffers or contents. `setup export --json` emits `droppedSecrets` as key names only — attempted grep for literal plaintext "O-SECRET-PW"/"O-SECRET-KEY" in output returned zero matches. The S48 value-leak is confined to `apply --json` + `diff --json` (which serialize `Change.prev`/`Change.next`); every other JSON emitter is clean | Shipped, verified 2026-04-23 via third-AI O-probe; S48 fix can scope to diff-renderer + apply-renderer and skip the other four emitters |
| YAML anchors/aliases in manifest bypass Zod (other-AI X-probe, attempted) | `yaml@2.8.3` pinned; `parseYamlSafe` (`src/fs/yamlSafe.ts:42`) passes `maxAliasCount: 100` and a 10 MiB cap. Billion-laughs throws before Zod runs. Zod `.parse()` deep-copies every nested level — `input.settings === validated.settings` is false, so post-validation mutation of the parsed alias-shared object cannot reach the validated copy. Prototype-pollution via YAML `__proto__:` lands as an own-key, not a prototype mutation, and Zod-strict drops it. The one residual shape-footprint: `SettingValueSchema` is non-strict `z.record`, so a `<<` merge-key literal inside a nested `settings.*` value round-trips to Lua as `["<<"] = {…}` — KOReader ignores it at runtime, inert but worth noting | Shipped, verified 2026-04-24 via two-AI X-probe; Zod breaks reference sharing, `maxAliasCount` caps the bomb, strict() rejects `<<` at manifest root. Nested `<<` shape-footprint is inert but should be mentioned in §8.11 scope if we pin parse-shape caps |
| `setup import` input sources (other-AI Z-probe, attempted) | Full call chain (`commands/setup.ts:1028 runSetupImport → lib/importSetup.ts:349 executeSetupImport → :82-104 loadSetup → existsSync + readFileSync / unpackSetup`) is filesystem-only. Grep for `fetch`, `http.get`, `new URL`, `process.stdin`, `createReadStream`, `"-"` in `src/commands/setup.ts`, `src/lib/importSetup.ts`, `src/lib/setupExport.ts` returns zero hits. Export mirrors via `Bun.write`. Process-substitution `<(cmd)` resolves to `/dev/fd/N` which `readFileSync` handles fine but requires attacker control of the invoking shell — not an SSRF surface | Shipped, verified 2026-04-24 via two-AI Z-probe; no network ingress on import/export path |
| `kindly watch` subprocess trust surface (other-AI HH-probe, attempted) | `src/commands/watch.ts:103-115` reads `.kindly/history.jsonl` only — does NOT touch `settings.reader.lua`, does NOT call apply/classify/restore. Pure push-only `fs.watch` + `JSON.stringify(ev)` stream — no `.replace()` call, no privileged op. TOCTOU between fsevent and read is theoretical but the only output is stdout JSON. Live probe planted a partial-line mid-write; watch correctly dropped it on first scan and emitted the completed entry on next event. The `typeof parsed.index === "number"` guard at `reader.ts:111` silently drops Y-probe-style wrong-type entries (renderer crash doesn't apply — `JSON.stringify` handles any type) | Shipped, verified 2026-04-24 via two-AI HH-probe; watch is passive, no ingestion path, no side-effect on settings/device |
| Environment-variable injection into kindly (DDD-probe, code-audited 2026-04-24) | Exactly **one** `process.env` read in all of `src/`: `process.env.KINDLY_TRACE === "1"` at `src/cli/env.ts:65`, a boolean toggle with no value interpretation. Zero reads of `HOME`, `TMPDIR` (Node's `tmpdir()` is called by `unpack.ts` but that's library-level, not kindly-level), `PATH`, `KOREADER_*`, `NODE_*`, or any attacker-influenceable variable. M-probe (§8.7 companion) flagged the `TAR_OPTIONS` gap which is **env passed to subprocess**, not env read by kindly — different surface, already scoped for fix | Shipped, verified 2026-04-24 via code audit; no env-driven trust surface in kindly itself. The M-probe subprocess-env gap is the only remaining env-related concern |
| `.kindly/trace.jsonl` as a forgeable ingestion surface (FFF-probe, code-audited 2026-04-24) | `src/cli/trace.ts:47` writes one line per invocation via `appendFileSync` (implicit `flag: "a"` → O_APPEND, no interleave). **No read path exists**: grep for `readFileSync.*trace\.jsonl\|parseTrace\|readdirSync` on `trace-archive/` returns zero hits across `src/`. No renderer, no validator, no consumer. The file is strictly write-only telemetry for the maintainer's self-dogfooding (docstring: "strictly for Claudiu to measure his own friction"). Race-free by design: no index computation (unlike history.jsonl's writer.ts:148-149 race — EE-probe gap). `argv` is hashed with sha256[:12], never stored raw — no secret-leak via trace content | Shipped, verified 2026-04-24 via code audit; trace.jsonl has no trust-exploitable surface. One minor note folded into §8.9: `.kindly/` chmod 0700 covers this file too — an attacker with read on `.kindly/trace.jsonl` still learns invocation-time correlation data (which commands ran, when, how often), which is covert-channel-adjacent but not a new gap |
| `kindly plugin` subcommand — attacker-controllable install surface (QQ-probe, code-audited 2026-04-24) | `src/commands/plugin.ts` exposes only `list` + `describe <name>` — both read-only. Dispatcher at `:290`, wired at `cli.ts:47`. No `install`/`remove`/`add`/`import`/`copy` subcommand exists. FS reads: (a) bundled catalog JSON at `data/catalog/plugins.bundled.v1.json` (`:50`) — resolved inside kindly install dir, not user-supplied; (b) best-effort `settings.reader.lua` read for enabled/disabled computation (`:41-45`). Zero device writes, zero path flow to `mount.koreaderRoot/plugins/`. The S42 `extra_plugin_paths` concern is unreachable through this subcommand | Shipped, verified 2026-04-24 via two-AI QQ-probe; `plugin` is a trust-boundary-free catalog browser. Any future `plugin install` subcommand must attach the same SENSITIVE/catalog/W31a dual-gate that `extra_plugin_paths` carries |
| Unicode `..` variants in tar entry names — filesystem traversal (WW-probe, code+live-audited 2026-04-24) | `isSafeRelativePath` (`src/fs/paths.ts:10-20`) rejects segments byte-equal to ASCII `..` only. Accepts `﹒﹒` (U+FE52), `․․` (U+2024), `．．` (U+FF0E), and NBSP/ZWSP-separated `. .`. Live probe on macOS bsdtar 3.5.3: all variants extract as literal directory names (`dest/﹒﹒/main.lua`) — kernel/libc never NFKC-normalize path components; only the `0x2E` byte is special. No filesystem-level escape | Shipped, verified 2026-04-24 via two-AI WW-probe; predicate is technically under-specified but gap not exploitable via tar traversal. Adjacent hazard: these filenames may survive round-trips through higher-layer code that **does** normalize (filename dedup, NFC-aware duplicate detection) — spoofing risk in doctor/pull renderers, out of scope for bomb-path defense but worth tracking for §8.3/§8.10 string hygiene |
| GNU `@LongLink` divergence between `listTarGz` and `extractTarGz` on bsdtar (XX-probe, live-audited 2026-04-24) | `archive.ts:219` (`tar -xzf`) vs `:233` (`tar -tzf`) both run bsdtar 3.5.3 on macOS. Hand-crafted tars with GNU `@LongLink` (typeflag `L`) preceding a ustar file header: Variant A (LongLink body = `safe/…/innocuous.lua`, ustar short name = `../../../tmp/PWNED.lua`) extracts under the LongLink name, list and extract agree. Variant B (inverse) is correctly rejected by `isSafeRelativePath` since `..` appears in listing | Shipped, verified 2026-04-24 via two-AI XX-probe on macOS. **Caveat:** probe did not run GNU tar on Linux. M-probe's Linux/`TAR_OPTIONS` gap is the canonical Linux tar concern and remains flagged. When kindly adds a Linux target, re-probe `@LongLink` on GNU tar — historical edge-cases (negative checksum, out-of-order headers) may still cause listing/extraction divergence that bsdtar doesn't |
| Multi-document YAML as a smuggle vector (S86, TTT-probe, attempted) | `yaml@2.8.3` throws `Source contains multiple documents; please use YAML.parseAllDocuments() at line N, column 1` on any `---`-separated input. `parseYamlSafe` inherits the throw at `yamlSafe.ts:42`. Confirmed against plain multidoc, `%YAML 1.1` + multidoc, and cross-doc anchor references (`&evil` in doc 1, `*evil` in doc 2) — all three fail at parse-time. No attacker primitive | Shipped, verified 2026-04-24 via SSS/TTT probe; multi-doc YAML is error-path only. Forward-looking note: yaml's error message literally names the escape hatch (`parseAllDocuments()`) — any future kindly feature adopting multi-doc manifests must pass each sub-doc through the full classifier chain, and must handle cross-doc anchor resolution explicitly (yaml resolves anchors across docs when the loader permits) |
| Lua scanner regex ReDoS / catastrophic backtracking (QQQ2-probe, attempted) | `luaScan.ts:88,96,121,127` regex shapes audited: all `\s*\(\s*` are bounded-quantifier sequences anchored by literal parens (no overlap with a following literal), alternations are fixed-length literal module names (no disjoint-prefix backtracking), `[^"']+["']` class+delimiter sets are disjoint so no quadratic scan on pathological input. `stripImpl` at `:154-238` is a single-pass state machine that strictly advances `i` on every branch (no re-scan windows). Worst-case benchmarked: 1.3 MB input with 50k deeply-nested comments + string-long-bracket mix → 25.6 ms end-to-end (0.02 ms/KB); 10 MB worst-case projects to ~200 ms — under the 1 s human-perception threshold | Shipped, verified 2026-04-24 via third-AI QQQ2-probe; scanner is linear-time safe. No bomb defense needed at the regex layer. `stripCommentsOnly`'s escape-emit gap is a correctness bug (S82) not a DoS vector |
| `backupRotation` race between concurrent `safeWrite` backups (EEE-probe, code-audited 2026-04-24) | `src/fs/backupRotation.ts:10` reads `readdirSync(dir)` → sorts lexicographically by ISO-millisecond stamp → `slice(-keepN)`. Concurrent rotators both see the full sorted listing at call time and converge on the same "keep newest 20" slice; no entry-level race. `rmSync({recursive:true, force:true})` on removed dirs follows POSIX unlink semantics — a symlink target is not followed for removal in Node ≥16. Symlink replacement of `.kindly/backups` is out-of-trust-model (requires attacker cwd control — S61 / S56 already cover that class). One residual wart: same-millisecond ISO stamp collisions between two `safeWrite` calls silently overwrite one pre-write archive (`mkdirSync({recursive:true})` + `copyFileSync` is idempotent on the dir but not on the file content). Lost-backup primitive of single-write granularity; low severity because the `.old` sibling still exists for one-step recovery | Shipped, verified 2026-04-24 via code audit; rotation is race-benign. The stamp-collision wart is documented but not a new gap — folded into S67's file-lock scope since adding a lock around safeWrite would serialize stamp creation incidentally |

## 4. Confirmed gaps (post-S3)

| Gap | Why it exists | Current mitigation |
|-----|---------------|--------------------|
| Scanner evaded by byte-table string assembly | Lexical, not dataflow; spec §2.2 known limitation | Reviewer, or `--strict-imports` if plugin is catalogued |
| Uncatalogued plugin + `--accept-plugins` (no strict) = trust-by-accept (S3) — **live-verified 2026-04-23** | Strict is opt-in, default accept-plugins path allows uncatalogued | None today — S3 exploits this; confirmed on KOReader/macOS: plugin `:init` ran on boot, `POST /s3` landed at `127.0.0.1:5353` with 14,351 bytes of real settings body |
| Patches are not catalog-verified | No catalog to verify against (patches are by definition custom) | Scanner (also evadable) |
| **Patch-in-MATCH bypasses full strict mode** (S4) — **live-verified 2026-04-23** | Patches have no trust tier; scanner is sole gate and is evadable | **None today — S4 is an open hole even under `--strict-imports`; confirmed on KOReader/macOS: patch loaded on boot, marker file written, POST body transited to local listener at 4242** |
| **ANSI/control-char injection in author / source / description** (S7 / S40) — **live-verified 2026-04-23** | `MetaSchema` fields are bare `z.string().optional()` (schema.ts:88-99); `renderImportAuthorBlock` writes them verbatim to stdout (setup.ts:725-740) | **None today — S40 demonstrated the full forgery: YAML `\x1b`-escape in `meta.author` uses `\r` + bold-green + `\x1b[K` to paint `(VERIFIED ✓ community-catalog-v1)` over the `(UNVERIFIED)` suffix. Hex-confirmed bytes: `0d 1b 5b 31 3b 33 32 6d … 1b 5b 30 6d 1b 5b 4b`. Chains with S4 to produce bold-green "VERIFIED" next to a silent patch install** |
| **`terminal_shell` settings-only code-exec** (S9) | Missing from `SENSITIVE_KEYS`; W31 gate never fires | None today — imports silently at exit 0 |
| **`kindly apply --file` bypasses the SENSITIVE gate entirely** (S38) — **live-verified 2026-04-23** | W31 wired only into `setup import`; `apply` runs `mergeYamlIntoLua` directly with no trust boundary | **None today — plain YAML (no manifest, no flags) lands SENSITIVE settings silently at exit 0; confirmed on KOReader/macOS: `Terminal: spawning shell /tmp/kindly-s38-live/probe.sh`, `GET /s38` 200 at listener, marker 7s after launch.** Broadest single surface: re-widens every other SENSITIVE-keys gap through the apply path |
| **`apply` + `extra_plugin_paths` = universal plugin injection** (S42) — **live-verified 2026-04-23** | Same root cause as S38, but this key is **dual-gated** under `setup import` (W31a); apply flattens the dual gate to zero | **None today — strongest primitive in the red-team: plain YAML + arbitrary filesystem path with a `.koplugin` dir = arbitrary Lua on KOReader boot. Confirmed: `Looking for plugins in directory: /tmp/kindly-s42-live/evil-plugins`, `s42evil: init fired`, marker 4s after launch. Bypasses `.kset` archive checks (W34b), catalog (W32), scanner, and both accept-flags** |
| **`apply` has no SECRET filter — overwrite + stdout leak** (S43) — **live-verified 2026-04-23** | `filterForYaml` runs on pull and setup-import only; `src/lib/apply.ts` imports nothing from classify.ts; diff renderer prints `prev → next` unredacted | **None today — plain YAML (a) silently overwrites `zlibrary_password`, `calibre_wireless_password`, `pinpadlock_pin_code`, `LocalSend_pin`, `kosync.userkey`, and `pinpadlock_message` (recovery-channel hijack), and (b) `apply --dry-run` stdout prints every victim plaintext in the diff lines — self-exfil surface for any user who screenshots / pastes / `tee`s output** |
| **`kindly rollback <attacker-dir>` = unverified settings+plugins+patches ingestion** (S44) — **live-verified 2026-04-23** | Rollback imports nothing from classify.ts; `extractTarGz` does size-cap + path-safety only, no hash/catalog/scanner; command accepts any directory path | **None today — single command delivers settings overwrite + arbitrary plugin + arbitrary patch in one go, no flags. Confirmed: settings + `s44evil.koplugin` + `2-autorun.lua` extracted, plugin `init` fired, marker + `GET /s44` 200 4s after KOReader launch. Command output says `✓ restored 3 plugin/patch file(s)` — "restored" is misleading** |
| **`kindly restore <attacker.tar.gz>` = fat-tar RCE in one command** (S46) — **live-verified 2026-04-23** | Same root cause as S44, but a single `.tar.gz` attack artifact instead of a directory; `restore` is framed as *undoing harm*, which mis-primes the user | **None today — zero flags, exit 0, `✓ restored 4 file(s)` output. Marker + `GET /s46` 200 4s after KOReader launch. Dry-run shows all entries but caps at 50 — real snapshots with 6+ plugins bury the evil one** |
| **Snapshot-as-distribution: kindly's own tooling is the attack framework** (S47) — **live-verified 2026-04-23** | `kindly snapshot` blindly tars `plugins/` + `patches/` with no "code from unknown origin" concept; tar carries no trust-tier metadata; `kindly restore` cannot distinguish self-authored from forum-sourced snapshots | **None today — attacker pipeline is `kindly snapshot` → share on forum as "my reading setup" → victim `kindly restore`. Full chain verified: attacker fixture with `s47evil.koplugin` → `kindly-snapshot-<ts>.tar.gz` (only warning is about plaintext secrets — a non-issue for attacker) → clean victim fixture → plugin fires 4s after KOReader launch, marker + `GET /s47` 200** |
| **`--json` envelope carries SECRET plaintexts on apply/diff** (S48) — **live-verified 2026-04-23** | `computeChanges` (diff.ts:46) operates on unfiltered on-device data; `json.ts:82` serializes the full result tree with no classify lookup; `DiffResult.grouped` emits each change twice | **None today — 5/5 victim plaintexts in stdout of both `apply --dry-run --json` and `diff --json`. CI/cron pipes that request `--json` land values in structured log stores (Splunk/Datadog/S3). Worse than S43b/S45: automation is the default consumer of JSON output, and double-emission via `grouped` survives most JSON path filters** |
| **Restore-path code-exec surface spans ≥5 files, not 2** (S49) — **live-verified 2026-04-23 (defaults.custom.lua); static-confirmed for history.lua, settings.reader.lua.old** | KOReader loads settings files via `pcall(dofile, …)`; every Lua file in `SNAPSHOT_PATHS` is a code-drop surface, not just `plugins/` + `patches/` | **None today — minimal attacker tar (`settings.reader.lua` + `defaults.custom.lua` only, no plugin, no patch) delivered code-exec via `kindly restore`. Marker in 2s (faster than plugin-based because `LuaDefaults:open` runs early in startup). §8.7 HMAC gate scope must cover the full tar, not just plugins/patches specifically** |
| **Symlink entries in restore tars bypass path-safety** (S50) — **live-verified 2026-04-23** | `isSafeRelativePath` validates entry paths only, not symlink targets; `listTarGz` uses `tar -tzf` which hides file types; BSD tar extracts symlinks as symlinks with target intact | **None today — `kindly restore` is an arbitrary-symlink-creation primitive inside the victim's filesystem. Cross-install exfil via bridged `settings.reader.lua` → another install's settings file confirmed live: `kindly diff` prints `"/home/someone-else" → "…"` as `prev` value; `kindly pull --full` landed bridged non-SECRET keys in output YAML. SECRET filter catches credentials accidentally (filterForYaml runs regardless of backing storage). Moderate severity: info-disclosure + invariant break, not RCE** |
| **`kindly rollback <attacker-dir>` = fourth tar-ingestion RCE** (S51) — **live-verified 2026-04-23** | `rollback.ts:73` resolves `snapshotDir` against env.cwd with no `.kindly/` anchor; entry-name `isSafeRelativePath` passes plain `plugins/foo.koplugin/*.lua`; `extractTarGz` unpacks into `mount.koreaderRoot`. History-jsonl read in `findHistoryEntryByIndex` trusts every line verbatim (no HMAC), so `rollback --to <N>` inherits the same primitive when an attacker can forge one history line | **None today — `kindly rollback /tmp/attacker-snapshot-dir --mount …` delivered `evil.koplugin` to koreaderRoot at exit 0 with `✓ restored 2 plugin/patch file(s)`. Marker + `GET /s51` 200 at 2s after KOReader launch. Broadens the §8.7 fix surface: must anchor `snapshotDir` to `<cwd>/.kindly/{pre-*}/` AND HMAC-sign history.jsonl lines** |
| **Lean `.kset` chain: re-enable Terminal via `plugins_disabled.terminal=false` + set `terminal_shell`** (S17) — **live-verified 2026-04-23** | `settings:` is a permissive `z.record`; `plugins_disabled` writes bypass `PluginsSchema`'s disable-only intent via shallow-merge | **None today — full driveby under `kindly setup import` with zero flags; confirmed on KOReader/macOS: `Terminal: spawning shell /tmp/pwn.sh`, listener hit, PTY allocated** |
| **`plugins_disabled.<name>: false` re-enables *any* built-in plugin silently** (S27) | `plugins_disabled` not in SENSITIVE_KEYS; generic primitive, not per-plugin | Exit 0, silent. SSH / LocalSend / httpinspector / calibre / wallabag / opds all re-enable |
| Type-mismatch values for known-typed keys (S20) | Schema validator warns, does not block; diff renderer prints live SECRET values during overwrite preview | Warn-only (exit 4). Info-leak requires user to paste dry-run output |
| Directory-redirection settings keys not in SENSITIVE (`screenshot_dir`, `screensaver_dir`, `wikipedia_save_dir`, `cover_image_path`, `cover_image_fallback_path`, `cover_image_cache_path`) | Consistency gap vs. existing `home_dir`/`download_dir`/`inbox_dir` coverage | None today — follow-up audit |
| Scanner runs only on declared file set | `.kset` manifest enumerates files; extras outside manifest would be refused earlier, but a determined malicious export tool could race | Archive path-safety (W34b) |
| **`.kindly/` state world-readable; SECRETs in backups** (S53, other-AI J-probe 2026-04-23) | `safeWrite.ts:76/85`, `history/writer.ts:143/169` etc. use `mkdirSync`/`openSync` with process umask (default 022 → 755/644). Zero `chmod`/`umask` calls in all of `src/`. `.kindly/backups/<ts>/settings.reader.lua` is a byte-copy of device state = plaintext SECRETs (`filterForYaml` NOT run on backups). `.kindly/history.jsonl` also world-readable | **None today — any local user with read on cwd harvests SECRETs from `.kindly/backups/*/settings.reader.lua` (plaintext passwords, PINs, API keys) and the full mutation audit from `history.jsonl`. `CLAUDE.md` scopes kindly as single-user but this is still porous: admin+regular-user shared macOS boxes, background sync daemons under other UIDs, Spotlight/LSP sandboxed processes. Fix is §8.9: `chmod 0700 .kindly/`, `chmod 0600` on every file inside** |
| **`setup export` missing producer-side "shipping executable code" warning** (audited 2026-04-23, lower severity than S47) | `setup.ts:133-176` renders bytes / file counts / hash but does NOT warn that plugin + patch files execute on importers' KOReaders. Mirror of S47's snapshot gap. Different severity profile: import side has strict-mode scanner + W32 catalog + `--accept-plugins` gate (stronger than restore's zero-gate ingestion) — but those gates are evadable (S3/S4) | **None today — producer warning absent.** Chain: compromised Victim A exports `.kset --include-plugin-files` unaware of attacker plugin, shares on forum, importers get UNCATALOGUED advisory + evadable scanner + `--accept-plugins` click-through. Lower severity than S47 because of the gate stack, but producer-side nudge still worth adding: `"archive ships N plugin file(s) + M patch file(s) — all executable Lua. Don't share with anyone you wouldn't trust to run code on your device."` |
| **Plugin catalog case-collision bypasses hash verification on APFS/vfat** (S58, other-AI T-probe, live-confirmed 2026-04-24) | `src/lib/verify.ts:68-69` compares plugin names with strict `===` (case-sensitive). APFS (macOS default) and vfat (Kindle USB) are case-insensitive at the filesystem layer. Attacker ships `plugins/ssh.koplugin/main.lua` (lowercase); catalog stores `"SSH"`; lookup misses → UNCATALOGUED verdict; hash verification never runs | **None today under non-strict `--accept-plugins`.** Attacker's `ssh.koplugin/main.lua` extracts on top of user's real `SSH.koplugin/` (same directory on APFS/vfat) and silently overwrites it. Affects ~half the bundled catalog (any non-all-lowercase entry). Under `--strict-imports`: blocked (UNCATALOGUED is non-MATCH). Fix: case-insensitive catalog lookup, or emit NAME_CASE_MISMATCH verdict explicitly |
| **Non-table top-level `return "str"` silently corrupts settings via kindly downstream** (S59, live-verified 2026-04-24) | `src/lua/reader.ts:101-116` (`parseFile`) returns `LuaValue` not `LuaTable`. `luaToYaml` + `mergeYamlIntoLua` (both in `src/schema/yaml.ts`) accept a bare string and iterate characters as numeric keys — zero type-check | **None today.** Post-poisoning (via S38/S42/S43/S44/S46/S51), attacker plants `return "evil"`; victim's `kindly pull` emits 400 lines of `"0": j\n"1": u\n…`; next `kindly apply` writes character-soup back to device. Legitimate settings structurally erased, zero error surfaced. Fix: `parseSettingsFile` rejects non-plain-table top-level |
| **`parseSettingsFile` stack overflow on deep nesting (~50k depth)** (S60, live-verified 2026-04-24) | `parseTable` recurses through `parseValue` per entry; V8 call-stack limit blown at ~30-50k depth (450 KB file). Attack file fits easily inside the 100 MB archive cap | **None today.** One poisoned settings.reader.lua kills every kindly command that calls `parseSettingsFile` (pull/diff/apply/doctor/rollback/restore/setup-import). Recovery requires direct filesystem edit. Push-button DoS of the whole user surface — including `kindly watch` subprocess powering the docs/97 GUI vision. Fix: recursion-depth cap (64) at `parseValue` entry |
| **`--output` paths accept absolute/traversal/symlink writes; `snapshot --output` = secondary-channel SECRET leak** (S61, audited 2026-04-24 — low severity) | Four user-controlled outputs use `resolve(env.cwd, opts.output)` with no path-safety: `init.ts:43`, `lib/pull.ts:42`, `snapshot.ts:57-59`, `lib/setupExport.ts:182-183`. `writeFileSync` follows symlinks; `--force` suppresses existsSync. `snapshot` writes a plaintext-SECRET fat tar; others write SECRET-filtered or hardcoded content | **None today** (self-inflicted for the user-typed flag). Non-self-inflicted concern: `kindly snapshot --output /tmp/public/foo.tar.gz` lands plaintext SECRETs in a shared-readable location — secondary S53 channel. Fix: `chmod 0600` on output regardless of location (§8.9), plus `--output` warning when resolved path escapes cwd |
| **`kindly doctor` ANSI injection via plugin-dir names and unknown settings keys** (S55, live-verified 2026-04-23) | `src/lib/doctor.ts:217` (unknown-keys `sample.join(", ")`) and `:361/380-381` (uncatalogued plugin names `sort().join(", ")`) both flow to stdout with zero C0/C1 sanitization. `isSafeRelativePath` (`src/fs/paths.ts:10-20`) permits all bytes except null, leading `/`, `\`, and `..` — so ESC 0x1B in tar entry names passes the path check and extracts cleanly | **None today — live probe wrote `plugins/\x1b[31;1mEVIL.koplugin/main.lua` and ran `kindly doctor --mount …`; `cat -v` output showed literal `^[[31;1m` bytes in the uncatalogued-plugin detail line.** Chain with S46 (`kindly restore`): attacker tar delivers ANSI-named plugin → victim runs doctor *precisely because something feels off* → doctor output fake-greens fraudulent integrity via `\r\x1b[K` overpaint. Same injection repeats via `history.ts:112-117` on attacker-written `e.label` (S53 chain). Folds into a new §8.10 (shared stdout sanitizer) or extends §8.3 |
| **Mount-side symlink on `settings.reader.lua` = cross-read + covert destruction** (S56, other-AI P-probe 2026-04-23) | Eight read-sites use plain `readFileSync` on `mount.settingsPath` — no `lstatSync` guard: `src/lib/pull.ts:36`, `diff.ts:35`, `apply.ts:40`, `doctor.ts:88`, `setupInspect.ts:168`, `importSetup.ts:549`, `commands/plugin.ts:42`, `commands/rollback.ts:140-143`. Only `unpack.ts:86,126` lstat-checks, and that is the archive-extract path (S50 scope) | **None today.** Attacker plants symlink `Kindle/koreader/settings.reader.lua → ~/.config/koreader/settings.reader.lua` (sibling install / other-user path / `/etc/passwd`). `pull`/`diff`/`doctor` read through and emit bridged content; `apply` replaces the symlink with a regular file (covert destruction — evidence of the bridge vanishes, legitimate Kindle settings also vanish). S50 sibling on the primary-read path. Fix: `lstatSync(path).isSymbolicLink()` reject at all 8 sites |
| **`setup import --dry-run` / `--json` leaks SENSITIVE values (but not SECRETs)** (S57, other-AI Q-probe 2026-04-23) | `renderSetupImport` at `setup.ts:941-951` prints `fmtValue(c.prev) → fmtValue(c.next)` raw for every change including `[SENSITIVE]`; `fmtValue` at `:682` has zero redaction; SENSITIVE gate at `importSetup.ts:605` explicitly skipped when `opts.dryRun`; `publicData.changes` at `:1066` carries raw LuaValues; `formatSensitiveChange` at `importSetup.ts:594-603` builds strict-mode error messages from the same `fmtValue` | **None today.** SECRETs are cleanly filtered (filterForYaml at importSetup:543, replace-mode preservedKeys at :553-558). SENSITIVE values — `ota_server`, `http_proxy`, `extra_plugin_paths`, SSH surface — leak via: (a) `--dry-run` human stdout, (b) `--json` envelope `publicData.changes`, (c) strict-imports error message on stderr. Dry-run gate bypass is itself a design error. Fix: widen §8.4's redactor to SENSITIVE + SECRET; run the SENSITIVE gate even on `dryRun=true` |
| **Unfiltered env passed to `tar` child process; `TAR_OPTIONS` bypasses path-safety on GNU tar / Linux** (M-probe, 2026-04-23 — defense-in-depth gap) | `archive.ts:64, 219, 233` all call `spawnSync("tar", args, { encoding: "utf8" })` with **no `env` option** — full `process.env` inherits. On macOS bsdtar (libarchive 3.7.4), `TAR_OPTIONS` is not read (verified: bogus flag silently dropped; only `TAPE` is honored). On **GNU tar (Linux)**, `TAR_OPTIONS` *is* read and `--transform='s,.*,koreader/plugins/evil.koplugin/main.lua,'` rewrites entry paths **at extraction time, after `isSafeRelativePath` already validated the original listing from `tar -tzf`**. `listTarGz` and `extractTarGz` disagree on what paths they see | **None today on Linux; macOS not exploitable.** Kindly's intended execution host is the user's desktop (macOS confirmed; Windows unsupported; Linux is the natural third target). The moment kindly runs on a Linux box, this is a silent bypass of every path-safety check in §8.7. Fix is trivial and defense-in-depth-friendly: `spawnSync("tar", args, { env: {}, encoding: "utf8" })` on all three sites, OR explicitly drop `TAR_OPTIONS`/`TAR_READER_OPTIONS`/`TAPE`/`LANG`/`LC_*` from the inherited env. Folds into §8.7 as a mandatory companion fix |
| **`kindly pull --full` emits EPHEMERAL PII with no warning** (S62, live-verified 2026-04-24) | `--full` flag includes EPHEMERAL keys per classify.ts:130-156. Several of those carry literal PII: `lastfile` (filesystem path), `lastdir` (folder hierarchy), `menu_search_string` (search queries), `quote_deck_pos`, `LocalSend_last_update_check`. No tag, no warning, single-line success message on exit 0 | **None today — self-inflicted but mis-priced.** `--full` mental model is "include more keys"; actual semantic is "include more keys **including PII**". Framing gap makes forum-paste / bug-report disclosure likely. Fix: split EPHEMERAL into `EPHEMERAL_VOLATILE` (safe) + `EPHEMERAL_PII` (paths/queries); `--full` = volatile only; new `--full-pii` gate for PII tier; stderr warning listing PII keys at write time; writeFileSecure chmod 0600 inherited from §8.9 |
| **Forged `history.jsonl` + `rollback --to N` = attacker-Lua on device** (S63, live-verified 2026-04-24) | `src/history/reader.ts:70` casts each JSONL line with `as HistoryEntry` (no Zod validation). `rollback.ts:268` does `dirname(s.backup_path)` verbatim — no HMAC, no `.kindly/` path constraint. Plus `history.ts:110` `e.ts.replace(…)` crashes on non-string `ts` (Y-probe) so the natural reconnaissance command is DoS-able alongside the primitive | **None today — single appended line to `.kindly/history.jsonl` + `kindly rollback --to 1` lands attacker Lua on-device. Probe confirmed: `rollback from /tmp/kindly-dd-live/attacker-backup` → `ATTACKER_FORGED_KEY = "DD_PROBE_LANDED"`, `terminal_shell = "/bin/sh"` in fixture. Severity sibling to S51 but with lower social-engineering friction (user types index, not path). Fix: Zod HistoryEntrySchema.strict() with path constraint to `<cwd>/.kindly/`, HMAC-sign each history line, render-time type guards on `e.ts` |
| **`plugins_disabled` as YAML array silently re-enables every disabled plugin** (S64, AA-probe, live-verified 2026-04-24) | `plugins_disabled: [SSH, terminal]` (YAML list) hits `mergeYamlIntoLua` (src/schema/yaml.ts:108-128) where object-vs-array type mismatch triggers wholesale replace (no sub-merge). Lua writer emits integer-keyed `{[1]="SSH",[2]="terminal"}`; KOReader's `plugins_disabled[plugin_name]` string-key lookup returns nil on an integer-keyed table → every previously-disabled plugin re-enables | **None today — one YAML line, no flags, exit 0. Stronger than S27 (which flips one key): S64 flips *all* disabled plugins including terminal (S17 primitive), SSH, httpinspector, LocalSend, calibre, wallabag, opds. §8.1's proposed `value === false` check (inspects map values) structurally cannot catch array form. Fix: reject non-plain-object `plugins_disabled` with `plugins_disabled must be a map of name → bool, got array` |
| **Unicode bidi / RTL-override in manifest identity fields bypasses §8.3** (S65, II-probe, live-verified 2026-04-24) | `meta.author`/`description` are bare `z.string().optional()`; `meta.source_url` is `z.string().url()` — but **`.url()` accepts U+202E inside path/host** (live-verified: `https://github.com/anthropic-kindly‮gro.reliove.cdn` validates clean). §8.3's proposed C0/C1 sanitizer (0x00-0x1F + 0x80-0x9F) is scoped below codepoint 0x2000 — U+202E at 0x202E is above that range and passes | **None today — on bidi-aware TTY, spoofed `source_url` renders `https://github.com/anthropic-kindlyndc.evoiler.org (UNVERIFIED)` *at the moment of trust-granting* (setup.ts:718-741). W33's "display but mark UNVERIFIED" strategy structurally broken when displayed bytes ≠ attacker bytes. Fix: extend §8.3 sanitizer to strip Unicode bidi block U+202A-202E, U+2066-2069, U+200E-200F. Single `sanitizeIdentityString` helper shared with S7/S40** |
| **OSC 52 clipboard-write injection via plugin dir names / `setup inspect` meta / `history` labels** (S66, VV-probe, live-verified 2026-04-24 at byte level) | Zero control-char sanitization on filesystem-sourced strings: `src/lib/doctor.ts:381` (uncatalogued plugin basenames), `src/commands/setup.ts:280-293,718-741` (meta.author/description), `src/history/writer.ts:163` (labels stored raw in JSONL) + history renderer. OSC 52 (`\x1b]52;c;<base64>\x07`) passes verbatim to stdout; iTerm2/kitty/most xterm variants honor it and silently write the decoded base64 to the system clipboard | **None today — silent clipboard-write. Severity high when chained with S65: `setup inspect` renders spoofed-looking GitHub URL while writing `kindly setup import /tmp/attacker.kset` to the clipboard; user pastes the attacker command thinking it's benign. Fix: shared `stripControl` at §8.10 covering filesystem-sourced strings (plugin names, key names) not just manifest identity — must include ESC (0x1B) so OSC/DCS/CSI all get caught. JSON emitter must pre-sanitize (not rely on `JSON.stringify` escaping) since `cat` of the logged JSON still honors the bytes** |
| **No file-lock on `settings.reader.lua`; lost-write race on desktop/emulator live-head target** (S67, UU-probe, live-verified 2026-04-24) | `src/fs/safeWrite.ts` is atomic per write, not per read-modify-write. `mergeYamlIntoLua` reads then writes with no coordination — grep `flock\|lockfile\|lockSync\|LOCK_EX` across `src/` returns zero hits. USB-mount-gate invariant (KOReader off while kindly runs) holds for Kindle but is **violated for the macOS KOReader-on-desktop live-head** target adopted per `project_kindly_koreader_live_head` memory | **None today — silent lost-write in either direction. Live probe (3000-iteration writer loop + 5 concurrent `kindly apply`): final state had `cover_image_quality = 10` (kindly's 75 overwritten) AND `koreader_write_iter = 3000` (writer's last iter preserved). No warning, exit 0. Severity MEDIUM on desktop/emulator (docs/97 GUI vision makes this explicit), LOW on Kindle. Fix: advisory `flock(fd, LOCK_EX)` spanning read-modify-write, or `proper-lockfile` sidecar. Long-term: upstream KOReader to honor the same lock** |
| **Catalog-file poisoning inverts W32/W34e MATCH gate + silences scanner** (S72, AAA-probe, live-verified 2026-04-24 — **High**, top of trust pyramid) | `src/catalog/reader.ts:109-134` `loadPluginCatalog` reads `data/catalog/plugins.bundled.v1.json` via plain `readFileSync` + Zod schema validation. **Zero file-level integrity check** — no embedded SHA, no signature, no pinning. `src/schema/settings.ts:41-48` same pattern for the settings schema JSON. Live probe: replaced `SSH.known_hashes["main.lua"]` with `sha256:<hash of attacker bytes>` → `verifyPluginAgainstCatalog` returns **MATCH** on attacker payload. Scanner suppression (`setup.ts:829`) also fires on poisoned MATCH → double-silence | **None today.** Single file swap inverts W32 MATCH, `--strict-imports` (requires MATCH), and W34e scanner advisory suppression simultaneously. No UI surface fires (unlike S3/S4 UNCATALOGUED). Threat model: supply-chain (compromised npm/bun/homebrew package), post-install tampering (shared dev machine), dotfiles-sync compromise. **Beats the §8.7 HMAC-marker proposal** — HMAC authenticates archives against a machine key, not the catalog against which scanner+hashes are checked; AAA attacks upstream. Fix: compile-time embedded `CATALOG_SHA256` constant in `reader.ts` source; loader computes + compares + throws. One-line change + build step. Folds into new §8.17 |
| **SECRET_PATHS / SENSITIVE_PATHS bypassed by YAML array wrapping and literal dotted-top-level keys** (S71, RRR-probe, live-verified 2026-04-24 — **High**) | `classify.ts:248` (and twins at `:115`, `:188`) short-circuit `!Array.isArray(v)` before recursing — SECRET/SENSITIVE path walk skips inside arrays. `classify.ts:158` `classifyKey` consults only `SECRET_KEYS`, not `SECRET_PATHS` — a single-key literal `"kosync.userkey"` passes. Confirmed leaks: (A) `settings.kosync: [{userkey: "…"}]` — array-of-object; (C) `settings["kosync.userkey"]: "…"` — dotted-literal. Variant B `{userkey: {nested: "…"}}` is clean (type-agnostic path check fires) | **None today.** Attacker YAML lands plaintext `kosync.userkey` / other SECRETs on device silently (gate doesn't fire). Chain: (1) smuggle via `apply`/`setup import`, (2) victim's future `kindly pull` also misses the bypass shape — credential re-emits in plaintext YAML. Silent SECRET introduction **and** silent re-emission. Same array-bypass hits SENSITIVE gate (setup-import path): kosync-array skips W31 fire. Fix: normalize input shape at YAML-load time — rewrite `{"kosync.userkey": v}` → `{kosync: {userkey: v}}` and recurse into arrays in the three classify walk sites. Folds into §8.12 — promotes that section from P2 parser-DoS to P1 SECRET integrity |
| **`--output` paths on `init` / `pull` / `snapshot` follow symlinks at the target** (S69, LLL-probe, live-verified 2026-04-24 — **Medium**) | `writeFileSync` (Node) opens `O_TRUNC\|O_WRONLY` — no `O_NOFOLLOW`. `existsSync` also traverses symlinks so `--force` bypasses guard against the target. Snapshot has no existence check. Three live-confirmed sites: `init.ts:51`, `pull.ts:54`, `archive.ts:64` (snapshot via `tar -czf`). S61 flagged this surface but said "self-inflicted for user-typed flag, low severity" — LLL elevates because the flag resolves *through* pre-seeded attacker symlinks | **None today.** Threat model: attacker with write access to user's cwd pre-seeds `./kindle.yaml → /target/to/clobber` + waits for `kindly` invocation. Realistic: shared machines, sync daemons, post-compromise persistence. Severity ordering: snapshot > pull > init (snapshot lands **plaintext SECRETs** at attacker's path — worst). Fix: `writeFileSecure(path, bytes)` wrapper at four sites (`init.ts:43`, `lib/pull.ts:42`, `snapshot.ts:57-59`, `lib/setupExport.ts:182-183`): `lstatSync` → reject symlink unless `--allow-symlink-output`; `O_NOFOLLOW` where supported; `chmod 0600` on output. Folds into §8.9 |
| **Hardlink on mount-side `settings.reader.lua` exfiltrates host file via pull + backup** (S70, OOO-probe, live-verified 2026-04-24 — **Medium**) | Sibling to S56 but via a distinct primitive — S56's proposed `lstatSync.isSymbolicLink()` fix **does not close this** because hardlinks share an inode, no directory-entry "link" to detect; `lstat` reports a regular file with `nlink > 1`. Live: hardlink `mount/koreader/settings.reader.lua → $HOME/.ssh/id_rsa` → `readFileSync` at `pull.ts:36` reads host content → sentinel lands in output YAML. `safeWrite.ts:78` `copyFileSync` also copies host content into `.kindly/backups/` (second exfil channel, persists 20 backups). Write side safe by accident: `renameSync` breaks the hardlink (new inode for `path`, host file preserved); but `.old` retains the hardlink for one apply cycle, narrow window for rollback re-promote | **None today.** Requires attacker with same-filesystem write access (no cross-fs hardlinks), so exclusively a desktop-live-head concern (macOS APFS / Linux ext4) — FAT32 Kindle USB doesn't support hardlinks. Fix: add `st.nlink > 1` check alongside S56's `isSymbolicLink()` at all 8 read sites. Same patch location, one extra predicate — `refusing hardlinked settings.reader.lua (nlink=N)`. Folds into S56's §8.14 scope |
| **gzip ISIZE 4 GiB wrap bypasses `enforceSizeCaps`** (S68, YY-probe, live-verified 2026-04-24 — **High**) | `src/fs/archive.ts:135-148` (`readGzipSizes`) parses `gzip -l`, which reports uncompressed size from the 4-byte ISIZE trailer — modulo 2³². Any tar.gz with ≥4 GiB actual uncompressed content has its size wrap, then slips through all three caps in `enforceSizeCaps` (`:153-183`). Live probe: 4.1 GiB bomb (`4,399,822,848` byte tar entry, 4.08 MiB compressed) reports ISIZE=100 MiB → passes 500 MiB cap; ratio=24.5:1 → passes 100:1 cap; archive-bytes=4 MiB → passes 100 MiB cap. `assertSafeArchive` returns success; `extractTarGz` (`:219` = `tar -xzf`) will write the full 4.1 GiB | **None today — first confirmed bypass of the A9/S-series bomb defense.** Reachable from `restore.ts:81` → `:136` (extract) and `setup/unpack.ts:83`. Disk-fill DoS on Kindle (~8 GiB internal storage) with an 8 GiB payload + 400 MiB uncompressed wrap remainder (still under cap, still ~8 MiB compressed). Fix: stream-decompress through a counting sink and abort at byte `cap+1` (authoritative, trailer-independent); secondary belt — sum `tar -tvzf` entry sizes and cross-check. Folds into A9 defense hardening scope |
| **`settings.reader.lua.old` live code-drop via dual-file fixture** (GGG-probe, live-verified 2026-04-24 — extends S49) | KOReader's `luasettings.lua:31-45` falls back to `settings.reader.lua.old` (`pcall(dofile, new.file..".old")`) whenever the main file's `dofile` returns `(ok=true, stored=nil)` — typically broken syntax, missing `return`, or `return nil`. `.old` is in `SNAPSHOT_PATHS` so kindly tars/restores/rolls it round-trip. Live probe on macOS emulator 2026-04-24 08:20: planted `settings.reader.lua = "return nil"` + `.old` containing top-level `do … io.open … end`; marker file written at boot, KOReader logged only `WARN LuaSettings: Failed reading ./settings.reader.lua (probably corrupted)` | **None today.** Stronger than S49's `defaults.custom.lua` primitive in three ways: (a) main-file payload invisible — schema validator on `settings.reader.lua` sees `return nil`, not the attacker Lua; (b) `.kset` shipping a `.old` sibling is prima facie suspect (KOReader generates it during its own atomic writes — no legitimate reason for an author to bundle one) → good lint signal; (c) `luasettings:37` `pcall` isolates failures, so KOReader boots cleanly after payload runs. Fix bundles with S49: SNAPSHOT_PATHS-wide code-drop gate, **and** explicit reject on `.old` in `.kset` archives unless explicit opt-in |
| **`bunfig.toml` in cwd is pre-exec RCE against every `kindly` invocation** (S81, LLL2-probe, live-verified 2026-04-24 — **High**) | kindly runs as `bun run src/cli.ts`; Bun reads `./bunfig.toml` from cwd on every invocation and honors `preload = [...]`. Attacker's preload runs **before** kindly's main parses argv. Compiled binary via `bun build --compile` does NOT fix this (verified live). `bun -c <path>` override does NOT suppress cwd bunfig (verified live) | **None today.** Pre-exec RCE with kindly's full permissions: mount RW, `.kindly/` write, history/trace append, HOME access for SSH keys/credentials. Same threat-model prerequisite as S56/S69/S70/S74 (attacker has cwd write); strictly worse outcome (arbitrary code vs. file-read bridging / single-file clobber / append oracle). Realistic scenarios: shared dev boxes, CI runners, cloned-project-dirs (S47-class "my Kindle setup" forum repo), sync daemons that cd into watched folders. **Upstream Bun design issue** — no clean fix without a Bun `BUN_CONFIG_SKIP=1` / `--no-config` flag. Interim: shell-wrapper that refuses to run if `./bunfig.toml` exists (limited: only protects the wrapper entrypoint, not `bun run src/cli.ts` directly). Must be documented in docs/87 threat-model callout |
| **YAML `<<:` merge keys smuggle values past SECRET/SENSITIVE classifier walks** (S79, JJJ-probe, live-verified 2026-04-24 — **High**) | `yaml` library at `parseYamlSafe` (`src/fs/yamlSafe.ts:42`) does NOT resolve `<<:` — stores as literal own-key with alias value as subtable. `classifyKey("<<")` → USER, `isSecretPath("kosync.<<")` → false. Third classifier-bypass shape after S71's array-wrap and dotted-literal | **None today.** Attacker YAML: `kosync: {<<: *evil, innocent: true}` with `&evil: {userkey: "ATTACKER…"}` → `kindly apply --file` + `setup import` both let it through, writer emits `["<<"] = {[userkey]=...}` on device, backups retain plaintext (S53 channel), `kindly pull` + `--json` re-leaks unredacted. KOReader's Lua treats `<<` as literal string key (no merge semantics) — payload doesn't hijack runtime `userkey`, but bytes land on device unredacted. Fix: input-shape normalizer at `parseYamlSafe` resolves `<<:` into own-keys before classify/merge sees it; same chokepoint handles S71's dotted-literal and array-wrap shapes. Promotes §8.12 from "parser guards" to "input normalizer owning three shapes" |
| **Cyclic YAML anchors reach S77 as a live exploit — `dumpSettingsFile` `RangeError`** (S80, JJJ-probe, live-verified 2026-04-24 — **Medium**) | `yaml` library materializes actually-cyclic graphs from `&a / *a` self-references. `parsed.root === parsed.root.child` → true; `dumpSettingsFile(parsed)` → `Maximum call stack size exceeded`. Promotes S77 from "defense-in-depth, not reachable" → "reachable via any path that takes attacker YAML → parse → writer" | **None today.** `kindly apply --file attacker.yaml` / `kindly setup import` on cyclic YAML → writer throws → exit 1 after merge has completed in memory but before device write. Push-button DoS of the mutation pipeline. No data written on device (writer throws before `writeFileSync`) but crash recurs on every apply until user removes cyclic YAML. Fix: S77's WeakSet + depth-cap landing at `serializeTable`; S79's input normalizer MUST also handle cycles (WeakSet at normalizer entry or structured-clone pass) — otherwise normalizer itself is DoS'd by cyclic input |
| **`.kindly/history.jsonl` + `.kindly/trace.jsonl` follow symlinks on read/write/append** (S74, CCC-probe, live-verified 2026-04-24 — **Medium**) | Zero `lstatSync`/`O_NOFOLLOW` in `src/history/reader.ts:59`, `src/history/writer.ts:169`, `src/cli/trace.ts:60`. Same pattern that S56 found on `settings.reader.lua`, now confirmed on the `.kindly/` cluster. Append oracle: symlink replacement lets attacker redirect audit-log writes to any user-writable file | **None today.** Attacker with write on user cwd pre-seeds `.kindly/history.jsonl → /target/to/append`. Every subsequent kindly mutation writes a JSON line to target. Read path chained with S63 (no Zod) → `rollback --to N` resolves to attacker-chosen `snapshot_dir` — fourth tar-ingestion RCE. Fix: shared `lstat`/`O_NOFOLLOW` helper folded into S56/S70's §8.14 scope — same pattern, adjacent call sites |
| **gzip multi-member archive hides non-final members from `enforceSizeCaps`** (S75, BBB-probe, live-verified 2026-04-24 — **Low**) | `readGzipSizes` at `archive.ts:136` parses `gzip -l` output which reports only the **last** member's ISIZE per RFC 1952 concat semantics. 11-member probe: 70 KB true uncompressed, 4 KB reported (17× undercount) | **Sibling to S68 but narrower.** Both bsdtar and GNU tar stop at the first embedded tar EOF marker → non-final members decompress through pipe but never hit disk. CPU/memory DoS only, not file-write amplification. Fix: scan for gzip magic `1f 8b` at offsets > 0 and refuse multi-member archives (legitimate `.tar.gz` workflows never produce them). Folds into §8.15 alongside the S68 stream-counting sink |
| **UTF-8 BOM in `settings.reader.lua`: KOReader strips, kindly throws** (S76, FFF-2-probe, live-verified 2026-04-24 — **Low**) | `src/lua/reader.ts` `skipWS` recognizes ASCII whitespace + `--` comments only. LuaJIT 2.1 auto-strips `EF BB BF`. Divergence: BOM + valid Lua parses fine on Kindle, fails with `LuaParseError` in every kindly command | **Not an attack surface — a support burden.** User edits settings in a BOM-emitting editor (historical Windows Notepad default, various legacy tools), device works, kindly breaks, user blames kindly. Fix: one-line BOM strip at `parseSettingsFile` entry. Folds into §8.12 |
| **No cycle detection in Lua writer** (S77, EEE-2-probe, live-verified 2026-04-24 — **Low, defense-in-depth**) | `serializeValue → serializeTable → serializeValue` in `src/lua/writer.ts` has zero `WeakSet`/depth-cap. Cyclic `LuaValue` → `RangeError: Maximum call stack size exceeded`. `mergeYamlIntoLua` at `yaml.ts:108-128` is structurally clean (object-spread fresh objects; acyclic parser inputs) | **No reachable exploit today** — all inputs come from text parsers that can't produce cycles. Severity is future-regression: any refactor introducing shared-reference reuse would silent-stack-overflow. Fix: `WeakSet<object>` seen-tracker + depth cap (64, pairs with S60's reader cap). Folds into §8.12 |
| **Concurrent snapshot/backup directory-stamp collision silently overwrites** (S78, GGG-2-probe, live-verified 2026-04-24 — **Low today, Medium once concurrent mutations fire**) | Millisecond-ISO stamps at `safeWrite.ts:74`, `snapshot.ts:59`, `restore.ts:120`, `importSetup.ts:712` with no random suffix. `mkdirSync({recursive:true})` merges; `copyFileSync` overwrites (no `COPYFILE_EXCL`). Live: 20 concurrent `safeWrite` → 8 unique dirs (12 clobbered); 5 concurrent `snapshot` → 4 files (1 clobbered) | **Low for Kindle single-user CLI workflow.** Medium-adjacent for docs/97 GUI + `kindly watch` + CI parallel tests — lost backups become routine once mutations fire concurrently. Combined with S67 (no file-lock) this is the backup-side hole that makes lost-write races unrecoverable. Fix: append `randomBytes(3).toString("hex")` suffix to every stamp; `COPYFILE_EXCL` + retry on `EEXIST`. Folds into §8.14 file-lock scope |
| **Lua reader prototype-pollution: `["__proto__"] = {...}` hides payload from all own-key walks** (S73, III-probe, live-verified 2026-04-24 — **Medium**) | `src/lua/reader.ts:257` does `obj[key] = val` on a plain `{}`. Key `"__proto__"` triggers the `Object.prototype.__proto__` setter → prototype swap, not own-key assignment. KOReader's Lua `dofile` stores `__proto__` as a literal string key (no proto semantics). Divergence confirmed live: `parseSettingsFile` on `{["__proto__"] = {terminal_shell="/bin/attacker"}, refresh_rate=5}` returns object where `Object.keys` → `["refresh_rate"]`, `Object.getPrototypeOf(p) !== Object.prototype`, but `p.terminal_shell === "/bin/attacker"` and `"terminal_shell" in p` | **None today — but no full exploit chain either.** Every kindly walk site uses `Object.entries`/`Object.keys` (classify.ts:113/116, yaml.ts:36/48/87/113/150/157/166, writer.ts:83) → payload is silently dropped at every layer, including the writer. Net effect: kindly's `apply` destroys prototype-smuggled fields on round-trip (integrity invariant broken: "apply is non-destructive on unmodified keys"), and any future code using `in`/direct-lookup/`for...in` on parsed settings would silently trust attacker data. Case C/D also pollute `hasOwnProperty`/`constructor` on the chain — DoS primitive for any code that calls `parsed.hasOwnProperty(...)` instead of `Object.prototype.hasOwnProperty.call`. Fix: `Object.create(null)` at `reader.ts:232` (one-line), or explicit reject of `__proto__`/`constructor`/`prototype` keys at parse. Folds into §8.12 |
| **Scanner evadable by Lua `\x`/`\###`/`\u{}` escape sequences in string literals** (S82, MMM-probe, live-verified 2026-04-24 — **High**) | `src/setup/luaScan.ts` patterns at `:88` (require net), `:96` (require ffi), `:121`/`:127` (os.remove/io.open abs-path) match literal bytes inside string quotes. `stripCommentsOnly` at `:150-216` walks string bodies but the `\`-branch at `:189-191` emits `\` + next char **verbatim** — no hex/decimal/unicode escape decoding. LuaJIT decodes all three at `dofile` → runtime sees `"socket"` while scanner residue contains the literal chars `\`,`x`,`7`,`3` | **None today — `require("\x73\x6f\x63\x6b\x65\x74")` passes scanner clean.** Collapses W36/W37 to a lexical theater check on plaintext module names. Breaks **before §W39 ships**: proposed trust-summary advisory scope is exactly the four regexes that MMM evades. Cheaper than S3 byte-table assembly (20 chars vs. 60). Fix: decode `\xHH`, `\###`, `\u{...}` during `stripCommentsOnly` walk. Does NOT close concatenation / `string.char` assembly — those are known dataflow limitations in docs/87 §2.2. Folds into §8.12 |
| **Lua reader silently coerces integers above 2⁵³ to nearest f64** (S83, PPP-probe, live-verified 2026-04-24 — **Low**) | `src/lua/reader.ts:219` parses numeric tokens via `Number(src.slice(…))`; no `Number.isSafeInteger` guard anywhere. `9007199254740993` → `9007199254740992` (−1); `2⁶⁰` → off by 24 | **None today — but no known KOReader key uses integers near 2⁵³ (largest typed-integer schema values are epoch-seconds ~1.7×10⁹ and byte-offsets ~10⁷).** LuaJIT default f64 matches kindly's behavior in the default build — divergence only fires if KOReader is compiled with `-DLJ_ARCH_NUMMODE=2`. Fix: `Number.isSafeInteger(n)` check on integer-shaped tokens, fail loudly instead of silently corrupting. Folds into §8.12 as one-line defense-in-depth |
| **`parseYamlSafe` honors `%YAML 1.1` directive, switching `<<:` merge semantics under attacker control** (S84, RRR2-probe, live-verified 2026-04-24 — **Medium**) | `src/fs/yamlSafe.ts:42` passes `{maxAliasCount: 100}` but no `version` — `yaml@2.8.3` defaults 1.2 but honors `%YAML 1.1` directive and switches parse tree accordingly. Under 1.1 `<<:` is resolved at parse time; under 1.2 it stays literal. Attacker picks which parser kindly uses by prepending 9 bytes of directive. Three parse sites affected: `yaml.ts:96`, `unpack.ts:92`, `importSetup.ts:67` | **None today.** Under 1.1 classifier DOES see flattened keys (gate fires on SECRET/SENSITIVE hits) — so this is not a gate-bypass like S79. Real severity is **reviewer-mental-model bypass**: reviewer scanning a `.kset` YAML parses it mentally as 1.2 (the lib default they think they know), misses a 9-byte directive at the top, audits `kosync: {<<: *evil}` as "literal `<<` key, inert", but kindly writes flattened `kosync.injected_key` to device. Plus cosmetic: writer at `yaml.ts:74` emits `<<` unquoted — safe under 1.2 but round-trip-dangerous if a downstream tool parses 1.1. Fix: one-line pin `version: '1.2'` in parseYamlSafe. Folds into §8.12, pairs with S79's input-shape normalizer |
| **YAML `!!binary` produces Node Buffer → 22× serialization amplification + shape-guard bypass** (S85, SSS-probe, live-verified 2026-04-24 — **High**) | `yaml@2.8.3` materializes `!!binary` as Node Buffer, `!!set` as Set, `!!timestamp` as Date, `!!omap` as Map. All four exclusion shape-guards in `src/schema/classify.ts` (`:115`, `:188`, `:248`) and `src/schema/yaml.ts` (`:117-122`, `:159-168`) use the same predicate `typeof === "object" && !Array.isArray && !(v instanceof Map)` — Buffer/Set/Date all pass. `Object.entries(Buffer)` yields numeric-string keys 0..N mapped to byte values → writer emits 15-char Lua entry per byte. Live probe: 7 MB YAML source at `parseYamlSafe` 10 MiB cap → **156 MB Lua output** (22× YAML, 29.8× Buffer bytes) | **None today.** Reachable via `apply --file`, `setup import`, `restore`. Per-apply disk footprint ~470 MB (`settings.reader.lua` + `.old` + `.kindly/backups/<ts>/settings.reader.lua`); 20 rotated backups × 470 MB = 10 GB = fully fills Kindle. On-device `pcall(dofile)` of 156 MB Lua source causes 10+ sec boot hang → potential fallback to `.old` sibling (S49/GGG code-drop). §8.15 scope is archive-decompression only; this bomb path (YAML → `yamlToLua` → `dumpSettingsFile` → `safeWrite`) is not covered. Secondary finding: `findSensitiveInValue` walking a Buffer at a SECRET_PATH parent (e.g. `kosync:`) sees numeric byte keys, misses `kosync.userkey` / `kosync.custom_server` / …, gate skipped. SECRET_KEYS top-level matches (e.g. `zlibrary_password: !!binary`) still fire correctly because the check is by key name, not value shape. Fix: reject non-plain-object YAML values at `parseYamlSafe` entry (or pass `customTags: []` + failsafe schema to disable non-core tags); add output-byte counter in `dumpSettingsFile` with 50 MiB cap matching §8.15's archive-uncompressed ceiling. Folds into §8.12 and widens §8.15 |
| **`defaults.custom.lua.old` + per-plugin `settings/*.old` fallback-dofile surfaces** (S88, VVV-2-probe, live-verified 2026-04-24 — **High**) | `luadefaults.lua:29-43` and `luasettings.lua:31-45` both fallback to `pcall(dofile, <path>.old)` when main file returns nil or raises. SNAPSHOT_PATHS includes `defaults.custom.lua` but NOT `.old`. Attacker ships `return nil` main + payload `.old` → fallback fires reliably. Same pattern for all 14+ per-plugin `settings/*.old` files (S87 sibling) | **None today — two-file tar (`defaults.custom.lua` stub + `.old` payload) extracts at exit 0, fallback fires on next boot. Safety-snapshot blind to `.old` → overwrite irreversible. Pre-HMAC fix: extend SNAPSHOT_PATHS/SAFETY_PATHS to include `.old` siblings + `settings/`. Folds into §8.7 + §8.16 `.old` reject rule** |
| **`settings/` directory code-drop via restore/rollback bypasses SNAPSHOT_PATHS** (S87, VVV-probe, live-verified 2026-04-24 — **High**) | `extractTarGz` (`archive.ts:202-225`) enforces only `enforceSizeCaps` + `isSafeRelativePath`; no extraction-side allowlist limits paths to `SNAPSHOT_PATHS`. `SNAPSHOT_PATHS` (`snapshot.ts:41-48`) is producer-side only. KOReader's `DataStorage:getSettingsDir()` returns `settings/`; 14+ plugins `pcall(dofile)` from there at init. `SAFETY_PATHS` (`restore.ts:49-56`) is the same 6-entry list → pre-restore backup blind to `settings/` | **None today — attacker tar with 10 `settings/<plugin>.lua` entries extracts at exit 0 with zero flags. Each file runs at next KOReader boot via `LuaSettings:open → pcall(dofile)`. Safety-snapshot blind spot removes victim's rollback recovery path. Fix: extraction-side path allowlist AND extend SNAPSHOT_PATHS to include `settings/`. Folds into §8.7** |
| **`history.jsonl` index collision under concurrent writers** (EE-probe, live-verified 2026-04-24) | `writer.ts:148-149` reads active entries then computes `highestIndexOf + 1` before `openSync(p, "a")` append at :169. O_APPEND prevents line-interleave/corruption; index *computation* is a read-modify-write with no lock. Racing writers see the same highest index → duplicate indexes. Live probe N=40 concurrent applies (re-run 2026-04-24): 36 persisted entries with 2 duplicate index pairs (indexes 21 and 24); first probe at N=40 saw 8 duplicates and N=20 saw 3 — collision count is non-deterministic but reliably >0 at ≥20 concurrent. `findHistoryEntryByIndex('/tmp/audit-EE2', 21)` returned the first match (backup stamp `…58-587Z`), silently ignoring the second (backup `…58-588Z`). `findHistoryEntryByIndex` (reader.ts:102-110) returns first match → **`rollback --to N` silently resolves to the wrong snapshot_dir**. `countAllHistory` dedupes → undercount → `rollback --to 20` falsely reports out-of-range when 20 entries actually exist | **Documented limitation per writer.ts:46-47, but the rollback misdirection consequence is new. Requires two genuinely-concurrent mutations in same cwd — unlikely in Kindle workflow but realistic once `kindly watch`/cron/GUI fire mutations in parallel (docs/97). Rotation triggered on `active.length` can straddle a collision window and cement duplicates in archive files permanently. Fix: `flock` the history file for the read-then-append window (same fix shape as S67), OR switch to UUID-based entry IDs and compute index lazily at read-time. Lower priority than S63 (forged entries) but the same JSONL file, same writer — worth bundling fixes** |

---

## 5. The honest threat model

Against **a skilled attacker shipping an obfuscated uncatalogued
plugin**, today's kindly **cannot defend the user** if they use
`--accept-plugins` without `--strict-imports`. This is not a bug the
scanner can fix — it's the fundamental limit of static analysis on a
dynamic language with full process-level access and no OS sandbox.

The scanner was specified (docs/93) for *median* attackers
(unobfuscated Lua in a zip file on a forum). S3 is above median. The
spec's "the reviewer is the backstop" assumption over-estimates how
carefully real users review plugin source before accepting.

---

## 6. Proposed hardening (v0.11.2 / W39–W41)

### W39 — make the trust decision explicit (highest ROI)

- **Flag semantics flip.** `--accept-plugins` implies strict mode:
  catalog MATCH required. Uncatalogued plugins require
  `--accept-community-plugins` (new flag). Closes S3's default path.
- **Scanner rebranded to advisory.** Rename "scanner findings" →
  "scanner advisories" in output. Add fixed-text banner: *"lexical
  scanner — a determined author can evade. Review the Lua yourself."*
  Kills false confidence.
- **Three narrow obfuscation patterns** (raise attacker cost, do not
  pretend completeness):
  - `require(<non-literal>)` — catches S3 directly
  - `_G\[["'](os|io|debug|package)["']\]` bracket indirection — catches S2
  - `string.char\s*\(` with ≥3 numeric literal args — byte-table
    assembly signal
  - New category: `suspected-obfuscation`. Zero FPs on the 17-plugin
    inventory (confirmed).
- Under `--accept-community-plugins`, ANY advisory requires
  `--ack-advisories` or interactive confirmation.

### W40 — community tier catalog

- `data/catalog/plugins.community.v1.json` — second catalog,
  community-vouched hashes. Seeded from docs/95 research. Start with
  ~10 most popular (LocalSend, assortedreader, KOSyncExtra, …).
- Verdict surface widens: `BUNDLED_MATCH`, `COMMUNITY_MATCH`,
  `UNKNOWN_PLUGIN`. `--accept-community-plugins` accepts first two
  silently; `UNKNOWN_PLUGIN` requires `--accept-unknown-plugin <name>`
  (per-plugin opt-in; forces a granular decision).

### W41 — quarantine + forensics

- **Quarantine flag.** `--accept-community-plugins --quarantine` ships
  the plugin with `plugins_disabled[<name>] = true`. User enables
  manually in KOReader's plugin manager after their own review.
- **Doctor awareness.** `kindly doctor` lists non-catalog plugins
  present on device with fingerprint + first-seen-date from
  `.kindly/history.jsonl`. Periodic re-review path.

### v0.13+ — author signing (the real long-term fix)

- Detached `.kset.sig` via minisign/age.
- Author key pinned in `.kindly/trusted_keys.json` on first use (TOFU).
- Trust decision shifts from "is this code safe" to "is this author's
  key". Same model every package manager converged on after they
  learned the hard way.

---

## 7. What remains un-fixable even after W41

A user who runs `--accept-community-plugins --ack-advisories
--accept-unknown-plugin evilthing` after reading three separate
warnings has made four explicit trust decisions. At that point the
defense is the same as `curl | sudo bash`: the user is vouching for
the code, and no tool can save them from themselves.

This limit should be named in docs/87 rather than hidden.

---

## 8. v0.11.2 minimum hardening (driven by confirmed exploits, not speculation)

Each item below is tied to a specific scenario that is reproducible
against `e8ce545` today. These are the *minimum* to close the holes
this red-team confirmed — not the full W39–W41 plan. Doing these
without also doing W39 leaves the trust-by-accept default untouched,
but they close every confirmed bypass.

### 8.1 Code changes in `src/schema/classify.ts`

Add to `SENSITIVE_KEYS`:

```
"terminal_shell",             // S9: C.execlp(shell, …) in terminal.koplugin
"screenshot_dir",             // consistency with *_dir cluster
"screensaver_dir",            //   "
"wikipedia_save_dir",         //   "
"cover_image_path",           //   "
"cover_image_fallback_path",  //   "
"cover_image_cache_path",     //   "
```

Add to `SENSITIVE_DOMAIN`:

```
terminal_shell: "code-exec",
screenshot_dir: "directory",
screensaver_dir: "directory",
wikipedia_save_dir: "directory",
cover_image_path: "directory",
cover_image_fallback_path: "directory",
cover_image_cache_path: "directory",
```

Introduce a new classification category for *plugin re-enable*
(S17/S27). `plugins_disabled` flipping `<name>: true` → `<name>: false`
(or removal in replace mode) must route through the SENSITIVE gate.
Cleanest implementation: a dedicated check in
`collectSensitiveFromSettings` that inspects
`settings.plugins_disabled` dict entries, emits a synthetic
`plugins_disabled.<name>=enable` SENSITIVE hit whenever the incoming
value is falsy. Domain `code-exec` for known-code-exec plugins
(`terminal`), `service` for daemon plugins (`SSH`, `httpinspector`,
`LocalSend`, `calibre`), `plugin` for the rest.

### 8.2 Patch-tier trust gate (S4)

The single most serious open hole. Patches are outside every existing
trust system. Minimum fix is option (2) from S4's mitigations list:
under `--strict-imports`, patches require explicit per-file hash
pinning via `--expect-patch-hash <sha256>:<path>` (repeatable flag).
Absent a matching pin, a patch in a strict-mode import is a policy
block, not a warning. Scanner output for patches changes wording from
"no novel findings" to "patch contents not verified — scanner is
advisory only".

### 8.3 Manifest identity-field sanitizer (S7 / S40 / S65 / KKK)

**KKK-probe 2026-04-24 refined the Zod-side gap.** `z.string().url()`
uses the WHATWG URL constructor, which accepts `\x1b` inside the
path segment — a crafted `source_url` with embedded OSC 52
(`https://evil/\x1b]52;c;<base64>\x07`) validates clean at Zod and
renders to stdout on `setup inspect` / `setup import` display paths
unescaped. Same mechanism for `z.string()` (no format validation at
all) on `meta.author` / `meta.description`. **10+ render sites in
`setup.ts:279-293` and `:718-740`** pass values through
`info()`/`warn()` with zero sanitization. JSON mode is safe
(`JSON.stringify` escapes `0x1b`); Zod error messages don't echo
raw values.

The sanitizer scope below now covers both the Zod bypass (ESC
survives validation) and the renderer bypass (no escaping at
emit).


`src/commands/setup.ts:279-288` writes `result.author`,
`result.sourceUrl`, `result.description`, and `result.name` straight
to stdout. Route these through the same C0/C1-stripping filter that
the settings-value renderer already uses (S25 is evidence this
filter exists and works). Reject or replace any byte in `0x00..0x1F`
except `\n`/`\t` and the C1 range `0x80..0x9F`. Enforce a max display
length per field; render each on its own line so `\r` or cursor-up
sequences cannot cross a following line.

### 8.4 Type-mismatch default + SECRET redaction across all diff renderers (S20 / S43b / S45 / S48)

`src/setup/import.ts` (or equivalent): type-mismatch on a known-typed
settings key becomes a policy-block (exit 3). Add
`--allow-type-mismatch` opt-out flag.

**Separately — the core hardening this section owns — every
change-renderer must route `prev`/`next` through a shared SECRET
redactor in `src/schema/classify.ts`.** Scope covers three output
paths, one helper:

1. **Apply human renderer** (`src/commands/apply.ts:91-100`
   `renderChange`): S43b live-verified, 5 victim plaintexts
   landed in `~ key "prev" → "next"` diff lines during
   `kindly apply --dry-run`.
2. **Diff human renderer** (`src/commands/diff.ts:84-96`
   `renderChange`): S45 verified, identical leak, worse framing
   because `diff` is the "safe preview" command and `git-diff`-
   style exit codes invite piping into CI / cron / log stores.
3. **JSON envelope** (`src/cli/json.ts:82` emitter):
   S48 live-verified, `apply --dry-run --json` and `diff --json`
   both serialize `prev`/`next` raw. `DiffResult.grouped`
   double-emits each change. JSON is the automation default —
   structured log stores (Splunk/Datadog/S3) retain values long-
   term. Generalization is load-bearing: JSON consumers are more
   likely to be *automated pipes* than humans, so this is the
   higher-blast-radius of the three.

Minimum shape of the shared helper:

```ts
// classify.ts
export function redactForDisplay(key: string, value: unknown): string {
    if (isSecret(key)) return `«redacted ${key}»`;
    return fmt(value);
}
```

Rule: **unconditional** — no `--show-secrets` flag. If a user
legitimately needs to see their own secret, they read
`settings.reader.lua` directly (an explicit machine-local action).
The leak channels are screenshots, paste-into-bug-reports, `tee`,
and piped JSON — none of which benefit from a flag.

Sub-item: the type-mismatch block must *also* call the redactor for
its "current value" column (original §8.4 scope). Merges into the
shared helper — no separate code path.

### 8.6 Share the SENSITIVE detector between `apply` and `setup import` (S38)

**Arguably the top 8.x item.** W31 (`collectSensitiveFromSettings`)
is wired into `src/setup/import.ts` only. `src/commands/apply.ts`
calls `mergeYamlIntoLua` with no SENSITIVE check. Result: plain
`kindly apply --file friend.yaml` lands every SENSITIVE key silently
at exit 0, including `terminal_shell`, `plugins_disabled.terminal`,
SSH settings, `ota_server`, and directory-redirection keys.

Minimum fix:

- Extract the sensitive-diff helper so both paths share it. Apply
  runs it on the post-merge settings diff.
- On hit: emit the same `[code-exec] terminal_shell …` / `[ssh] …`
  / `[directory] …` tagged lines that setup import emits, and
  require `--accept-sensitive` (plus per-key `--accept-key <name>`
  if setup's granular flag exists) before writing. No flag ⇒
  policy block (exit 3), mirroring W31.
- Dry-run output (`apply --dry-run`) shows the tagged lines too.

Without this, 8.1 (expanded SENSITIVE_KEYS) and the
plugin-re-enable classification only protect the `setup import`
path. The broader, more popular `apply` path stays silent.

**Sub-item: dual-gate semantics must survive the extraction (S42).**
`extra_plugin_paths` today is dual-gated under setup (`--accept-
sensitive` *and* `--accept-plugins` both required, per W31a). When
the shared helper fires in apply, it must preserve the dual gate
— not flatten to a single `--accept-sensitive`. Single-accept
under apply still leaves S42 open: a plain YAML user who's been
trained to answer "yes sensitive" for harmless-looking settings
changes would hand the attacker arbitrary plugin execution on any
filesystem path. Same dual-gate semantics that docs/88 §4.3
specifies for setup apply verbatim in apply.

**Sub-item: the shared helper must cover SECRETs, not just SENSITIVE (S43a).**
The classify.ts denylist distinguishes SECRET (credentials / PII,
always stripped on pull) from SENSITIVE (code-exec / network /
SSH, prompt-gated). Setup-import calls `filterForYaml(…, "full")`
which drops SECRETs from the incoming manifest entirely. Apply has
no such filter. The shared helper (or the apply path directly)
must: (a) detect SECRET overwrites in the incoming diff, (b)
default to policy-block (exit 3) on any SECRET overwrite, (c) gate
acceptance behind a per-key opt-in flag (`--accept-overwrite-
secret zlibrary_password`), matching the explicitness of setup-
side granularity. Silent credential overwrite should not be an
option any YAML-paste can reach.

**Sub-item: §8.4 generalizes to cover S43b.** §8.4 already calls
for the diff renderer to redact SECRET keys on the "current value"
side under type-mismatch. S43b demonstrates the leak fires on
every SECRET overwrite, not just type-mismatch. Generalize: in
`renderChange` (`src/commands/apply.ts:91-100`), call
`classifyKey(c.path[0])`; if SECRET, render both `prev` and `next`
as `«REDACTED»` (or show only a hash prefix for diff-usefulness).
This is a unconditional fix — no flag opt-in — because the leak
channel is the dry-run user's own screenshot.

### 8.7 Rollback / restore / snapshot trust gate (S44 / S46 / S47 / S49 / S51 / S87 / S88)

**Sibling to §8.6 in scope.** §8.6 extends the setup-import trust
boundary to `apply`. §8.7 extends it to the three commands that
*ingest attacker-controlled tars*: `rollback`, `restore`, and the
producer side `snapshot` which — combined with restore — forms a
distribution channel (S47). Today every one of these commands runs
with zero classify.ts imports and zero trust metadata on the tar
payload.

**Attack surface confirmed open (all live-verified 2026-04-23):**

- **S44 (rollback).** `kindly rollback <attacker-dir>` with zero
  flags: settings overwrite + plugin + patch in one command.
  Output `✓ restored 3 plugin/patch file(s)` is misleading —
  "restored" framing masks first-touch attacker-code ingestion.
- **S46 (restore).** `kindly restore <attacker.tar.gz>` with zero
  flags: single-file attack artifact (strictly more distributable
  than S44's directory shape); same gate-free code-drop.
- **S47 (snapshot-as-distribution).** Attacker uses `kindly
  snapshot` on their compromised fixture → blessed-looking
  `kindly-snapshot-<ts>.tar.gz` → posts on forum → victim
  `kindly restore`s it → code fires. **kindly's own tooling is
  the attack framework; no custom tar construction needed.**
  Tars carry no origin metadata: a snapshot the user took
  yesterday and one from a forum post look identical to
  restore.
- **S49 (code-drop surface is ≥5 files, not 2).** KOReader loads
  settings files via `pcall(dofile, …)` — every Lua file in
  `SNAPSHOT_PATHS` is a code-drop surface. Live-demo'd with
  `defaults.custom.lua` (marker in 2s). Same primitive confirmed
  statically for `history.lua` (`readhistory.lua:110`) and
  `settings.reader.lua.old` (`luasettings.lua:37`). Any gate
  that enumerates "plugins/ + patches/" specifically is
  incomplete.
- **S50 (symlink entries bypass path-safety).**
  `isSafeRelativePath` validates entry paths only, not symlink
  targets. `listTarGz` (`tar -tzf`) hides file types. BSD tar
  extracts symlinks with target intact. Result: `kindly
  restore/rollback` is an arbitrary-symlink-creation primitive
  inside the victim's filesystem. Cross-install exfil confirmed
  (bridged settings file leaked non-SECRET values through
  `kindly diff`/`pull`). Moderate severity, info-disclosure + invariant
  break. Fold into §8.7 via a `tar -tvzf` mode-column check.
- **S51 (rollback accepts any directory).**
  `rollback.ts:73` `resolve(env.cwd, opts.snapshotDir)` with no
  anchor to `<cwd>/.kindly/{pre-import,pre-apply,pre-rollback,
  backups}/`. Any directory containing a file literally named
  `plugins-patches.tar.gz` is a valid rollback source; entry
  names pass `isSafeRelativePath`, extraction lands in
  koreaderRoot. Sibling primitive to S46 via a distinct command
  — social-engineering footprint "run `kindly rollback
  /tmp/dir` to undo your import". `--to <N>` path inherits the
  same primitive when `history.jsonl` has a forged entry
  (reader trusts every line verbatim; no HMAC, no schema
  anchoring).
- **S87 (`settings/` directory code-drop).** 14+ KOReader
  plugins call `LuaSettings:open(<settingsDir>/<name>.lua)` →
  `pcall(dofile)` at plugin init. `extractTarGz` accepts any
  path-safe entry, so attacker tar entries under `settings/`
  extract to `<mount>/koreader/settings/` with zero gates.
  `SNAPSHOT_PATHS` (producer-side) and `SAFETY_PATHS`
  (pre-restore backup) are both blind to `settings/` — victim
  cannot roll back. **Scope widening for §8.7 fix:** (a) expand
  `SNAPSHOT_PATHS` / `SAFETY_PATHS` to include `settings/` so
  safety snapshots cover it; (b) add extraction-side allowlist
  that rejects entries outside the expanded set unless
  `--from-untrusted`; (c) HMAC marker's `file_digests[]` must
  cover `settings/*.lua`.
- **S88 (`.old` fallback-dofile surfaces).** KOReader's
  `luadefaults.lua` and `luasettings.lua` both fall back to
  `pcall(dofile, <path>.old)` when the main file returns nil.
  `SNAPSHOT_PATHS` includes `defaults.custom.lua` but NOT
  `defaults.custom.lua.old`; same gap for `settings/*.old`.
  Two-file attack: ship `return nil` main + payload `.old` →
  fallback fires reliably. **Pre-HMAC remediation landable
  today:** extend `SNAPSHOT_PATHS` at `snapshot.ts:41-48` and
  `SAFETY_PATHS` at `restore.ts:49-56` to include
  `defaults.custom.lua.old` and `settings/`. One-line change,
  no new flags, no HMAC dependency — ensures safety snapshots
  capture the surfaces and restoration is reversible. Pairs
  with §8.16's `.old` reject rule for `.kset` archives.

**The minimum hardening shape.**

**Primary: HMAC'd snapshot marker keyed to a machine-local secret.**

- On first `kindly` run (or on `kindly init` / explicit setup),
  generate `~/.kindly/machine-hmac-key` — 32 random bytes,
  `chmod 600`, persist. This key never leaves the machine.
- `kindly snapshot` writes a `.kindly-snapshot-marker` file into
  the tar containing: `{ producer_fingerprint, created_at,
  file_digests[] }` HMAC'd with the machine-local key. The
  digests cover every Lua file in the archive (**full-tar
  coverage, per S49**).
- `kindly rollback` and `kindly restore` refuse tars without a
  valid marker. Error message: `"archive has no kindly-snapshot
  marker — it was not produced by kindly on this machine. To
  ingest an external snapshot, use --from-untrusted, which runs
  the full setup-import pipeline (scanner, catalog lookup,
  SENSITIVE/SECRET detectors)."`
- **Entry-type filter for all tar extraction (S50 / S52 defense).**
  Replace `listTarGz`'s `tar -tzf` with `tar -tvzf` and parse the
  mode column. Reject any entry whose mode character is `l`
  (symlink), `h` (hardlink), `p` (FIFO/named pipe), `c` (char
  device), `b` (block device), or anything other than `-`
  (regular file) / `d` (directory). Applies to both the HMAC'd-
  trusted and `--from-untrusted` paths — the type invariant must
  hold unconditionally. Closes S50 (symlink exfil), S52's FIFO
  DoS primitive against `kindly doctor`/scanner `readFileSync`
  calls, and the S52 hardlink gap which is currently masked by
  BSD tar's linkname rule on macOS but **not by any kindly-side
  defense** (untested on GNU tar / Linux-Kindle).
  Alternative: migrate extraction to an in-process tar reader
  with explicit entry-type filtering.
- `--from-untrusted` routes the tar through the same trust
  pipeline as `setup import`: scanner on every Lua file in the
  tar (not just plugins/), SENSITIVE-key detection on the
  contained `settings.reader.lua`, and the `--accept-plugins` /
  `--accept-patches` / `--accept-sensitive` flags required where
  the content triggers them.

**Why machine-local HMAC, not a universal signature.**

- Universal signatures would require key distribution / a trust
  root / a central authority — none of which kindly has or
  should have for a local CLI.
- Machine-local HMAC solves the S47 distribution channel
  cleanly: an attacker's snapshot won't have a marker valid on
  the victim's machine, so restore refuses by default. Users
  who legitimately want to move a snapshot between their own
  machines use `--from-untrusted` and accept the pipeline run.
- Copy-marker attacks are nullified by the machine-local key:
  attacker can't produce a valid HMAC without the victim's
  `~/.kindly/machine-hmac-key`.

**Companion: scrub env before `spawnSync("tar", …)`  (M-probe, 2026-04-23).**

All three `spawnSync("tar", …)` call sites in
`src/fs/archive.ts:64, 219, 233` inherit the full `process.env`.
macOS bsdtar (libarchive 3.7.4) ignores `TAR_OPTIONS` (verified:
only `TAPE` is read, bogus flags silently dropped), so the macOS
execution path is not exploitable today. **GNU tar on Linux reads
`TAR_OPTIONS`** — a malicious caller (or a compromised shell
rc / systemd unit) can set
`TAR_OPTIONS='--transform=s,.*,koreader/plugins/evil.koplugin/main.lua,'`,
and extraction rewrites entry paths *after* `listTarGz` /
`isSafeRelativePath` already validated the original listing.
`listTarGz` and `extractTarGz` disagree about the set of paths.
Every path-safety gate in §8.7's tar pipeline silently inverts.

The fix is a one-line change at each site:
`spawnSync("tar", args, { env: {}, encoding: "utf8" })` — or,
if locale preservation is wanted, pass an explicit allowlist
(`{ LANG, LC_ALL, LC_CTYPE, PATH }`) that drops
`TAR_OPTIONS`/`TAR_READER_OPTIONS`. Must ship with §8.7; an HMAC-
gated tar pipeline that extracts with attacker-influenced env is
still compromised.

**Secondary: `kindly snapshot` warning about tarred code.**

Current snapshot output warns only about plaintext secrets.
Add: `"archive contains <N> plugin file(s) and <M> patch
file(s) and <K> Lua settings file(s) — all are code that
executes on KOReader boot. Do not share this archive with
anyone you would not trust to run arbitrary code on your
device."` This complements the HMAC gate on the restore side
with a producer-side awareness nudge.

**Non-goal clarification: §8.6 does NOT cover this.** §8.6
shares the SENSITIVE detector between `apply` and `setup import`.
Rollback/restore operate on fat tars with Lua code files, not on
YAML settings — the SENSITIVE detector is the wrong tool. The
trust question on these paths is "did kindly produce this tar?"
not "does this settings payload contain code-exec keys?".

### 8.9 Restrictive permissions on `.kindly/` state (S53)

**Independent from the trust-gate work in §8.6–§8.7.** §8.6/§8.7
stop attacker-controlled bytes from writing into trusted
locations. §8.9 stops non-kindly readers from reading kindly's
state. Different axis, same root cause: kindly never calls
`chmod` / `umask`.

**The gap.** `mkdirSync` / `openSync` inherit the process umask
(default 022 on macOS, most Linux distros), so every file and
directory kindly creates under `.kindly/` lands world-readable
(755/644). Critically, `.kindly/backups/<ts>/settings.reader.lua`
is a byte-copy of pre-apply device state — `filterForYaml` is
NOT run on backups because the whole point of a backup is
byte-exact recovery. So every SECRET on device at backup time
sits in plaintext in a 644 file.

**The fix.** `chmod 0700` on `.kindly/` at creation, `chmod 0600`
on every file written inside. Call sites to patch:

- `src/fs/safeWrite.ts:76` — `mkdirSync` for backups dir
- `src/fs/safeWrite.ts:85` — `openSync` for `.tmp` file
- `src/history/writer.ts:143` — `mkdirSync` for `.kindly`
- `src/history/writer.ts:169` — `openSync` for `history.jsonl`
- `src/commands/rollback.ts:130` — `mkdirSync` for pre-rollback
- `src/lib/importSetup.ts` — pre-import dir creation
- `src/commands/restore.ts` — pre-restore dir creation

Simplest implementation: single helper `mkdirSecure(path)` and
`writeFileSecure(path, bytes)` wrappers in `src/fs/` that
set mode explicitly. Thread all `.kindly/`-rooted I/O through
them. Drop `process.umask(0o077)` at CLI entry as a
defense-in-depth fallback for any call that slips through.

**Why it's sibling of §8.7 not a subsidiary.** §8.7 is about
authenticating inbound tars (HMAC marker keyed to machine-local
secret). §8.9 is about restricting outbound perms on state we
already trust. Neither subsumes the other — you need both. An
attacker can harvest `.kindly/backups/*/settings.reader.lua`
without ever touching kindly's trust-ingestion surface.

### 8.10 Shared stdout sanitizer for filesystem-sourced strings (S55 / S65 / S66)

§8.3 covers **manifest identity fields** (strings inside `meta.*`).
S55 / S65 / S66 broaden the surface: strings sourced from the
filesystem itself — plugin directory basenames (doctor), unknown
settings key names (doctor), label field in history entries
(history render) — reach stdout with zero sanitization. OSC 52
clipboard-write (`\x1b]52;c;<base64>\x07`) and bidi controls
(U+202A–202E, U+2066–2069, U+200E–200F) pass through verbatim.

**Fix.** Single `stripControl(s: string): string` in `src/lib/tty.ts`:

- Strip C0 `0x00–0x1F` except `\n`/`\t`
- Strip C1 `0x80–0x9F`
- Strip Unicode bidi block (U+202A–202E, U+2066–2069, U+200E–200F)
- Strip DEL `0x7F`
- Cap display length per field

Call sites to route through it (beyond §8.3):

- `src/lib/doctor.ts:217` — unknown-keys `sample.join(", ")`
- `src/lib/doctor.ts:361, 380-381` — uncatalogued plugin basenames
- `src/commands/history.ts:112-117` — `e.label`
- `src/commands/setup.ts:280-293, 718-741` — meta echo path (extends §8.3)
- Every `renderChange` emitter for `Change.path[]` / value stringification

**JSON output must pre-sanitize, not rely on `JSON.stringify` escaping.**
`cat`'ing the JSON log file honors the control bytes even when
`stdout` would escape them. Apply `stripControl` to every string
before it enters the JSON value tree.

Extends §8.3 rather than duplicating; §8.3's identity-field
sanitizer becomes a caller of this helper.

### 8.11 history.jsonl trust layer (S63 / EE / Y-probe)

History is a three-way trust failure: entries aren't schema-validated,
aren't HMAC-signed, and the index-computation read-modify-write races
under concurrent writers.

**Fix (three components, one commit):**

1. **Zod `HistoryEntrySchema.strict()`** in `src/history/reader.ts`.
   Reject non-string `ts` (Y-probe crash), non-number `index`
   (EE/duplicate-index footprint), absent `cmd`, and paths outside
   `<cwd>/.kindly/`. Today `reader.ts:70` casts via `as HistoryEntry`
   — zero validation.

2. **HMAC each line with the machine-local key from §8.7.** Line
   format: `{entry}\t<hmac-hex>`. `findHistoryEntryByIndex` and
   `rollback --to N` verify before acting. Forged `history.jsonl`
   lines (S63 primitive) fail HMAC → rollback refuses. Reuses the
   machine-local key already provisioned for snapshot markers — no
   new secret management.

3. **`flock(LOCK_EX)` the history file** around the read-compute-
   index-then-append sequence (`writer.ts:148-169`). Closes EE's
   duplicate-index race. Alternative: migrate to UUID entry IDs
   computed at write time, with index lazily assigned at read.
   Lock is simpler — ships with §8.14 which needs flock anyway.

**Renderer guards** (defense in depth): render-time `typeof` checks
on every user-visible field so a malformed survivor entry can't
crash the displayer. §8.10 sanitizer covers the `label` field.

### 8.12 Parser & shape guards for settings.reader.lua (S59 / S60 / S64 / S71 / S73 / S76 / S77 / S79 / S80 / S82 / S83 / S84 / S85) — **P1 after S71/S79/S82/S85**

**Status upgraded 2026-04-24.** RRR probe confirmed S71: array
wrapping (`kosync: [{userkey: v}]`) and literal dotted-top-level
(`"kosync.userkey": v`) both bypass SECRET_PATHS / SENSITIVE_PATHS
classifiers. This section was P2 (parser DoS defense); S71 promotes
it to **P1 — SECRET filter integrity**.

**Fix.**

- **Non-plain-table top-level reject.** `parseSettingsFile` returns
  early with a typed error if `dofile` evaluates to anything other
  than a Lua table with string keys. Closes S59 (string top-level
  → kindly emits `0:j\n1:u\n…` character-soup into pull YAML).
- **Recursion-depth cap at `parseValue`.** Default cap 64, raise
  to 128 if any real-world snapshot needs more. Closes S60
  (~50k depth → V8 stack blown, DoS of every parser-using
  command). Applies to both reader and writer.
- **`plugins_disabled` shape guard in `mergeYamlIntoLua`**
  (`src/schema/yaml.ts:108-128`). Reject non-plain-object:
  `plugins_disabled: [SSH, terminal]` and `plugins_disabled: true`
  fail fast with `plugins_disabled must be a map of name → bool`.
  Closes S64 (array wholesale-replace silently re-enables every
  disabled plugin, including terminal).
- **Classifier path integrity (S71).** Three changes in
  `src/schema/classify.ts`:
  - `:248` and `:115`/`:188` — recurse into arrays when the
    array's elements could satisfy `SECRET_PATHS[0]` / parent
    path prefix. Drop `!Array.isArray(v)` short-circuit. Array
    elements inherit parent path.
  - `:158` `classifyKey` — consult `SECRET_PATHS` for any key
    string containing `.`; or, cleaner: add a single
    **input-shape normalizer** at YAML-load time in
    `src/schema/yaml.ts` that rewrites `{"kosync.userkey": v}`
    → `{kosync: {userkey: v}}` before any classifier sees it.
    Normalization is preferred — one check vs. scattering path
    awareness across every classifier call site.
  - Unit tests for both shapes against every entry in
    `SECRET_PATHS` + `SENSITIVE_PATHS`.

None of these are flag-gated; all are type-invariant violations
with no legitimate user case. S71 changes the stakes — without
the classifier fix, every other §8.1 / §8.4 / §8.6 gate can be
bypassed by reshaping the input.

- **Prototype-safe table allocation (S73).** At `src/lua/reader.ts:232`:

  ```ts
  const obj: Record<string, LuaValue> = Object.create(null);
  ```

  Removes the `__proto__` setter from the object entirely — the
  `obj["__proto__"] = val` assignment at `:257` now creates an
  own-key instead of swapping the prototype. Downstream
  `Object.entries(obj)` / `Object.keys(obj)` walks now include
  `__proto__` (and `constructor` if someone ships one); classifier,
  YAML emitter, and Lua writer all see the payload — which is
  exactly what we want (either it fires the SENSITIVE gate or
  round-trips honestly). Same mitigation handles `constructor`,
  `prototype`, `hasOwnProperty`, `toString` — no enumeration of
  unsafe keys needed. Alternative, if we prefer loud-reject over
  normalize-away: add `__proto__` / `constructor` / `prototype`
  to a small reserved-key set and `fail()` in `parseTable` on
  match. Either is a few lines; `Object.create(null)` is one.

- **UTF-8 BOM strip at `parseSettingsFile` entry (S76).**

  ```ts
  export function parseSettingsFile(src: string): LuaValue {
      if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
      return new Parser(src).parseFile();
  }
  ```

  Matches LuaJIT behavior. Closes the BOM-edited-settings
  divergence — users with BOM-emitting editors see kindly work.

- **Cycle detection in Lua writer (S77 / S80).** `src/lua/writer.ts`
  `serializeTable` takes a `WeakSet<object>` parameter; throws on
  repeat visit; depth counter capped at 64 (symmetric with S60's
  reader-side cap). **Now P1, not defense-in-depth** — S80 probe
  confirmed the `yaml` library materializes actually-cyclic
  graphs from attacker YAML (`&a / *a` self-reference), reaching
  the writer via `kindly apply --file` / `kindly setup import`
  as a push-button DoS.

- **Input-shape normalizer at `parseYamlSafe` (S71 / S79).** Single
  chokepoint that runs before any classifier / merge / writer call.
  Three shape rewrites in one pass:

  1. **Merge-key resolution (S79).** `{"<<": T, k: v}` →
     `{...T, k: v}` (explicit key wins on collision — YAML 1.1
     semantics).
  2. **Dotted-literal promotion (S71c).** `{"kosync.userkey": v}`
     → `{kosync: {userkey: v}}`.
  3. **Array-wrap descent (S71a).** Recurse `normalize` into
     array elements so classifier walks reach values under
     arrays — pair with classify.ts:115/188/248 drop of the
     `!Array.isArray(v)` short-circuit.

  WeakSet cycle-guard at normalizer entry (S80): if the parser
  materialized a cycle, normalize a structured-clone copy or
  short-circuit on repeat visit. Otherwise the normalizer
  itself is DoS'd by cyclic YAML.

- **Pin YAML version to 1.2 in `parseYamlSafe` (S84).** One-line
  patch at `src/fs/yamlSafe.ts:42`:

  ```ts
  return yamlParseRaw(src, {
      maxAliasCount: MAX_ALIAS_COUNT,
      version: '1.2',
  });
  ```

  Attacker loses the `%YAML 1.1` primitive that would otherwise
  let them pick between "literal `<<` key" (1.2) and "flattened
  siblings" (1.1) parse trees. Pairs with the input-shape
  normalizer above: normalizer owns S71/S79 literal-`<<`
  handling; version pin ensures `<<` is **always** literal at
  the yaml-library layer. All three parse sites
  (`yaml.ts:96`, `unpack.ts:92`, `importSetup.ts:67`) inherit
  via the shared `parseYamlSafe` chokepoint.

- **Scanner escape-sequence decoding (S82).** Extend
  `stripCommentsOnly` in `src/setup/luaScan.ts:150-216` to decode
  `\xHH`, `\###`, and `\u{...}` in the not-stripped branch:

  ```ts
  if (ch === "\\" && !stripStrings) {
      const esc = source[i + 1];
      if (esc === "x" && isHex(source[i+2]) && isHex(source[i+3])) {
          out += String.fromCharCode(parseInt(source.slice(i+2, i+4), 16));
          i += 4; continue;
      }
      if (esc >= "0" && esc <= "9") { /* 1-3 decimal digits */ ... }
      if (esc === "u" && source[i+2] === "{") { /* parse until } */ ... }
      out += escapeTable[esc] ?? esc;
      i += 2; continue;
  }
  ```

  Must land **before or alongside W39** — W39's proposed trust-
  summary advisory relies on scanner findings; without decode,
  escape-evaded payloads produce silent "no sensitive imports"
  advisories. Concatenation and `string.char` byte-table assembly
  remain evadable (S3-class, dataflow limitation in docs/87 §2.2);
  escape-decode closes the cheapest single-literal evasion.

- **Reject non-plain-object YAML values at `parseYamlSafe` (S85).**
  `yaml@2.8.3` materializes `!!binary` → Buffer, `!!set` → Set,
  `!!timestamp` → Date, `!!omap` → Map. All of these pass kindly's
  current `!(v instanceof Map)` + `!Array.isArray(v)` shape-guards,
  entering object-branches with surprising semantics (`Buffer` in
  particular gets walked as a numeric-keyed byte table). Two-part
  defense:

  1. **Disable non-core tags at the parser.** Extend
     `parseYamlSafe` to pass a restricted schema:

     ```ts
     yamlParseRaw(src, {
         maxAliasCount: MAX_ALIAS_COUNT,
         version: '1.2',
         customTags: [],
         schema: 'failsafe',   // only !!map, !!seq, !!str — no binary/set/ts/omap
     });
     ```

     kindly's settings are strings/numbers/booleans/nested maps.
     The failsafe schema covers everything legitimate; the core
     schema's `!!binary`/`!!set`/`!!timestamp`/`!!omap` have no
     kindly use case.

  2. **Belt-and-suspenders typed-object reject post-parse.** Walk
     the parsed tree; throw on any `Buffer`/`Set`/`Date`/`Map`
     subtree with a typed error that points at the offending
     path. Catches the case where a future maintainer restores
     `schema: 'core'` without noticing.

  Combined with the input-shape normalizer, this closes the third
  parse-time bypass class (after literal-`<<` and dotted-literal):
  attacker can no longer smuggle typed objects through the
  classifier walks, and the 22× serialization amplification of
  `!!binary` → Lua numeric-keyed table is unreachable.

- **Safe-integer guard in Lua reader (S83).** At
  `src/lua/reader.ts:219`, after `Number(token)`:

  ```ts
  const n = Number(this.src.slice(start, this.pos));
  if (Number.isNaN(n)) this.fail("invalid number");
  if (isIntegerToken && !Number.isSafeInteger(n)) {
      this.fail(`integer literal ${this.src.slice(start, this.pos)} exceeds f64 safe range`);
  }
  return n;
  ```

  `isIntegerToken` = no `.` and no `e`/`E` in the slice.
  One-line defense-in-depth; matches LuaJIT semantics in the
  default build (both use f64) but fails loudly rather than
  silently corrupting if KOReader ever stores large integers.

### 8.13 EPHEMERAL tier split (S62)

`classify.ts` has one EPHEMERAL tier. Several EPHEMERAL keys carry
literal PII (`lastfile`, `lastdir`, `menu_search_string`,
`quote_deck_pos`, `LocalSend_last_update_check`). `--full` mental
model is "include more keys"; actual semantic silently widens to
"include more keys **including PII**".

**Fix.** Split EPHEMERAL into two sub-tiers:

- `EPHEMERAL_VOLATILE` — UI state that isn't PII (panel positions,
  toolbar toggles, last-used-unit). `--full` includes these.
- `EPHEMERAL_PII` — paths, queries, user-typed strings. `--full`
  excludes these by default. Require explicit `--full-pii`.

On `--full-pii` write, stderr warning listing the PII keys about
to land in YAML (same shape as the setup-import SENSITIVE
renderer). `--output`-targeted files inherit `chmod 0600` from
§8.9. Small scope, closes S62 without mental-model churn for
existing `--full` users (PII keys mostly weren't what people
wanted anyway).

### 8.14 Advisory lock + stamp-uniqueness on read-modify-write (S67 / S78)

`mergeYamlIntoLua` reads, mutates in memory, then writes — no
lock across the window. On Kindle the USB-mount invariant holds
(KOReader exited by construction while kindly runs). On
**macOS KOReader-on-desktop** — the live-head target adopted in
`project_kindly_koreader_live_head` memory — KOReader can write
the file between kindly's read and write, and the last-writer-
wins silently.

**Fix.** Advisory `flock(LOCK_EX)` around the read-modify-write
span in `mergeYamlIntoLua` and in every other kindly command
that does read-then-write on `settings.reader.lua` (apply, diff
dry-run… actually diff is pure read, so apply is the only
mutator). Use `proper-lockfile` if Bun's native `flock` binding
doesn't land cleanly; the sidecar file is fine under `.kindly/`.

Long-term follow-up: propose KOReader honor the same lock in
`luasettings.lua`. Out of kindly's scope for v0.11.2 but worth a
docs-level note so the lock file is discoverable.

**Companion: stamp-collision fix for concurrent backups (S78).**
Four sites use millisecond-ISO stamps as directory / filename
components without randomness — `safeWrite.ts:74`,
`snapshot.ts:59`, `restore.ts:120`, `importSetup.ts:712`.
Concurrent writers silently clobber. Append 3 random bytes (6 hex
chars) to every stamp:

```ts
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
```

~1-in-16M collision per pair. `copyFileSync` → `copyFile` with
`COPYFILE_EXCL` + retry on `EEXIST` as a belt. Folds here because
the file-lock already serializes the hot path inside a single
process; the stamp fix handles cross-process and GUI/watch
concurrency where the lock is held briefly per operation but
stamps collide within the millisecond window.

**Second companion: `.kindly/history.jsonl` + `.kindly/trace.jsonl`
symlink guards (S74).** All three sites — `history/reader.ts:59`,
`history/writer.ts:169`, `cli/trace.ts:60` — route through
`openAppendSecure(path)` / `readFileSecure(path)` wrappers that
`lstat` before open and refuse symlinks. Same helper as S56/S70's
settings-read guards (§8.14 scope intersects §8.9's
`writeFileSecure`). Closes the append-oracle primitive: attacker
pre-seeding `.kindly/history.jsonl → /target` no longer redirects
mutation writes.

### 8.15 Stream-counting bomb cap (S68 / S75 / S85 / YY-probe / BBB-probe)

`readGzipSizes` trusts ISIZE, which is 32-bit → wraps at 4 GiB.
Confirmed bypass: 4.1 GiB bomb passes all three caps.

**Fix.** Replace `readGzipSizes` → `enforceSizeCaps` with a
streaming-decompress pipeline: pipe through `zlib`-native or
`spawn("gunzip", ["-c"])`, count bytes through a passthrough
sink, abort (kill child, delete partial output) once byte
`cap + 1` is observed. Authoritative — trailer-independent — and
handles arbitrarily-sized bombs.

Belt-and-suspenders: sum `tar -tvzf` entry sizes before extract
and reject if the sum exceeds the cap. In the YY probe the tar
header *did* honestly report 4.1 GiB, so even a cheap pre-check
on `tar -tvzf` output would have caught it. Keep the streaming
cap as the primary; tar-header sum is a secondary belt. Both
land with §8.7 since that section already owns the tar pipeline.

**Companion: reject multi-member gzip (S75 / BBB).** `gzip -l`
reports only the last member's ISIZE per RFC 1952 concat
semantics. BBB probe: 11-member archive reported 4 KB, true
uncompressed 70 KB (17× undercount). `tar -xzf` stops at the
first embedded tar EOF marker, so only CPU/memory DoS today — not
file-write amplification — but the stream-counting sink in the
primary fix already catches the real bytes if hit. Tight
complementary check: in `readGzipSizes`, scan the archive for
gzip magic `1f 8b` at any offset beyond byte 0 and refuse.
Legitimate `.tar.gz` workflows never produce multi-member
archives; pure-JS byte scan, zero dependency on the gzip binary's
output shape.

**Companion: YAML→Lua serialization cap (S85).** Orthogonal bomb
path: attacker YAML `!!binary "<base64>"` materializes as Buffer,
gets walked by `yamlToLua`'s plain-object branch, gets serialized
as `["N"] = NNN,\n` per byte → 22× YAML-source amplification,
29.8× Buffer-bytes amplification (live-confirmed: 7 MB YAML →
156 MB Lua). `parseYamlSafe`'s 10 MiB source cap × 22 = 220 MiB
theoretical output, well over the 100 MiB `extractTarGz` cap.
**This bomb path never passes through a tar/gzip pipeline** — it
exits `dumpSettingsFile` straight into `safeWrite`'s 6-step
atomic pipeline, writing to `settings.reader.lua` + `.old` +
`.kindly/backups/<ts>/settings.reader.lua` (~3× amplification
beyond the serialization output itself).

Two-part fix pairs with §8.12's typed-object reject at
`parseYamlSafe`:

1. **Primary: reject Buffer/Set/Date/Map at parse time** (§8.12
   above) — closes the amplification at the source.
2. **Belt: counting buffer in `dumpSettingsFile`.** Pass through
   a counting wrapper; abort with `SerializationBombError` at
   `SERIAL_CAP = 50 MiB` (matches archive-uncompressed ceiling).
   Catches any future typed-value path that bypasses the parse-
   time reject (e.g. a settings.reader.lua that already has a
   misshapen value from a prior attacker apply), and bounds the
   worst-case `safeWrite` footprint.

Without the §8.12 reject, the counting cap is reached after
~1.6 MB of attacker Buffer source (50 MiB / 30 amplification) —
still useful, but S85's parse-time reject is the clean fix.

### 8.16 SNAPSHOT_PATHS code-drop gate + `.old` sibling reject (S49 / GGG)

§8.7 currently mandates HMAC coverage for "every Lua file in the
archive (full-tar coverage, per S49)." GGG adds a concrete shape
to enforce in the `--from-untrusted` pipeline:

- **Reject `.kset`/tar archives that ship `settings.reader.lua.old`**
  unless `--accept-dot-old` (new flag, off by default). KOReader
  generates `.old` during its own atomic writes — no legitimate
  author packs one into a distribution. `.old` siblings in a
  `.kset` are prima facie suspect.
- **Scanner runs on every file in SNAPSHOT_PATHS that KOReader
  `dofile`s**, not just `plugins/*.lua` and `patches/*.lua`.
  Namely `defaults.custom.lua`, `history.lua`, `settings.reader.lua.old`,
  and `settings.reader.lua` itself (yes, the main settings file —
  `return {…}` is code; S59 shows non-table returns are an
  exploit primitive). If any fails the lexical scanner, the full
  import is a policy block under `--strict-imports`, an advisory
  under default mode.
- **Main-file validation extends to the `.old` sibling** when
  present: if the main file parses as a plain table, kindly
  validates that too; if the main returns `nil`/non-table, the
  `.old` is treated as the *actual* settings source and scanned /
  validated in its place (this matches KOReader's runtime
  semantics).

Folds into §8.7's `--from-untrusted` pipeline; no new command.

### 8.18 Bun cwd-trust — `bunfig.toml` hijack (S81) — **depends on upstream**

**No clean kindly-side fix exists.** Bun's documented behavior is
to load `./bunfig.toml` from cwd on every invocation, including
from compiled binaries (empirically verified 2026-04-24). Three
fix candidates tested live; two rejected (compile-to-binary,
`-c` override); one partial (cwd-forcing wrapper breaks
relative-path flags).

**Minimum to ship:**

1. **Shell wrapper that refuses to run if `./bunfig.toml` exists
   in cwd.** The `kindly` script (if distributed as a wrapper
   over `bun run src/cli.ts`) greps for `bunfig.toml` before
   exec and errors with: `"refusing to run: cwd contains
   bunfig.toml which Bun honors as preload config. cd to a
   directory you control."` Bypasses with `--allow-cwd-bunfig`
   for users who intentionally use it (rare).
2. **docs/87 threat-model callout.** Name cwd-trust as an
   explicit kindly assumption. "Never run kindly from `/tmp/`,
   freshly-cloned repos, or shared working directories." The
   same advisory applies to every Bun-based tool — kindly is
   the canary for a broader ecosystem issue.
3. **Upstream ask: Bun feature request for a suppress-bunfig
   mode.** `BUN_CONFIG_SKIP=1` or `bun run --no-config`. Until
   this lands, no robust defense exists. File the issue;
   reference this scenario.

**Optional but worth considering:**

- **Move `kindly` to a compiled distribution** with the wrapper
  shell above. Still doesn't fix the bunfig-from-cwd issue
  (proven), but reduces exposure to "user ran `bun run
  kindly/src/cli.ts`" paths by making that invocation less
  canonical.
- **Canary preload.** Ship a kindly-side preload that runs
  very early and refuses to proceed if any *other* preload
  was registered. Defense-in-depth only — attacker preload
  already ran by the time kindly's check runs. More useful as
  telemetry ("did anyone attack via bunfig?") than prevention.

This section is deliberately separate from §8.17 because the
fix model is different: §8.17 is a local integrity check kindly
owns entirely; §8.18 is an upstream design issue kindly can
only work around. Both must be in the v0.11.2 scope — §8.17 for
the trust pyramid, §8.18 for the execution-substrate trust
assumption.

### 8.17 Catalog + schema file integrity (S72) — **P0, top of trust pyramid**

AAA-probe 2026-04-24 confirmed: a single-file swap of
`data/catalog/plugins.bundled.v1.json` inverts the W32 MATCH
gate, silences the W34e scanner, and beats `--strict-imports`
— with zero UI surface firing. **Every other hardening item in
§8 presupposes this gate holds.** If the catalog is
attacker-controlled, §8.1 SENSITIVE expansion, §8.2 patch hash
pinning, §8.6 shared SENSITIVE detector, and §8.7 HMAC marker
all operate on forged ground truth.

**Fix (preferred — compile-time embedded hash).**

Add a constant in `src/catalog/reader.ts`:

```ts
const CATALOG_SHA256_EXPECTED = "sha256:…";  // updated by build step
```

Loader check at `:123`:

```ts
const bytes = readFileSync(p);
const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
if (actual !== CATALOG_SHA256_EXPECTED) {
    throw new KindlyError(
        ErrorCodes.CATALOG_INTEGRITY_FAIL,
        `catalog at ${p} has unexpected hash`,
        [{ text: "Reinstall kindly from a trusted source." }],
    );
}
```

Build step: `scripts/embed-catalog-hash.ts` recomputes the hash
whenever `data/catalog/plugins.bundled.v1.json` changes and
patches the constant. Same rig as `scripts/extract-plugin-meta.ts`.
Unit test verifies the constant matches the committed catalog.
Attacker modifying the catalog must also modify a `.ts` file —
which is code-exec-equivalent (Bun compiles at runtime), so the
attack collapses to "attacker already has RCE."

**Same treatment for `data/schemas/settings.reader.lua.v1.json`
via `src/schema/settings.ts:41-48`.** Lower severity than
catalog (SECRET/SENSITIVE lists are hardcoded in classify.ts
source, not derived from the schema), but type-mismatch
detection depends on the schema being honest. Bundle one fix
covering both files.

**Tradeoff: the release process now signs catalog updates.**
Release engineer regenerates → build step re-embeds hash →
commit includes both JSON and .ts delta. Routine for any
release with catalog changes; non-issue for point releases
that don't touch catalog.

**Secondary defense (post-install tampering only):** on first
run, write `~/.kindly/install-integrity.json` (chmod 0600 via
§8.9) containing catalog SHA at install. Compare every load.
Catches post-install tampering but **does not defend supply-
chain** (the install-time bytes may have been owned upstream).
Preferred fix already covers supply-chain; this is a weaker
layer that's useful only if the preferred fix is not feasible.

Must ship with or **before** any §8.1-§8.16 work — otherwise
every downstream gate is inverted.

### 8.8 Summary: the hardening patch in one paragraph

"Expand SENSITIVE_KEYS to cover `terminal_shell` and the unlisted
`*_dir` cluster. Classify `plugins_disabled` enables as SENSITIVE
generically. Gate patches under strict mode with per-file hash pins.
Sanitize manifest identity fields through the same escaper settings
values already use, and **extend that sanitizer to every
filesystem-sourced string reaching stdout (plugin basenames, key
names, history labels) to close the OSC 52 clipboard-write and the
bidi-override spoofing surfaces.** Promote type-mismatch from
warning to block, and route every change-renderer (apply human,
diff human, JSON envelope) through a shared SECRET redactor.
**Share the SENSITIVE detector between `apply` and `setup import` so
every other SENSITIVE-keys fix covers both paths — otherwise plain
`kindly apply --file friend.yaml` bypasses the entire trust
boundary.** **Close the rollback/restore/snapshot channel with an
HMAC'd machine-local marker so attacker-minted tars can't be
ingested via `kindly restore` without explicit `--from-untrusted`,
which runs the full setup-import pipeline** — and extend the
scanner inside that pipeline to every file in `SNAPSHOT_PATHS` that
KOReader `dofile`s (not just `plugins/` + `patches/`), including a
reject of `.old` siblings which have no legitimate reason to ship.
**Replace the gzip-ISIZE-based bomb cap with a streaming-counter
sink**, since ISIZE wraps at 4 GiB and a 4.1 GiB bomb slips past
all three current caps. **Add a Zod strict schema + per-line HMAC
+ `flock` to `history.jsonl`**, because today a single appended
line + `kindly rollback --to N` lands attacker Lua on-device, and
the same file races to duplicate indexes under concurrent writers.
**Add an advisory `flock` on settings.reader.lua read-modify-write**
for the macOS desktop live-head target where KOReader is not
quiesced by the USB-mount invariant. **Split EPHEMERAL into
volatile vs. PII tiers** so `--full` stops silently widening to
paths and search queries. **Drop `TAR_OPTIONS`/`LANG` env on every
`spawnSync("tar", …)` call** so a GNU-tar Linux install can't
invert every path-safety check via `--transform`. And **parser/
shape guards on settings.reader.lua itself** — non-plain-table
top-level, recursion-depth cap, `plugins_disabled` map-only — so
an attacker-planted settings file can't DoS every kindly command
that parses it or silently re-enable every disabled plugin via
array-form. None of these change the default UX for catalogued
well-formed Setups — only the ones trying to slip code-exec,
credential leaks, or DoS past the trust boundary."

---

## 9. Red-team scenarios not yet run

- **S5 — downgrade to catalog-pinned vulnerable plugin.** Mechanism:
  attacker ships plugin bytes matching kindly's *stale* catalog;
  device runs a newer KOReader where that plugin was fixed. Import
  downgrades the plugin. Confirmed mechanism: verification uses
  kindly's own catalog, not the manifest. Version-skew note fires but
  does not block. Weaponization requires a real CVE-fixed plugin
  whose old hash kindly pins — worth a review of catalog staleness
  policy more than a local demo.
- **S6 — TOCTOU on fat install.** Race between extraction and
  verification (if any window exists). Hardware-specific, not easily
  demo'd in a local fixture.
- ~~**S29 — snapshot/restore round-trip.**~~ ✅ **Covered 2026-04-23
  by S44 + S46 + S47.** S44 proved rollback has no W31 equivalent;
  S46 proved `kindly restore` is the same gate-free path with a
  single-file attack artifact; S47 proved the full snapshot→restore
  round-trip using kindly's own tools end-to-end. The auto-pre-import
  snapshot itself is benign (captures pre-attack state); the
  compromise propagates through *subsequent* user snapshots (S47).
- **S31 — meta.name / meta.tags path-traversal.** `meta.name` becomes
  part of the setup ID and may touch filesystem paths
  (`~/.kindly/setups/<id>-<slug>.kset`). Malicious name like `../`
  sequences or null bytes — does `src/lib/setupExport.ts`'s slug
  function sanitize?

---


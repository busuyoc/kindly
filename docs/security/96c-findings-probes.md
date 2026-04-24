# 96c — Red-team findings: automated probes (S68–S88)

> Split from the original 96-red-team-v0.11.1.md.
> Other parts: [96a](96a-findings-core.md) (S1–S51), [96b](96b-findings-extended.md) (S52–S67), [96d](96d-hardening.md) (§2–§9), [96e](96e-koreader-live.md) (§10–§11).

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

### S87 — `settings/` directory code-drop via restore/rollback bypasses SNAPSHOT_PATHS (VVV-probe, live-verified 2026-04-24) — **High**

`src/commands/snapshot.ts:41-48` defines `SNAPSHOT_PATHS` as 6 entries
(`settings.reader.lua`, `.old`, `defaults.custom.lua`, `history.lua`,
`patches`, `plugins`). This list is **producer-side only** — it
controls what `kindly snapshot` tars, but is NOT enforced on the
consumer side. `src/fs/archive.ts:202-225` `extractTarGz` checks only
`enforceSizeCaps` + `isSafeRelativePath`. Any path-safe tar entry
extracts to `<mount>/koreader/`.

KOReader's `DataStorage:getSettingsDir()` returns `<data_dir>/settings/`.
14+ plugins call `LuaSettings:open(<settingsDir>/<plugin>.lua)` at
plugin init, which does `pcall(dofile)`. Grep-confirmed list:
`autostandby`, `battery_stats`, `bookshortcuts`, `hotkeys`, `gestures`,
`perception_expander`, `newsdownloader`, `wallabag`, `cloudstorage`,
`opds`, `profiles`, `texteditor`, `movetoarchive`, `docsettingtweak`.

**Live probe** (`/tmp/kindly-vvv-live/probe.ts`): built
`malicious.tar.gz` with 10 attacker `settings/<plugin>.lua` entries
carrying a top-level `io.open(...)` marker-write payload above the
`return { … }`. Ran `executeRestore` with zero flags against a fake
mount. Result: exit 0, `restored 11 files`, all 10 landed at
`<mount>/koreader/settings/`. No path rejection, no allowlist warning.
On next KOReader boot every matching plugin's `LuaSettings:open` would
`pcall(dofile, <attacker file>)` → RCE at plugin init.

**Aggravators:**

- **Safety-snapshot blind spot.** `restore.ts:49-56` `SAFETY_PATHS` is
  the same 6-entry list → pre-restore safety snapshot is blind to
  `settings/`. Victim cannot roll back from an infected `settings/`
  state via kindly's own tooling.
- **Rollback sibling.** `rollback.ts` shares the same `extractTarGz`
  path (S51 pattern). Same RCE surface — attacker's
  `plugins-patches.tar.gz` containing `settings/gestures.lua` extracts
  without challenge.
- **Setup import partially defended.** `unpack.ts:113` rejects
  undeclared entries, so a manifest that doesn't declare `settings/*`
  paths blocks them. But if an attacker declares those paths in the
  manifest, they extract. The manifest-declaration gate is the only
  defense; no path-allowlist exists.

**Severity: High.** S49 established code-drop via the 5 files in
`SNAPSHOT_PATHS`. S87 extends to 14+ additional surfaces under
`settings/`, each independently `dofile`'d at plugin init. The
attack surface is wider than S49 (more files, more execution
opportunities at boot), and the safety-snapshot blind spot removes
the victim's recovery path.

**Fix.** Two complementary approaches (not mutually exclusive):

1. **Extraction-side allowlist.** `extractTarGz` and `rollback`'s
   direct-copy path reject any entry outside an expanded
   `ALLOWED_PATHS` set (current SNAPSHOT_PATHS + `settings/`) unless
   `--from-untrusted` is passed. Closes S87 and hardens S44/S46/S51.
2. **Extend SNAPSHOT_PATHS to include `settings/`.** Producer-side:
   `kindly snapshot` captures `settings/` so pre-restore backups
   cover it. Consumer-side: safety-snapshot covers it → rollback
   recovery possible.

Folds into §8.7 (tar-ingestion trust gate). The HMAC marker's
`file_digests[]` must also cover `settings/*.lua`.

---

### S88 — `defaults.custom.lua.old` + per-plugin `settings/*.lua.old` fallback-dofile surfaces (VVV-2-probe, live-verified 2026-04-24) — **High**

Sibling of GGG (`settings.reader.lua.old`) and S87 (`settings/`).
KOReader's `luadefaults.lua:29-43` pattern:

```lua
ok, stored = pcall(dofile, "defaults.custom.lua")
if ok and stored then new.rw = stored
else pcall(dofile, "defaults.custom.lua.old")  -- attacker surface
```

`SNAPSHOT_PATHS` includes `defaults.custom.lua` but **NOT** its `.old`
sibling. `extractTarGz` has no allowlist → attacker tar entry
`defaults.custom.lua.old` extracts to `<mount>/koreader/`. Fallback
fires when the main file is absent, raises, or returns nil — attacker
controls this trivially by shipping `defaults.custom.lua` containing
`return nil` alongside the payload `.old`.

Same pattern applies to per-plugin settings under `settings/`: each
`LuaSettings:open(path)` at `luasettings.lua:31-45` does
`pcall(dofile, path)` then falls back to `pcall(dofile, path..".old")`.
Every `.old` sibling of the 14+ plugin settings files from S87 is an
independent code-drop surface.

**Live probe** (`/tmp/kindly-vvv-live/probe2.ts`): built tar with
`defaults.custom.lua` (`return nil` stub) + `defaults.custom.lua.old`
(payload with `io.open` marker-write). Ran `executeRestore` with zero
flags. Result: exit 0, both files landed. Safety snapshot
(`SAFETY_PATHS`) did not capture `.old` — if victim had a legitimate
`.old` pre-attack, overwrite is irreversible via kindly.

**Severity: High.** Multiplies the attack surface from S87 and GGG.
Each `pcall(dofile, <path>.old)` fallback is independently
exploitable. The two-file attack shape (`return nil` + `.old` payload)
is reliable regardless of victim's pre-existing state.

**Fix.** Pre-HMAC remediation landable today:

1. **Extend `SNAPSHOT_PATHS` and `SAFETY_PATHS`** to include
   `defaults.custom.lua.old` and `settings/`. One-line change at
   `snapshot.ts:41-48` and `restore.ts:49-56`. Ensures safety
   snapshots capture the fallback surfaces and `kindly snapshot`
   produces round-trippable archives.
2. **Extraction-side allowlist** (same as S87's fix): reject entries
   outside the expanded set unless `--from-untrusted`.

Folds into §8.7 alongside S87. The `.old` reject rule proposed in
§8.16 (`--accept-dot-old` flag) should extend to cover
`defaults.custom.lua.old` and `settings/*.old` as well.

---


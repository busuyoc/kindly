# 88 — SENSITIVE key class: implementation spec
### *Contract for W31. Rationale in 87-security-matrices.md.*

Date: 2026-04-23.
Status: spec (code will cite this file).

---

## 1. Classification change

`classify.ts` gains a fourth class:

```
SECRET     → never exported, never imported
EPHEMERAL  → excluded by default, --full includes
USER       → normal flow
SENSITIVE  → normal flow, mandatory warning + gate on import
```

`classifyKey()` return type becomes `"SECRET" | "EPHEMERAL" | "SENSITIVE" | "USER"`.

`filterForYaml()` treats SENSITIVE identically to USER — it flows
through pull and export unchanged. The gate fires only on the
import/apply path.

---

## 2. Authoritative SENSITIVE key list

These are the exact key strings as they appear in
`settings.reader.lua`. Top-level unless marked nested.

### Top-level keys

| Key | Domain | Threat |
|-----|--------|--------|
| `extra_plugin_paths` | code-exec | Redirects KOReader plugin loader to arbitrary dirs |
| `ota_server` | network | Controls OTA update source |
| `http_proxy` | network | MITMs all HTTP traffic |
| `http_proxy_enabled` | network | Activates proxy |
| `calibre_wireless_url` | network | Calibre endpoint |
| `trans_server` | network | Translation service endpoint |
| `zlibrary_base_url` | network | Z-Library mirror |
| `SSH_allow_no_password` | ssh | Passwordless SSH access |
| `SSH_autostart` | ssh | Auto-starts SSH daemon |
| `SSH_key_only_auth` | ssh | Changes SSH auth mode |
| `SSH_port` | ssh | SSH port |
| `httpinspector_autostart` | service | Auto-starts HTTP inspector |
| `httpinspector_port` | service | HTTP inspector port |
| `LocalSend_autostart` | service | Auto-starts LocalSend |
| `LocalSend_port` | service | LocalSend port |
| `LocalSend_save_dir` | directory | File receive target |
| `LocalSend_ext_dirs` | directory | Dirs exposed to LocalSend |
| `home_dir` | directory | KOReader home (all path resolution) |
| `download_dir` | directory | Download target |
| `inbox_dir` | directory | Received-file target |
| `debug` | debug | Enables debug logging |
| `opds_servers` | network | OPDS catalog servers (top-level array of tables; any mutation triggers the gate — see §4.2) |

### Nested paths (dotted)

| Path | Domain | Threat |
|------|--------|--------|
| `kosync.custom_server` | network | Reading-sync endpoint (creds sent here) |

Total: 23 keys. 22 top-level, 1 nested.

### How the list is maintained

Same denylist pattern as SECRET_KEYS / SECRET_PATHS. New top-level keys
default to USER. When KOReader adds a new security-relevant setting, we
extend this list. The list lives in `classify.ts` as `SENSITIVE_KEYS`
(Set) and `SENSITIVE_PATHS` (Set), mirroring `SECRET_KEYS` /
`SECRET_PATHS`.

### Known gap: plugin-scoped keys

Individual KOReader plugins define their own settings — stored in
`settings.reader.lua` as top-level keys or nested sub-keys under a
plugin's namespace (e.g. `newsdownloader.feed_urls`,
`send2ebook.url`, `calibre.wireless_url` in certain versions). Some
of these control network endpoints or file-write targets and would
qualify as SENSITIVE by intent.

These are **structurally invisible** to the SENSITIVE list: the
denylist covers core KOReader keys only, and the universe of
plugin-scoped keys grows with every third-party plugin. Enumerating
all of them is not feasible.

Defense-in-depth:

- **Import path:** no signal. A Setup that sets
  `newsdownloader.feed_urls` to an attacker endpoint flows through
  unmarked. This is a known residual risk.
- **Doctor path:** W34's `schema.uncurated_keys` check (`90` §5.2)
  surfaces on-device keys not in the core schema — the user sees
  plugin-scoped keys there and can audit. This is the primary
  mitigation until the catalog grows plugin-level schema metadata.

The gap is documented, not fixed. Expanding SENSITIVE to cover
popular third-party plugins is a curation task, not a denylist
structural change.

---

## 3. Gate behavior

### 3.0 Canonical import pipeline (authoritative)

All v0.11 specs that add a gate cite this sequence. **Do not redefine
it in other docs** — cite "88 §3.0 step N" instead. Drift across specs
is how we ended up with contradictions in the first draft.

Sequence inside `executeSetupImport` (`src/lib/importSetup.ts`):

| Step | Action | Where | Data dependencies |
|------|--------|-------|-------------------|
| 1 | `loadSetup` | existing, ~l. 178 | file on disk |
| 2 | `--expect-hash` assertion | 92 §5 | manifestBytes |
| 3 | `FAT_REQUIRES_ACK` | existing, ~l. 185 | shippedPlugins/Patches |
| 4 | Mount detection (`resolveMount` + `readKoreaderVersion`) | existing, ~l. 204 | env |
| 5 | Plugin hash verification | 89 §4.1 | archive files + catalog + device version (step 4) |
| 6 | Compat check | existing, ~l. 216 | manifest + device version |
| 7 | Schema validation | existing, ~l. 251 | manifest |
| 8 | Flatten + SECRET filter + parse device settings | existing, ll. 282–290 | manifest + device file |
| 9 | `computeChanges` / `computeReplaceChanges` | existing, ~l. 301 | manifest + device state |
| 10 | **SENSITIVE gate** (§3.2) | this spec | changes[] from step 9 |
| 11 | Dry-run short-circuit | existing, ~l. 338 | all above |
| 12 | Write phase | existing, ~l. 344+ | all above |

**Why this order:**

- Identity assertions (step 2) fire before anything expensive. Wrong
  file → nothing else matters.
- Fat-ack (step 3) is policy, not data-dependent — gates on archive
  presence alone.
- Plugin hash verification (step 5) needs the device KOReader version
  for the version-skew advisory, which comes from step 4's mount
  detection. It does NOT need device-settings parsing (step 8) or
  diff computation (step 9), so it sits between mount detection and
  compat.
- SENSITIVE (step 10) needs `changes[]` from step 9. It cannot fire
  earlier — the whole point is to classify the diff, and the diff
  doesn't exist until step 9.
- Dry-run (step 11) short-circuits after content gates. Rule in §3.5.

### 3.1 Flag name: `--accept-sensitive`

Not `--accept-network-changes`. The class covers code execution
(`extra_plugin_paths`), SSH, debug, and directory redirection — not just
network endpoints. A network-scoped name would be misleading for
non-network keys. One flag covers the entire SENSITIVE class.

Per-key override: `--accept-key=<keys>` accepts only listed SENSITIVE
keys. **Comma-separated** (`--accept-key=SSH_port,debug`) — the arg
parser stores string flags as single values (last-write-wins), so
repeated flags would silently drop earlier values. The CLI layer
splits on `,` after `parseArgs` returns, trims whitespace, and passes
`Set<string>` into the lib. Accepts exact key strings (top-level) or
dotted paths (nested, e.g. `kosync.custom_server`). Unknown keys in
the list are an `ArgError` (exit 2) — silent acceptance of typos
would defeat the per-key gate.

### 3.2 When the gate fires

**Step 10 in the canonical pipeline (§3.0).** Fires immediately after
`computeChanges` / `computeReplaceChanges` returns, before the
dry-run short-circuit. The gate operates on `changes[]` — it cannot
fire earlier because the diff doesn't exist before step 9.

The check: iterate `changes[]`. For each change, run
`changeHitsSensitive(c)` (§4.7) which checks both the direct path and
recurses into `next`/`prev` for subtree-carrier cases. Collect all
hits. If any exist and neither `--accept-sensitive` nor a matching
entry in `--accept-key=` was passed, throw.

**Scope: `setup import` only.** NOT `apply`. Rationale: `apply`
operates on the user's own `kindly.yaml` — a file they authored or
already trust. Gating every `apply` on first SENSITIVE key addition
creates warning fatigue that erodes the gate when it matters (a
stranger's `.kset.yaml` from Reddit). Local-file trust is user's
responsibility; `apply` of an untrusted local YAML is the
`curl | sh` equivalent and out of scope here, matching the stance
already taken for other local-file workflows in kindly.

Does NOT fire on `pull`, `export`, `setup inspect`, `diff`, or
`apply` — those are either read-only or trust-boundary-inside.

### 3.3 Throw behavior

```typescript
throw new KindlyError(
    ErrorCodes.SENSITIVE_REQUIRES_ACK,
    `this Setup modifies ${n} security-sensitive setting(s):\n${list}`,
    [
        { text: "Review with: kindly setup inspect <file>" },
        { text: "Accept all: --accept-sensitive" },
        { text: "Accept one: --accept-key=<key>" },
    ],
);
```

The `list` includes: key path, domain label, old value → new value (or
"(added)" / "(removed)"). Values are displayed as-is for scalars; for
arrays/objects, display `<array of N items>` or `<object with N keys>`.

### 3.4 Interaction with `--strict-imports`

`--strict-imports` (W34e in `80-v0.6-plus-roadmap.md` §v0.11 P1) will
block on ANY SENSITIVE key change, even if `--accept-sensitive` is
passed. It's the "refuse everything suspicious" mode for U1 automation.
In W31 (before `--strict-imports` exists), `--accept-sensitive` is
sufficient to proceed.

### 3.5 Interaction with `--dry-run`

`--dry-run` skips the gate. The diff output shows SENSITIVE keys with
a marker (e.g. `[SENSITIVE]` prefix in text mode, `"sensitive": true`
field in JSON mode). This lets users preview before deciding.

**Rule for future gates** (to avoid asymmetry drift across specs):

> Dry-run skips **content warnings** — gates that inform the user
> about *what the file would do* (SENSITIVE, plugin hash
> verification, BREAKING severity). It does NOT skip **identity
> assertions** — gates that verify *which file this is*
> (`--expect-hash` in 92; future signature verification in W39).
>
> Rationale: content warnings are informational — dry-run's whole
> purpose is to preview them. Identity assertions answer "do I have
> the right file at all?" — a question dry-run cannot defer. Running
> dry-run on the wrong file produces wrong output, which is the
> failure mode the assertion exists to prevent.

When adding a new gate, classify it as content or identity and wire
the dry-run interaction accordingly. Cite this rule rather than
reinventing the reasoning.

### 3.6 Interaction with `--force`

`--force` does NOT bypass the SENSITIVE gate. It only bypasses compat
checks. Rationale: compat is "this might not work on your device"
(user's risk); SENSITIVE is "this might compromise your device"
(different risk class). They require separate consent.

---

## 4. Edge cases

### 4.1 Nested key under a USER parent (`kosync.custom_server`)

`kosync` is a USER-class top-level key. Its sub-key `custom_server` is
a SENSITIVE path. The diff engine recurses into plain objects
(`diff.ts:87-93`), producing change entries with `path: ["kosync",
"custom_server"]`. The SENSITIVE check joins the path with `.` and
checks against `SENSITIVE_PATHS`.

The merge path (`yaml.ts:112-126`) does shallow merge on nested tables,
so setting `kosync.custom_server` preserves `kosync.userkey` and
`kosync.username` (SECRET paths). This is correct but is exactly the
A2 attack vector from 87 — the SENSITIVE gate is what makes it visible.

Implementation: `isSensitivePath(parentKey, childKey)` mirrors
`isSecretPath()`. Check is: `SENSITIVE_PATHS.has(\`${parent}.${child}\`)`.

### 4.2 Array key (`opds_servers`)

`opds_servers` is an array of objects (each is an OPDS server config).
The diff engine treats arrays as scalars — any mutation (add, remove,
reorder, edit nested field) shows as a single `changed` entry with
`path: ["opds_servers"]`. The SENSITIVE gate fires on ANY change. No
need to distinguish add from reorder from edit.

This is the correct granularity: even a reorder could swap a legitimate
server to a lower priority and insert a malicious one at the top.

### 4.3 `extra_plugin_paths` is dual-gated (W31a)

`extra_plugin_paths` redirects KOReader's plugin loader to arbitrary
directories. Once set, any Lua under those paths executes on the next
startup with full device access. The threat is not the value of the key
in isolation — a settings change cannot place files anywhere — but the
two-stage delivery: an attacker drops `.koplugin/` directories at a
known path (theme pack, SD card, screenshot dir) and ships a lean
Setup that points the loader at it.

For this reason `extra_plugin_paths` is gated by **both** flag classes
even when no files are shipped in the archive:

- `--accept-sensitive` (or `--accept-key=extra_plugin_paths`):
  "I accept that this Setup changes where KOReader looks for plugins."
- `--accept-plugins`: "I accept that Lua plugins from a path I don't
  fully control may execute on my device."

| Setup shape                                 | Required flags                                       |
|---------------------------------------------|------------------------------------------------------|
| Lean, sets `extra_plugin_paths`             | `--accept-sensitive` + `--accept-plugins`            |
| Fat, ships plugin files only                | `--accept-plugins`                                   |
| Fat, ships plugin files + `extra_plugin_paths` | `--accept-sensitive` + `--accept-plugins`         |
| Lean, no `extra_plugin_paths`               | (no plugin gate)                                     |

**Why dual-gate when one flag would already block.** A user
habituated to `--accept-sensitive` ("yeah, I know about the SSH
config") does not see `extra_plugin_paths` as code-exec — the SENSITIVE
warning groups it with network endpoints and directory pins. Forcing
a second, distinctly-named flag (`--accept-plugins`) routes the
decision through a different mental model: "code I don't control is
about to run." The two flags are not interchangeable consents.

**Pipeline position.** The W31a check fires immediately after the
SENSITIVE gate in step 10 of §3.0. UX is two-step: a Setup with
`extra_plugin_paths` and no flags throws SENSITIVE first; once the
user passes `--accept-sensitive`, the next run throws
`FAT_REQUIRES_ACK` from W31a. Acceptable cost — it makes the
distinction concrete instead of hiding it behind one super-flag.

**Error code.** Reuse `FAT_REQUIRES_ACK` (same trust boundary — Lua
execution). Message text differs from the shipped-files case to
describe the lean redirect:

> this Setup sets `extra_plugin_paths` — KOReader will load Lua plugins
> from the listed directories. Any Lua code in those paths will
> execute on your Kindle with full device access. Pass
> `--accept-plugins` to consent.

**Skipped under `--dry-run`** (content gate per §3.5).

### 4.4 Additive vs. replace mode

In additive mode (`mergeYamlIntoLua`): only keys PRESENT in the
manifest can be SENSITIVE triggers. A manifest that doesn't mention
`SSH_port` leaves the device's current `SSH_port` untouched — no gate.

In replace mode (`replaceYamlIntoLua`): a SENSITIVE key on device that
is NOT declared in the manifest gets removed. Removal of a SENSITIVE
key is also a gate-worthy event. Example: removing `http_proxy` (which
disables the proxy) is benign, but removing `SSH_key_only_auth` (which
weakens SSH auth to allow password login) is not. The gate fires on
removal too, with the warning showing "(removed)" and the old value.

### 4.5 Key present but value unchanged

If the manifest declares a SENSITIVE key with the exact same value
already on device, `computeChanges` produces no change entry (the
`deepEqual` check at `diff.ts:83` matches). The SENSITIVE gate does NOT
fire — there's nothing to warn about.

### 4.6 SENSITIVE key in `--accept-key` that isn't actually changing

If the user passes `--accept-key=SSH_port` but the manifest doesn't
touch `SSH_port`, the flag is silently ignored (not an error). Same
behavior as `--accept-plugins` when no plugins are shipped.

### 4.7 Subtree-carrier changes (parent absent or parent-removed) — **LOAD-BEARING**

`computeChanges` in `src/schema/diff.ts:76-79` short-circuits when the
parent key doesn't exist on device (or, in replace mode, when the
parent is being removed): it emits **a single** change entry for the
whole subtree rather than recursing. This means §4.1's assumption that
nested SENSITIVE changes always surface as `path: ["kosync",
"custom_server"]` is incorrect for two real cases:

**Case A — parent absent on device (additive mode):**
- Device has no `kosync` table (user never used reading sync)
- Manifest sets `kosync: { custom_server: "https://evil.com" }`
- `computeChanges` emits one change: `{kind: "added", path: ["kosync"], next: {custom_server: "..."}}`
- A naive gate impl — "for each change, check path against `SENSITIVE_KEYS` / `SENSITIVE_PATHS`" — misses this. `["kosync"]` is not SENSITIVE, but the subtree *contains* `kosync.custom_server` which is.

**Case B — parent removed (replace mode):**
- Device has `kosync: { custom_server: "http://my-server", userkey: "..." }`
- Manifest in replace mode omits `kosync` entirely
- `computeReplaceChanges` emits `{kind: "removed", path: ["kosync"], prev: {custom_server: "...", userkey: "..."}}`
- Removing `kosync.custom_server` is a SENSITIVE change (old endpoint abandoned — could be a legitimate fix, could be the attacker clearing tracks after harvesting). The gate must fire.

**Correct gate logic:** for every change entry, check both (a) the direct change path against `SENSITIVE_KEYS` and `SENSITIVE_PATHS`, AND (b) recurse into the change's carrier value (`next` for `added`/`changed`; `prev` for `removed`; both for `changed` when either side is an object) to find embedded SENSITIVE paths underneath the declared change path.

```typescript
// Returns dotted paths of SENSITIVE keys reachable inside `value`,
// rooted at `pathPrefix`. Used when a change entry's path is shallower
// than the SENSITIVE path we care about (Cases A + B above).
function findSensitiveInValue(
    pathPrefix: readonly string[],
    value: LuaValue,
): string[] {
    const hits: string[] = [];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return hits;
    }
    for (const [k, v] of Object.entries(value)) {
        const full = [...pathPrefix, k];
        const dotted = full.join(".");
        if (full.length === 1 && SENSITIVE_KEYS.has(dotted)) hits.push(dotted);
        else if (SENSITIVE_PATHS.has(dotted)) hits.push(dotted);
        hits.push(...findSensitiveInValue(full, v));
    }
    return hits;
}

function changeHitsSensitive(c: Change): string[] {
    const direct = c.path.join(".");
    const hits: string[] = [];
    if (c.path.length === 1 && SENSITIVE_KEYS.has(direct)) hits.push(direct);
    if (c.path.length >= 2 && SENSITIVE_PATHS.has(direct)) hits.push(direct);
    // Subtree carrier: change path is shallower than a SENSITIVE path.
    if (c.kind === "added" || c.kind === "changed") {
        hits.push(...findSensitiveInValue(c.path, c.next));
    }
    if (c.kind === "removed" || c.kind === "changed") {
        const prev = c.kind === "removed" ? c.prev : (c as { prev: LuaValue }).prev;
        hits.push(...findSensitiveInValue(c.path, prev));
    }
    return [...new Set(hits)];
}
```

**Rationale for putting this in §4, not just §6:** this is the attack
vector the whole SENSITIVE class exists to block (A2 in `87`). A
straightforward reading of §3.2 would produce a broken gate that
silently passes precisely the Reddit-attached `.kset.yaml` scenario we
designed against. The recursive check is not an edge case — it's the
load-bearing path for the A2 mitigation.

**Tests required (non-negotiable):**
- Lean `.kset.yaml` setting `kosync.custom_server` against a device
  with no prior `kosync` → gate fires, cites `kosync.custom_server`
- Replace-mode manifest omitting `kosync` against a device with
  `kosync.custom_server` set → gate fires on the removal
- Additive manifest changing `kosync.auto_sync` (USER) against device
  with no prior `kosync` → gate does **not** fire (no SENSITIVE path
  reachable in the subtree)

### 4.8 Array-of-tables subtree (`opds_servers` added wholesale)

`opds_servers` is a SENSITIVE top-level key. If the manifest adds it
for the first time on a device that didn't have it, the change entry
is `{kind: "added", path: ["opds_servers"], next: [...]}`. Direct path
match against `SENSITIVE_KEYS` catches it — no recursion needed
because arrays are treated as scalars by `diff.ts:81`. No separate
handling required; listed here so the reader of §4.7 doesn't conclude
arrays need the same recursive treatment they don't.

---

## 5. Error codes

Add to `ErrorCodes` in `src/types/errors.ts`:

```typescript
SENSITIVE_REQUIRES_ACK: "SENSITIVE_REQUIRES_ACK",
```

This parallels `FAT_REQUIRES_ACK`. One code for all SENSITIVE blocks
(the message body lists the specific keys). No separate code per
domain — the domain is metadata in the warning text, not in the
error code.

---

## 6. Classify.ts changes (sketch)

```typescript
const SENSITIVE_KEYS = new Set<string>([
    "extra_plugin_paths",
    "ota_server",
    "http_proxy",
    "http_proxy_enabled",
    "calibre_wireless_url",
    "trans_server",
    "zlibrary_base_url",
    "SSH_allow_no_password",
    "SSH_autostart",
    "SSH_key_only_auth",
    "SSH_port",
    "httpinspector_autostart",
    "httpinspector_port",
    "LocalSend_autostart",
    "LocalSend_port",
    "LocalSend_save_dir",
    "LocalSend_ext_dirs",
    "home_dir",
    "download_dir",
    "inbox_dir",
    "debug",
    "opds_servers",
]);

const SENSITIVE_PATHS = new Set<string>([
    "kosync.custom_server",
]);
```

Updated `classifyKey`:

```typescript
export function classifyKey(key: string): Classification {
    if (SECRET_KEYS.has(key)) return "SECRET";
    if (SENSITIVE_KEYS.has(key)) return "SENSITIVE";
    if (EPHEMERAL_KEYS.has(key)) return "EPHEMERAL";
    for (const s of EPHEMERAL_SUFFIXES) if (key.endsWith(s)) return "EPHEMERAL";
    for (const r of EPHEMERAL_REGEXES) if (r.test(key)) return "EPHEMERAL";
    return "USER";
}

export function isSensitivePath(parent: string, child: string): boolean {
    return SENSITIVE_PATHS.has(`${parent}.${child}`);
}
```

Evaluation order: SECRET > SENSITIVE > EPHEMERAL > USER. SENSITIVE
takes priority over EPHEMERAL because a key that's both flappy and
dangerous is dangerous.

---

## 7. Display contract

### Text mode (stderr)

```
⚠ This Setup modifies 3 security-sensitive settings:

  [network]   kosync.custom_server: (added) → "https://example.com/kosync"
  [network]   http_proxy: (added) → "http://example.com:8080"
  [code-exec] extra_plugin_paths: (added) → "/mnt/us/documents/.hidden/plugins"

Pass --accept-sensitive to proceed, or --accept-key=<key> for individual keys.
Review first: kindly setup inspect <file>
```

### JSON mode

```json
{
  "error": {
    "code": "SENSITIVE_REQUIRES_ACK",
    "sensitive_changes": [
      { "path": ["kosync", "custom_server"], "domain": "network", "kind": "added", "next": "..." },
      { "path": ["http_proxy"], "domain": "network", "kind": "added", "next": "..." },
      { "path": ["extra_plugin_paths"], "domain": "code-exec", "kind": "added", "next": "..." }
    ]
  }
}
```

### Dry-run text mode

Changes that touch SENSITIVE keys get a `[SENSITIVE]` prefix in the
diff output. The gate does not fire.

```
  [SENSITIVE] + kosync.custom_server: "https://example.com/kosync"
  [SENSITIVE] + http_proxy: "http://example.com:8080"
              + night_mode: true
```

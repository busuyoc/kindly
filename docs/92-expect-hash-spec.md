# 92 — `--expect-hash` on `setup import`
### *Contract for W34a. Rationale in 87-security-matrices.md §2.2 A7, §4 T4.*

Date: 2026-04-23.
Status: spec (code will cite this file).

---

## 1. Problem

`kindly setup import file.kset` prints the content hash but doesn't
gate on it. A power-user (U1 in `81`) who obtained a hash out-of-band
(Signal, forum DM, README) has no way to say "refuse if the file
doesn't match." Closes A7 (MITM / tampered-in-transit). Zero crypto
infrastructure — pure byte compare.

---

## 2. Which hash

`--expect-hash` compares against `hashBytes(manifestBytes)` from
`src/setup/canonical.ts:67-71` — the SHA256 of the raw manifest
bytes on disk (for lean) or as extracted from the archive (for fat).
NOT `manifestHash(manifest)` (which re-canonicalizes). NOT the fat
archive's tar.gz bytes.

Rationale: `hashBytes(manifestBytes)` is the identity function
already used at `importSetup.ts:180`. It's stable under repackaging
because fat archives carry the manifest as a member file; the tar
envelope doesn't affect the manifest's bytes. And it matches what
`kindly setup hash <file>` prints — the user compares the same value
end-to-end.

---

## 3. Flag parsing (CLI layer)

Add to the `setup import` flag spec (`src/commands/setup.ts`):

```typescript
"expect-hash": {
    type: "string",
    description: "refuse import if manifest hash doesn't match",
},
```

Accepted input forms:

| Input | Normalized to |
|-------|--------------|
| `sha256:a1b2c3...` (64 hex) | `sha256:a1b2c3...` |
| `a1b2c3...` (bare 64 hex) | `sha256:a1b2c3...` |
| anything else | `ArgError` exit 2 |

**Format validation is a CLI-layer concern** — it's syntactic. Runs
during arg parsing in `runSetupImport` (`src/commands/setup.ts`), not
inside the lib. Bad format surfaces as `ArgError` at parse time and
maps to exit 2, consistent with the rest of `kindly`'s flag handling.

```typescript
// In src/commands/setup.ts (runSetupImport), during arg parsing:
function normalizeExpectedHash(raw: string): string {
    const bare = raw.startsWith("sha256:") ? raw.slice(7) : raw;
    if (!/^[a-f0-9]{64}$/.test(bare)) {
        throw new ArgError(
            `--expect-hash: invalid hash "${raw}". ` +
            `Expected sha256:<64 hex> or bare <64 hex>.`
        );
    }
    return `sha256:${bare}`;
}

// Pass pre-normalized string into the lib:
const opts: SetupImportOptions = {
    ...,
    ...(argv["expect-hash"]
        ? { expectHash: normalizeExpectedHash(argv["expect-hash"]) }
        : {}),
};
```

---

## 4. `SetupImportOptions` delta

Add one optional field to the interface at
`src/lib/importSetup.ts:146-159`:

```typescript
export interface SetupImportOptions {
    file: string;
    // ... existing fields ...
    /** Pre-normalized `sha256:<64hex>`. Validated by the caller. */
    expectHash?: string;
}
```

The lib trusts the string is well-formed — validation is the CLI's
responsibility (§3). This keeps the lib layer free of `ArgError`.

---

## 5. Pipeline position (lib layer)

In `executeSetupImport` (`src/lib/importSetup.ts`), immediately after
`loadSetup(path)` returns and `id` is computed (line 180). Before
`FAT_REQUIRES_ACK` (line 185), before SENSITIVE gate (88), before
compat check, before schema validation. Fail fast — don't prompt the
user about plugins if the file isn't even the right one.

```typescript
const id = shortId(hashBytes(manifestBytes));

// W34a: hash assertion — first gate after load.
// opts.expectHash is already `sha256:<64hex>` (caller normalized).
if (opts.expectHash) {
    const actual = hashBytes(manifestBytes);
    if (actual !== opts.expectHash) {
        throw new KindlyError(
            ErrorCodes.MANIFEST_HASH_MISMATCH,
            `expected ${opts.expectHash}\n   got  ${actual}`,
            [
                { text: "Verify you received the file you expected." },
                { text: "Re-download from the original source." },
            ],
        );
    }
}
```

---

## 6. Error code

Add to `ErrorCodes` in `src/types/errors.ts`:

```typescript
MANIFEST_HASH_MISMATCH: "MANIFEST_HASH_MISMATCH",
```

Not `SETUP_INVALID` — the manifest is structurally valid; the user's
assertion about its identity failed. Distinct code lets scripts
distinguish "bad file" from "wrong file."

**Name chosen over generic `HASH_MISMATCH`** to leave room for 89's
reserved `PLUGIN_HASH_MISMATCH` (see `89` §6). The qualifier says
*which* hash the assertion is about.

Exit code: **1** (runtime error). The flag itself parsed fine (not an
arg error); the assertion about the world failed.

---

## 7. JSON envelope

Mismatch uses the standard error envelope (`src/cli/json.ts`) — no
per-error extra fields. The message string carries both hashes so
scripts can extract `actual` if they want; the code is the machine
hook.

```json
{
  "$schema_version": 1,
  "command": "setup import",
  "status": "error",
  "error": {
    "code": "MANIFEST_HASH_MISMATCH",
    "message": "expected sha256:a1b2c3... but Setup hashes to sha256:x9y8z7...",
    "remediation": [
      { "text": "Verify you received the file you expected." },
      { "text": "Re-download from the original source." }
    ]
  }
}
```

Rationale: envelope shape is uniform across all error codes —
extending it per-error for typed `expected`/`actual` fields breaks
consumer assumptions and isn't load-bearing. The caller already owns
`expected` (they set `--expect-hash`); knowing `actual`
programmatically is a debugging convenience, not a correctness
requirement.

Match: import proceeds normally. No extra field in the success
envelope — the hash being correct is the default expectation.

---

## 8. Interactions

**`--dry-run`:** `--expect-hash` runs before the dry-run
short-circuit. A dry-run with a mismatched hash still fails.
Rationale: the user is asserting identity, not rehearsing.

**`--json`:** composes freely. `MANIFEST_HASH_MISMATCH` error emits
the JSON envelope above. No TTY dependency.

**`--force`:** does NOT bypass `--expect-hash`. Force overrides compat
checks (W31 precedent); hash assertion is a user-initiated trust
anchor, not a system-initiated warning.

**`kindly apply`:** `--expect-hash` is `setup import`-only. `apply`
takes a user-authored YAML whose identity the user already controls
(it's their file). No gate needed.

**`kindly setup inspect`:** `--expect-hash` is **out of scope for
W34a**. An auditor reading a stranger's `.kset` via `inspect` may
reasonably want to pin a hash before trusting the contents; adding
the flag there is straightforward (the same normalize + compare runs
at the top of `executeSetupInspect`) but defer to a follow-up
W-item so this spec stays focused on the mutation surface. Document
the scope choice here so implementers don't silently add it.

---

## 9. Tests required

| Test | Assert |
|------|--------|
| Matching hash (lean) | Import proceeds, exit 0 |
| Matching hash (fat) | Import proceeds, exit 0 |
| Mismatched hash | `MANIFEST_HASH_MISMATCH`, exit 1, no writes |
| `sha256:` prefix accepted | Normalized, import proceeds |
| Bare hex accepted | Normalized to `sha256:`, import proceeds |
| Wrong length (63 chars) | `ArgError`, exit 2 |
| Invalid chars (`sha256:ZZZZ...`) | `ArgError`, exit 2 |
| Unknown prefix (`md5:abc...`) | `ArgError`, exit 2 |
| `--dry-run --expect-hash` mismatch | `MANIFEST_HASH_MISMATCH`, exit 1 (not dry-run) |
| `--json` mismatch envelope | `{ok: false, error: {code: "MANIFEST_HASH_MISMATCH", expected, actual}}` |
| `--force --expect-hash` mismatch | Still fails (`--force` doesn't bypass) |
| CLI normalization happens before lib call | Lib never sees a bare-hex or malformed string (property test) |

---

W34a is independent of W31/W32/W33 — ship order is free.

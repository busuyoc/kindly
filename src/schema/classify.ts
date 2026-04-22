// Key classifier for settings.reader.lua. See docs/30-decisions.md §S1-S3.
//
// Every top-level key is exactly one of:
//   - SECRET    — plaintext credentials / PII. Never emitted to YAML.
//   - EPHEMERAL — state that flaps on every device interaction. Emitted only
//                 with --full, otherwise dropped.
//   - USER      — the default: user-tuned settings we want to sync.
//
// The lists below are hard-coded denylists. When KOReader adds a new secret
// we extend the list; everything else is USER by default. This is safer than
// an allowlist because the failure mode (new user-setting gets synced) is
// benign, while the inverse (new secret leaks) is not.

export type Classification = "SECRET" | "EPHEMERAL" | "USER";

// Exact top-level key matches. See docs/30-decisions.md Secrets denylist.
const SECRET_KEYS = new Set<string>([
    "calibre_wireless_password",
    "device_id",
    "LocalSend_pin",
    "pinpadlock_pin_code",
    "pinpadlock_message",        // phone number in practice
    "screensaver_message",       // phone number in practice
    "zlib_user_id",
    "zlib_user_key",
    "zlibrary_password",
    "zlibrary_username",
]);

// Nested secret paths: dotted key-within-key. Applied by filterLuaTable.
const SECRET_PATHS = new Set<string>([
    "kosync.userkey",
    "kosync.username",
]);

// Exact ephemeral keys.
const EPHEMERAL_KEYS = new Set<string>([
    "lastfile",
    "lastdir",
    "last_migration_date",
    "navbar_homescreen_flow_recent_fp",
    "LocalSend_last_update_check",
    "quote_deck_pos",
    "current_tries_number",
    "wifi_was_on",
    "block_start_time",
    "currently_blocked",
    "menu_search_string",         // last search box content
    "quickstart_shown_version",
    "closed_rotation_mode",
]);

// Suffix patterns for ephemeral migration/setup markers.
const EPHEMERAL_SUFFIXES = [
    "_initial_default_setup_done",
    "_initial_default_setup_done2",
];
const EPHEMERAL_REGEXES = [
    /^simpleui_defaults_v\d+$/,
    /_migrated_v\d+$/,
];

export function classifyKey(key: string): Classification {
    if (SECRET_KEYS.has(key)) return "SECRET";
    if (EPHEMERAL_KEYS.has(key)) return "EPHEMERAL";
    for (const s of EPHEMERAL_SUFFIXES) if (key.endsWith(s)) return "EPHEMERAL";
    for (const r of EPHEMERAL_REGEXES) if (r.test(key)) return "EPHEMERAL";
    return "USER";
}

export function isSecretPath(parent: string, child: string): boolean {
    return SECRET_PATHS.has(`${parent}.${child}`);
}

export type FilterMode = "minimal" | "full";

export type FilterResult = {
    kept: Record<string, unknown>;
    droppedSecrets: string[];     // keys (or dotted paths) dropped as secrets
    droppedEphemerals: string[];  // keys dropped as ephemeral (only in minimal)
};

// Produce a copy of `data` with secrets/ephemerals removed per `mode`.
// Secrets are ALWAYS removed; ephemerals only in `minimal`.
export function filterForYaml(
    data: Record<string, unknown>,
    mode: FilterMode
): FilterResult {
    const kept: Record<string, unknown> = {};
    const droppedSecrets: string[] = [];
    const droppedEphemerals: string[] = [];

    for (const [k, v] of Object.entries(data)) {
        const cls = classifyKey(k);
        if (cls === "SECRET") {
            droppedSecrets.push(k);
            continue;
        }
        if (cls === "EPHEMERAL" && mode === "minimal") {
            droppedEphemerals.push(k);
            continue;
        }

        // Nested secret scrubbing: kosync.userkey etc.
        if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Map)) {
            const scrubbed: Record<string, unknown> = {};
            for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
                if (isSecretPath(k, ck)) {
                    droppedSecrets.push(`${k}.${ck}`);
                    continue;
                }
                scrubbed[ck] = cv;
            }
            kept[k] = scrubbed;
        } else {
            kept[k] = v;
        }
    }

    return { kept, droppedSecrets, droppedEphemerals };
}

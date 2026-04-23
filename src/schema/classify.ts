// Key classifier for settings.reader.lua. See docs/30-decisions.md §S1-S3.
//
// Every top-level key is exactly one of:
//   - SECRET    — plaintext credentials / PII. Never emitted to YAML.
//   - SENSITIVE — security-relevant (network endpoints, SSH, code-exec,
//                 debug, directory redirection). Flows through like USER,
//                 but `setup import` gates on it. See docs/88.
//   - EPHEMERAL — state that flaps on every device interaction. Emitted only
//                 with --full, otherwise dropped.
//   - USER      — the default: user-tuned settings we want to sync.
//
// The lists below are hard-coded denylists. When KOReader adds a new secret
// we extend the list; everything else is USER by default. This is safer than
// an allowlist because the failure mode (new user-setting gets synced) is
// benign, while the inverse (new secret leaks) is not.

import type { Change } from "./diff.ts";
import type { LuaValue } from "../lua/writer.ts";

export type Classification = "SECRET" | "SENSITIVE" | "EPHEMERAL" | "USER";

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

// SENSITIVE top-level keys. See docs/88-sensitive-keys-spec.md §2. Covers
// code-exec (extra_plugin_paths), network endpoints, SSH surface,
// autostart services, directory redirection, and debug.
export const SENSITIVE_KEYS = new Set<string>([
    // code-exec via settings alone (no fat archive needed)
    "extra_plugin_paths",
    // network endpoints
    "ota_server",
    "http_proxy",
    "http_proxy_enabled",
    "calibre_wireless_url",
    "trans_server",
    "zlibrary_base_url",
    "opds_servers",
    // SSH surface (full set — KOReader ships an SSH server)
    "SSH_allow_no_password",
    "SSH_autostart",
    "SSH_key_only_auth",
    "SSH_port",
    // autostart network services
    "httpinspector_autostart",
    "httpinspector_port",
    "LocalSend_autostart",
    "LocalSend_port",
    // directory redirection (file-write targets)
    "LocalSend_save_dir",
    "LocalSend_ext_dirs",
    "home_dir",
    "download_dir",
    "inbox_dir",
    // debug surface
    "debug",
]);

// Nested SENSITIVE paths: dotted parent.child.
export const SENSITIVE_PATHS = new Set<string>([
    "kosync.custom_server",
]);

// Threat domain → short label for display (88 §7). Used to prefix each
// key in the SENSITIVE warning list.
const SENSITIVE_DOMAIN: Record<string, string> = {
    extra_plugin_paths: "code-exec",
    ota_server: "network", http_proxy: "network", http_proxy_enabled: "network",
    calibre_wireless_url: "network", trans_server: "network",
    zlibrary_base_url: "network", opds_servers: "network",
    "kosync.custom_server": "network",
    SSH_allow_no_password: "ssh", SSH_autostart: "ssh",
    SSH_key_only_auth: "ssh", SSH_port: "ssh",
    httpinspector_autostart: "service", httpinspector_port: "service",
    LocalSend_autostart: "service", LocalSend_port: "service",
    LocalSend_save_dir: "directory", LocalSend_ext_dirs: "directory",
    home_dir: "directory", download_dir: "directory", inbox_dir: "directory",
    debug: "debug",
};

// Domain label for a SENSITIVE key or dotted path. Unknown keys (shouldn't
// happen — caller vets against isSensitiveKeyName first) fall back to "other".
export function sensitiveDomain(dottedPath: string): string {
    return SENSITIVE_DOMAIN[dottedPath] ?? "other";
}

// Is this dotted string a known SENSITIVE top-level key or nested path?
// Used by the CLI layer to validate --accept-key= entries.
export function isSensitiveKeyName(name: string): boolean {
    return SENSITIVE_KEYS.has(name) || SENSITIVE_PATHS.has(name);
}

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
    // Evaluation order: SECRET > SENSITIVE > EPHEMERAL > USER. A key that's
    // both flappy and dangerous is dangerous; the import gate takes priority
    // over the ephemeral drop. See docs/88 §6.
    if (SECRET_KEYS.has(key)) return "SECRET";
    if (SENSITIVE_KEYS.has(key)) return "SENSITIVE";
    if (EPHEMERAL_KEYS.has(key)) return "EPHEMERAL";
    for (const s of EPHEMERAL_SUFFIXES) if (key.endsWith(s)) return "EPHEMERAL";
    for (const r of EPHEMERAL_REGEXES) if (r.test(key)) return "EPHEMERAL";
    return "USER";
}

export function isSecretPath(parent: string, child: string): boolean {
    return SECRET_PATHS.has(`${parent}.${child}`);
}

export function isSensitivePath(parent: string, child: string): boolean {
    return SENSITIVE_PATHS.has(`${parent}.${child}`);
}

// Returns dotted paths of SENSITIVE keys reachable inside `value`, rooted
// at `pathPrefix`. Used by `changeHitsSensitive` to find embedded
// SENSITIVE paths when the diff engine short-circuits a subtree (parent
// absent on device in additive, or parent-removed in replace). See
// docs/88-sensitive-keys-spec.md §4.7 (LOAD-BEARING — A2 mitigation).
function findSensitiveInValue(
    pathPrefix: readonly string[],
    value: LuaValue,
): string[] {
    const hits: string[] = [];
    if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Map) {
        return hits;
    }
    for (const [k, v] of Object.entries(value as Record<string, LuaValue>)) {
        const full = [...pathPrefix, k];
        const dotted = full.join(".");
        if (full.length === 1 && SENSITIVE_KEYS.has(dotted)) hits.push(dotted);
        else if (SENSITIVE_PATHS.has(dotted)) hits.push(dotted);
        hits.push(...findSensitiveInValue(full, v));
    }
    return hits;
}

// Returns dotted paths of SENSITIVE keys touched by a single change entry.
// Handles both direct matches and subtree-carrier cases (88 §4.7).
export function changeHitsSensitive(c: Change): string[] {
    const direct = c.path.join(".");
    const hits: string[] = [];
    if (c.path.length === 1 && SENSITIVE_KEYS.has(direct)) hits.push(direct);
    if (c.path.length >= 2 && SENSITIVE_PATHS.has(direct)) hits.push(direct);
    if (c.kind === "added" || c.kind === "changed") {
        hits.push(...findSensitiveInValue(c.path, c.next));
    }
    if (c.kind === "removed" || c.kind === "changed") {
        const prev = c.kind === "removed" ? c.prev : c.prev;
        hits.push(...findSensitiveInValue(c.path, prev));
    }
    return [...new Set(hits)];
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

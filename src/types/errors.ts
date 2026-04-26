// Structured errors for kindly.
//
// Every user-facing failure carries a stable `code` and zero-or-more
// `remediation` entries. The CLI renderer turns this into text; the JSON
// renderer (W3) will emit the same shape as a field; a future GUI maps
// `code` to its own copy and renders remediations as clickable buttons.
//
// A `code` is a string literal — not a numeric enum — so it shows up verbatim
// in logs, stderr, and JSON without translation. Codes are added here as
// they're introduced at throw sites; callers reference ErrorCodes.X rather
// than raw strings so typos get caught at compile time.

import { sanitizeForTerminal } from "../cli/sanitize.ts";

export interface Remediation {
    /** Short human-readable suggestion. */
    text: string;
    /** Optional CLI command the user can run as a next step. */
    command?: string;
}

export class KindlyError extends Error {
    public remediation: Remediation[];

    constructor(
        public code: string,
        message: string,
        remediation: Remediation[] = [],
    ) {
        // Sanitize user-facing strings at construction time. Error
        // messages are typically assembled by interpolating attacker-
        // controlled fields (key names, manifest `meta.name`, plugin
        // IDs) into templates that then flow through several renderers
        // (JSON envelope, text, history log, trace). Doing the scrub
        // once here means every consumer sees safe bytes. Belt to the
        // Writer-layer suspenders; `sanitizeForTerminal` is idempotent.
        super(sanitizeForTerminal(message));
        this.name = "KindlyError";
        this.remediation = remediation.map(r => ({
            text: sanitizeForTerminal(r.text),
            ...(r.command !== undefined
                ? { command: sanitizeForTerminal(r.command) }
                : {}),
        }));
    }

    // JSON.stringify skips Error.message by default (non-enumerable). Define
    // toJSON so `--json` output and test roundtrips carry the full shape.
    toJSON(): { code: string; message: string; remediation: Remediation[] } {
        return {
            code: this.code,
            message: this.message,
            remediation: this.remediation,
        };
    }
}

// Central registry of codes. Grows over time; never reuse / renumber.
export const ErrorCodes = {
    ARG_INVALID:          "ARG_INVALID",
    LUA_PARSE_FAILED:     "LUA_PARSE_FAILED",
    MOUNT_NOT_FOUND:      "MOUNT_NOT_FOUND",
    MOUNT_INVALID:        "MOUNT_INVALID",
    SETTINGS_NOT_FOUND:   "SETTINGS_NOT_FOUND",
    OUTPUT_EXISTS:        "OUTPUT_EXISTS",
    YAML_NOT_FOUND:       "YAML_NOT_FOUND",
    ARCHIVE_NOT_FOUND:    "ARCHIVE_NOT_FOUND",
    ARCHIVE_UNSAFE_PATH:  "ARCHIVE_UNSAFE_PATH",
    ARCHIVE_TOO_LARGE:    "ARCHIVE_TOO_LARGE",
    ARCHIVE_MALFORMED:    "ARCHIVE_MALFORMED",
    STRICT_IMPORT_BLOCKED: "STRICT_IMPORT_BLOCKED",
    SNAPSHOT_INVALID:     "SNAPSHOT_INVALID",
    SCHEMA_VIOLATION:     "SCHEMA_VIOLATION",
    COMPAT_INCOMPATIBLE:  "COMPAT_INCOMPATIBLE",
    FAT_REQUIRES_ACK:     "FAT_REQUIRES_ACK",
    SENSITIVE_REQUIRES_ACK: "SENSITIVE_REQUIRES_ACK",
    CODE_EXEC_REQUIRES_ACK: "CODE_EXEC_REQUIRES_ACK",
    SETUP_INVALID:        "SETUP_INVALID",
    MANIFEST_HASH_MISMATCH: "MANIFEST_HASH_MISMATCH",
    CATALOG_NOT_FOUND:    "CATALOG_NOT_FOUND",
    CATALOG_MALFORMED:    "CATALOG_MALFORMED",
    PLUGIN_NOT_FOUND:     "PLUGIN_NOT_FOUND",
    YAML_SHAPE_BLOCKED:   "YAML_SHAPE_BLOCKED",
    YAML_CYCLIC:          "YAML_CYCLIC",
    YAML_DIRECTIVE:       "YAML_DIRECTIVE",
    YAML_RESERVED_KEY:    "YAML_RESERVED_KEY",
    YAML_NON_NFC_KEY:     "YAML_NON_NFC_KEY",
    DESTRUCTIVE_YAML_SHAPE: "DESTRUCTIVE_YAML_SHAPE",
    LOCK_HELD:            "LOCK_HELD",
    CONTROL_BYTES_IN_VALUE: "CONTROL_BYTES_IN_VALUE",
    SETUP_SIGNATURE_INVALID: "SETUP_SIGNATURE_INVALID",
    MOUNT_FINGERPRINT_MISMATCH: "MOUNT_FINGERPRINT_MISMATCH",
    SETTINGS_INTERRUPTED_APPLY: "SETTINGS_INTERRUPTED_APPLY",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

// W38: codes that mean "blocked by a safety policy — pass a flag to
// override." CLI maps these to exit 3 instead of exit 1.
export const POLICY_BLOCK_CODES = new Set<string>([
    ErrorCodes.SENSITIVE_REQUIRES_ACK,
    ErrorCodes.CODE_EXEC_REQUIRES_ACK,
    ErrorCodes.FAT_REQUIRES_ACK,
    ErrorCodes.STRICT_IMPORT_BLOCKED,
    ErrorCodes.COMPAT_INCOMPATIBLE,
    ErrorCodes.SCHEMA_VIOLATION,
    ErrorCodes.MANIFEST_HASH_MISMATCH,
    ErrorCodes.YAML_SHAPE_BLOCKED,
    ErrorCodes.DESTRUCTIVE_YAML_SHAPE,
    ErrorCodes.CONTROL_BYTES_IN_VALUE,
    ErrorCodes.MOUNT_FINGERPRINT_MISMATCH,
]);

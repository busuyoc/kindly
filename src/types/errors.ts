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

export interface Remediation {
    /** Short human-readable suggestion. */
    text: string;
    /** Optional CLI command the user can run as a next step. */
    command?: string;
}

export class KindlyError extends Error {
    constructor(
        public code: string,
        message: string,
        public remediation: Remediation[] = [],
    ) {
        super(message);
        this.name = "KindlyError";
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
    SNAPSHOT_INVALID:     "SNAPSHOT_INVALID",
    SCHEMA_VIOLATION:     "SCHEMA_VIOLATION",
    COMPAT_INCOMPATIBLE:  "COMPAT_INCOMPATIBLE",
    FAT_REQUIRES_ACK:     "FAT_REQUIRES_ACK",
    SETUP_INVALID:        "SETUP_INVALID",
    CATALOG_NOT_FOUND:    "CATALOG_NOT_FOUND",
    CATALOG_MALFORMED:    "CATALOG_MALFORMED",
    PLUGIN_NOT_FOUND:     "PLUGIN_NOT_FOUND",
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

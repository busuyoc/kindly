// Producer: normalizedYaml.
//
// Walks a YAML-parsed settings dict (top-level keys → values) and
// collects structural errors that would let a crafted YAML wipe SECRETs
// on merge. The producer does NOT throw — it returns {data, errors}.
// The accompanying YAML_SHAPE_NORMAL gate translates errors → block.
//
// This producer is the S89 fix site. The bug: mergeYamlIntoLua's
// shallow-merge preserves nested siblings only when BOTH sides are
// plain objects. A YAML with `kosync: null` (or `~`, `[]`, `"null"`,
// etc.) at a parent-of-secret path bypasses the nested-merge guard and
// replaces the whole nested table — wiping e.g. kosync.userkey on
// apply. See project_kindly_s89_yaml_null_wipes_secrets.md.
//
// Rejections:
//
//   1. top-level SECRET-class key in YAML           → secret-key-in-yaml
//      SECRETs must not appear in YAML output OR YAML input; they exist
//      only on device. FIRES ON APPLY ONLY — on the import path,
//      filterForYaml already strips these and reports them as
//      `refusedSecrets` in the result. (Duplicating the rejection at
//      import would retro-break existing tests that exercise the
//      filter-and-report behavior.) On apply we have no equivalent
//      upstream filter — this is the S89-V7 site.
//
//   2. non-object value at a known parent-of-secret path
//      (null / array / scalar / string) → non-object-at-secret-parent
//      Example: kosync: null. Fires on BOTH boundaries — no upstream
//      protection anywhere.
//
//   3. explicit null at a known nested secret path  → null-at-nested-secret
//      Example: kosync.userkey: ~. Fires on BOTH boundaries.
//
// The producer reads ctx.opts.yamlSettings. If absent, returns empty
// errors (nothing to check).

import { exfilClass, secretNestedChildrenOf } from "../../schema/classify.ts";
import type { GateContext, Producer } from "../types.ts";

export type YamlShapeErrorKind =
    | "secret-key-in-yaml"
    | "non-object-at-secret-parent"
    | "null-at-nested-secret";

export interface YamlShapeError {
    kind: YamlShapeErrorKind;
    path: string;
    detail: string;
}

export interface NormalizedYaml {
    /** The input settings dict passed through (unmodified). */
    data: Record<string, unknown>;
    /** Structural violations. Empty → safe to merge. Non-empty → gate blocks. */
    errors: YamlShapeError[];
}

export const normalizedYaml: Producer<NormalizedYaml> = (ctx: GateContext) => {
    const data =
        (ctx.opts.yamlSettings as Record<string, unknown> | undefined) ?? {};
    const errors: YamlShapeError[] = [];

    for (const [k, v] of Object.entries(data)) {
        // (1) SECRET-class top-level key must not appear — ON APPLY ONLY.
        // On import, filterForYaml + refusedSecrets already handle this
        // path loudly; duplicating the rejection here would retro-break
        // existing filter-and-report tests. On apply, nothing upstream
        // strips SECRETs — this is the S89-V7 fix site.
        if (ctx.boundary === "apply" && exfilClass(k) === "secret") {
            errors.push({
                kind: "secret-key-in-yaml",
                path: k,
                detail:
                    `SECRET-class key "${k}" must not appear in YAML — ` +
                    "secrets stay on device; they're never synced through YAML.",
            });
            continue;
        }
        // On import, silently skip top-level SECRETs here — filterForYaml
        // downstream will refuse them.
        if (ctx.boundary === "import" && exfilClass(k) === "secret") {
            continue;
        }

        // (2) + (3): parent-of-secret paths. Only relevant if we know of
        // nested SECRETs under k.
        const secretChildren = secretNestedChildrenOf(k);
        if (secretChildren.length === 0) continue;

        if (v === null || typeof v !== "object" || Array.isArray(v)) {
            // null / array / scalar / string at a secret-parent path →
            // would wipe all nested secrets on shallow-merge.
            errors.push({
                kind: "non-object-at-secret-parent",
                path: k,
                detail:
                    `${k} is a parent of nested SECRET path(s): ${secretChildren.join(", ")}. ` +
                    "Assigning a non-object value would wipe the on-device secret(s) " +
                    "when YAML is merged into settings.reader.lua.",
            });
            continue;
        }

        // v is a plain object. Walk its direct children looking for
        // explicit nulls at known nested secret paths.
        const obj = v as Record<string, unknown>;
        for (const child of secretChildren) {
            if (child in obj && obj[child] === null) {
                errors.push({
                    kind: "null-at-nested-secret",
                    path: `${k}.${child}`,
                    detail:
                        `${k}.${child} is a SECRET-class nested path; ` +
                        "null here would wipe the on-device secret on merge.",
                });
            }
        }
    }

    return { data, errors };
};

// Curated templates registry.
//
// Each template is a pre-authored starting point: a named bundle of
// settings + plugins.disabled that ships concrete, opinionated values
// for a specific use case. On `kindly setup export --template <id>` the
// CLI builds a manifest from the template (skipping the device-settings
// read) and lets the user override anything at the flag layer.
//
// All templates default to apply_mode: "additive" — they LAYER onto the
// user's existing configuration, they don't wipe it. A user who wants
// "replace" semantics passes --apply-mode replace explicitly.
//
// Templates are bundled in the binary as TS data — zero I/O, fully
// typed, trivially testable. A DSL / parameter system is out of scope
// for v0.3 (see docs/50-v0.3-setups.md). If two configurations differ
// meaningfully, they become two templates; we don't parametrize.
//
// The settings values below all use keys from real KOReader saves (see
// tests/fixtures/kindle/settings.reader.lua). Some values encode an
// author's opinion ("for night reading, autodim_fraction should be 20");
// users are explicitly encouraged to edit after export. See
// docs/51-templates.md for per-template rationale.

import type { LuaValue } from "../lua/writer.ts";

export type Template = {
    id: string;                                        // "night-reading"
    display_name: string;                              // "Night reading"
    description: string;                               // fallback meta.description
    apply_mode: "additive" | "replace";                // default; CLI can override
    settings?: Record<string, LuaValue>;
    plugins?: { disabled?: readonly string[] };
};

// The registry. Order in this array is the order shown by
// `kindly setup templates`.
const TEMPLATES: readonly Template[] = [
    {
        id: "minimal-ui",
        display_name: "Minimal UI",
        description:
            "Quiet the reader chrome: suppress UI flashing and hide the footer. " +
            "Disables visually heavy plugins (cover browser, calendar, news " +
            "downloader). A starting point for immersive reading — edit after export.",
        apply_mode: "additive",
        settings: {
            avoid_flashing_ui: true,
            book_map_ten_pages_markers: 0,
            reader_footer_mode: 0,
        },
        plugins: {
            disabled: ["coverbrowser", "calendar", "newsdownloader"],
        },
    },
    {
        id: "night-reading",
        display_name: "Night reading",
        description:
            "Warm the display and fade the frontlight for bedtime reading. " +
            "Turns on autowarmth in easy mode; sets gentle autodim duration " +
            "and fraction. Tune the exact values in KOReader's menus after import.",
        apply_mode: "additive",
        settings: {
            autowarmth_activate: 1,
            autowarmth_easy_mode: true,
            autowarmth_hide_nightmode_warning: true,
            autodim_duration_seconds: 5,
            autodim_fraction: 20,
        },
    },
    {
        id: "distraction-free",
        display_name: "Distraction-free",
        description:
            "Reader-only: disables autoturn and routes end-of-document to " +
            "the next file rather than a menu. Turns off plugins that nag or " +
            "surface unrelated content (cover browser, calendar, statistics, " +
            "news downloader, OPDS, japanese). A starting point for long-read sessions.",
        apply_mode: "additive",
        settings: {
            autoturn_enabled: false,
            end_document_action: "next_file",
        },
        plugins: {
            disabled: [
                "calendar",
                "coverbrowser",
                "japanese",
                "newsdownloader",
                "opds",
                "statistics",
            ],
        },
    },
] as const;

// Frozen Map view so lookups are O(1) without mutating the registry.
const BY_ID: ReadonlyMap<string, Template> = new Map(
    TEMPLATES.map((t) => [t.id, t] as const),
);

export function listTemplates(): readonly Template[] {
    return TEMPLATES;
}

export function getTemplate(id: string): Template | undefined {
    return BY_ID.get(id);
}

// Count the distinct settings keys a template sets. Used by
// `kindly setup templates` to show the user how much a template touches
// before they pick one.
export function templateKeyCount(t: Template): number {
    return Object.keys(t.settings ?? {}).length;
}

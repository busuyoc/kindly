// `kindly init minimal` preset — a curated starter kindly.yaml.
//
// Philosophy: ship opinions that solve real KOReader UX papercuts without
// demanding the user know Lua. Each entry below has a reason. When in doubt,
// omit — users opt in to more via `kindly pull` after configuring the device.
//
// This file is the source of truth for `kindly init minimal`. Keep it short.

export const MINIMAL_PRESET = {
    // UI papercuts
    avoid_flashing_ui: true,            // fewer full-screen refreshes; less strain
    inertial_scroll: false,             // deterministic, no "swipe and pray" overshoot
    back_to_exit: "prompt",             // stop accidentally exiting when you meant to go back

    // Reader behavior
    default_highlight_action: "ask",    // don't commit to one behavior you'll want to change later
    end_document_action: "pop-up",      // fewer surprise auto-advances to the next book
    autoremove_deleted_items_from_history: true,  // history stays honest

    // Plugins: disable defaults that a solo reader won't use. Commented-out
    // entries here serve as "consider disabling" pointers.
    plugins_disabled: {
        coverbrowser: true,   // heavy, triggers full-library scans
        statistics: true,     // writes to sqlite constantly; nice to have but costly
        newsdownloader: true, // only useful if you actively use it
        opds: true,           // only useful if you use OPDS catalogs
        wallabag: true,       // only useful if you self-host wallabag
        calibre: true,        // only useful if you use calibre companion
    },
} as const;

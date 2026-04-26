// W46 cross-platform reproducibility probe — used by CI.
//
// Builds a deterministic .kset from an in-memory fixture, prints the
// canonical manifest hash to stdout. Run on macOS and Linux runners; the
// reproducibility job fails if the two hashes differ.
//
// The fixture is intentionally small but exercises the dimensions where
// canonical drift has historically appeared: a Unicode-named plugin
// (NFC vs NFD on different filesystems), a multi-file plugin (sort
// order), and a patch entry (separate manifest section). The test
// driver writes everything to a tmp dir, so this script never touches
// the working tree.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPluginDirs, collectPatches } from "../src/setup/files.ts";
import { parseManifest } from "../src/setup/schema.ts";
import { packSetup } from "../src/setup/pack.ts";

const stage = mkdtempSync(join(tmpdir(), "kindly-w46-"));
try {
    const pluginsRoot = join(stage, "plugins");
    const patchesRoot = join(stage, "patches");

    // NFC-stamped names. The CI matrix runs this on filesystems with
    // different default Unicode forms (APFS sometimes hands NFD, ext4
    // preserves NFC); the canonical pipeline must produce the same hash
    // either way.
    const plugin = "Café.koplugin".normalize("NFC");
    mkdirSync(join(pluginsRoot, plugin), { recursive: true });
    writeFileSync(join(pluginsRoot, plugin, "máin.lua".normalize("NFC")), "main\n");
    writeFileSync(join(pluginsRoot, plugin, "z.lua"), "z\n");
    mkdirSync(patchesRoot, { recursive: true });
    writeFileSync(join(patchesRoot, "1-tweak.lua"), "tweak\n");

    const pluginCollect = collectPluginDirs(pluginsRoot);
    const patchCollect = collectPatches(patchesRoot);

    const manifest = parseManifest({
        kindly_setup: "v1",
        meta: { name: "W46-probe", created_at: "2026-04-25T00:00:00Z" },
        apply_mode: "additive",
        plugins: { files: pluginCollect.declared },
        patches: patchCollect.declared,
    });
    const files = new Map<string, Buffer>();
    for (const [k, v] of pluginCollect.files) files.set(k, v);
    for (const [k, v] of patchCollect.files) files.set(k, v);

    const out = join(stage, "probe.kset");
    const result = packSetup({ manifest, files }, out);
    process.stdout.write(result.manifestHash + "\n");
} finally {
    rmSync(stage, { recursive: true, force: true });
}

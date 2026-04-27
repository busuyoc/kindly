-- kindly harness boot-and-exit patch.
--
-- Priority 2 (late) — runs after UIManager is ready. Schedules an
-- immediate quit so the emulator boots, signals ready, and exits 0
-- without user interaction.
--
-- Used by Slice 2's KO_HOME-injection regression test: boot a
-- kindly-mutated tree, assert clean exit. If KOReader's boot sequence
-- ever crashes on a config the harness considers valid, this patch
-- carries the failure to a non-zero exit code that the test can catch.
--
-- The patch is a no-op unless KINDLY_BOOT_AND_EXIT=1 is set, so it's
-- safe to keep installed in long-lived KO_HOME trees.

if os.getenv("KINDLY_BOOT_AND_EXIT") ~= "1" then return end

local UIManager = require("ui/uimanager")

UIManager:scheduleIn(0.5, function()
    UIManager:quit(0)
end)

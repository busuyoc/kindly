-- kindly preview patch: screenshot + exit after UI settles.
--
-- Priority 2 (late) — runs after UIManager is ready but before the
-- main event loop starts. Schedules a delayed screenshot so the
-- reader/filemanager has time to render the first frame.
--
-- The patch checks for the KINDLY_SCREENSHOT env var. If absent, it
-- does nothing — safe to leave installed during normal use.

local screenshot_path = os.getenv("KINDLY_SCREENSHOT")
if not screenshot_path then return end

local delay_s = tonumber(os.getenv("KINDLY_SCREENSHOT_DELAY")) or 2

local UIManager = require("ui/uimanager")
local Screen = require("device").screen

UIManager:scheduleIn(delay_s, function()
    Screen:shot(screenshot_path)
    UIManager:quit(0)
end)

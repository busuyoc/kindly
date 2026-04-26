#!/usr/bin/env bash
# koreader-roundtrip.sh <kset-path>
#
# Repeatable live-run harness: apply a kindly .kset to a fixture mount,
# launch KOReader against the same tree via KO_HOME, wait for a marker
# file to appear, and report.
#
# Used to promote static kindly red-team scenarios to observed behavior
# on a real KOReader binary. See docs/98-koreader-emulator-setup.md.
#
# Env:
#   KOREADER_BIN      path to koreader.sh (default: ~/src/koreader/koreader.sh)
#   WORKDIR           fixture workspace   (default: /tmp/kindly-s17-live)
#   MARKER            file that signals success (default: $WORKDIR/marker.txt)
#   LISTEN_PORT       TCP listener port   (default: 9999)
#   TIMEOUT_SECONDS   wait for marker     (default: 30)
#   KINDLY_FLAGS      extra flags for `kindly setup import`
#                       (default: empty — S17-style zero-flag import;
#                        S4 needs "--accept-plugins --accept-patches --strict-imports")
#   AUTORUN_SEED      path to a Lua patch to drop at patches/N-autorun.lua
#                       (default: $WORKDIR/patches-autorun.lua.seed if present)

set -euo pipefail

KSET=${1:?usage: koreader-roundtrip.sh <kset-path>}
KOREADER_BIN=${KOREADER_BIN:-$HOME/src/koreader/koreader.sh}
WORKDIR=${WORKDIR:-/tmp/kindly-s17-live}
MARKER=${MARKER:-$WORKDIR/marker.txt}
LISTEN_PORT=${LISTEN_PORT:-9999}
TIMEOUT_SECONDS=${TIMEOUT_SECONDS:-30}
KINDLY_FLAGS=${KINDLY_FLAGS:-}
# Legacy seed path (S17) or new-style path — try both.
AUTORUN_SEED=${AUTORUN_SEED:-}
if [[ -z "$AUTORUN_SEED" ]]; then
    if [[ -f "$WORKDIR/patches-autorun.lua.seed" ]]; then
        AUTORUN_SEED="$WORKDIR/patches-autorun.lua.seed"
    elif [[ -f "$WORKDIR/patches-2-autorun.lua.seed" ]]; then
        AUTORUN_SEED="$WORKDIR/patches-2-autorun.lua.seed"
    fi
fi

MOUNT="$WORKDIR/fixture"
KO_HOME="$MOUNT/koreader"
PROBE_LOG="$WORKDIR/probe.log"
LISTEN_LOG="$WORKDIR/listener.log"
KO_LOG="$WORKDIR/koreader.log"

if [[ ! -x "$KOREADER_BIN" ]]; then
    echo "error: KOREADER_BIN not executable: $KOREADER_BIN" >&2
    exit 2
fi
if [[ ! -f "$KSET" ]]; then
    echo "error: kset not found: $KSET" >&2
    exit 2
fi
if [[ ! -d "$KO_HOME" ]]; then
    echo "error: fixture missing: $KO_HOME (see $WORKDIR/README.md)" >&2
    exit 2
fi

echo "== reset =="
rm -f "$MARKER" "$PROBE_LOG" "$LISTEN_LOG" "$KO_LOG"
cp "$KO_HOME/settings.reader.lua.seed" "$KO_HOME/settings.reader.lua"
rm -f "$KO_HOME/settings.reader.lua.old"
# Wipe any prior patches/ — fresh slate per run. Autorun is re-dropped
# after kindly apply so it always wins.
rm -rf "$KO_HOME/patches"
mkdir -p "$KO_HOME/patches"

# Strip prior plugin dirs too (fat imports land plugins here).
if [[ -d "$KO_HOME/plugins" ]]; then
    rm -rf "$KO_HOME/plugins"
fi

echo "== kindly setup import ${KINDLY_FLAGS} =="
cd /Users/claw/kindly
# shellcheck disable=SC2086
bun run src/cli.ts setup import "$KSET" --mount "$MOUNT" $KINDLY_FLAGS || {
    rc=$?
    echo "kindly import exited $rc (non-zero may mean SENSITIVE gate or policy block — inspect output above)"
}

if [[ -n "$AUTORUN_SEED" && -f "$AUTORUN_SEED" ]]; then
    # Priority 2 = `late` phase (after UIManager ready). Priority 9
    # is `on_exit` and would never run during normal operation.
    # Attacker patches also at priority 2 still win on alphanum-sort:
    # `2-analytics-hook.lua` < `2-autorun.lua`.
    cp "$AUTORUN_SEED" "$KO_HOME/patches/2-autorun.lua"
else
    echo "note: no autorun seed found — KOReader will stay open until manually closed"
fi

echo "== listener =="
# Prefer Python over nc — macOS BSD nc lacks -k and has quirky EOF.
python3 -u -c "
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *a): sys.stdout.write('%s\\n' % (fmt % a)); sys.stdout.flush()
    def do_GET(self): self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def do_POST(self):
        n = int(self.headers.get('Content-Length', '0') or '0')
        body = self.rfile.read(n) if n else b''
        sys.stdout.write('POST body %d bytes: %r\\n' % (len(body), body[:120])); sys.stdout.flush()
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
with socketserver.TCPServer(('127.0.0.1', $LISTEN_PORT), H) as s: s.serve_forever()
" > "$LISTEN_LOG" 2>&1 &
LISTENER_PID=$!
sleep 0.3

cleanup() {
    kill "$LISTENER_PID" 2>/dev/null || true
    [[ -n "${KO_PID:-}" ]] && kill "$KO_PID" 2>/dev/null || true
    wait 2>/dev/null || true
}
trap cleanup EXIT

echo "== launch KOReader (KO_HOME=$KO_HOME) =="
KO_HOME="$KO_HOME" "$KOREADER_BIN" > "$KO_LOG" 2>&1 &
KO_PID=$!

echo "== wait up to ${TIMEOUT_SECONDS}s for $MARKER =="
for i in $(seq 1 "$TIMEOUT_SECONDS"); do
    if [[ -f "$MARKER" ]]; then
        echo "  marker appeared after ${i}s"
        break
    fi
    sleep 1
done

echo
echo "== verdict =="
if [[ -f "$MARKER" ]]; then
    echo "OBSERVED: scenario marker present — attacker-controlled code ran."
    echo "  marker:   $(cat "$MARKER")"
    echo "  probe:    $PROBE_LOG"
    echo "  listener: $LISTEN_LOG"
else
    echo "NO MARKER: terminal_shell did not fire within ${TIMEOUT_SECONDS}s."
    echo "  koreader stdout: $KO_LOG"
    echo "  listener:        $LISTEN_LOG"
    echo "  check patches/2-autorun.lua CANDIDATE_ACTIONS and KO_HOME resolution"
fi

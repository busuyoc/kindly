// Render-layer sanitizer for user-facing terminal output.
//
// Threat model (red-team findings S282/S283/S284, Batch M):
// attacker-controlled strings (manifest `meta.name`, plugin `fullname` in
// catalog, KOReader key names echoed into error messages, etc.) flow
// through `KindlyError.remediation`, the JSON envelope, and renderer
// info()/warn() calls directly to the user's terminal. An OSC sequence
// embedded in such a string can redefine the terminal title, or in some
// terminals push bytes onto the user's command line (i.e. plant a command
// they then hit return on).
//
// `sanitizeForTerminal` is the single chokepoint that strips dangerous
// ANSI/control bytes before they reach the TTY. It is wired default-on
// into `StreamWriter.write` / `StringWriter.write` so every renderer path
// is covered; callers that have already produced safe bytes (or need to
// emit raw control bytes — e.g. tests that inspect ANSI output) use
// `writeRaw(writer, s)` as an explicit escape hatch.
//
// Rules (see spec in the plan doc, Step 2):
//   - Preserve bare UTF-8 printable content.
//   - Preserve `\t` (0x09), `\n` (0x0A), and `\r\n` pairs.
//   - Preserve ANSI SGR (`\x1b[<params>m`) where every `;`-separated param
//     is in the whitelist: 0, 1, 22, 30-37, 40-47, 90-97, 100-107.
//     (Plain reset, bold, non-bold, 8 standard colors, 8 standard bg,
//     8 bright colors, 8 bright bg.)
//   - Strip all other CSI sequences (`\x1b[...<final>`).
//   - Strip OSC sequences entirely (`\x1b]...\x07` or `\x1b]...\x1b\`).
//     These are the S282 attack vector.
//   - Strip any other ESC-introduced sequence (`\x1bN`, `\x1bO...`,
//     `\x1b\`, bare `\x1b`, etc.).
//   - Strip lone `\r` (but preserve `\r\n` as a pair).
//   - Strip other C0 control bytes: 0x00-0x08, 0x0B-0x0C, 0x0E-0x1F, 0x7F.
//   - Strip C1 control bytes 0x80-0x9F. U+009B is the 8-bit CSI introducer
//     and U+009D is the 8-bit OSC introducer; xterm with `decode8bit` (and
//     some legacy emulators in Latin-1 mode) interpret them as the start of
//     control sequences with the same effects as ESC[ / ESC]. Parity with
//     filterCheck.ts (sign/verify time): manifest strings must already pass
//     the same C1+Cf rejection, but render-time sanitize is the last line
//     of defense for any string that bypasses the sign-time gate (KindlyError
//     wrapping a system error message, locally-edited trust roster labels,
//     anything from a future code path that lacks parity).
//   - Strip bidi controls (U+202A-U+202E override/embedding, U+2066-U+2069
//     isolates) — arbitrary visual reordering is an S383-class info-leak
//     channel and can mask the real key being displayed.
//   - Strip invisible format controls (U+200B-U+200D ZWSP/ZWNJ/ZWJ,
//     U+2060-U+2064 WJ/invisibles, U+FEFF BOM/ZWNBSP) — zero-width chars
//     let attackers forge lookalike keys that pass visual review.
//   - Strip U+2028 LINE SEPARATOR / U+2029 PARA SEPARATOR — unterminated
//     under JSON.stringify in ECMAScript ≤ 2018; break --json framing
//     for downstream JS consumers (S269).
//
// Pure function, no side effects — safe to call on any string.

import type { Writer } from "./env.ts";

const SGR_PARAM_WHITELIST: ReadonlySet<number> = new Set<number>([
    0, 1, 22,
    30, 31, 32, 33, 34, 35, 36, 37,
    40, 41, 42, 43, 44, 45, 46, 47,
    90, 91, 92, 93, 94, 95, 96, 97,
    100, 101, 102, 103, 104, 105, 106, 107,
]);

// Does `\x1b[<params><final>` match a whitelisted SGR sequence?
// `params` is the body between `\x1b[` and the final byte; `final` is `m`.
function isWhitelistedSgr(params: string, final: string): boolean {
    if (final !== "m") return false;
    // Empty params `\x1b[m` == `\x1b[0m` (reset). Accept.
    if (params.length === 0) return true;
    const parts = params.split(";");
    for (const p of parts) {
        // Empty slots (e.g. `\x1b[;31m`) behave as 0 per spec. Accept.
        if (p.length === 0) continue;
        // Only digits allowed — no intermediate bytes, no colons (which
        // would signal 256/truecolor SGR extensions we don't whitelist).
        if (!/^\d+$/.test(p)) return false;
        const n = Number.parseInt(p, 10);
        if (!SGR_PARAM_WHITELIST.has(n)) return false;
    }
    return true;
}

// BMP codepoints we strip outright: bidi controls, invisible format
// controls, and JS-breaking line separators. All single UTF-16 code units,
// so `charCodeAt` is sufficient.
function isStrippableUnicode(ch: number): boolean {
    return (
        (ch >= 0x200B && ch <= 0x200D) ||  // ZWSP, ZWNJ, ZWJ
        ch === 0x2028 || ch === 0x2029 ||  // LS, PS
        (ch >= 0x202A && ch <= 0x202E) ||  // LRE, RLE, PDF, LRO, RLO
        (ch >= 0x2060 && ch <= 0x2064) ||  // WJ, FUNCTION APP, INVISIBLE *
        (ch >= 0x2066 && ch <= 0x2069) ||  // LRI, RLI, FSI, PDI
        ch === 0xFEFF                      // BOM / ZWNBSP
    );
}

// Hot-path detection regex. Matches if anything in the string needs
// inspection — C0 controls, ESC/CR, C1 controls, bidi, invisibles,
// LS/PS, BOM. Built via RegExp() so the \uXXXX escapes stay
// ASCII-readable in source.
const HOT_PATH_RE = new RegExp(
    "[\\x00-\\x08\\x0B-\\x0C\\x0E-\\x1F\\x7F-\\x9F\\r\\x1B" +
    "\\u200B-\\u200D\\u2028\\u2029\\u202A-\\u202E" +
    "\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]"
);

export function sanitizeForTerminal(s: string): string {
    if (!HOT_PATH_RE.test(s)) return s;

    let out = "";
    const len = s.length;
    let i = 0;
    while (i < len) {
        const ch = s.charCodeAt(i);

        // ESC (0x1b): handle ANSI sequences.
        if (ch === 0x1b) {
            // Need a next byte to determine type.
            if (i + 1 >= len) {
                // Lone trailing ESC — strip.
                i += 1;
                continue;
            }
            const next = s.charCodeAt(i + 1);
            // CSI: ESC '[' ... <final in 0x40..0x7e>
            if (next === 0x5b /* '[' */) {
                // Parse parameter bytes 0x30-0x3f, intermediate 0x20-0x2f,
                // then a final byte 0x40-0x7e.
                let j = i + 2;
                const paramStart = j;
                while (j < len) {
                    const c = s.charCodeAt(j);
                    if (c >= 0x30 && c <= 0x3f) { j += 1; continue; }
                    break;
                }
                const paramEnd = j;
                // intermediates
                while (j < len) {
                    const c = s.charCodeAt(j);
                    if (c >= 0x20 && c <= 0x2f) { j += 1; continue; }
                    break;
                }
                const interEnd = j;
                if (j < len) {
                    const finalByte = s.charCodeAt(j);
                    if (finalByte >= 0x40 && finalByte <= 0x7e) {
                        const params = s.slice(paramStart, paramEnd);
                        const inter = s.slice(paramEnd, interEnd);
                        const final = s[j];
                        // Whitelist: no intermediates, final is 'm',
                        // every param whitelisted.
                        if (inter.length === 0 && isWhitelistedSgr(params, final)) {
                            out += "\x1b[" + params + final;
                        }
                        // else: strip entirely.
                        i = j + 1;
                        continue;
                    }
                }
                // Malformed CSI (no final byte found). Strip what we consumed.
                i = j;
                continue;
            }
            // OSC: ESC ']' ... BEL (0x07) or ST (ESC '\')
            if (next === 0x5d /* ']' */) {
                let j = i + 2;
                while (j < len) {
                    const c = s.charCodeAt(j);
                    if (c === 0x07 /* BEL */) { j += 1; break; }
                    if (c === 0x1b /* ESC */ && j + 1 < len && s.charCodeAt(j + 1) === 0x5c /* '\' */) {
                        j += 2;
                        break;
                    }
                    j += 1;
                }
                // Strip everything from ESC to terminator (or EOS).
                i = j;
                continue;
            }
            // String-introducer escapes: DCS (ESC 'P'), APC (ESC '_'),
            // PM (ESC '^'). Payload runs until ST (ESC '\') or BEL.
            if (next === 0x50 /* 'P' */ || next === 0x5f /* '_' */ || next === 0x5e /* '^' */) {
                let j = i + 2;
                while (j < len) {
                    const c = s.charCodeAt(j);
                    if (c === 0x07) { j += 1; break; }
                    if (c === 0x1b && j + 1 < len && s.charCodeAt(j + 1) === 0x5c) {
                        j += 2;
                        break;
                    }
                    j += 1;
                }
                i = j;
                continue;
            }
            // Other two-byte escapes: ESC followed by a byte in the "Fe"
            // final-byte range (0x40-0x5f). Examples: ESC '\\' (ST),
            // ESC 'N' (SS2), ESC 'O' (SS3). Consume both bytes.
            if (next >= 0x40 && next <= 0x5f) {
                i += 2;
                continue;
            }
            // Anything else after ESC (printable letter, digit, etc.) is
            // probably the ESC byte leaking in isolation — strip just
            // the ESC and re-process the next byte normally.
            i += 1;
            continue;
        }

        // CR: preserve only as part of \r\n. Lone \r stripped.
        if (ch === 0x0d) {
            if (i + 1 < len && s.charCodeAt(i + 1) === 0x0a) {
                out += "\r\n";
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }

        // Allowed whitespace controls.
        if (ch === 0x09 || ch === 0x0a) {
            out += s[i];
            i += 1;
            continue;
        }

        // Other C0 controls + DEL + C1 controls (0x80-0x9F). Parity with
        // filterCheck.ts FORBIDDEN_RE: U+009B / U+009D are 8-bit CSI/OSC
        // introducers on terminals that decode 8-bit (xterm `decode8bit`,
        // legacy Latin-1 emulators) — leaving them through means an
        // attacker who lands a C1 byte in any string the renderer emits
        // gets the same effect as ESC[ / ESC] would, which the ESC branch
        // above already strips.
        if (ch <= 0x1f || (ch >= 0x7f && ch <= 0x9f)) {
            i += 1;
            continue;
        }

        // Bidi + invisible format + LS/PS + BOM — all BMP single code units.
        if (isStrippableUnicode(ch)) {
            i += 1;
            continue;
        }

        // Printable / UTF-8 continuation / multibyte. Pass through.
        out += s[i];
        i += 1;
    }
    return out;
}

// Escape hatch for callers that have already produced safe bytes (or are
// legitimately emitting raw control output — e.g. tests that capture ANSI).
// Internally calls the writer's write method, bypassing sanitize by
// going through a private _writeRaw if the writer exposes one. Otherwise
// falls back to write() (which will sanitize — harmless double-sanitize
// because sanitize is idempotent over its own output).
export function writeRaw(writer: Writer, s: string): void {
    // `Writer` implementations expose a `writeRaw` method when they want
    // to support unfiltered writes. `StreamWriter` and `StringWriter`
    // both do after Step 2 wiring.
    const w = writer as Writer & { writeRaw?: (s: string) => void };
    if (typeof w.writeRaw === "function") {
        w.writeRaw(s);
        return;
    }
    writer.write(s);
}

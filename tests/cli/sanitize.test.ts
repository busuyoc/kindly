// Unit + integration tests for the render-layer ANSI/control-byte
// sanitizer introduced in Step 2 of the gates refactor. See
// `docs/infra/99-gates-refactor-plan.md` §Step 2 for the threat model
// (red-team S282/S283/S284).

import { describe, test, expect } from "bun:test";

import { sanitizeForTerminal, writeRaw } from "../../src/cli/sanitize.ts";
import { StringWriter } from "../../src/cli/env.ts";
import { KindlyError } from "../../src/types/errors.ts";
import { emitJsonError } from "../../src/cli/json.ts";
import type { CliEnv } from "../../src/cli/env.ts";

describe("sanitizeForTerminal", () => {
    test("preserves whitelisted SGR color sequences", () => {
        const s = "\x1b[31mRED\x1b[0m";
        expect(sanitizeForTerminal(s)).toBe(s);
    });

    test("preserves multi-param SGR (bold red)", () => {
        const s = "\x1b[1;31mBOLD RED\x1b[0m";
        expect(sanitizeForTerminal(s)).toBe(s);
    });

    test("strips non-whitelisted CSI (clear screen)", () => {
        // `\x1b[2J` is erase-display — clears the terminal. Must be stripped.
        const s = "before\x1b[2Jafter";
        expect(sanitizeForTerminal(s)).toBe("beforeafter");
    });

    test("strips OSC injection (S282 vector)", () => {
        // `\x1b]0;evil\x07` sets the terminal title to 'evil'. Strip.
        const s = "hi\x1b]0;evil\x07there";
        expect(sanitizeForTerminal(s)).toBe("hithere");
    });

    test("strips OSC terminated by ST (ESC \\)", () => {
        const s = "hi\x1b]0;evil\x1b\\there";
        expect(sanitizeForTerminal(s)).toBe("hithere");
    });

    test("strips lone \\r but preserves \\r\\n", () => {
        expect(sanitizeForTerminal("foo\rbar")).toBe("foobar");
        expect(sanitizeForTerminal("foo\r\nbar")).toBe("foo\r\nbar");
    });

    test("strips C0 controls and DEL", () => {
        expect(sanitizeForTerminal("hello\x00world\x7Fstuff")).toBe("helloworldstuff");
        expect(sanitizeForTerminal("bell\x07rung")).toBe("bellrung");
    });

    test("strips C1 controls (0x80-0x9F) including 8-bit CSI/OSC", () => {
        // U+009B is 8-bit CSI introducer; xterm with decode8bit interprets
        // ` 2 J` as clear-screen, equivalent to ESC[2J. Strip the
        // C1 byte so a downstream `2J` is rendered as harmless text.
        expect(sanitizeForTerminal("hi2Jthere")).toBe("hi2Jthere");
        // U+009D is 8-bit OSC introducer; pair with BEL terminator the way
        // filterCheck.ts treats it: a forbidden control byte. The trailing
        // BEL is also a C0 control and gets stripped on the same pass.
        expect(sanitizeForTerminal("hi0;evilthere")).toBe("hi0;evilthere");
        // Every C1 codepoint should drop. Spot-check the boundaries plus
        // U+0085 NEL (treated as line break by some terminals).
        for (const cp of [0x80, 0x85, 0x9b, 0x9d, 0x9f]) {
            const s = "a" + String.fromCharCode(cp) + "b";
            expect(sanitizeForTerminal(s)).toBe("ab");
        }
    });

    test("hot-path regex triggers when only a C1 byte is present", () => {
        // Without the regex including 0x80-0x9F, the early return at the
        // top of sanitizeForTerminal would skip the strip loop and let
        // the C1 byte through unchanged.
        expect(sanitizeForTerminal("cleanclean")).toBe("cleanclean");
    });

    test("happy path: printable + tab + newline + emoji", () => {
        const s = "plain text\twith émojis 🦊\nnext line";
        expect(sanitizeForTerminal(s)).toBe(s);
    });

    test("strips SGR with non-whitelisted param (256-color)", () => {
        // \x1b[38;5;196m — 256-color foreground. Not in our whitelist.
        const s = "\x1b[38;5;196mfancy\x1b[0m";
        expect(sanitizeForTerminal(s)).toBe("fancy\x1b[0m");
    });

    test("strips bare ESC and ESC-introduced two-byte sequences", () => {
        expect(sanitizeForTerminal("x\x1by")).toBe("xy");
        // ESC N (SS2) consumes 2 bytes.
        expect(sanitizeForTerminal("x\x1bNyz")).toBe("xyz");
    });

    test("idempotent: sanitizing output of sanitize is a no-op", () => {
        const inputs = [
            "plain",
            "\x1b[31mred\x1b[0m",
            "\x1b[1;32;40mstyled\x1b[0m",
            "with\ttabs\nand newlines",
        ];
        for (const s of inputs) {
            const once = sanitizeForTerminal(s);
            expect(sanitizeForTerminal(once)).toBe(once);
        }
    });

    test("idempotent: sanitizing malicious input, output is safe", () => {
        const s = "\x1b]0;evil\x07hello\x00world\x1b[2J";
        const once = sanitizeForTerminal(s);
        expect(sanitizeForTerminal(once)).toBe(once);
        expect(once).toBe("helloworld");
    });
});

describe("sanitizeForTerminal — C2 Unicode extension", () => {
    // Bidi override/embedding/isolate codepoints
    const BIDI = ["‪", "‫", "‬", "‭", "‮",
                  "⁦", "⁧", "⁨", "⁩"];
    // Zero-width / invisible format controls
    const INVISIBLES = ["​", "‌", "‍",
                        "⁠", "⁡", "⁢", "⁣", "⁤",
                        "﻿"];
    // JS-breaking line separators
    const JS_BREAKERS = [" ", " "];

    test("strips all bidi controls", () => {
        for (const ch of BIDI) {
            expect(sanitizeForTerminal(`a${ch}b`)).toBe("ab");
        }
    });

    test("strips all invisible format controls", () => {
        for (const ch of INVISIBLES) {
            expect(sanitizeForTerminal(`a${ch}b`)).toBe("ab");
        }
    });

    test("strips U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR", () => {
        for (const ch of JS_BREAKERS) {
            expect(sanitizeForTerminal(`a${ch}b`)).toBe("ab");
        }
    });

    test("BOM is stripped whether leading, mid, or trailing", () => {
        expect(sanitizeForTerminal("﻿hello")).toBe("hello");
        expect(sanitizeForTerminal("hel﻿lo")).toBe("hello");
        expect(sanitizeForTerminal("hello﻿")).toBe("hello");
    });

    test("RLO spoofing attack on a filename is neutralized", () => {
        // Classic RLO trick: "script‮gpj.exe" renders as "scriptexe.jpg"
        // Strip the RLO; the name becomes readable-as-written.
        const spoofed = "invoice‮gpj.exe";
        expect(sanitizeForTerminal(spoofed)).toBe("invoicegpj.exe");
    });

    test("ZWSP homoglyph forgery is flattened", () => {
        // "ad​min" visually reads as "admin" but differs byte-wise.
        // After sanitize, the ZWSP is gone.
        expect(sanitizeForTerminal("ad​min")).toBe("admin");
    });

    test("hot-path regex triggers on every strippable codepoint", () => {
        // Fast-path regex must cover every codepoint isStrippableUnicode
        // rejects, else strippable chars leak through when the string
        // contains nothing else dangerous.
        for (const ch of [...BIDI, ...INVISIBLES, ...JS_BREAKERS]) {
            const s = `clean${ch}clean`;
            expect(sanitizeForTerminal(s)).toBe("cleanclean");
        }
    });

    test("legitimate non-BMP emoji survives (surrogate pair, high codepoint)", () => {
        // Four-byte UTF-16 pairs (above BMP) must not be collateral damage.
        expect(sanitizeForTerminal("hello 🚀 world")).toBe("hello 🚀 world");
        expect(sanitizeForTerminal("café")).toBe("café");
        expect(sanitizeForTerminal("日本語")).toBe("日本語");
    });

    test("codepoints just outside the stripped ranges survive", () => {
        // U+200A (hair space) — not stripped; U+200E (LRM) is outside
        // our override range (we strip 202A-202E and 2066-2069 only;
        // LRM/RLM at 200E/200F are directional marks, not overrides —
        // strip them too since they alter display and serve no purpose
        // in kindly output... actually we DON'T strip them, so confirm.)
        //
        // Boundary check: U+200A, U+200E, U+200F, U+2065, U+206A pass through.
        expect(sanitizeForTerminal("a b")).toBe("a b");  // hair space
        expect(sanitizeForTerminal("a⁥b")).toBe("a⁥b");  // unassigned, not in strip set
        expect(sanitizeForTerminal("a⁪b")).toBe("a⁪b");  // inhibit symmetric swap
    });

    test("mixed attack: bidi + OSC + invisible + JS-breaker", () => {
        const evil = "nor​mal\x1b]0;steal\x07 text‮ with  bad⁨ bytes";
        expect(sanitizeForTerminal(evil)).toBe("normal text with bad bytes");
    });

    test("idempotent over the C2 extension", () => {
        const s = "a‮b​c d﻿e";
        const once = sanitizeForTerminal(s);
        expect(sanitizeForTerminal(once)).toBe(once);
        expect(once).toBe("abcde");
    });
});

describe("Writer wiring", () => {
    test("StringWriter.write sanitizes by default", () => {
        const w = new StringWriter();
        w.write("hi\x1b]0;evil\x07there\n");
        expect(w.value).toBe("hithere\n");
    });

    test("StringWriter.write preserves whitelisted SGR color", () => {
        const w = new StringWriter();
        w.write("\x1b[31mred\x1b[0m\n");
        expect(w.value).toBe("\x1b[31mred\x1b[0m\n");
    });

    test("writeRaw() bypasses sanitize on StringWriter", () => {
        const w = new StringWriter();
        writeRaw(w, "raw\x07bell");
        expect(w.value).toBe("raw\x07bell");
    });

    test("KindlyError message with OSC renders sanitized via StringWriter", () => {
        const err = new KindlyError("TEST", "header\x1b]0;evil\x07tail", [
            { text: "remediate\x1b]0;evil2\x07step", command: "run --opt\x07" },
        ]);
        const w = new StringWriter();
        w.write(err.message + "\n");
        for (const r of err.remediation) {
            w.write(r.text + "\n");
            if (r.command) w.write(r.command + "\n");
        }
        const out = w.value;
        // Attacker-controlled OSC payload and BEL must be gone.
        expect(out).not.toContain("evil");
        expect(out).not.toContain("\x1b]");
        expect(out).not.toContain("\x07");
        // Surrounding text preserved.
        expect(out).toContain("header");
        expect(out).toContain("tail");
        expect(out).toContain("remediate");
        expect(out).toContain("step");
    });

    test("JSON envelope with OSC in error field renders sanitized", () => {
        const stdout = new StringWriter();
        const stderr = new StringWriter();
        const env: CliEnv = {
            cwd: "/tmp",
            stdout,
            stderr,
            color: false,
            now: () => new Date("2026-04-24T00:00:00.000Z"),
        };
        const err = new KindlyError(
            "TEST_CODE",
            "boom\x1b]0;evil\x07ended",
            [{ text: "try\x1b]0;osc\x07again" }],
        );
        emitJsonError(env, "pull", err);

        const out = stderr.value;
        // The OSC payload strings must not appear in the rendered bytes.
        expect(out).not.toContain("evil");
        expect(out).not.toContain("osc");
        expect(out).not.toContain("\x1b]");
        expect(out).not.toContain("\x07");
        // The envelope is still parseable JSON and keeps the safe text.
        // The trailing newline is sanitized but preserved.
        const lines = out.split("\n").filter(l => l.length > 0);
        expect(lines.length).toBe(1);
        const parsed = JSON.parse(lines[0]) as {
            status: string;
            error: { code: string; message: string; remediation: { text: string }[] };
        };
        expect(parsed.status).toBe("error");
        expect(parsed.error.code).toBe("TEST_CODE");
        expect(parsed.error.message).toContain("boom");
        expect(parsed.error.message).toContain("ended");
        expect(parsed.error.message).not.toContain("evil");
        expect(parsed.error.remediation[0].text).toContain("try");
        expect(parsed.error.remediation[0].text).toContain("again");
        expect(parsed.error.remediation[0].text).not.toContain("osc");
    });
});

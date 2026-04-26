// Parser for the subset of Lua emitted by KOReader's dump.lua.
//
// We only need to read files we (or dump.lua) write, so the grammar is tiny:
//
//   file   := "return" value
//   value  := "nil" | "true" | "false" | number | string | table
//   table  := "{" (entry ("," entry)* ","?)? "}"
//   entry  := "[" key "]" "=" value
//   key    := number | string
//
// No bareword identifiers, no function calls, no long-bracket strings, no
// comments (dump.lua never emits any of these). Keeping the subset narrow
// means we don't accidentally execute code from a settings file.

import type { LuaTable, LuaValue } from "./writer.ts";
import { KindlyError, ErrorCodes } from "../types/errors.ts";

export class LuaParseError extends KindlyError {
    constructor(msg: string, public pos: number, public src: string) {
        super(
            ErrorCodes.LUA_PARSE_FAILED,
            `${msg} at pos ${pos}: ${JSON.stringify(src.slice(Math.max(0, pos - 20), pos + 20))}`,
        );
        this.name = "LuaParseError";
    }
}

// KOReader settings have a few levels of nesting (kosync, cre_header_info,
// statistics, etc.); 64 is well above any legitimate config and well below
// V8/JSC's call-stack limit even for the recursive descent path here.
const MAX_TABLE_DEPTH = 64;

class Parser {
    pos = 0;
    depth = 0;
    constructor(public src: string) {}

    fail(msg: string): never {
        throw new LuaParseError(msg, this.pos, this.src);
    }

    peek(n = 0): string {
        return this.src[this.pos + n] ?? "";
    }

    eat(s: string): boolean {
        if (this.src.startsWith(s, this.pos)) {
            this.pos += s.length;
            return true;
        }
        return false;
    }

    expect(s: string): void {
        if (!this.eat(s)) this.fail(`expected ${JSON.stringify(s)}`);
    }

    skipWS(): void {
        while (this.pos < this.src.length) {
            const c = this.src.charCodeAt(this.pos);
            // space, tab, \n, \r, \v, \f
            if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
                this.pos++;
                continue;
            }
            // Lua comments. Real settings.reader.lua files include a leading
            //   -- ./settings.reader.lua
            // header line (written by luasettings.lua, not dump.lua), and
            // dump.lua itself emits --[[ LOOP: ... ]] markers when it detects
            // a recursive table. We accept both shapes as whitespace.
            if (c === 0x2d && this.src[this.pos + 1] === "-") {
                this.pos += 2;
                this.skipComment();
                continue;
            }
            break;
        }
    }

    // Positioned just past the opening `--`. Consumes through end-of-comment.
    skipComment(): void {
        // Long-bracket form: --[=*[ ... ]=*]
        if (this.src[this.pos] === "[") {
            let probe = this.pos + 1;
            let level = 0;
            while (this.src[probe] === "=") { level++; probe++; }
            if (this.src[probe] === "[") {
                // We have --[<level-equals>[
                this.pos = probe + 1;
                const closer = "]" + "=".repeat(level) + "]";
                const idx = this.src.indexOf(closer, this.pos);
                if (idx === -1) this.fail("unterminated long comment");
                this.pos = idx + closer.length;
                return;
            }
            // Not a long bracket — fall through to short-comment handling.
        }
        // Short comment: to end of line.
        const nl = this.src.indexOf("\n", this.pos);
        if (nl === -1) {
            this.pos = this.src.length;
        } else {
            this.pos = nl + 1;
        }
    }

    parseFile(): LuaValue {
        this.skipWS();
        this.expect("return");
        // `return` must be followed by whitespace (or EOF, but dump.lua always
        // writes a value after it).
        if (this.pos < this.src.length) {
            const c = this.src.charCodeAt(this.pos);
            const isWS = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
            if (!isWS) this.fail("expected whitespace after 'return'");
        }
        this.skipWS();
        const v = this.parseValue();
        this.skipWS();
        if (this.pos !== this.src.length) this.fail("unexpected trailing content");
        return v;
    }

    parseValue(): LuaValue {
        this.skipWS();
        const c = this.peek();
        if (c === "{") return this.parseTable();
        if (c === '"') return this.parseString();
        if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();
        if (this.eat("nil")) return null;
        if (this.eat("true")) return true;
        if (this.eat("false")) return false;
        this.fail("expected value");
    }

    parseString(): string {
        this.expect('"');
        let out = "";
        while (this.pos < this.src.length) {
            const ch = this.src[this.pos]!;
            if (ch === '"') {
                this.pos++;
                return out;
            }
            if (ch === "\\") {
                this.pos++;
                const e = this.src[this.pos];
                if (e === undefined) this.fail("unterminated escape");
                // `\` + literal newline → newline (this is how dump.lua emits \n)
                if (e === "\n") {
                    out += "\n";
                    this.pos++;
                    continue;
                }
                if (e === "\r") {
                    // `\r` or `\r\n` after backslash → newline
                    this.pos++;
                    if (this.src[this.pos] === "\n") this.pos++;
                    out += "\n";
                    continue;
                }
                // Named single-char escapes Lua recognizes in source. dump.lua
                // only emits \\ and \" via this path, but we're permissive.
                const named: Record<string, string> = {
                    "a": "\x07", "b": "\x08", "f": "\x0c",
                    "n": "\n", "r": "\r", "t": "\t", "v": "\x0b",
                    "\\": "\\", '"': '"', "'": "'",
                };
                if (e in named) {
                    out += named[e];
                    this.pos++;
                    continue;
                }
                // `\<decimal>`, up to 3 digits. This is how dump.lua emits all
                // non-printable bytes (including \0, \r, \13, etc).
                if (e >= "0" && e <= "9") {
                    let digits = "";
                    for (let i = 0; i < 3 && this.pos < this.src.length; i++) {
                        const d = this.src[this.pos]!;
                        if (d >= "0" && d <= "9") {
                            digits += d;
                            this.pos++;
                        } else break;
                    }
                    const n = parseInt(digits, 10);
                    if (n > 255) this.fail(`decimal escape out of range: ${n}`);
                    out += String.fromCharCode(n);
                    continue;
                }
                this.fail(`unknown escape \\${e}`);
            }
            if (ch === "\n") this.fail("unescaped newline in string");
            out += ch;
            this.pos++;
        }
        this.fail("unterminated string");
    }

    parseNumber(): number {
        const start = this.pos;
        if (this.peek() === "-") this.pos++;
        let sawDigit = false;
        while (this.peek() >= "0" && this.peek() <= "9") {
            this.pos++;
            sawDigit = true;
        }
        if (this.peek() === ".") {
            this.pos++;
            while (this.peek() >= "0" && this.peek() <= "9") {
                this.pos++;
                sawDigit = true;
            }
        }
        if (this.peek() === "e" || this.peek() === "E") {
            this.pos++;
            if (this.peek() === "+" || this.peek() === "-") this.pos++;
            let expDigits = false;
            while (this.peek() >= "0" && this.peek() <= "9") {
                this.pos++;
                expDigits = true;
            }
            if (!expDigits) this.fail("malformed exponent");
        }
        if (!sawDigit) this.fail("expected number");
        const n = Number(this.src.slice(start, this.pos));
        // Red-team S880 (2026-04-26): KOReader's dump.lua emits Infinity as
        // "1e999" (or any 400-digit integer); parsing as Number yields ±Inf,
        // luaToYaml then writes ".inf" to YAML, and the next apply throws
        // an unstructured "cannot serialize non-finite number" — kindly is
        // wedged. Reject non-finite at parse so the failure has a code and
        // a position, and a future pull can surface it as a device-side
        // bug to the user instead of dying on apply.
        if (!Number.isFinite(n)) this.fail("non-finite number");
        return n;
    }

    parseTable(): LuaTable | LuaValue[] {
        // Red-team S881 (2026-04-26): unbounded recursion in the parseValue
        // → parseTable → parseValue chain. A 30k-deep nested table from
        // device read crashes pull with "Maximum call stack size exceeded"
        // and an UNKNOWN error code (no remediation). Cap depth so the
        // failure has a structured code and position.
        if (++this.depth > MAX_TABLE_DEPTH) {
            this.depth--;
            this.fail(`nested table depth exceeded ${MAX_TABLE_DEPTH}`);
        }
        try {
            return this.parseTableBody();
        } finally {
            this.depth--;
        }
    }

    parseTableBody(): LuaTable | LuaValue[] {
        this.expect("{");
        // We preserve insertion order via an object; arrays detected
        // post-hoc if all keys are 1..N integers.
        const obj: Record<string, LuaValue> = {};
        const numericObj = new Map<number, LuaValue>();
        let hasStringKey = false;
        let hasNumericKey = false;

        this.skipWS();
        while (this.peek() !== "}") {
            this.expect("[");
            this.skipWS();
            const keyC = this.peek();
            let key: string | number;
            if (keyC === '"') {
                key = this.parseString();
                hasStringKey = true;
            } else if (keyC === "-" || (keyC >= "0" && keyC <= "9")) {
                key = this.parseNumber();
                hasNumericKey = true;
            } else {
                this.fail("expected string or numeric key");
            }
            this.skipWS();
            this.expect("]");
            this.skipWS();
            this.expect("=");
            this.skipWS();
            const val = this.parseValue();
            if (typeof key === "number") {
                numericObj.set(key, val);
            } else {
                obj[key] = val;
            }
            this.skipWS();
            if (this.eat(",")) {
                this.skipWS();
                continue;
            }
            break;
        }
        this.skipWS();
        this.expect("}");

        // Array heuristic: only numeric keys, and they are exactly 1..N.
        if (hasNumericKey && !hasStringKey) {
            const keys = Array.from(numericObj.keys()).sort((a, b) => a - b);
            const isDenseFromOne = keys.length > 0
                && keys[0] === 1
                && keys[keys.length - 1] === keys.length
                && keys.every((k, i) => k === i + 1);
            if (isDenseFromOne) {
                return keys.map((k) => numericObj.get(k)!);
            }
            // Sparse or non-1-indexed: return a Map to preserve integer keys.
            // Sort by key for determinism.
            return new Map(keys.map((k) => [k, numericObj.get(k)!]));
        }

        // Mixed or all-string: merge into a single table. If we have any
        // numeric keys alongside strings, fall back to Map (object keys are
        // always strings in JS).
        if (hasNumericKey && hasStringKey) {
            const m = new Map<string | number, LuaValue>();
            const nkeys = Array.from(numericObj.keys()).sort((a, b) => a - b);
            for (const k of nkeys) m.set(k, numericObj.get(k)!);
            for (const k of Object.keys(obj).sort()) m.set(k, obj[k]!);
            return m;
        }
        return obj;
    }
}

export function parse(src: string): LuaValue {
    const p = new Parser(src);
    p.skipWS();
    return p.parseValue();
}

export function parseSettingsFile(src: string): LuaValue {
    return new Parser(src).parseFile();
}

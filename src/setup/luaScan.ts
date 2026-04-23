// W36/W37: Lua static scanner — dangerous call detection.
//
// Spec: docs/93-lua-static-scanner-spec.md. Field-data baseline:
// docs/93-lua-dangerous-calls-inventory.md (95 hits across 17 bundled
// plugins, 0 suspicious — the inventory shaped every regex below).
//
// Pure function. Source text → list of matches. No IO, no catalog
// knowledge. Callers wrap this with file walking and catalog
// suppression (src/catalog/scanPipeline.ts).
//
// Design: lexical, not AST. We strip comments and string literals
// first (preserving newlines so line numbers survive), then run a
// small regex catalog over the residue. A capable attacker who
// obfuscates (`_G["os"]["execute"]`, `load(string.char(...))`) will
// bypass us — the W32 catalog hash is the backstop for tampered
// bundled plugins; this scanner is the signal for novel uncatalogued
// ones.

export type ScanCategory =
    | "shell"
    | "dynamic-load"
    | "network"
    | "native-code"
    | "reflection"
    | "fs-outside-scope";

export interface ScanMatch {
    category: ScanCategory;
    /** Short human label — "os.execute", "require(<net>)", … */
    label: string;
    /** 1-indexed line number in the original source. */
    line: number;
    /** The full source line trimmed, length-capped for rendering. */
    snippet: string;
}

// --- Pattern catalog ---------------------------------------------------
//
// Word-boundary anchored so `myos.execute` doesn't FP on `os.execute`.
// Call-shape patterns that need literal-vs-variable-arg filtering
// require `(` plus a char-class check for the first non-whitespace
// argument char.

interface Pattern {
    readonly regex: RegExp;
    readonly category: ScanCategory;
    readonly label: string;
    /** Which residue to scan against.
     *  - "stripped": both comments and string literals blanked. Use for
     *    identifier-shaped patterns where a mention inside a string is
     *    data, not code (`"os.execute not allowed"` must not match).
     *  - "no-comments": only comments blanked. Use for patterns whose
     *    regex inspects the string argument itself (`require("socket")`,
     *    absolute-path filters). */
    readonly residue: "stripped" | "no-comments";
}

const PATTERNS: readonly Pattern[] = [
    // shell — reference OR call both match. `util.execute = os.execute`
    // (aliasing) is caught because the assignment itself contains the
    // token (spec §2.2).
    { regex: /\bos\.execute\b/g, category: "shell", label: "os.execute", residue: "stripped" },
    { regex: /\bio\.popen\b/g, category: "shell", label: "io.popen", residue: "stripped" },

    // dynamic-load
    { regex: /\bloadstring\b/g, category: "dynamic-load", label: "loadstring", residue: "stripped" },
    // load(x) / dofile(x) where x is NOT a literal. Literal-string and
    // long-bracket args produce only whitespace in the stripped residue,
    // so `load("x")` → `load(   )` → no match. Variables pass through.
    {
        regex: /\bload\s*\(\s*[^"'[\s)]/g,
        category: "dynamic-load",
        label: "load(<non-literal>)",
        residue: "stripped",
    },
    {
        regex: /\bdofile\s*\(\s*[^"'[\s)]/g,
        category: "dynamic-load",
        label: "dofile(<non-literal>)",
        residue: "stripped",
    },

    // network — exact module-name match. Scans no-comments residue so
    // the string argument is still visible. `require("my-socket")` and
    // `require("socket-stub")` don't FP because the alternation is
    // anchored by closing quote.
    {
        regex: /\brequire\s*\(\s*["'](?:socket|socket\.http|ssl|ssl\.https)["']\s*\)/g,
        category: "network",
        label: "require(<net>)",
        residue: "no-comments",
    },

    // native-code
    {
        regex: /\brequire\s*\(\s*["']ffi["']\s*\)/g,
        category: "native-code",
        label: 'require("ffi")',
        residue: "no-comments",
    },
    {
        regex: /\bpackage\.loadlib\b/g,
        category: "native-code",
        label: "package.loadlib",
        residue: "stripped",
    },

    // reflection — only the genuinely dangerous debug.* surface.
    // debug.traceback / debug.getinfo stay out: routine diagnostics.
    {
        regex: /\bdebug\.(?:setfenv|getregistry|sethook|setupvalue|upvaluejoin)\b/g,
        category: "reflection",
        label: "debug.<reflect>",
        residue: "stripped",
    },

    // fs-outside-scope — absolute-path literals only. Survey showed 20/20
    // bundled writes use well-scoped relative paths; loosening would swamp
    // the reader with FPs.
    {
        regex: /\bos\.(?:remove|rename)\s*\(\s*["']\//g,
        category: "fs-outside-scope",
        label: "os.remove/rename(abs)",
        residue: "no-comments",
    },
    {
        regex: /\bio\.open\s*\(\s*["']\/[^"']+["']\s*,\s*["'][waW+]/g,
        category: "fs-outside-scope",
        label: "io.open(abs,write)",
        residue: "no-comments",
    },
];

// --- Strip comments + string literals ----------------------------------
//
// Replace stripped regions with spaces (keeping `\n` intact) so the
// output has 1:1 character offsets with the input — line numbers for
// regex matches against the residue equal line numbers in source.
//
// Handles: line comments `-- ...`, long comments `--[[...]]` and
// `--[==[...]==]`, short strings `"..."` / `'...'` with `\`-escapes,
// long strings `[[...]]` / `[==[...]==]`. Unterminated sequences bail
// at EOL/EOF rather than crash — worst case the residue gets a few
// extra chars and the regex pass either matches or doesn't.

export function stripCommentsAndStrings(source: string): string {
    return stripImpl(source, /* strings */ true);
}

export function stripCommentsOnly(source: string): string {
    return stripImpl(source, /* strings */ false);
}

function stripImpl(source: string, stripStrings: boolean): string {
    let out = "";
    let i = 0;
    const n = source.length;

    while (i < n) {
        const c = source[i];

        // comment (line or long)
        if (c === "-" && source[i + 1] === "-") {
            const lb = tryLongBracket(source, i + 2);
            if (lb !== null) {
                const end = findLongBracketClose(source, lb.contentStart, lb.level);
                out += blankPreserveNewlines(source, i, end);
                i = end;
                continue;
            }
            while (i < n && source[i] !== "\n") {
                out += " ";
                i++;
            }
            continue;
        }

        // short string
        if (c === '"' || c === "'") {
            const q = c;
            if (!stripStrings) {
                // Walk the string to skip past it but emit source chars.
                out += c;
                i++;
                while (i < n) {
                    const ch = source[i]!;
                    out += ch;
                    i++;
                    if (ch === "\\") {
                        if (i < n) { out += source[i]!; i++; }
                        continue;
                    }
                    if (ch === q) break;
                    if (ch === "\n") break; // unterminated
                }
                continue;
            }
            out += " ";
            i++;
            while (i < n) {
                const ch = source[i];
                if (ch === "\\") {
                    out += " ";
                    i++;
                    if (i < n) {
                        out += source[i] === "\n" ? "\n" : " ";
                        i++;
                    }
                    continue;
                }
                if (ch === q) { out += " "; i++; break; }
                if (ch === "\n") { out += "\n"; i++; break; }
                out += " ";
                i++;
            }
            continue;
        }

        // long string
        if (c === "[") {
            const lb = tryLongBracket(source, i);
            if (lb !== null) {
                const end = findLongBracketClose(source, lb.contentStart, lb.level);
                if (stripStrings) {
                    out += blankPreserveNewlines(source, i, end);
                } else {
                    out += source.slice(i, end);
                }
                i = end;
                continue;
            }
        }

        out += c;
        i++;
    }
    return out;
}

function tryLongBracket(
    source: string, at: number,
): { level: number; contentStart: number } | null {
    if (source[at] !== "[") return null;
    let j = at + 1;
    let level = 0;
    while (source[j] === "=") { level++; j++; }
    if (source[j] !== "[") return null;
    return { level, contentStart: j + 1 };
}

function findLongBracketClose(source: string, from: number, level: number): number {
    const n = source.length;
    let i = from;
    while (i < n) {
        if (source[i] === "]") {
            let j = i + 1;
            let matchLevel = 0;
            while (source[j] === "=") { matchLevel++; j++; }
            if (source[j] === "]" && matchLevel === level) return j + 1;
        }
        i++;
    }
    return n; // unterminated
}

function blankPreserveNewlines(source: string, start: number, end: number): string {
    let s = "";
    for (let k = start; k < end; k++) {
        s += source[k] === "\n" ? "\n" : " ";
    }
    return s;
}

// --- Main scan ---------------------------------------------------------

const SNIPPET_MAX = 80;

export function scanLuaSource(source: string): ScanMatch[] {
    const stripped = stripCommentsAndStrings(source);
    const noComments = stripCommentsOnly(source);
    const matches: ScanMatch[] = [];

    // Precompute line-start offsets: matchIndex → line is then O(log n).
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === "\n") lineStarts.push(i + 1);
    }
    const lineOf = (idx: number): number => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if (lineStarts[mid]! <= idx) lo = mid; else hi = mid - 1;
        }
        return lo + 1;
    };
    const lineText = (lineNum: number): string => {
        const start = lineStarts[lineNum - 1] ?? 0;
        const end = lineStarts[lineNum] ?? source.length;
        return source.slice(start, end).replace(/\n$/, "");
    };

    for (const p of PATTERNS) {
        const re = new RegExp(p.regex.source, p.regex.flags);
        const residue = p.residue === "stripped" ? stripped : noComments;
        for (const m of residue.matchAll(re)) {
            const line = lineOf(m.index ?? 0);
            const raw = lineText(line).trim();
            const snippet = raw.length > SNIPPET_MAX
                ? raw.slice(0, SNIPPET_MAX - 1) + "…"
                : raw;
            matches.push({
                category: p.category,
                label: p.label,
                line,
                snippet,
            });
        }
    }

    matches.sort((a, b) =>
        a.line !== b.line ? a.line - b.line : a.category.localeCompare(b.category),
    );
    return matches;
}

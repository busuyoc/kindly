// Port of KOReader's frontend/dump.lua — serializes a JS value into the exact
// string KOReader produces when it flushes settings.reader.lua.
//
// The goal is byte-faithful output: anything else risks KOReader silently
// falling back to its .old sibling because pcall(dofile) fails.
//
// KOReader's dump() writes keys in alphabetical order when ordered=true
// (which luasettings uses). We always write ordered — matches what KOReader
// itself emits on every flush.

export type LuaValue =
    | string
    | number
    | boolean
    | null
    | LuaTable
    | LuaValue[];

export type LuaTable = { [key: string]: LuaValue } | Map<string | number, LuaValue>;

const INDENT = "    ";

// Lua 5.1 %q format. Reference: src/lstrlib.c :: addquoted
//   - " and \ prefixed with backslash
//   - \n written as `\` + literal newline
//   - \0 and other non-printable bytes written as \<decimal>
//     (\r becomes \13 — there is NO named \r escape in %q output)
export function luaQuoteString(s: string): string {
    let out = '"';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        const ch = s[i];
        if (ch === '"' || ch === "\\") {
            out += "\\" + ch;
        } else if (ch === "\n") {
            out += "\\\n";
        } else if (c === 0 || c < 32 || c === 127) {
            out += "\\" + c.toString(10);
        } else {
            out += ch;
        }
    }
    return out + '"';
}

// Mirror Lua's tostring() for numbers. Integers → "42", floats → "3.14".
// Lua 5.1 prints ints as int-shaped when they fit; 5.3+ uses "%.14g" for
// floats. KOReader runs on Lua 5.1 via LuaJIT. tostring() there produces
// "%.14g" for floats and "%d" for integer-valued floats. We approximate.
function luaNumberString(n: number): string {
    if (!Number.isFinite(n)) {
        throw new Error(`cannot serialize non-finite number: ${n}`);
    }
    if (Number.isInteger(n)) return n.toString();
    // "%.14g" — JS's toPrecision gives us a reasonable approximation for
    // settings.reader.lua, which rarely stores high-precision floats.
    return n.toPrecision(14).replace(/\.?0+$/, "").replace(/(\.\d*?)0+e/, "$1e");
}

// Serialize a key. Keys are serialized recursively and wrapped in [ ].
// For settings.reader.lua we almost always see string keys, but dump.lua
// supports any Lua value as a key.
function serializeKey(k: string | number, out: string[], indent: number): void {
    if (typeof k === "number") {
        out.push(luaNumberString(k));
    } else {
        out.push(luaQuoteString(k));
    }
}

// Collect entries from an object-or-Map in alphabetical order (string-key
// sort; numeric keys sort numerically and appear before strings — matches
// orderedPairs behavior on the KOReader side for mixed tables, but
// settings.reader.lua tables are string-keyed in practice).
function orderedEntries(t: LuaTable | LuaValue[]): Array<[string | number, LuaValue]> {
    if (Array.isArray(t)) {
        // Lua arrays are 1-indexed tables with integer keys.
        return t.map((v, i) => [i + 1, v]);
    }
    if (t instanceof Map) {
        return Array.from(t.entries()).sort(compareKeys);
    }
    return Object.entries(t).sort(compareKeys);
}

function compareKeys(
    a: [string | number, LuaValue],
    b: [string | number, LuaValue]
): number {
    const [ka] = a;
    const [kb] = b;
    if (typeof ka === "number" && typeof kb === "number") return ka - kb;
    if (typeof ka === "number") return -1;
    if (typeof kb === "number") return 1;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function serializeValue(v: LuaValue, out: string[], indent: number): void {
    if (v === null) {
        out.push("nil");
        return;
    }
    if (typeof v === "string") {
        out.push(luaQuoteString(v));
        return;
    }
    if (typeof v === "number") {
        out.push(luaNumberString(v));
        return;
    }
    if (typeof v === "boolean") {
        out.push(v ? "true" : "false");
        return;
    }
    if (typeof v === "object") {
        serializeTable(v as LuaTable | LuaValue[], out, indent);
        return;
    }
    throw new Error(`unsupported value type: ${typeof v}`);
}

function serializeTable(t: LuaTable | LuaValue[], out: string[], indent: number): void {
    // In Lua, `t[k] = nil` deletes the key — nil entries are invisible to
    // pairs(). Drop null-valued entries so we match that behavior.
    const entries = orderedEntries(t).filter(([, v]) => v !== null);
    out.push("{");
    let didRun = false;
    for (const [k, v] of entries) {
        out.push("\n");
        out.push(INDENT.repeat(indent + 1));
        out.push("[");
        serializeKey(k, out, indent + 1);
        out.push("] = ");
        serializeValue(v, out, indent + 1);
        out.push(",");
        didRun = true;
    }
    if (didRun) {
        out.push("\n");
        out.push(INDENT.repeat(indent));
    }
    out.push("}");
}

// Serialize any supported value to its dump.lua representation.
export function dump(data: LuaValue): string {
    const out: string[] = [];
    serializeValue(data, out, 0);
    return out.join("");
}

// Match KOReader's util.writeToFile() framing for settings files:
//   -- <filepath>
//   return <dump>
//   <trailing newline>
// Reference: frontend/util.lua :: writeToFile, lua_dofile_ready branch.
// `filepath` is the path the file will live at — becomes a leading comment
// byte-identical to what KOReader would emit for that destination.
export function dumpSettingsFile(data: LuaTable, filepath?: string): string {
    const header = filepath ? `-- ${filepath}\n` : "";
    return header + "return " + dump(data) + "\n";
}

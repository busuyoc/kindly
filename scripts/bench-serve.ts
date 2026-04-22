// Perf benchmark: `kindly serve` warm requests vs cold `bun run` spawns.
// Success bar from the W26 DoD: warm ≥5× faster than cold.
//
// Usage: bun run scripts/bench-serve.ts [N]  (default N=100)
//
// Command under test: `doctor --json` against a fake Kindle tmpdir. Cheap,
// deterministic, exercises the full dispatch path (parseArgs → executeDoctor
// → emitJson). Not a microbenchmark — this is "what the GUI would feel".

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.argv[2] ?? 100);
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function makeFakeKindle(): string {
    const root = mkdtempSync(join(tmpdir(), "bench-kindle-"));
    mkdirSync(join(root, "koreader"));
    writeFileSync(
        join(root, "koreader", "settings.reader.lua"),
        `return {
    ["avoid_flashing_ui"] = true,
    ["refresh_rate"] = 8,
    ["lastfile"] = "/mnt/us/documents/book.epub",
}
`,
    );
    return root;
}

function now(): number { return performance.now(); }

function fmt(ms: number): string {
    return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(1)}ms`;
}

async function benchCold(mount: string): Promise<number> {
    const t0 = now();
    for (let i = 0; i < N; i++) {
        const r = spawnSync("bun", ["run", CLI, "doctor", "--mount", mount, "--json"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        if (r.status !== 0) throw new Error(`cold run ${i} exited ${r.status}`);
    }
    return now() - t0;
}

async function benchWarm(mount: string): Promise<number> {
    const child = spawn("bun", ["run", CLI, "serve"], {
        stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for hello line, then drive N requests and collect N responses.
    const responses: string[] = [];
    let buf = "";
    const done = new Promise<void>((resolve, reject) => {
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
                responses.push(buf.slice(0, nl));
                buf = buf.slice(nl + 1);
                if (responses.length === N + 1) resolve();  // +1 for hello
            }
        });
        child.stderr.on("data", (d: Buffer) => {
            process.stderr.write(`[serve stderr] ${d.toString()}`);
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (responses.length < N + 1) reject(new Error(`serve exited early with ${code}; got ${responses.length}/${N + 1} lines`));
        });
    });

    const t0 = now();
    for (let i = 0; i < N; i++) {
        const req = JSON.stringify({ id: i, argv: ["doctor", "--mount", mount] }) + "\n";
        child.stdin.write(req);
    }
    await done;
    const elapsed = now() - t0;

    child.stdin.end();
    child.kill();
    return elapsed;
}

async function main() {
    const mount = makeFakeKindle();
    console.log(`fake Kindle: ${mount}`);
    console.log(`N = ${N}`);
    console.log();

    // Warm-up: one of each to amortize first-time filesystem cache.
    spawnSync("bun", ["run", CLI, "doctor", "--mount", mount, "--json"], { stdio: "ignore" });

    console.log("cold (bun run spawn per request)...");
    const coldMs = await benchCold(mount);

    console.log("warm (kindly serve)...");
    const warmMs = await benchWarm(mount);

    const ratio = coldMs / warmMs;

    console.log();
    console.log(`cold:  ${fmt(coldMs)} total, ${fmt(coldMs / N)}/req`);
    console.log(`warm:  ${fmt(warmMs)} total, ${fmt(warmMs / N)}/req`);
    console.log(`ratio: ${ratio.toFixed(1)}× (DoD: ≥5×)`);
    console.log();
    console.log(ratio >= 5 ? "✓ meets W26 DoD" : "✗ below W26 DoD");
    process.exit(ratio >= 5 ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

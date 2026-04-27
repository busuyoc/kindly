# W46 — KOReader-in-Docker harness red-team (Slices 0–4)

Filed 2026-04-27 against `c6ace03` (W46 Slices 0–4 commit). Scope:
the harness image (`harness/koreader/`), the entrypoint, the
patches, and the host-side `kindly preview` driver
(`src/lib/preview.ts`, `src/commands/preview.ts`).

Three usable findings (one HIGH, one MEDIUM, one LOW) and one
NO-FINDING (analysed and discharged here so it doesn't return as
a future false alarm).

## Threat model recap

The harness is a power-user / contributor tool. It runs a KOReader
emulator inside a container with two bind mounts:

- `KO_HOME` — read-write, materialized in a host tmpdir; kindly
  writes `settings.reader.lua` there before run, removes it after.
- `out` — read-write, materialized in a host tmpdir; the screenshot
  patch writes `preview.png` there, the host moves it to the user's
  `--output` path after the container exits.

Network is `--network=none`. The container runs the upstream
KOReader code we built into the image. The merged YAML is *not*
classify-filtered before being dumped into the container — preview
needs pixel accuracy, so the entire user config flows through.

The trust boundary the redteam interrogated:

> Anything that crosses the bind-mount boundary from container →
> host is data the kindly user-account is about to operate on.
> What primitives does the host side ship that compose with
> container-side write access?

## W46-S1 (HIGH) — `copyFileSync` follows symlinks: container → host file exfil primitive

**File:** `src/lib/preview.ts:139` (introduced in `c6ace03`).

```ts
const tmpPng = join(outDir, "preview.png");
if (!exists(tmpPng, "internal")) { /* throw */ }
mkdirSync(dirname(outputPath), { recursive: true });
copyFileSync(tmpPng, outputPath);   // ← follows symlinks by default
```

Node's `fs.copyFileSync` follows symlinks (no `O_NOFOLLOW`-equivalent
option exists on the sync API). If the container places a symlink at
`/work/out/preview.png`, the host's `copyFileSync` resolves the link
target *in the host namespace* and copies whatever it points at into
the user's `--output`.

**Reproduction (live, run 2026-04-27):**

```bash
mkdir -p /tmp/kindly-probe/out
echo "EXFIL_PROBE_…" > /tmp/kindly-probe/secret-host-data.txt

docker run --rm -v /tmp/kindly-probe/out:/work/out alpine:latest \
    sh -c 'ln -sf /tmp/kindly-probe/secret-host-data.txt /work/out/preview.png'

# host then reproduces the preview.ts:139 line:
bun -e 'require("node:fs").copyFileSync(
  "/tmp/kindly-probe/out/preview.png",
  "/tmp/kindly-probe/exfil.png")'

cat /tmp/kindly-probe/exfil.png
# → contents of secret-host-data.txt
```

The probe succeeded: `exfil.png` ended up byte-identical to the
target file. The host-side primitive is unconditional — symlinks
in `/work/out/` resolve to wherever they point on the host, with
the kindly process's own permissions.

**Reachability.** Today the only writer of `/work/out/preview.png`
is the kindly screenshot patch (`patches/2-kindly-screenshot.lua`),
which calls `Screen:shot()` — a real-file write, not a symlink.
So a *clean* harness image with the *shipped* patch never plants
a symlink, and the primitive is dormant. But:

1. **Compose with W46-S2 (image-tag trust):** if the local
   `kindly-koreader:dev` tag is ever swapped, or if a future
   release pulls a tampered upstream KOReader, a hostile build
   can plant the symlink in entrypoint.sh or in a replacement
   patch. The host-side primitive then weaponizes immediately.
2. **Compose with future settings-driven KOReader code paths:**
   a hostile YAML cannot reach a write primitive in the container
   today (W46-NF1 below), but every future plugin or setting that
   adds `os.execute`/`lfs.link`/`io.popen` reachability via
   merged config re-arms this.
3. **The kindly user-account scope.** The exfilable surface is
   anything the kindly process can read: `~/.ssh/id_rsa`,
   `~/.aws/credentials`, the user's mounted Kindle's
   `settings.reader.lua` (with secrets), keychain export files,
   and so on. `--network=none` does not contain this — exfil rides
   the bind mount, not the network.

**Severity: HIGH.** The primitive is unconditional, the consequence
is host-file disclosure to the kindly process's `--output` path
(which the user thinks is a PNG), and the composition surface is
both Vector S2 (image trust) and any future settings-driven RCE.

**Fix.** Refuse symlinks at the boundary. Two layers:

1. `src/lib/preview.ts` — replace the `exists()` + `copyFileSync`
   pair with `lstatSync(tmpPng)` first; if `isSymbolicLink()`,
   throw `HARNESS_OUTPUT_TAINTED`. Then read the regular file
   and write to `outputPath` ourselves (or use `fs.copyFile` with
   the explicit guarantee that the source isn't a symlink).
2. The exists() call at `:130` passes `"internal"` as the
   `PathProvenance` — but `"internal"` is **not** a member of
   `PathProvenance` in `src/fs/safeRead.ts`. Either widen the
   type or, better, use `"derived-from-cwd"` (the outDir is a
   `mkdtempSync` we created) and rely on a strengthened
   `safeRead.copyFile()` path that already does
   `rejectSymlinkFromUntrusted`.

Test: extend `tests/harness/preview.test.ts` (gated by
`KINDLY_HARNESS_DOCKER=1`) with a probe variant where the patch
replaces preview.png with a symlink — assert
`HARNESS_OUTPUT_TAINTED` is raised and `--output` is not written.

## W46-S2 (MEDIUM) — Image-tag trust: TOFU on first build, no digest pin

**Files:**
- `src/lib/preview.ts:48` — `const HARNESS_IMAGE = "kindly-koreader:dev"`.
- `harness/koreader/Dockerfile:24` — `ARG KOREADER_REF=master`.
- `harness/koreader/Dockerfile:71-73` — shallow clone of upstream
  KOReader at build time, no commit pin.
- `harness/koreader/build.sh:22` — `docker build -t "$TAG" .` —
  no signature, no SBOM, no expected-digest verification.

`kindly preview` runs whatever image the local docker daemon has
tagged `kindly-koreader:dev`. There is no integrity check: no
`docker inspect kindly-koreader:dev --format '{{.Id}}'` against an
expected sha256, no Sigstore/cosign verification, no manifest
digest in the source.

Two attacker paths compose with this:

1. **Local foothold amplification.** Anyone with docker access on
   the host (which is anyone running kindly, since the harness
   needs docker) can `docker tag <hostile-image> kindly-koreader:dev`.
   The next `kindly preview` runs the hostile image with
   `--network=none` *plus* the user's bind-mounted KO_HOME — which,
   if `--mount` is set, includes the device's `settings.reader.lua`
   merged with the user's YAML (passwords, PINs, kosync keys).
   The hostile image gets read access to all of that and write
   access to `/work/out`, which composes with W46-S1 for host
   file exfil.
2. **Upstream supply chain.** `KOREADER_REF=master` (default) means
   `build.sh` clones whatever `koreader/koreader` HEAD looks like
   at build time. KOReader is FOSS, accept-PRs upstream; a
   compromised PR or a key compromise on github.com/koreader
   between two of our builds bakes in arbitrary code. We have no
   pin, no diff, no review window.

**Reachability.** Local-foothold (1) is realistic but bounded —
attacker must already have user-level access. Supply-chain (2) is
real but largely outside kindly's scope; the same threat applies
to every `npm install` or `apt install` we already trust. Honest
framing: kindly's threat model trusts the docker daemon as a local
component on par with PATH and the user's shell.

**Severity: MEDIUM.** Not a self-sufficient exploit, but an
amplifier for any local-access attacker and a real
supply-chain-trust gap that the harness's "single-purpose,
hermetic" framing currently hand-waves.

**Fix candidates (pick one, smallest first):**

1. **Pin KOReader to a tagged release** in `build.sh`'s default —
   change `REF="${1:-master}"` to a known tag like `v2025.10`. This
   is a one-line fix and it's what the `--build-arg KOREADER_REF`
   plumbing was designed for; we just don't default-use it.
2. **Record the expected image digest** in a checked-in file
   (e.g., `harness/koreader/EXPECTED_DIGEST`) and have
   `preview.ts` call `docker inspect --format '{{.Id}}'` and
   compare. Brittle: every legitimate rebuild updates the digest.
3. **Sign the image with cosign**, ship the public key in
   the repo, verify before run. Heaviest, but matches industry
   norms; defer until kindly has CI building harness images.

Recommended: (1) for v0.14, (3) for v1.0 alongside CI image build.

## W46-S3 (LOW) — Container has no resource limits beyond a 30s wallclock watchdog

**Files:**
- `src/lib/preview.ts:101-114` — `docker run` args list omits
  `--memory`, `--cpus`, `--pids-limit`, `--read-only`.
- `harness/koreader/entrypoint.sh:69, 78` — `timeout 30` is the
  only stop.

Verified live (`docker run --rm --network=none alpine cat
/sys/fs/cgroup/memory.max`): default cgroup-v2 limits inside
the container are `max` for `memory.max`, `pids.max`, and
`cpu.max` is `max 100000` (no quota). A malicious workload
inside the container can:

- **Fork-bomb** (`:(){ :|:& };:`): no PID cap; on Docker Desktop
  for macOS the limit is host-wide, not per-container.
- **Memory pressure**: `mmap` until host OOM killer fires.
- **CPU saturation**: tight loop on N cores until host throttles.
- **Disk fill** through the bind mount: write zeros to
  `/work/out/blob` until the host's tmpdir partition fills.

The 30s watchdog stops the workload eventually — but 30s is
plenty of time to OOM a developer laptop or fill /tmp.

**Severity: LOW** for the single-user dev workflow this harness
targets — you'd notice your laptop slowing down and you control
the YAML you're rendering. **MEDIUM** for any future scenario
where `kindly serve` or a GUI accepts preview requests from a
less-trusted caller.

**Reachability.** No known YAML→fork-bomb chain (W46-NF1), but
this is a defense-in-depth gap that costs ~5 lines.

**Fix.** Add `--memory=512m --pids-limit=256 --cpus=2 --read-only
--tmpfs /tmp` to the docker run argv in `preview.ts:101-114`.
Tune memory cap empirically (KOReader's offscreen build with a
small epub uses ~150 MiB resident in our tests).

## W46-NF1 — YAML alone cannot reach a host-write primitive (analysed, discharged)

A hostile `kindly.yaml` is dumped via `dumpSettingsFile()` into the
container's `KO_HOME/settings.reader.lua`, then KOReader parses it.
The redteam looked for any settings-driven KOReader code path that
could plant a symlink into `/work/out/` (which would then weaponize
W46-S1).

What we found:

- `yamlToLua` (`src/schema/yaml.ts:167`) converts YAML to data and
  rejects `__proto__`/`constructor`/`prototype` keys (S800 fix);
  `parseYamlSafe` rejects non-NFC keys (Lead 19); cyclic anchors
  trip `YAML_CYCLIC` (S840 fix).
- KO_HOME is populated *only* with `settings.reader.lua` and the
  kindly-supplied screenshot patch. No plugins, no scripts, no
  user-controlled patches. The YAML cannot add files to KO_HOME
  through its own content — `Bun.write` only writes the one path.
- Settings parsing in KOReader is data-driven (string/integer/bool
  values, no Lua execution from settings.reader.lua itself). Code
  paths that *act* on settings (plugin loaders, history writers)
  cannot create files in `/work/out` — that path isn't in their
  default search list.
- `extra_plugin_paths` could in principle redirect plugin-scan to
  `/work/out`, but `/work/out` is empty at boot, so no plugins
  load from there.

So today, with the shipped patches and the kindly KO_HOME
population pattern, the YAML *alone* has no path to weaponize
W46-S1. **This is fragile, not robust** — it depends on KOReader
not gaining a settings-key that triggers a write to a YAML-supplied
path. Fixing W46-S1 unconditionally (refuse symlinks at the host
boundary) is the durable defense; relying on this analysis is not.

## Cross-finding fix cluster

Land in this order:

1. **W46-S1 first** — symlink rejection at the host boundary.
   Closes the entire class of container→host exfil regardless of
   whether the planter is a swapped image, a compromised upstream,
   or a future settings-driven RCE.
2. **W46-S3** — resource limits. Cheap, defense-in-depth.
3. **W46-S2 (1)** — pin `KOREADER_REF` default to a tagged
   release. One-line fix; closes the most common supply-chain
   slip (`build.sh` re-runs picking up upstream master drift).
4. **W46-S2 (3)** — cosign signing — defer to v1.0 / CI image
   build.

## Out of scope for this round

- **Kindle-side hardening audit.** Was the original "should we do
  red team for the new Docker work" prompt; this doc covers only
  the host↔container boundary. Device-side (FAT32, plug/unplug,
  KOReader RCE on the Kindle itself) is the next sprint per the
  roadmap memory.
- **Phase 2 (compiled binary)** — not yet committed; the redteam
  surface there is `bun build --compile` asset embedding and
  binary trust, separate analysis.
- **Cross-version matrix (Slice 5).** Once we pin `KOREADER_REF`
  per-tag, the surface changes per ref; redo a focused redteam
  per supported tag.

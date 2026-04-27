# KOReader-in-Docker harness

Power-user / contributor tool. Runs the KOReader SDL3 emulator
headless inside a container, used for:

1. Exploit regression — `KO_HOME=<kindly-mutated tree>`, assert
   the emulator boots cleanly. Catches the same class of bugs as
   docs/96 red-team probes but reproducibly in CI.
2. Cross-version matrix — pin upstream KOReader tags via
   `--build-arg KOREADER_REF=v2025.10`.
3. v1.x preview substrate — render a PNG of the rendered Kindle
   screen for the future GUI.

Not for ordinary users. Docker install is a wall by design — see
the kindly compiled binary (`bun build --compile`) for the
no-Docker path.

## Slice 0 result (recorded 2026-04-27)

`debian:trixie-slim` libsdl3-dev 3.2.10 ships both `offscreen` and
`dummy` video drivers compiled in. Headless harness uses
`SDL_VIDEO_DRIVER=offscreen` — no Xvfb needed, no SDL3 source build.
Re-run the probe with `docker build -t probe probe && docker run
--rm probe`.

## Quick start

```bash
# Build (cold ~15-30 min; cached ~2 min).
./build.sh

# Pin a specific upstream KOReader tag.
./build.sh v2025.10

# Boot smoke test — verify the bundled luajit + libs link cleanly.
# (reader.lua has no --help that exits, so the smoke must use luajit
# directly rather than the entrypoint.)
docker run --rm --entrypoint /opt/koreader/luajit kindly-koreader:dev \
    -e 'print("ok"); print(jit.version)'

# Slice 2: KO_HOME boot-and-exit regression.
docker run --rm \
    -e KO_HOME=/work/ko_home \
    -v "$PWD/some-fake-mount":/work/ko_home \
    kindly-koreader:dev --mode=boot-and-exit

# Slice 3: render a preview PNG.
docker run --rm \
    -e KO_HOME=/work/ko_home \
    -e KINDLY_SCREENSHOT=/work/out/preview.png \
    -v "$PWD/some-fake-mount":/work/ko_home \
    -v "$PWD/out":/work/out \
    kindly-koreader:dev --mode=preview reader.lua /work/ko_home/sample.epub

# Slice 4: render a kindly.yaml as a Kindle-screen PNG via the CLI.
kindly preview --file=kindly.yaml --output=preview.png --mount=
# (or, with a real Kindle plugged in, drop --mount= to merge the YAML
# over the device's current settings.reader.lua as the baseline.)
```

## Image structure

- **builder** stage (~2 GB): full toolchain, clones KOReader at
  `KOREADER_REF`, runs `./kodev fetch-thirdparty && ./kodev build`.
- **runtime** stage (target ~80 MB): debian:trixie-slim +
  libsdl3-0 + fonts-noto-core, with the built emulator at
  `/opt/koreader/`. `SDL_VIDEO_DRIVER=offscreen` is default.
- **entrypoint** (`/opt/entrypoint.sh`) dispatches between
  `--mode=boot-and-exit` (Slice 2) and `--mode=preview` (Slice 3).
  Patches live at `/opt/koreader-patches/` and are copied into
  `KO_HOME/patches/` at run time so the container leaves no state
  in KO_HOME beyond what the user explicitly passes in.

## Build args

| Arg            | Default     | Purpose                                |
|----------------|-------------|----------------------------------------|
| `DEBIAN_BASE`  | `trixie-slim` | Base image. Bookworm only has SDL2. |
| `KOREADER_REF` | `master`    | Upstream branch or tag to clone.       |

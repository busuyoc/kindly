# Slice 1 — KOReader emulator builds & boots in container.
#
# Multi-stage:
#   builder  — full toolchain + KOReader source + ./kodev build (cold ~15-30 min).
#   runtime  — debian:trixie-slim + libsdl3-0 + the built emulator. Target ~80 MB.
#
# Slice 0 closed: trixie's libsdl3-dev 3.2.10 ships both offscreen + dummy
# drivers compiled in, so the runtime image runs headless without Xvfb.
#
# Build:
#   docker build -t kindly-koreader:dev harness/koreader
#   docker build --build-arg KOREADER_REF=v2025.10 \
#                -t kindly-koreader:v2025.10 harness/koreader
#
# Verify (luajit smoke — reader.lua has no --help, would hang):
#   docker run --rm --entrypoint /opt/koreader/luajit kindly-koreader:dev \
#       -e 'print("ok"); print(jit.version)'

ARG DEBIAN_BASE=trixie-slim

# === Stage 1: builder ========================================================
FROM debian:${DEBIAN_BASE} AS builder

ARG KOREADER_REF=v2025.10

ENV DEBIAN_FRONTEND=noninteractive

# KOReader's official Debian/Ubuntu deps (doc/Building.md §"Debian/Ubuntu")
# plus libsdl3-dev. KOReader-base rebuilds SDL3 from source (its bundled
# thirdparty/sdl3 source tree); SDL3's CMake auto-detects X11 and demands
# the full X11 -dev set even though we only use the offscreen driver at
# runtime. Listing them all here is cheaper than patching koreader-base.
RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf \
        automake \
        bash \
        build-essential \
        ca-certificates \
        cmake \
        curl \
        gettext \
        git \
        libsdl3-dev \
        libtool \
        libtool-bin \
        libx11-dev \
        libxcursor-dev \
        libxext-dev \
        libxfixes-dev \
        libxi-dev \
        libxinerama-dev \
        libxkbcommon-dev \
        libxrandr-dev \
        libxss-dev \
        libxtst-dev \
        libxxf86vm-dev \
        meson \
        nasm \
        ninja-build \
        patch \
        pkg-config \
        python3 \
        python3-pip \
        unzip \
        wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src

# Shallow clone with shallow submodules — saves ~1 GB of git history.
RUN git clone --recurse-submodules --depth=1 --shallow-submodules \
        --branch=${KOREADER_REF} \
        https://github.com/koreader/koreader.git .

# fetch-thirdparty pulls extra non-submodule deps (luarocks, etc.).
# Then build the emulator.
RUN ./kodev fetch-thirdparty && ./kodev build

# kodev names the output dir `koreader-emulator-<arch-triple>-debug`,
# and inside it `luajit` and `libs/*.so` are symlinks back into
# /src/base/build/<arch-triple>-debug/. Docker's COPY preserves
# symlinks but doesn't follow them across stages, so we materialize a
# self-contained tree at /src/koreader-emulator/ via `cp -L`. Separate
# RUN step so the expensive kodev build layer above stays cacheable.
RUN cp -aL "$(ls -d /src/koreader-emulator-*-debug | head -n1)/koreader" /src/koreader-emulator

# === Stage 2: runtime ========================================================
FROM debian:${DEBIAN_BASE} AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    SDL_VIDEO_DRIVER=offscreen \
    PATH="/opt/koreader:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        fonts-noto-core \
        libsdl3-0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/koreader-emulator/ /opt/koreader/

# Patches go to a staging dir; the entrypoint copies the right one
# into KO_HOME/patches/ at runtime based on --mode. Keeps KO_HOME
# untouched when the harness is not driving the run.
COPY patches/ /opt/koreader-patches/
COPY entrypoint.sh /opt/entrypoint.sh

WORKDIR /opt/koreader

ENTRYPOINT ["/opt/entrypoint.sh"]
# No default — users must pass --mode={boot-and-exit,preview,interactive}.
# reader.lua has no --help that exits, so a "trivial smoke" CMD would
# hang. The entrypoint prints usage and exits 2 when --mode is omitted.

# Slice 0 — SDL3 offscreen feasibility probe.
#
#   docker build -t kindly-koreader-probe harness/koreader/probe
#   docker run --rm kindly-koreader-probe
#
# Decision gate. Exit 0 means apt-shipped libsdl3 has offscreen (or dummy)
# baked in and the Slice 1 image can use the distro package. Exit 1 means
# we either rebuild SDL3 from source or add Xvfb to the runtime image.
#
# Trixie (Debian 13) is the first stable to ship libsdl3-dev. Bookworm
# (12) only has SDL2.

FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libsdl3-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY check_offscreen.c .

RUN cc -O2 -Wall -Wextra -o check_offscreen check_offscreen.c \
        $(pkg-config --cflags --libs sdl3)

ENTRYPOINT ["/work/check_offscreen"]

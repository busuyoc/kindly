// Slice 0 — does the apt-shipped libsdl3 ship the offscreen / dummy
// video drivers compiled in? If yes, the harness Dockerfile uses the
// distro package (~80 MB image). If no, we either rebuild SDL3 from
// source with -DSDL_VIDEO_DRIVER_OFFSCREEN=ON or fall back to Xvfb
// (~120 MB image).
//
// Build:   cc check_offscreen.c $(pkg-config --cflags --libs sdl3)
// Run:     ./a.out
// Exit 0 => harness can run headless without Xvfb.
// Exit 1 => harness needs Xvfb (or a custom SDL3 build).

#include <SDL3/SDL.h>
#include <stdio.h>
#include <string.h>

static int try_driver(const char *name) {
    SDL_ResetHint(SDL_HINT_VIDEO_DRIVER);
    SDL_SetHint(SDL_HINT_VIDEO_DRIVER, name);
    if (!SDL_Init(SDL_INIT_VIDEO)) {
        printf("  init %-9s : FAIL (%s)\n", name, SDL_GetError());
        return 0;
    }
    const char *cur = SDL_GetCurrentVideoDriver();
    int matched = cur && strcmp(cur, name) == 0;
    printf("  init %-9s : %s (current=%s)\n",
           name, matched ? "OK" : "MISMATCH", cur ? cur : "null");
    SDL_Quit();
    return matched;
}

int main(void) {
    int n = SDL_GetNumVideoDrivers();
    printf("SDL3 reports %d compiled video drivers:", n);
    int has_offscreen = 0, has_dummy = 0;
    for (int i = 0; i < n; i++) {
        const char *name = SDL_GetVideoDriver(i);
        printf(" %s", name ? name : "(null)");
        if (name && strcmp(name, "offscreen") == 0) has_offscreen = 1;
        if (name && strcmp(name, "dummy") == 0) has_dummy = 1;
    }
    printf("\n");

    int off_ok = has_offscreen && try_driver("offscreen");
    int dum_ok = has_dummy && try_driver("dummy");

    if (off_ok) {
        puts("RESULT: offscreen OK -- harness uses SDL_VIDEO_DRIVER=offscreen");
        return 0;
    }
    if (dum_ok) {
        puts("RESULT: offscreen MISSING but dummy OK -- harness uses dummy");
        return 0;
    }
    puts("RESULT: neither offscreen nor dummy available "
         "-- harness needs Xvfb or a custom SDL3 build");
    return 1;
}

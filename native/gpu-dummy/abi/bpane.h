/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_DDX_H
#define BPANE_DDX_H
#include <xorg-server.h>
#include <stdbool.h>
#include <stdint.h>
#include <xf86.h>
#include <xf86Module.h>
#include <scrnintstr.h>
#include <pixmapstr.h>
#include <windowstr.h>
#include <randrstr.h>
#include <os.h>
#define GLAMOR_FOR_XORG
#include <glamor.h>

#ifndef BPANE_TEST_SOFTWARE
#define BPANE_TEST_SOFTWARE 0
#endif

typedef struct BpClock BpClock;
uint64_t bp_geometry(uint32_t width, uint32_t height);
BpClock *bp_clock_new(uint64_t epoch, uint32_t hz);
void bp_clock_free(BpClock *clock);
uint64_t bp_clock_sample(BpClock *clock, uint64_t now, uint64_t *msc);
bool bp_clock_queue(BpClock *clock, uint64_t id, uint64_t target);
void bp_clock_abort(BpClock *clock, uint64_t id);
uint32_t bp_clock_delay(BpClock *clock, uint64_t now);
bool bp_clock_pop(BpClock *clock, uint64_t now, uint64_t output[3]);

typedef struct {
    int fd;
    struct BpCapture *capture;
    void *test_pixels;
    BpClock *clock;
    OsTimerPtr timer;
    RRCrtcPtr crtc;
    RROutputPtr output;
    CloseScreenProcPtr close;
    CreateScreenResourcesProcPtr resources;
} BpScreen;

static inline BpScreen *bp_screen(ScreenPtr screen) {
    return xf86ScreenToScrn(screen)->driverPrivate;
}

Bool bp_screen_init(ScreenPtr screen, int argc, char **argv);
Bool bp_randr_init(ScreenPtr screen);
Bool bp_present_init(ScreenPtr screen);
Bool bp_dri3_init(ScreenPtr screen);
Bool bp_replace_root(ScreenPtr screen, unsigned width, unsigned height);
void bp_present_close(ScreenPtr screen);
uint64_t bp_now(void);
#endif

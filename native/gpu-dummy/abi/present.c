/* SPDX-License-Identifier: AGPL-3.0-only */
#include "bpane.h"
#include <present.h>
#include <time.h>

uint64_t bp_now(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) FatalError("BPANE_MONOTONIC_CLOCK_FAILED\n");
    return (uint64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}
static RRCrtcPtr bp_get_crtc(WindowPtr window) { return bp_screen(window->drawable.pScreen)->crtc; }
static int bp_get_time(RRCrtcPtr crtc, uint64_t *ust, uint64_t *msc) {
    BpScreen *state = crtc->devPrivate;
    *ust = bp_clock_sample(state->clock, bp_now(), msc);
    return Success;
}
static CARD32 bp_timer(OsTimerPtr timer, CARD32 now, void *data) {
    (void)timer; (void)now;
    BpScreen *state = data;
    uint64_t sample = bp_now(), event[3];
    /* Deliver only events present in this snapshot. Reentrant notification may
     * queue more work; it must yield to Xorg instead of spinning indefinitely. */
    for (unsigned count = 0; count < 256 && bp_clock_pop(state->clock, sample, event); count++)
        present_event_notify(event[0], event[1], event[2]);
    return bp_clock_delay(state->clock, bp_now());
}
static Bool bp_queue(RRCrtcPtr crtc, uint64_t id, uint64_t target) {
    BpScreen *state = crtc->devPrivate;
    /* Despite the Bool typedef, Xorg compares this callback with Success (0). */
    if (!bp_clock_queue(state->clock, id, target)) return BadAlloc;
    state->timer = TimerSet(state->timer, 0, bp_clock_delay(state->clock, bp_now()), bp_timer, state);
    if (!state->timer) { bp_clock_abort(state->clock, id); return BadAlloc; }
    return Success;
}
static void bp_abort(RRCrtcPtr crtc, uint64_t id, uint64_t target) {
    (void)target;
    BpScreen *state = crtc->devPrivate;
    bp_clock_abort(state->clock, id);
    if (state->timer && !bp_clock_delay(state->clock, bp_now())) TimerCancel(state->timer);
}
static void bp_flush(WindowPtr window) {
    if (!BPANE_TEST_SOFTWARE) glamor_block_handler(window->drawable.pScreen);
}
Bool bp_present_init(ScreenPtr screen) {
    static present_screen_info_rec callbacks = {
        .version = PRESENT_SCREEN_INFO_VERSION,
        .get_crtc = bp_get_crtc, .get_ust_msc = bp_get_time,
        .queue_vblank = bp_queue, .abort_vblank = bp_abort, .flush = bp_flush,
        /* Deliberately copy-present. No fictitious scanout/pageflip or fence. */
        .capabilities = 0,
    };
    return present_screen_init(screen, &callbacks);
}
void bp_present_close(ScreenPtr screen) {
    BpScreen *state = bp_screen(screen);
    if (state->timer) { TimerFree(state->timer); state->timer = NULL; }
}

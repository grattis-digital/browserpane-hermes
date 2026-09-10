/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-client.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const uint32_t background = 0x123456;

static void paint(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                  uint32_t color, int x, int y, int width, int height) {
    xcb_change_gc(c, gc, XCB_GC_FOREGROUND, &color);
    xcb_rectangle_t rect = {x, y, width, height};
    xcb_poly_fill_rectangle(c, screen->root, gc, 1, &rect);
}

static void malformed(xcb_connection_t *c, LeaseFrame *frame) {
    lease_request(c, BP_QUERY, NULL, 4, XCB_LENGTH);
    lease_request(c, BP_QUERY, NULL, 12, XCB_LENGTH);
    lease_request(c, BP_QUERY, NULL, 20, XCB_LENGTH);
    lease_request(c, 255, NULL, 16, XCB_REQUEST);
    lease_request(c, BP_QUERY, &frame->wire, 16, XCB_VALUE);
    BpLeaseReply token = frame->wire;
    token.lease++;
    lease_request(c, BP_RELEASE, &token, 16, XCB_VALUE);
    token = frame->wire; token.generation++;
    lease_request(c, BP_RELEASE, &token, 16, XCB_VALUE);
    token = frame->wire; token.slot = 3;
    lease_request(c, BP_RELEASE, &token, 16, XCB_VALUE);
    xcb_connection_t *other = lease_connect();
    free(lease_request(other, BP_QUERY, NULL, 16, 0));
    lease_request(other, BP_ACQUIRE, NULL, 16, XCB_ACCESS);
    lease_request(other, BP_RELEASE, &frame->wire, 16, XCB_ACCESS);
    xcb_disconnect(other);
}

static void resize_held(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                        LeaseGpu *gpu, LeaseFrame *held, uint32_t patch) {
    Display *display = XOpenDisplay(NULL);
    assert(display);
    XRRSetScreenSize(display, DefaultRootWindow(display), 1365, 767, 361, 203);
    XSync(display, False);
    paint(c, screen, gc, background, 0, 0, 1365, 767);
    LeaseFrame fresh = lease_acquire(c, BP_OK);
    assert(fresh.wire.width == 1365 && fresh.wire.height == 767);
    assert(fresh.wire.generation > held->wire.generation && fresh.wire.copied_pixels == 1365 * 767);
    lease_import(gpu, &fresh);
    lease_pixels(held, background, patch); // Old generation must remain immutable.
    lease_pixels(&fresh, background, background);
    lease_destroy(gpu, held); lease_release(c, held);
    lease_destroy(gpu, &fresh); lease_release(c, &fresh);
    XCloseDisplay(display);
}

int main(void) {
    xcb_connection_t *c = lease_connect();
    xcb_screen_t *screen = xcb_setup_roots_iterator(xcb_get_setup(c)).data;
    assert(screen && screen->width_in_pixels == 1280 && screen->height_in_pixels == 720);
    free(lease_request(c, BP_QUERY, NULL, 16, 0));
    xcb_gcontext_t gc = xcb_generate_id(c);
    xcb_create_gc(c, gc, screen->root, 0, NULL);
    LeaseGpu gpu = lease_gpu();
    paint(c, screen, gc, background, 0, 0, 1280, 720);
    LeaseFrame first = lease_acquire(c, BP_OK);
    assert(first.wire.copied_pixels == 1280 * 720);
    lease_import(&gpu, &first); lease_pixels(&first, background, background);
    malformed(c, &first);
    paint(c, screen, gc, 0xabcdef, 4, 8, 24, 24);
    LeaseFrame second = lease_acquire(c, BP_OK);
    assert(second.wire.copied_pixels == 1280 * 720 && second.wire.generation == first.wire.generation);
    lease_import(&gpu, &second);
    lease_pixels(&first, background, background); lease_pixels(&second, background, 0xabcdef);
    double cold[3]; lease_diff(&second, &first, 1, cold);
    LeaseFrame video = lease_acquire(c, BP_OK);
    assert(video.wire.slot == 2);
    lease_import(&gpu, &video); lease_pixels(&video, background, 0xabcdef);
    lease_acquire(c, BP_BUSY);
    lease_destroy(&gpu, &video); lease_release(c, &video);
    lease_destroy(&gpu, &first); lease_release(c, &first);
    lease_request(c, BP_RELEASE, &first.wire, 16, XCB_VALUE);
    LeaseFrame same = lease_acquire(c, BP_OK);
    assert(same.wire.copied_pixels == 4096);
    lease_import(&gpu, &same);
    double idle[3]; lease_diff(&same, &second, 0, idle);
    lease_pixels(&same, background, 0xabcdef);
    lease_destroy(&gpu, &second); lease_release(c, &second);
    /* Keep one immutable previous frame. Alternate slots and rapidly reverse
     * content; compare exact GPU pixels, not input-derived scroll guesses. */
    printf("{\"width\":1280,\"height\":720,\"metadataBytes\":64,\"coldCompareMs\":%.6f,\"samples\":[", cold[2]);
    uint32_t patch = 0;
    for (unsigned i = 0; i < 20; i++) {
        patch = i % 2 ? 0xabcdef : 0xfedcba;
        double begin = lease_now();
        paint(c, screen, gc, patch, 4, 8, 24, 24);
        LeaseFrame fresh = lease_acquire(c, BP_OK);
        double acquired = lease_now();
        assert(fresh.wire.copied_pixels == 4096 && fresh.wire.generation == same.wire.generation);
        lease_import(&gpu, &fresh);
        double imported = lease_now(), timings[3];
        lease_diff(&fresh, &same, 1, timings);
        /* Full CPU oracle intentionally outside measured comparison/handoff. */
        lease_pixels(&fresh, background, patch);
        if (i >= 4) printf("%s{\"acquireMs\":%.6f,\"importMs\":%.6f,\"dispatchMs\":%.6f,\"metadataWaitMs\":%.6f,\"compareMs\":%.6f,\"gpuCopyPixels\":4096}",
            i == 4 ? "" : ",", acquired - begin, imported - acquired, timings[0], timings[1], timings[2]);
        lease_destroy(&gpu, &same); lease_release(c, &same);
        same = fresh;
    }
    lease_destroy(&gpu, &same); lease_release(c, &same);
    lease_scroll_checks(c, screen, gc, &gpu);
    paint(c, screen, gc, background, 0, 0, 1280, 720);
    paint(c, screen, gc, patch, 4, 8, 24, 24);
    same = lease_acquire(c, BP_OK);
    lease_import(&gpu, &same); lease_pixels(&same, background, patch);
    resize_held(c, screen, gc, &gpu, &same, patch);
    /* Disconnect with an outstanding export; next owner gets a fresh pool. */
    LeaseFrame abandoned = lease_acquire(c, BP_OK);
    lease_import(&gpu, &abandoned); lease_pixels(&abandoned, background, background);
    xcb_disconnect(c);
    c = lease_connect();
    LeaseFrame recovered = lease_acquire(c, BP_OK);
    assert(recovered.wire.copied_pixels == 1365 * 767);
    lease_import(&gpu, &recovered); lease_pixels(&recovered, background, background);
    lease_pixels(&abandoned, background, background);
    lease_destroy(&gpu, &abandoned);
    lease_destroy(&gpu, &recovered); lease_release(c, &recovered);
    xcb_disconnect(c); lease_gpu_close(&gpu);
    puts("],\"pixelErrors\":0,\"negativeRequests\":\"passed\",\"backpressure\":\"passed\",\"immutableLease\":\"passed\",\"resize\":\"passed\",\"disconnect\":\"passed\",\"scrollFrames\":12,\"scrollConsistency\":\"passed\"}");
    return 0;
}

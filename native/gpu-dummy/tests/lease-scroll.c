/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-client.h"
#include <stdio.h>
#include <stdlib.h>

static uint32_t row_color(unsigned row) {
    return ((row * 17 % 255) << 16) | ((row * 31 % 255) << 8) | (row * 7 % 255);
}

static void exposed(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                    unsigned offset, int top, int bottom) {
    for (int y = top; y < bottom; y++) {
        uint32_t color = row_color(offset + y);
        xcb_change_gc(c, gc, XCB_GC_FOREGROUND, &color);
        xcb_rectangle_t rect = {0, y, 1280, 1};
        xcb_poly_fill_rectangle(c, screen->root, gc, 1, &rect);
    }
}

static void scroll(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                   unsigned *offset, int delta) {
    assert(delta > -720 && delta < 720 && (int)*offset + delta >= 0);
    if (!delta) return;
    int source = delta > 0 ? delta : 0, destination = delta < 0 ? -delta : 0;
    xcb_copy_area(c, screen->root, screen->root, gc, 0, source, 0, destination, 1280, 720 - abs(delta));
    *offset += delta;
    exposed(c, screen, gc, *offset, delta > 0 ? 720 - delta : 0, delta > 0 ? 720 : -delta);
}

static void oracle(LeaseFrame *frame, unsigned offset) {
    assert(frame->wire.width == 1280 && frame->wire.height == 720);
    uint8_t *pixels = malloc(1280 * 720 * 4);
    assert(pixels);
    glBindFramebuffer(GL_FRAMEBUFFER, frame->framebuffer);
    glReadPixels(0, 0, 1280, 720, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    assert(glGetError() == GL_NO_ERROR);
    for (unsigned y = 0; y < 720; y++) for (unsigned x = 0; x < 1280; x++) {
        uint8_t *p = pixels + (y * 1280 + x) * 4;
        uint32_t actual = (p[0] << 16) | (p[1] << 8) | p[2];
        if (actual != row_color(offset + y)) {
            fprintf(stderr, "scroll lease pixel mismatch at %u,%u offset=%u\n", x, y, offset);
            abort();
        }
    }
    free(pixels);
}

void lease_scroll_checks(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc, LeaseGpu *gpu) {
    const int deltas[] = {1, 7, 32, -17, -64, 64, 3, -3, 127, -126, 0, 13};
    unsigned offset = 1024;
    exposed(c, screen, gc, offset, 0, 720);
    LeaseFrame previous = lease_acquire(c, BP_OK);
    lease_import(gpu, &previous); oracle(&previous, offset);
    for (unsigned tick = 0; tick < sizeof(deltas) / sizeof(deltas[0]); tick++) {
        unsigned old_offset = offset;
        scroll(c, screen, gc, &offset, deltas[tick]);
        if (tick % 3 == 0) {
            /* Coalesced input frames: no capture between forward and reverse. */
            scroll(c, screen, gc, &offset, 9);
            scroll(c, screen, gc, &offset, -5);
        }
        LeaseFrame current = lease_acquire(c, BP_OK);
        assert(current.wire.generation == previous.wire.generation && current.wire.lease > previous.wire.lease);
        lease_import(gpu, &current);
        double timings[3];
        lease_diff(&current, &previous, offset == old_offset ? 0 : 240, timings);
        oracle(&current, offset);
        oracle(&previous, old_offset); // Source still belongs to the preceding frame.
        lease_destroy(gpu, &previous); lease_release(c, &previous);
        previous = current;
    }
    lease_destroy(gpu, &previous); lease_release(c, &previous);
}

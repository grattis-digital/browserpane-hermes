/* SPDX-License-Identifier: AGPL-3.0-only */
#include "compare-kernel.h"
#include <stdio.h>
#include <stdlib.h>

static void paint(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                  uint32_t color, unsigned x, unsigned y, unsigned width, unsigned height) {
    xcb_change_gc(c, gc, XCB_GC_FOREGROUND, &color);
    xcb_rectangle_t rect = {x, y, width, height};
    xcb_poly_fill_rectangle(c, screen->root, gc, 1, &rect);
}

void compare_fixture(LeaseGpu *gpu, xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                     unsigned width, unsigned height, unsigned scenario, LeaseFrame frames[2]) {
    paint(c, screen, gc, 0x123456, 0, 0, width, height);
    frames[0] = lease_acquire(c, BP_OK);
    lease_import(gpu, &frames[0]);
    if (scenario == 1) paint(c, screen, gc, 0xabcdef, 4, 8, 24, 24);
    if (scenario == 2) paint(c, screen, gc, 0xfedcba, 0, 0, width, height);
    if (scenario == 3) paint(c, screen, gc, 0xabcdef, width - 1, height - 1, 1, 1);
    frames[1] = lease_acquire(c, BP_OK);
    lease_import(gpu, &frames[1]);
    assert(frames[1].wire.width == width && frames[1].wire.height == height);
    assert(frames[1].wire.generation == frames[0].wire.generation);
}

void compare_oracle(LeaseFrame *frame, unsigned scenario) {
    unsigned width = frame->wire.width, height = frame->wire.height;
    uint8_t *pixels = malloc(width * height * 4);
    assert(pixels);
    glBindFramebuffer(GL_FRAMEBUFFER, frame->framebuffer);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    assert(glGetError() == GL_NO_ERROR);
    for (unsigned y = 0; y < height; y++) for (unsigned x = 0; x < width; x++) {
        uint32_t color = scenario == 2 ? 0xfedcba : 0x123456;
        if (scenario == 1 && x >= 4 && x < 28 && y >= 8 && y < 32) color = 0xabcdef;
        if (scenario == 3 && x == width - 1 && y == height - 1) color = 0xabcdef;
        uint8_t *p = pixels + (y * width + x) * 4;
        uint32_t actual = (p[0] << 16) | (p[1] << 8) | p[2];
        if (actual != color) { fprintf(stderr, "Comparison frame pixel mismatch %u,%u\n", x, y); abort(); }
    }
    free(pixels);
}

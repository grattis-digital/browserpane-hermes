/* SPDX-License-Identifier: AGPL-3.0-only */
#include "compare-kernel.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <stdio.h>

static double drain(void) {
    /* Intrusive diagnostic boundary only: remove producer/import queue debt
     * before benchmarking repeated reads of the same immutable frame pair. */
    double start = lease_now();
    GLsync fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    assert(fence);
    GLenum result = glClientWaitSync(fence, GL_SYNC_FLUSH_COMMANDS_BIT, UINT64_C(2000000000));
    assert(result == GL_ALREADY_SIGNALED || result == GL_CONDITION_SATISFIED);
    glDeleteSync(fence);
    return lease_now() - start;
}

static void benchmark(CompareKernel kernels[COMPARE_VARIANTS], LeaseFrame frames[2], unsigned scenario) {
    unsigned tiles = ((frames[1].wire.width + 63) / 64) * ((frames[1].wire.height + 63) / 64);
    uint32_t expected[16] = {0};
    if (scenario == 1) expected[0] = 1;
    if (scenario == 2) for (unsigned tile = 0; tile < tiles; tile++) expected[tile / 32] |= 1u << (tile % 32);
    if (scenario == 3) expected[(tiles - 1) / 32] = 1u << ((tiles - 1) % 32);
    double queue = drain();
    printf("{\"width\":%u,\"height\":%u,\"scenario\":%u,\"producerDrainMs\":%.6f,\"samples\":[",
           frames[1].wire.width, frames[1].wire.height, scenario, queue);
    for (unsigned round = 0; round < 13; round++) for (unsigned step = 0; step < COMPARE_VARIANTS; step++) {
        unsigned index = ((round % 2 ? COMPARE_VARIANTS - 1 - step : step) + round + scenario) % COMPARE_VARIANTS;
        CompareKernel *kernel = &kernels[index];
        CompareTimes result = compare_run(kernel, &frames[1], &frames[0], expected);
        if (round >= 3) printf("%s{\"variant\":\"%s\",\"round\":%u,\"setupMs\":%.6f,\"submitMs\":%.6f,\"waitMs\":%.6f,\"totalMs\":%.6f}",
            round == 3 && step == 0 ? "" : ",", kernel->name, round - 3, result.setup, result.submit, result.wait, result.total);
    }
    printf("],\"maskErrors\":0}");
}

int main(void) {
    LeaseGpu gpu = lease_gpu();
    CompareKernel kernels[COMPARE_VARIANTS]; compare_init(kernels);
    xcb_connection_t *c = lease_connect();
    xcb_screen_t *screen = xcb_setup_roots_iterator(xcb_get_setup(c)).data;
    assert(screen && screen->width_in_pixels == 1280 && screen->height_in_pixels == 720);
    xcb_gcontext_t gc = xcb_generate_id(c); xcb_create_gc(c, gc, screen->root, 0, NULL);
    printf("{\"schema\":1,\"mode\":\"immutable-pair-comparison\",\"metadataBytes\":64,\"warmup\":3,\"rounds\":10,\"cases\":[");
    unsigned dimensions[][2] = {{1280, 720}, {1365, 767}};
    for (unsigned size = 0; size < 2; size++) {
        unsigned width = dimensions[size][0], height = dimensions[size][1];
        if (size) {
            Display *display = XOpenDisplay(NULL); assert(display);
            XRRSetScreenSize(display, DefaultRootWindow(display), width, height, width * 254 / 960, height * 254 / 960);
            XSync(display, False); XCloseDisplay(display);
        }
        for (unsigned scenario = 0; scenario < 4; scenario++) {
            LeaseFrame frames[2];
            compare_fixture(&gpu, c, screen, gc, width, height, scenario, frames);
            if (size || scenario) printf(",");
            benchmark(kernels, frames, scenario);
            /* CPU oracles are after the entire case, never between variants. */
            compare_oracle(&frames[0], 0); compare_oracle(&frames[1], scenario);
            for (unsigned i = 0; i < 2; i++) { lease_destroy(&gpu, &frames[i]); lease_release(c, &frames[i]); }
        }
    }
    puts("],\"pixelErrors\":0}");
    xcb_disconnect(c); compare_close(kernels); lease_gpu_close(&gpu);
    return 0;
}

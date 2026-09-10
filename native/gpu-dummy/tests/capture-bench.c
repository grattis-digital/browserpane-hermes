/* SPDX-License-Identifier: AGPL-3.0-only
 * Synthetic EGL draw -> Present -> full-frame MIT-SHM readback, NOT viewer FPS.
 */
#define _POSIX_C_SOURCE 200809L
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/shm.h>
#include <time.h>

static double milliseconds(void) {
    struct timespec now;
    assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
    return (double)now.tv_sec * 1000 + (double)now.tv_nsec / 1000000;
}
static uint32_t expected(unsigned frame, unsigned band) {
    return (((frame * 13) % 251 + 1) << 16) | ((band * 31) << 8) | (frame % 2 ? 0x55 : 0xaa);
}
static void draw(unsigned frame) {
    glEnable(GL_SCISSOR_TEST);
    for (unsigned band = 0; band < 8; band++) {
        uint32_t color = expected(frame, band);
        glScissor(0, band * 90, 1280, 90);
        glClearColor(((color >> 16) & 255) / 255.0f, ((color >> 8) & 255) / 255.0f, (color & 255) / 255.0f, 1);
        glClear(GL_COLOR_BUFFER_BIT);
    }
    glDisable(GL_SCISSOR_TEST);
    glFinish();
    assert(glGetError() == GL_NO_ERROR);
}
static void verify(XImage *image, unsigned frame) {
    assert(image->bits_per_pixel == 32 && image->byte_order == LSBFirst);
    for (unsigned y = 0; y < 720; y++) {
        const uint32_t *row = (const uint32_t *)(image->data + y * image->bytes_per_line);
        uint32_t color = expected(frame, (719 - y) / 90);
        for (unsigned x = 0; x < 1280; x++) assert((row[x] & 0xffffff) == color);
    }
}

void bp_capture_bench(Display *display, Window window, EGLDisplay egl, EGLSurface surface) {
    XWindowAttributes attributes;
    assert(XGetWindowAttributes(display, window, &attributes) && attributes.width == 1280 && attributes.height == 720);
    XShmSegmentInfo shm = {0};
    assert(XShmQueryExtension(display));
    XImage *image = XShmCreateImage(display, attributes.visual, attributes.depth, ZPixmap, NULL, &shm, 1280, 720);
    assert(image);
    shm.shmid = shmget(IPC_PRIVATE, image->bytes_per_line * 720, IPC_CREAT | 0600);
    assert(shm.shmid >= 0);
    shm.shmaddr = shmat(shm.shmid, NULL, 0);
    assert(shm.shmaddr != (void *)-1);
    image->data = shm.shmaddr;
    assert(XShmAttach(display, &shm)); XSync(display, False);
    assert(shmctl(shm.shmid, IPC_RMID, NULL) == 0);
    /* Use a fixed interval to measure work without an idle display-clock wait. */
    assert(eglSwapInterval(egl, 0));
    printf("{\"width\":1280,\"height\":720,\"warmup\":10,\"swapInterval\":0,\"samples\":[");
    for (unsigned frame = 0; frame < 70; frame++) {
        double start = milliseconds();
        draw(frame);
        double rendered = milliseconds();
        assert(eglSwapBuffers(egl, surface));
        XSync(display, False);
        unsigned reads = 0;
        double read_ms = 0;
        do {
            assert(milliseconds() - rendered < 1500); // Finite hang guard; no success by timeout.
            double before_read = milliseconds();
            assert(XShmGetImage(display, window, image, 0, 0, AllPlanes));
            read_ms += milliseconds() - before_read;
            reads++;
            if ((XGetPixel(image, 0, 0) & 0xffffff) == expected(frame, 7)) break;
            struct timespec interval = {.tv_nsec = 1000000};
            nanosleep(&interval, NULL);
        } while (1);
        double captured = milliseconds();
        verify(image, frame); // Full-frame oracle outside the measured boundary.
        if (frame >= 10) printf("%s{\"drawMs\":%.4f,\"swapCaptureMs\":%.4f,\"readMs\":%.4f,\"reads\":%u}",
            frame == 10 ? "" : ",", rendered - start, captured - rendered, read_ms, reads);
    }
    puts("],\"pixelErrors\":0,\"scope\":\"synthetic GPU draw to full SHM frame; no Chromium, encoding or viewer\"}");
    XShmDetach(display, &shm); XSync(display, False); shmdt(shm.shmaddr);
    image->data = NULL; XDestroyImage(image);
}

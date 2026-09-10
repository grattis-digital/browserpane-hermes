/* SPDX-License-Identifier: AGPL-3.0-only
 * Finite producer-metadata oracle. Pixel reads verify results AFTER collecting
 * damage; they never choose the submitted rectangles. Not a speed benchmark.
 */
#define _POSIX_C_SOURCE 200809L
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xdamage.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

enum { WIDTH = 1280, HEIGHT = 720, LEFT = 32, TOP = 96, SIDE = 24 };

static void pause_ms(long ms) {
    struct timespec interval = {.tv_sec = 0, .tv_nsec = ms * 1000000};
    nanosleep(&interval, NULL);
}

static void draw(unsigned marker) {
    glDisable(GL_SCISSOR_TEST);
    glClearColor(0, 0, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glEnable(GL_SCISSOR_TEST);
    glScissor(LEFT, HEIGHT - TOP - SIDE, SIDE, SIDE);
    glClearColor(marker, !marker, 0, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDisable(GL_SCISSOR_TEST);
    assert(glGetError() == GL_NO_ERROR);
}

static int pixels_match(Display *display, Window window, unsigned marker) {
    XImage *image = XGetImage(display, window, 0, 0, WIDTH, HEIGHT, AllPlanes, ZPixmap);
    assert(image);
    int valid = 1;
    for (int y = 0; y < HEIGHT; y++)
        for (int x = 0; x < WIDTH; x++) {
            unsigned long expected = x >= LEFT && x < LEFT + SIDE && y >= TOP && y < TOP + SIDE
                ? (marker ? 0xff0000 : 0x00ff00) : 0;
            if ((XGetPixel(image, x, y) & 0xffffff) != expected) {
                if (valid) fprintf(stderr, "damage_pixel_mismatch x=%d y=%d actual=%06lx expected=%06lx\n",
                                   x, y, XGetPixel(image, x, y) & 0xffffff, expected);
                valid = 0;
            }
        }
    XDestroyImage(image);
    return valid;
}

static void discard(Display *display, Damage damage) {
    XDamageSubtract(display, damage, None, None);
    XSync(display, False);
    unsigned count = 0;
    while (XPending(display)) {
        XEvent event;
        XNextEvent(display, &event);
        assert(++count <= 4096);
    }
}

void bp_damage_probe(Display *display, Window window, EGLDisplay egl, EGLSurface surface) {
    const char *extensions = eglQueryString(egl, EGL_EXTENSIONS);
    assert(extensions && strstr(extensions, "EGL_KHR_swap_buffers_with_damage"));
    /* No VNC viewer drives the idle server's MSC clock in this network-free
     * fixture. Do not schedule swaps on an unrelated future display tick. */
    assert(eglSwapInterval(egl, 0));
    int event_base, error_base;
    assert(XDamageQueryExtension(display, &event_base, &error_base));
    Damage damage = XDamageCreate(display, DefaultRootWindow(display), XDamageReportRawRectangles);
    assert(damage);
    /* Seed a complete, valid surface. A damaged swap still requires a fully
     * valid back buffer; do not confuse surface damage with buffer repair. */
    draw(0);
    assert(eglSwapBuffers(egl, surface));
    assert(eglWaitClient() && eglWaitNative(EGL_CORE_NATIVE_ENGINE));
    pause_ms(200);
    assert(pixels_match(display, window, 0));
    discard(display, damage);
    printf("{\"width\":%d,\"height\":%d,\"swapInterval\":0,\"submitted\":[%d,%d,%d,%d],\"renderer\":\"%s\",\"samples\":[",
           WIDTH, HEIGHT, LEFT, TOP, SIDE, SIDE, glGetString(GL_RENDERER));
    for (unsigned frame = 0; frame < 6; frame++) {
        unsigned marker = (frame + 1) % 2;
        draw(marker); /* Complete buffer, identical pixels outside the marker. */
        EGLint rect[] = {LEFT, HEIGHT - TOP - SIDE, SIDE, SIDE};
        assert(frame < 3 ? eglSwapBuffers(egl, surface) : eglSwapBuffersWithDamageKHR(egl, surface, rect, 1));
        assert(eglWaitClient() && eglWaitNative(EGL_CORE_NATIVE_ENGINE));
        int left = WIDTH, top = HEIGHT, right = 0, bottom = 0;
        unsigned rectangles = 0, events = 0;
        /* Present may be asynchronous. This bounded collection is deliberately
         * slower than a frame and precedes every pixel verification read. */
        for (unsigned attempt = 0; attempt < 20; attempt++) {
            pause_ms(10);
            XSync(display, False);
            while (XPending(display)) {
                XEvent event;
                XNextEvent(display, &event);
                assert(++events <= 4096);
                if (event.type != event_base + XDamageNotify) continue;
                const XDamageNotifyEvent *notify = (const XDamageNotifyEvent *)&event;
                assert(notify->damage == damage);
                XRectangle area = notify->area;
                if (!area.width || !area.height) continue;
                if (area.x < left) left = area.x;
                if (area.y < top) top = area.y;
                if (area.x + area.width > right) right = area.x + area.width;
                if (area.y + area.height > bottom) bottom = area.y + area.height;
                rectangles++;
            }
        }
        assert(rectangles && left <= LEFT && top <= TOP && right >= LEFT + SIDE && bottom >= TOP + SIDE);
        assert(left >= 0 && top >= 0 && right <= WIDTH && bottom <= HEIGHT);
        assert(pixels_match(display, window, marker));
        printf("%s{\"mode\":\"%s\",\"rectangles\":%u,\"observedBounds\":[%d,%d,%d,%d],\"pixelErrors\":0}",
               frame ? "," : "", frame < 3 ? "swap" : "swapWithDamage", rectangles,
               left, top, right - left, bottom - top);
        discard(display, damage);
    }
    puts("]}");
    XDamageDestroy(display, damage);
}

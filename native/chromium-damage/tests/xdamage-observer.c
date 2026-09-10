/* SPDX-License-Identifier: BSD-3-Clause
 * Disposable diagnostic only: observes XDamage metadata, never pixel buffers.
 */
#define _POSIX_C_SOURCE 200809L
#include <X11/Xlib.h>
#include <X11/extensions/Xdamage.h>
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static double milliseconds(void) {
    struct timespec t;
    assert(clock_gettime(CLOCK_MONOTONIC, &t) == 0);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}

int main(int argc, char **argv) {
    const char *token = getenv("BPANE_RENDER_PILOT");
    const char *test = getenv("BPANE_PIPELINE_TEST");
    const char *name = getenv("DISPLAY");
    assert(argc == 2 && token && strlen(token) == 36 && strcmp(argv[1], token) == 0);
    assert(test && strcmp(test, "1") == 0 && name && strcmp(name, ":99") == 0);
    Display *display = XOpenDisplay(name);
    assert(display);
    int event_base, error_base;
    assert(XDamageQueryExtension(display, &event_base, &error_base));
    Window root = DefaultRootWindow(display);
    XWindowAttributes geometry;
    assert(XGetWindowAttributes(display, root, &geometry));
    assert(geometry.width == 1280 && geometry.height == 720);
    Damage damage = XDamageCreate(display, root, XDamageReportRawRectangles);
    assert(damage);
    XDamageSubtract(display, damage, None, None);
    XSync(display, False);
    unsigned discarded = 0;
    while (XPending(display)) {
        XEvent event;
        XNextEvent(display, &event);
        assert(++discarded <= 4096);
    }
    puts("{\"ready\":true,\"width\":1280,\"height\":720}");
    fflush(stdout);
    double started = milliseconds();
    unsigned events = 0, rectangles = 0;
    int stopped = 0;
    while (!stopped) {
        assert(milliseconds() - started < 12000.0);
        struct pollfd fds[] = {{ConnectionNumber(display), POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
        assert(poll(fds, 2, 100) >= 0);
        assert(!(fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)));
        if (fds[1].revents & (POLLIN | POLLHUP)) stopped = 1;
        while (XPending(display)) {
            XEvent event;
            XNextEvent(display, &event);
            assert(++events <= 4096);
            if (event.type != event_base + XDamageNotify) continue;
            const XDamageNotifyEvent *notify = (const XDamageNotifyEvent *)&event;
            assert(notify->damage == damage);
            XRectangle area = notify->area;
            if (!area.width || !area.height) continue;
            assert(area.x >= 0 && area.y >= 0 && area.x + area.width <= 1280 && area.y + area.height <= 720);
            printf("{\"ms\":%.3f,\"x\":%d,\"y\":%d,\"width\":%u,\"height\":%u}\n",
                   milliseconds() - started, area.x, area.y, area.width, area.height);
            assert(++rectangles <= 1024);
        }
        fflush(stdout);
    }
    printf("{\"done\":true,\"rectangles\":%u}\n", rectangles);
    XDamageDestroy(display, damage);
    XCloseDisplay(display);
    return 0;
}

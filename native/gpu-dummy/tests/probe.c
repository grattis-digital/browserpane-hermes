/* SPDX-License-Identifier: AGPL-3.0-only
 * Real X11 protocol/pixel oracle. Software fixture is not a GPU performance test.
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/Xrandr.h>
#include <X11/extensions/XShm.h>
#include <X11/extensions/Xpresent.h>
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/shm.h>
#include <time.h>

static void pixels(Display *dpy, Window root, unsigned width, unsigned height, unsigned long color) {
    XImage *image = XGetImage(dpy, root, 0, 0, width, height, AllPlanes, ZPixmap);
    assert(image);
    for (unsigned y = 0; y < height; y++)
        for (unsigned x = 0; x < width; x++) {
            unsigned long actual = XGetPixel(image, x, y) & 0xffffff;
            if (actual != color) {
                fprintf(stderr, "GetImage %ux%u (%u,%u): got %06lx expected %06lx\n", width, height, x, y, actual, color);
                abort();
            }
        }
    XDestroyImage(image);
    XShmSegmentInfo shm = {0};
    assert(XShmQueryExtension(dpy));
    image = XShmCreateImage(dpy, DefaultVisual(dpy, 0), 24, ZPixmap, NULL, &shm, width, height);
    assert(image);
    shm.shmid = shmget(IPC_PRIVATE, image->bytes_per_line * height, IPC_CREAT | 0600);
    assert(shm.shmid >= 0);
    shm.shmaddr = shmat(shm.shmid, NULL, 0);
    assert(shm.shmaddr != (void *)-1);
    image->data = shm.shmaddr;
    assert(XShmAttach(dpy, &shm));
    XSync(dpy, False);
    assert(shmctl(shm.shmid, IPC_RMID, NULL) == 0);
    assert(XShmGetImage(dpy, root, image, 0, 0, AllPlanes));
    for (unsigned y = 0; y < height; y++)
        for (unsigned x = 0; x < width; x++) assert((XGetPixel(image, x, y) & 0xffffff) == color);
    XShmDetach(dpy, &shm);
    XSync(dpy, False);
    shmdt(shm.shmaddr);
    image->data = NULL;
    XDestroyImage(image);
}

static void resize(Display *dpy, Window root, unsigned width, unsigned height) {
    XRRScreenResources *resources = XRRGetScreenResourcesCurrent(dpy, root);
    assert(resources && resources->ncrtc == 1 && resources->noutput == 1);
    RRCrtc crtc = resources->crtcs[0]; RROutput output = resources->outputs[0];
    XRROutputInfo *info = XRRGetOutputInfo(dpy, resources, output);
    assert(info && !strcmp(info->name, "DUMMY0"));
    XRRFreeOutputInfo(info);
    assert(XRRSetCrtcConfig(dpy, resources, crtc, CurrentTime, 0, 0, None, RR_Rotate_0, NULL, 0) == Success);
    XRRSetScreenSize(dpy, root, width, height, width * 254 / 960, height * 254 / 960);
    XSync(dpy, False);
    char name[48];
    snprintf(name, sizeof(name), "probe-%ux%u", width, height);
    XRRModeInfo mode = {.width = width, .height = height, .name = name, .nameLength = strlen(name),
        .hSyncStart = width + 4, .hSyncEnd = width + 8, .hTotal = width + 16,
        .vSyncStart = height + 2, .vSyncEnd = height + 4, .vTotal = height + 8,
        .dotClock = (width + 16) * (height + 8) * 60};
    RRMode id = None;
    for (int i = 0; i < resources->nmode; i++)
        if (resources->modes[i].nameLength == strlen(name)
            && !memcmp(resources->modes[i].name, name, strlen(name))) id = resources->modes[i].id;
    if (!id) id = XRRCreateMode(dpy, root, &mode);
    assert(id);
    XRRAddOutputMode(dpy, output, id);
    XRRFreeScreenResources(resources);
    resources = XRRGetScreenResourcesCurrent(dpy, root);
    assert(XRRSetCrtcConfig(dpy, resources, crtc, CurrentTime, 0, 0, id, RR_Rotate_0, &output, 1) == Success);
    XRRFreeScreenResources(resources);
    XWindowAttributes attributes;
    assert(XGetWindowAttributes(dpy, root, &attributes));
    assert(attributes.width == (int)width && attributes.height == (int)height);
}

static XPresentCompleteNotifyEvent completion(Display *dpy, int opcode, unsigned serial) {
    for (unsigned attempt = 0; attempt < 100; attempt++) {
        if (!XPending(dpy)) {
            struct pollfd fd = {.fd = ConnectionNumber(dpy), .events = POLLIN};
            assert(poll(&fd, 1, 1000) > 0);
        }
        XEvent event;
        XNextEvent(dpy, &event);
        if (event.type != GenericEvent || event.xcookie.extension != opcode || !XGetEventData(dpy, &event.xcookie)) continue;
        if (event.xcookie.evtype == PresentCompleteNotify) {
            XPresentCompleteNotifyEvent result = *(XPresentCompleteNotifyEvent *)event.xcookie.data;
            XFreeEventData(dpy, &event.xcookie);
            if (result.serial_number == serial) return result;
        } else XFreeEventData(dpy, &event.xcookie);
    }
    abort();
}

static void present(Display *dpy, Window root) {
    int opcode, event, error;
    assert(XPresentQueryExtension(dpy, &opcode, &event, &error));
    Window window = XCreateSimpleWindow(dpy, root, 0, 0, 64, 64, 0, 0, 0);
    XMapWindow(dpy, window);
    XID subscription = XPresentSelectInput(dpy, window, PresentCompleteNotifyMask);
    XPresentNotifyMSC(dpy, window, 1, 0, 0, 0);
    XFlush(dpy);
    XPresentCompleteNotifyEvent first = completion(dpy, opcode, 1);
    XPresentNotifyMSC(dpy, window, 2, first.msc + 3, 0, 0);
    XFlush(dpy);
    XPresentCompleteNotifyEvent next = completion(dpy, opcode, 2);
    assert(next.msc >= first.msc + 3 && next.ust > first.ust);
    assert(next.ust - first.ust < 500000); // Broad hang guard, not a latency benchmark.
    Pixmap pixmap = XCreatePixmap(dpy, root, 64, 64, 24);
    GC gc = XCreateGC(dpy, pixmap, 0, NULL);
    XSetForeground(dpy, gc, 0x00ff00);
    XFillRectangle(dpy, pixmap, gc, 0, 0, 64, 64);
    XPresentPixmap(dpy, window, pixmap, 3, None, None, 0, 0, None, None, None, 0, next.msc + 1, 0, 0, NULL, 0);
    XFlush(dpy);
    XPresentCompleteNotifyEvent frame = completion(dpy, opcode, 3);
    assert(frame.kind == PresentCompleteKindPixmap && frame.mode == PresentCompleteModeCopy);
    pixels(dpy, window, 64, 64, 0x00ff00);
    XPresentFreeInput(dpy, window, subscription);
    XFreeGC(dpy, gc); XFreePixmap(dpy, pixmap); XDestroyWindow(dpy, window);
    printf("present_delta_us=%llu copy_present=passed\n", (unsigned long long)(next.ust - first.ust));
}

static void scroll_pixels(Display *dpy, Window root) {
    Window window = XCreateSimpleWindow(dpy, root, 0, 0, 128, 128, 0, 0, 0);
    XMapWindow(dpy, window);
    GC gc = XCreateGC(dpy, window, 0, NULL);
    XSetGraphicsExposures(dpy, gc, False);
    for (unsigned band = 0; band < 16; band++) {
        XSetForeground(dpy, gc, 0x010101 * band);
        XFillRectangle(dpy, window, gc, 0, band * 8, 128, 8);
    }
    XCopyArea(dpy, window, window, gc, 0, 32, 128, 96, 0, 0);
    XSetForeground(dpy, gc, 0xaabbcc);
    XFillRectangle(dpy, window, gc, 0, 96, 128, 32);
    XImage *image = XGetImage(dpy, window, 0, 0, 128, 128, AllPlanes, ZPixmap);
    assert(image);
    for (unsigned y = 0; y < 128; y++)
        for (unsigned x = 0; x < 128; x++) {
            unsigned long expected = y < 96 ? 0x010101 * ((y + 32) / 8) : 0xaabbcc;
            assert((XGetPixel(image, x, y) & 0xffffff) == expected);
        }
    XDestroyImage(image); XFreeGC(dpy, gc); XDestroyWindow(dpy, window);
}

static int expected_error;
static int capture_error(Display *dpy, XErrorEvent *error) {
    (void)dpy;
    expected_error = error->error_code;
    return 0;
}
static void reject_size(Display *dpy, Window root, int width, int height) {
    XWindowAttributes before, after;
    assert(XGetWindowAttributes(dpy, root, &before));
    XErrorHandler previous = XSetErrorHandler(capture_error);
    expected_error = 0;
    XRRSetScreenSize(dpy, root, width, height, 300, 200);
    XSync(dpy, False);
    XSetErrorHandler(previous);
    assert(expected_error);
    assert(XGetWindowAttributes(dpy, root, &after));
    assert(before.width == after.width && before.height == after.height);
}

int main(void) {
    Display *dpy = XOpenDisplay(NULL);
    assert(dpy);
    Window root = DefaultRootWindow(dpy);
    GC gc = XCreateGC(dpy, root, 0, NULL);
    Window survivor = XCreateSimpleWindow(dpy, root, 32, 32, 64, 64, 0, 0, 0);
    XMapWindow(dpy, survivor);
    unsigned sizes[][2] = {{1280, 720}, {1365, 767}, {960, 640}, {1360, 768}, {1280, 720}};
    for (unsigned i = 0; i < sizeof(sizes) / sizeof(sizes[0]); i++) {
        unsigned w = sizes[i][0], h = sizes[i][1];
        fprintf(stderr, "checking resize %ux%u\n", w, h);
        resize(dpy, root, w, h);
        unsigned long color = i % 2 ? 0xff00ff : 0x00ff00;
        XSetForeground(dpy, gc, color);
        XFillRectangle(dpy, root, gc, 0, 0, w, h);
        XFillRectangle(dpy, survivor, gc, 0, 0, 64, 64);
        XSync(dpy, False);
        pixels(dpy, root, w, h, color);
        fprintf(stderr, "checking Present %ux%u\n", w, h);
        present(dpy, root);
        scroll_pixels(dpy, root);
    }
    reject_size(dpy, root, 8192, 8192);
    reject_size(dpy, root, 31, 720);
    XDestroyWindow(dpy, survivor);
    XFreeGC(dpy, gc); XCloseDisplay(dpy);
    puts("exact_geometry=passed getimage=passed mit_shm=passed present=passed");
    puts("live_window_resize=passed overlap_scroll=passed rejected_resize_unchanged=passed");
    return 0;
}

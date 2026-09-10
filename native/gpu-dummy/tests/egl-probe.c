/* SPDX-License-Identifier: AGPL-3.0-only
 * Hardware-only X11 EGL swap/readback oracle, not a Chromium or speed benchmark.
 */
#define _POSIX_C_SOURCE 200809L
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <dlfcn.h>

void bp_capture_bench(Display *display, Window window, EGLDisplay egl, EGLSurface surface);
void bp_damage_probe(Display *display, Window window, EGLDisplay egl, EGLSurface surface);

static int matches(Display *display, Window window, unsigned long expected) {
    XImage *image = XGetImage(display, window, 0, 0, 128, 128, AllPlanes, ZPixmap);
    assert(image);
    for (int y = 0; y < 128; y++)
        for (int x = 0; x < 128; x++) {
            if ((XGetPixel(image, x, y) & 0xffffff) != expected) {
                XDestroyImage(image);
                return 0;
            }
        }
    XDestroyImage(image);
    return 1;
}

static void verify(Display *display, Window window, unsigned long expected) {
    /* Swap can enqueue a future MSC. GetImage alone does not wait for it. */
    for (unsigned attempt = 0; attempt < 100; attempt++) {
        if (matches(display, window, expected)) return;
        struct timespec interval = {.tv_nsec = 5000000};
        nanosleep(&interval, NULL);
    }
    fprintf(stderr, "BPANE_EGL_PIXEL_DEADLINE\n");
    abort();
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--check-runtime")) {
        void *library = dlopen("libGLESv2.so.2", RTLD_NOW | RTLD_LOCAL);
        assert(library);
        assert(dlclose(library) == 0);
        puts("gles_runtime=available hardware=not_checked");
        return 0;
    }
    int benchmark = argc == 2 && !strcmp(argv[1], "--benchmark");
    int damage_test = argc == 2 && !strcmp(argv[1], "--damage-test");
    assert(argc == 1 || benchmark || damage_test);
    Display *display = XOpenDisplay(NULL);
    assert(display);
    int opcode, first_event, first_error;
    assert(XQueryExtension(display, "DRI3", &opcode, &first_event, &first_error));
    EGLDisplay egl = eglGetDisplay((EGLNativeDisplayType)display);
    assert(egl != EGL_NO_DISPLAY && eglInitialize(egl, NULL, NULL));
    assert(eglBindAPI(EGL_OPENGL_ES_API));
    EGLint attributes[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
    EGLConfig config;
    EGLint count, visual_id;
    assert(eglChooseConfig(egl, attributes, &config, 1, &count) && count == 1);
    assert(eglGetConfigAttrib(egl, config, EGL_NATIVE_VISUAL_ID, &visual_id));
    XVisualInfo match = {.visualid = visual_id};
    int visual_count;
    XVisualInfo *visual = XGetVisualInfo(display, VisualIDMask, &match, &visual_count);
    assert(visual && visual_count == 1);
    Window root = RootWindow(display, visual->screen);
    Colormap colormap = XCreateColormap(display, root, visual->visual, AllocNone);
    XSetWindowAttributes window_attributes = {.colormap = colormap, .border_pixel = 0};
    int width = benchmark || damage_test ? 1280 : 128, height = benchmark || damage_test ? 720 : 128;
    Window window = XCreateWindow(display, root, 0, 0, width, height, 0, visual->depth,
        InputOutput, visual->visual, CWColormap | CWBorderPixel, &window_attributes);
    XMapWindow(display, window);
    XSync(display, False);
    EGLint context_attributes[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext context = eglCreateContext(egl, config, EGL_NO_CONTEXT, context_attributes);
    EGLSurface surface = eglCreateWindowSurface(egl, config, (EGLNativeWindowType)window, NULL);
    assert(context != EGL_NO_CONTEXT && surface != EGL_NO_SURFACE);
    assert(eglMakeCurrent(egl, surface, surface, context));
    const char *renderer = (const char *)glGetString(GL_RENDERER);
    assert(renderer && strstr(renderer, "V3D") && !strstr(renderer, "llvmpipe"));
    assert(eglSwapInterval(egl, 1));
    glViewport(0, 0, width, height);
    if (benchmark) bp_capture_bench(display, window, egl, surface);
    if (damage_test) bp_damage_probe(display, window, egl, surface);
    for (unsigned frame = 0; !benchmark && !damage_test && frame < 12; frame++) {
        int magenta = frame % 2;
        glClearColor(magenta, !magenta, magenta, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        assert(glGetError() == GL_NO_ERROR);
        assert(eglSwapBuffers(egl, surface));
        /* This test intentionally waits. It verifies completed GPU pixels, not
         * a zero-copy pipeline or an asynchronous performance measurement. */
        assert(eglWaitClient());
        assert(eglWaitNative(EGL_CORE_NATIVE_ENGINE));
        XSync(display, False);
        verify(display, window, magenta ? 0xff00ff : 0x00ff00);
    }
    assert(eglMakeCurrent(egl, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    eglDestroySurface(egl, surface); eglDestroyContext(egl, context); eglTerminate(egl);
    XDestroyWindow(display, window); XFreeColormap(display, colormap); XFree(visual); XCloseDisplay(display);
    if (!benchmark && !damage_test) puts("v3d_x11_egl_swap_pixels=passed chromium_dma_buf_and_performance=not_qualified");
    return 0;
}

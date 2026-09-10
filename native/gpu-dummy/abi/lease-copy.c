/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease.h"
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <gbm.h>
#include <gcstruct.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>

static PixmapPtr snapshot(struct BpCapture *capture, unsigned index) {
    ScreenPtr screen = capture->screen;
    PixmapPtr root = screen->GetScreenPixmap(screen), dst = capture->slots[index];
    if (dst && (dst->drawable.width != root->drawable.width || dst->drawable.height != root->drawable.height)) {
        screen->DestroyPixmap(dst);
        capture->slots[index] = dst = NULL;
    }
    if (!dst) {
        const char *layout=getenv("BPANE_GPU_LEASE_LAYOUT");
        if (layout && strcmp(layout,"uif") && strcmp(layout,"legacy")) return NULL;
        Bool tiled=layout && !strcmp(layout,"uif");
        dst = tiled
            ? bp_capture_tiled_pixmap(screen,root->drawable.width,root->drawable.height)
            : screen->CreatePixmap(screen, root->drawable.width, root->drawable.height,
                                   screen->rootDepth, GLAMOR_CREATE_NO_LARGE);
        if (!dst) return NULL;
        /* Imported DRM textures deliberately return zero from this accessor. */
        if (!tiled && !glamor_get_pixmap_texture(dst)) { screen->DestroyPixmap(dst); return NULL; }
        /* Export may allocate an exportable BO and GPU-copy this texture once.
         * Clear first: allocation/export must never expose recycled pixels. */
        glamor_clear_pixmap(dst);
        capture->slots[index] = dst;
    }
    return dst;
}

static Bool copy_damage(struct BpCapture *capture, PixmapPtr dst, BpLeaseReply *reply) {
    ScreenPtr screen = capture->screen;
    PixmapPtr root = screen->GetScreenPixmap(screen);
    GCPtr gc = GetScratchGC(screen->rootDepth, screen);
    if (!gc) return FALSE;
    ChangeGCVal value = {.val = FALSE};
    ChangeGC(NULL, gc, GCGraphicsExposures, &value);
    ValidateGC(&dst->drawable, gc);
    uint32_t cursor = 0, rect[4];
    while (bp_pool_rect(capture->pool, reply->slot, &cursor, rect)) {
        gc->ops->CopyArea(&root->drawable, &dst->drawable, gc,
                         rect[0], rect[1], rect[2], rect[3], rect[0], rect[1]);
        reply->copied_pixels += rect[2] * rect[3];
    }
    FreeScratchGC(gc);
    return TRUE;
}

static int completion_fence(ScreenPtr screen) {
    /* Public glamor entrypoint selects its context. Never call glFinish here. */
    glamor_block_handler(screen);
    EGLDisplay display = eglGetCurrentDisplay();
    if (display == EGL_NO_DISPLAY || !epoxy_has_egl_extension(display, "EGL_ANDROID_native_fence_sync")) return -1;
    EGLSyncKHR sync = eglCreateSyncKHR(display, EGL_SYNC_NATIVE_FENCE_ANDROID, NULL);
    if (sync == EGL_NO_SYNC_KHR) return -1;
    glFlush();
    int fd = eglDupNativeFenceFDANDROID(display, sync);
    eglDestroySyncKHR(display, sync);
    return fd;
}

Bool bp_capture_export(struct BpCapture *capture, BpLeaseReply *reply, int fds[5]) {
    PixmapPtr dst = snapshot(capture, reply->slot);
    if (!dst) return FALSE;
    /* Ask the allocator for format; never guess ARGB/XRGB or a linear modifier. */
    struct gbm_bo *bo = glamor_gbm_bo_from_pixmap(capture->screen, dst);
    if (!bo) { xf86DrvMsg(capture->screen->myNum,X_ERROR,"BPANE_LEASE_EXPORT GBM failed\n"); return FALSE; }
    reply->fourcc = gbm_bo_get_format(bo);
    gbm_bo_destroy(bo);
    int planes = glamor_fds_from_pixmap(capture->screen, dst, fds,
                                       reply->strides, reply->offsets, &reply->modifier);
    if (planes < 1 || planes > 4) {
        xf86DrvMsg(capture->screen->myNum,X_ERROR,"BPANE_LEASE_EXPORT planes=%d\n",planes);
        return FALSE;
    }
    reply->planes = planes;
    reply->width = dst->drawable.width;
    reply->height = dst->drawable.height;
    if (!copy_damage(capture, dst, reply)) return FALSE;
    fds[planes] = completion_fence(capture->screen);
    if (fds[planes] < 0) return FALSE;
    reply->nfd = planes + 1;
    return TRUE;
}

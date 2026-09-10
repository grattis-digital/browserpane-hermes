/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease.h"
#include <drm_fourcc.h>
#include <gbm.h>
#include <errno.h>

/* Headless capture is not scanout. A generic scanout allocation can force a
 * linear BO on V3D and a full shadow-texture refresh on every sampler dispatch.
 * This opt-in path explicitly negotiates UIF without any scanout/master device.
 * No private Xorg layouts or Mesa allocation internals are accessed. */
PixmapPtr bp_capture_tiled_pixmap(ScreenPtr screen, unsigned width, unsigned height) {
    struct gbm_device *gbm=glamor_egl_get_gbm_device(screen);
    const uint64_t modifier=DRM_FORMAT_MOD_BROADCOM_UIF;
    if (!gbm) { xf86DrvMsg(screen->myNum,X_ERROR,"BPANE_UIF_ALLOC no GBM device\n"); return NULL; }
    struct gbm_bo *bo=bp_capture_padded_bo(gbm,width,height);
    if (!bo) { xf86DrvMsg(screen->myNum,X_ERROR,"BPANE_UIF_ALLOC GBM failed errno=%d\n",errno); return NULL; }
    PixmapPtr pixmap=NULL;
    if (gbm_bo_get_modifier(bo)!=modifier || gbm_bo_get_plane_count(bo)!=1) {
        xf86DrvMsg(screen->myNum,X_ERROR,"BPANE_UIF_ALLOC unexpected modifier=%016llx planes=%d\n",
            (unsigned long long)gbm_bo_get_modifier(bo),gbm_bo_get_plane_count(bo));
        goto done;
    }
    pixmap=screen->CreatePixmap(screen,0,0,screen->rootDepth,0);
    if (!pixmap) { xf86DrvMsg(screen->myNum,X_ERROR,"BPANE_UIF_ALLOC pixmap failed\n"); goto done; }
    /* glamor_get_pixmap_texture only admits GLAMOR_TEXTURE_ONLY; it returns
     * zero for a valid imported GLAMOR_TEXTURE_DRM pixmap. Trust the public
     * textured-import result here, not that internal-texture accessor. */
    if (!screen->ModifyPixmapHeader(pixmap,width,height,screen->rootDepth,32,gbm_bo_get_stride(bo),NULL) ||
        !glamor_egl_create_textured_pixmap_from_gbm_bo(pixmap,bo,TRUE)) {
        xf86DrvMsg(screen->myNum,X_ERROR,"BPANE_UIF_ALLOC pixmap header/import failed\n");
        screen->DestroyPixmap(pixmap); pixmap=NULL;
    }
done:
    gbm_bo_destroy(bo);
    return pixmap;
}

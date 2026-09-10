/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease.h"
#include <gbm.h>
#include <drm_fourcc.h>
#include "v3d-buffer-uapi.h"
#include <xf86drm.h>
#include <fcntl.h>
#include <unistd.h>

/* Mesa 25 V3DV adds TFU readahead padding even when importing a storage-only
 * image. Gallium's image allocation need not have that trailing page. Ask GBM
 * for the exact UIF layout, then allocate a fresh BO with one extra page via
 * the public render-node UAPI. This is allocation only: no pixels are mapped,
 * read or copied. Never change dimensions to fake padding (UIF layout depends
 * on height). The template is discarded and the new texture is cleared before
 * any lease export. Normal/legacy snapshots never call this function. */
struct gbm_bo *bp_capture_padded_bo(struct gbm_device *gbm, unsigned width, unsigned height) {
    const uint64_t modifier=DRM_FORMAT_MOD_BROADCOM_UIF;
    struct gbm_bo *layout=gbm_bo_create_with_modifiers2(gbm,width,height,GBM_FORMAT_ARGB8888,
        &modifier,1,GBM_BO_USE_RENDERING);
    if (!layout) return NULL;
    struct gbm_bo *result=NULL;
    int template_fd=-1, padded_fd=-1, render=gbm_device_get_fd(gbm);
    if (gbm_bo_get_modifier(layout)!=modifier || gbm_bo_get_plane_count(layout)!=1) goto done;
    template_fd=gbm_bo_get_fd(layout);
    if (template_fd<0) goto done;
    off_t size=lseek(template_fd,0,SEEK_END);
    if (size<=0 || size>32*1024*1024 || size%4096) goto done;
    struct bp_v3d_create_bo alloc={.size=(uint32_t)size+4096};
    if (drmIoctl(render,BP_V3D_CREATE_BO,&alloc)) goto done;
    int exported=drmPrimeHandleToFD(render,alloc.handle,DRM_CLOEXEC|DRM_RDWR,&padded_fd);
    /* The fresh handle is not known to Mesa. Close it BEFORE GBM imports the
     * FD, so we never close a handle subsequently owned/cached by Gallium. */
    int closed=drmCloseBufferHandle(render,alloc.handle);
    if (exported || closed) goto done;
    struct gbm_import_fd_modifier_data data={.width=width,.height=height,
        .format=GBM_FORMAT_ARGB8888,.num_fds=1,.fds={padded_fd},
        .strides={gbm_bo_get_stride(layout)},.offsets={gbm_bo_get_offset(layout,0)},.modifier=modifier};
    result=gbm_bo_import(gbm,GBM_BO_IMPORT_FD_MODIFIER,&data,GBM_BO_USE_RENDERING);
done:
    if (padded_fd>=0) close(padded_fd);
    if (template_fd>=0) close(template_fd);
    gbm_bo_destroy(layout);
    return result;
}

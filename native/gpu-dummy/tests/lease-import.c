/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-client.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xf86drm.h>

LeaseGpu lease_gpu(void) {
    LeaseGpu gpu = {.fd = open("/dev/bpane-render", O_RDWR | O_CLOEXEC | O_NOFOLLOW)};
    assert(gpu.fd >= 0 && drmGetNodeTypeFromFd(gpu.fd) == DRM_NODE_RENDER);
    drmVersionPtr version = drmGetVersion(gpu.fd);
    assert(version && version->name && !strcmp(version->name, "v3d"));
    drmFreeVersion(version);
    gpu.gbm = gbm_create_device(gpu.fd);
    assert(gpu.gbm);
    gpu.display = eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, gpu.gbm, NULL);
    assert(gpu.display != EGL_NO_DISPLAY && eglInitialize(gpu.display, NULL, NULL));
    assert(epoxy_has_egl_extension(gpu.display, "EGL_EXT_image_dma_buf_import_modifiers"));
    assert(epoxy_has_egl_extension(gpu.display, "EGL_ANDROID_native_fence_sync"));
    assert(epoxy_has_egl_extension(gpu.display, "EGL_KHR_wait_sync"));
    assert(eglBindAPI(EGL_OPENGL_ES_API));
    EGLint attrs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE};
    gpu.context = eglCreateContext(gpu.display, NULL, EGL_NO_CONTEXT, attrs);
    assert(gpu.context != EGL_NO_CONTEXT && eglMakeCurrent(gpu.display, EGL_NO_SURFACE, EGL_NO_SURFACE, gpu.context));
    const char *renderer = (const char *)glGetString(GL_RENDERER);
    assert(renderer && strstr(renderer, "V3D") && !strstr(renderer, "llvmpipe"));
    fprintf(stderr, "lease consumer renderer=%s\n", renderer);
    return gpu;
}

void lease_import(LeaseGpu *gpu, LeaseFrame *frame) {
    BpLeaseReply *wire = &frame->wire;
    const EGLint keys[4][5] = {
        {EGL_DMA_BUF_PLANE0_FD_EXT, EGL_DMA_BUF_PLANE0_OFFSET_EXT, EGL_DMA_BUF_PLANE0_PITCH_EXT, EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT},
        {EGL_DMA_BUF_PLANE1_FD_EXT, EGL_DMA_BUF_PLANE1_OFFSET_EXT, EGL_DMA_BUF_PLANE1_PITCH_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE1_MODIFIER_HI_EXT},
        {EGL_DMA_BUF_PLANE2_FD_EXT, EGL_DMA_BUF_PLANE2_OFFSET_EXT, EGL_DMA_BUF_PLANE2_PITCH_EXT, EGL_DMA_BUF_PLANE2_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE2_MODIFIER_HI_EXT},
        {EGL_DMA_BUF_PLANE3_FD_EXT, EGL_DMA_BUF_PLANE3_OFFSET_EXT, EGL_DMA_BUF_PLANE3_PITCH_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_LO_EXT, EGL_DMA_BUF_PLANE3_MODIFIER_HI_EXT}
    };
    EGLint attrs[48] = {EGL_WIDTH, wire->width, EGL_HEIGHT, wire->height, EGL_LINUX_DRM_FOURCC_EXT, wire->fourcc};
    unsigned cursor = 6;
    for (unsigned plane = 0; plane < wire->planes; plane++) {
        EGLint values[5] = {frame->fds[plane], wire->offsets[plane], wire->strides[plane],
                           (uint32_t)wire->modifier, wire->modifier >> 32};
        for (unsigned key = 0; key < (wire->modifier == UINT64_MAX ? 3u : 5u); key++) {
            attrs[cursor++] = keys[plane][key]; attrs[cursor++] = values[key];
        }
    }
    attrs[cursor] = EGL_NONE;
    frame->image = eglCreateImageKHR(gpu->display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, NULL, attrs);
    if (!frame->image) fprintf(stderr, "DMA-BUF import failed EGL=%x format=%x modifier=%llx\n", eglGetError(), wire->fourcc, (unsigned long long)wire->modifier);
    assert(frame->image != EGL_NO_IMAGE_KHR);
    for (unsigned i = 0; i < wire->planes; i++) { close(frame->fds[i]); frame->fds[i] = -1; }
    EGLint sync_attrs[] = {EGL_SYNC_NATIVE_FENCE_FD_ANDROID, frame->fds[wire->planes], EGL_NONE};
    EGLSyncKHR sync = eglCreateSyncKHR(gpu->display, EGL_SYNC_NATIVE_FENCE_ANDROID, sync_attrs);
    assert(sync != EGL_NO_SYNC_KHR);
    frame->fds[wire->planes] = -1; // EGL owns the imported sync_file descriptor.
    assert(eglWaitSyncKHR(gpu->display, sync, 0)); // GPU-side wait, not glFinish.
    assert(eglDestroySyncKHR(gpu->display, sync));
    glGenTextures(1, &frame->texture);
    glBindTexture(GL_TEXTURE_2D, frame->texture);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, frame->image);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glGenFramebuffers(1, &frame->framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, frame->framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, frame->texture, 0);
    assert(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE && glGetError() == GL_NO_ERROR);
}

void lease_pixels(LeaseFrame *frame, uint32_t background, uint32_t patch) {
    unsigned width = frame->wire.width, height = frame->wire.height;
    assert(width >= 32 && width <= 1920 && height >= 32 && height <= 1080);
    uint8_t *pixels = malloc(width * height * 4);
    assert(pixels);
    glBindFramebuffer(GL_FRAMEBUFFER, frame->framebuffer);
    glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    assert(glGetError() == GL_NO_ERROR);
    for (unsigned y = 0; y < height; y++) for (unsigned x = 0; x < width; x++) {
        uint32_t expected = (x >= 4 && x < 28 && y >= 8 && y < 32) ? patch : background;
        uint8_t *p = pixels + (y * width + x) * 4;
        uint32_t actual = (p[0] << 16) | (p[1] << 8) | p[2];
        if (actual != expected) { fprintf(stderr, "lease pixel %u,%u got=%06x expected=%06x\n", x, y, actual, expected); abort(); }
    }
    free(pixels);
}

void lease_destroy(LeaseGpu *gpu, LeaseFrame *frame) {
    glDeleteFramebuffers(1, &frame->framebuffer);
    glDeleteTextures(1, &frame->texture);
    assert(eglDestroyImageKHR(gpu->display, frame->image));
}

void lease_gpu_close(LeaseGpu *gpu) {
    assert(eglMakeCurrent(gpu->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT));
    eglDestroyContext(gpu->display, gpu->context);
    eglTerminate(gpu->display);
    gbm_device_destroy(gpu->gbm);
    close(gpu->fd);
}

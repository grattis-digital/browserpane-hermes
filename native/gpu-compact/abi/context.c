/* SPDX-License-Identifier: AGPL-3.0-only
 * Owned, single-threaded, finite test context; never binds an existing display.
 */
#include "compact.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int bp_gpu_ok(void) {
    GLenum error = glGetError();
    if (error != GL_NO_ERROR) fprintf(stderr, "GL error: %x\n", error);
    return error == GL_NO_ERROR;
}

static GLuint program(const char *source, int length, int deduplicate) {
    // Preserve #version as the first line. Select at compile time so even the
    // control shader has no added per-pixel uniform branch/register pressure.
    const char *newline = memchr(source, '\n', (size_t)length);
    if (!newline) return 0;
    int first = (int)(newline + 1 - source);
    const char *define = deduplicate ? "#define BPANE_DEDUPLICATE 1\n" : "#define BPANE_DEDUPLICATE 0\n";
    const char *parts[] = {source, define, source + first};
    GLint lengths[] = {first, (GLint)strlen(define), length - first};
    GLuint shader = glCreateShader(GL_COMPUTE_SHADER);
    glShaderSource(shader, 3, parts, lengths);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[4096]; glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "Shader: %s\n", log); glDeleteShader(shader); return 0;
    }
    GLuint result = glCreateProgram();
    glAttachShader(result, shader); glLinkProgram(result); glDeleteShader(shader);
    glGetProgramiv(result, GL_LINK_STATUS, &ok);
    if (!ok) { glDeleteProgram(result); return 0; }
    return result;
}

static int context(BpGpu *gpu, int software) {
    if (software) {
        gpu->display = eglGetPlatformDisplayEXT(EGL_PLATFORM_SURFACELESS_MESA, NULL, NULL);
    } else {
        gpu->fd = open("/dev/bpane-render", O_RDWR | O_CLOEXEC);
        if (gpu->fd < 0) return 0;
        gpu->gbm = gbm_create_device(gpu->fd);
        if (!gpu->gbm) return 0;
        gpu->display = eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, gpu->gbm, NULL);
    }
    if (gpu->display == EGL_NO_DISPLAY || !eglInitialize(gpu->display, NULL, NULL) ||
        !eglBindAPI(EGL_OPENGL_ES_API)) return 0;
    // GBM need not offer pbuffers. No surface is created for this compute probe.
    EGLint attrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_SURFACE_TYPE,
        0, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
    EGLConfig config; EGLint count;
    if (!eglChooseConfig(gpu->display, attrs, &config, 1, &count) || count != 1) {
        fprintf(stderr, "EGL config failed: %x\n", eglGetError()); return 0;
    }
    EGLint ctx[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 1, EGL_NONE};
    gpu->context = eglCreateContext(gpu->display, config, EGL_NO_CONTEXT, ctx);
    if (gpu->context == EGL_NO_CONTEXT || !eglMakeCurrent(gpu->display,
        EGL_NO_SURFACE, EGL_NO_SURFACE, gpu->context)) {
        fprintf(stderr, "EGL context failed: %x\n", eglGetError()); return 0;
    }
    const char *renderer = (const char *)glGetString(GL_RENDERER);
    const char *version = (const char *)glGetString(GL_VERSION);
    fprintf(stderr, "renderer=%s version=%s\n", renderer, version);
    return renderer && (software ? strstr(renderer, "llvmpipe") != NULL :
        (strstr(renderer, "V3D") != NULL && strstr(renderer, "llvmpipe") == NULL));
}

static int resources(BpGpu *gpu) {
    glGenTextures(3, gpu->texture);
    glGenBuffers(3, gpu->rows);
    for (int index = 0; index < 3; ++index) {
        glBindTexture(GL_TEXTURE_2D, gpu->texture[index]);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, gpu->width, gpu->height);
        GLint compatibility;
        glGetTexParameteriv(GL_TEXTURE_2D, GL_IMAGE_FORMAT_COMPATIBILITY_TYPE, &compatibility);
        if (compatibility != GL_IMAGE_FORMAT_COMPATIBILITY_BY_SIZE) return 0;
        glBindBuffer(GL_SHADER_STORAGE_BUFFER, gpu->rows[index]);
        glBufferData(GL_SHADER_STORAGE_BUFFER, ((gpu->width + 31) / 32) * (gpu->height + 2048) * 4,
            NULL, GL_DYNAMIC_COPY);
    }
    glGenBuffers(2, gpu->buffer);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, gpu->buffer[0]);
    glBufferData(GL_SHADER_STORAGE_BUFFER, (3 * gpu->tiles + 1) * 4, NULL, GL_DYNAMIC_READ);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, gpu->buffer[1]);
    glBufferData(GL_SHADER_STORAGE_BUFFER, gpu->tiles * 4096, NULL, GL_DYNAMIC_READ);
    glGenFramebuffers(1, &gpu->framebuffer);
    return bp_gpu_ok();
}

BpGpu *bp_gpu_new(int width, int height, int software, int flags, const BpShader sources[5]) {
    if (width < 1 || width > 1920 || height < 1 || height > 1080 ||
        (software != 0 && software != 1) || flags < 0 || flags > 3 || !sources)
        return NULL;
    for (int i = 0; i < 5; ++i)
        if (!sources[i].source || sources[i].length < 1 || sources[i].length > 32768) return NULL;
    BpGpu *gpu = calloc(1, sizeof(*gpu));
    if (!gpu) return NULL;
    gpu->fd = -1; gpu->width = width; gpu->height = height;
    gpu->deduplicate = flags & 1; gpu->profile = (flags >> 1) & 1;
    gpu->tiles = ((width + 31) / 32) * ((height + 31) / 32);
    if (!context(gpu, software) || !bp_profile_init(gpu)) { bp_gpu_free(gpu); return NULL; }
    gpu->fixture = program(sources[0].source, sources[0].length, 0);
    gpu->compact = program(sources[1].source, sources[1].length, gpu->deduplicate);
    gpu->fingerprints = program(sources[2].source, sources[2].length, 0);
    gpu->motion = program(sources[3].source, sources[3].length, 0);
    gpu->index_clear = program(sources[4].source, sources[4].length, 0);
    if (!gpu->fixture || !gpu->compact || !gpu->fingerprints || !gpu->motion || !gpu->index_clear || !resources(gpu)) {
        bp_gpu_free(gpu); return NULL;
    }
    return gpu;
}

void bp_gpu_free(BpGpu *gpu) {
    if (!gpu) return;
    if (gpu->context != EGL_NO_CONTEXT && eglGetCurrentContext() == gpu->context) {
        if (gpu->query[0]) glDeleteQueriesEXT(4, gpu->query);
        glDeleteProgram(gpu->fixture); glDeleteProgram(gpu->compact);
        glDeleteProgram(gpu->fingerprints); glDeleteProgram(gpu->motion);
        glDeleteProgram(gpu->index_clear);
        glDeleteTextures(3, gpu->texture); glDeleteBuffers(2, gpu->buffer);
        glDeleteBuffers(3, gpu->rows);
        glDeleteFramebuffers(1, &gpu->framebuffer);
        eglMakeCurrent(gpu->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    }
    if (gpu->display != EGL_NO_DISPLAY) {
        if (gpu->context != EGL_NO_CONTEXT) eglDestroyContext(gpu->display, gpu->context);
        eglTerminate(gpu->display);
    }
    if (gpu->gbm) gbm_device_destroy(gpu->gbm);
    if (gpu->fd >= 0) close(gpu->fd);
    free(gpu);
}

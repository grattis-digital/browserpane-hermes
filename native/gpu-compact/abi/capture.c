/* SPDX-License-Identifier: AGPL-3.0-only */
#include "compact.h"
#include <string.h>
#include <time.h>

static uint64_t clock_ns(clockid_t clock) {
    struct timespec value;
    if (clock_gettime(clock, &value)) return 0;
    return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}

static void uniforms(BpGpu *gpu, GLuint program) {
    glUseProgram(program);
    glUniform2i(glGetUniformLocation(program, "size"), gpu->width, gpu->height);
}

int bp_gpu_render(BpGpu *gpu, int scene, int frame, int index) {
    if (!gpu || index < 0 || index > 2 || scene < 0 || scene > 9 || frame < 0 || frame > 128)
        return 0;
    uniforms(gpu, gpu->fixture);
    glUniform1i(glGetUniformLocation(gpu->fixture, "scene"), scene);
    glUniform1i(glGetUniformLocation(gpu->fixture, "frame"), frame);
    glBindImageTexture(0, gpu->texture[index], 0, GL_FALSE, 0, GL_WRITE_ONLY, GL_RGBA8);
    glDispatchCompute((gpu->width + 7) / 8, (gpu->height + 7) / 8, 1);
    glMemoryBarrier(GL_SHADER_IMAGE_ACCESS_BARRIER_BIT | GL_FRAMEBUFFER_BARRIER_BIT);
    // Fixture production is completed before BOTH timed strategies. This is a
    // ready-texture component comparison, not overlapping compositor rendering.
    glFinish();
    return bp_gpu_ok();
}

int bp_gpu_full(BpGpu *gpu, int index, uint32_t *output, BpTimes *times) {
    if (!gpu || index < 0 || index > 1 || !output || !times) return 0;
    uint64_t wall = clock_ns(CLOCK_MONOTONIC), cpu = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    glBindFramebuffer(GL_FRAMEBUFFER, gpu->framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
        gpu->texture[index], 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) return 0;
    glReadPixels(0, 0, gpu->width, gpu->height, GL_RGBA, GL_UNSIGNED_BYTE, output);
    times->wall_ns = clock_ns(CLOCK_MONOTONIC) - wall;
    times->cpu_ns = clock_ns(CLOCK_THREAD_CPUTIME_ID) - cpu;
    times->metadata_ns = 0; times->payload_ns = 0;
    return bp_gpu_ok();
}

static int read_buffer(GLuint buffer, uint32_t *output, size_t bytes) {
    if (!bytes) return 1;
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffer);
    void *mapped = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, bytes, GL_MAP_READ_BIT);
    if (!mapped) return 0;
    memcpy(output, mapped, bytes);
    return glUnmapBuffer(GL_SHADER_STORAGE_BUFFER) == GL_TRUE;
}

int bp_gpu_compact(BpGpu *gpu, int index, int wrong_candidate, int valid,
        uint32_t *header, uint32_t *payload, BpTimes *times) {
    if (!gpu || index < 0 || index > 1 || (wrong_candidate != 0 && wrong_candidate != 1) ||
        !header || !payload || !times || (valid != 0 && valid != 1))
        return 0;
    bp_profile_reset(gpu);
    uint64_t wall = clock_ns(CLOCK_MONOTONIC), cpu = clock_ns(CLOCK_THREAD_CPUTIME_ID);
    uint32_t zero = 0;
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, gpu->buffer[0]);
    glBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, 4, &zero);
    bp_gpu_motion(gpu, index);
    bp_profile_start(gpu, 3);
    uniforms(gpu, gpu->compact);
    glUniform1i(glGetUniformLocation(gpu->compact, "wrong_candidate"), wrong_candidate);
    glUniform1i(glGetUniformLocation(gpu->compact, "history_valid"), valid);
    int sources[] = {index, 1-index, 2};
    for (int unit = 0; unit < 3; ++unit) {
        glBindImageTexture(unit, gpu->texture[sources[unit]], 0, GL_FALSE, 0, GL_READ_ONLY, GL_R32UI);
    }
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 2, gpu->buffer[0]);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 3, gpu->buffer[1]);
    glDispatchCompute((gpu->width + 31) / 32, (gpu->height + 31) / 32, 1);
    bp_profile_end(gpu);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);
    if (!read_buffer(gpu->buffer[0], header, (3 * gpu->tiles + 1) * 4)) return 0;
    uint64_t metadata_end = clock_ns(CLOCK_MONOTONIC);
    if (header[0] > (unsigned)gpu->tiles ||
        !read_buffer(gpu->buffer[1], payload, header[0] * 4096)) return 0;
    times->wall_ns = clock_ns(CLOCK_MONOTONIC) - wall;
    times->cpu_ns = clock_ns(CLOCK_THREAD_CPUTIME_ID) - cpu;
    times->metadata_ns = metadata_end - wall;
    times->payload_ns = times->wall_ns - times->metadata_ns;
    return bp_gpu_ok() && bp_profile_collect(gpu, times);
}

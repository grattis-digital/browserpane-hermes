/* SPDX-License-Identifier: AGPL-3.0-only */
#include "compact.h"

int bp_gpu_prime(BpGpu *gpu, int index) {
    if (!gpu || index < 0 || index > 2) return 0;
    bp_gpu_rows(gpu, index);
    glFinish();
    return bp_gpu_ok();
}

void bp_gpu_rows(BpGpu *gpu, int index) {
    bp_profile_start(gpu, 0);
    glUseProgram(gpu->index_clear);
    glUniform2i(glGetUniformLocation(gpu->index_clear, "size"), gpu->width, gpu->height);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 4, gpu->rows[index]);
    glDispatchCompute(((gpu->width + 31) / 32) * 2048 / 64, 1, 1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
    bp_profile_end(gpu);
    bp_profile_start(gpu, 1);
    glUseProgram(gpu->fingerprints);
    glUniform2i(glGetUniformLocation(gpu->fingerprints, "size"), gpu->width, gpu->height);
    glBindImageTexture(0, gpu->texture[index], 0, GL_FALSE, 0, GL_READ_ONLY, GL_R32UI);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 4, gpu->rows[index]);
    glDispatchCompute((((gpu->width + 31) / 32) + 7) / 8, (gpu->height + 7) / 8, 1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
    bp_profile_end(gpu);
}

void bp_gpu_motion(BpGpu *gpu, int index) {
    bp_gpu_rows(gpu, index);
    bp_profile_start(gpu, 2);
    glUseProgram(gpu->motion);
    glUniform2i(glGetUniformLocation(gpu->motion, "size"), gpu->width, gpu->height);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 2, gpu->buffer[0]);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 4, gpu->rows[index]);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 5, gpu->rows[1-index]);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 6, gpu->rows[2]);
    glDispatchCompute((((gpu->width + 31) / 32) + 7) / 8, (((gpu->height + 31) / 32) + 7) / 8, 1);
    glMemoryBarrier(GL_SHADER_STORAGE_BARRIER_BIT);
    bp_profile_end(gpu);
}

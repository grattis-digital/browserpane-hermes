/* SPDX-License-Identifier: AGPL-3.0-only
 * Diagnostic-only GL query intervals. V3D implements timestamps with scheduled
 * CPU-queue jobs, NOT a pure hardware GPU clock. Never pool with clean runs.
 */
#include "compact.h"
#include <stdio.h>

int bp_profile_init(BpGpu *gpu) {
    if (!gpu->profile) return 1;
    if (!epoxy_has_gl_extension("GL_EXT_disjoint_timer_query")) {
        fprintf(stderr, "Stage profiling unavailable: EXT_disjoint_timer_query missing\n");
        return 0;
    }
    GLint bits = 0;
    glGetQueryivEXT(GL_TIME_ELAPSED_EXT, GL_QUERY_COUNTER_BITS_EXT, &bits);
    if (bits < 30) return 0;
    glGenQueriesEXT(4, gpu->query);
    fprintf(stderr, "stage-query=EXT_disjoint_timer_query bits=%d (driver intervals, not GPU clock attribution)\n", bits);
    return bp_gpu_ok();
}

void bp_profile_reset(BpGpu *gpu) {
    if (!gpu->profile) return;
    GLint disjoint;
    glGetIntegerv(GL_GPU_DISJOINT_EXT, &disjoint);
}

void bp_profile_start(BpGpu *gpu, int stage) {
    if (gpu->profile) glBeginQueryEXT(GL_TIME_ELAPSED_EXT, gpu->query[stage]);
}

void bp_profile_end(BpGpu *gpu) {
    if (gpu->profile) glEndQueryEXT(GL_TIME_ELAPSED_EXT);
}

int bp_profile_collect(BpGpu *gpu, BpTimes *times) {
    if (!gpu->profile) return 1;
    // Only this explicitly intrusive diagnostic waits for trailing query jobs,
    // after ALL capture work and outside the recorded capture spans. A payload
    // BO wait alone need not complete a timestamp job writing a different BO.
    glFinish();
    // No polling loop or blocking RESULT query before availability is confirmed.
    for (int i = 0; i < 4; ++i) {
        GLuint ready = 0;
        glGetQueryObjectuivEXT(gpu->query[i], GL_QUERY_RESULT_AVAILABLE_EXT, &ready);
        if (!ready) {
            fprintf(stderr, "Stage query unavailable after capture; diagnostic invalid\n");
            return 0;
        }
        GLuint64 value;
        glGetQueryObjectui64vEXT(gpu->query[i], GL_QUERY_RESULT_EXT, &value);
        // <1s is safe even at the minimum 30-bit counter width. Do not silently
        // accept wrapped, saturated or nonsensical intervals in this finite test.
        if (!value || value >= 1000000000) return 0;
        times->stage_query_ns[i] = value;
    }
    GLint disjoint = 0;
    glGetIntegerv(GL_GPU_DISJOINT_EXT, &disjoint);
    if (disjoint) fprintf(stderr, "Disjoint stage queries; diagnostic invalid\n");
    return !disjoint && bp_gpu_ok();
}

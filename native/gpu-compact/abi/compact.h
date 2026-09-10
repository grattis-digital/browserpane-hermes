/* SPDX-License-Identifier: AGPL-3.0-only */
#include <stdint.h>
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <gbm.h>
typedef struct {
    int fd, width, height, tiles;
    struct gbm_device *gbm;
    EGLDisplay display;
    EGLContext context;
    GLuint texture[3], rows[3], buffer[2], framebuffer, fixture, compact, fingerprints, motion, index_clear;
    GLuint query[4];
    int deduplicate, profile;
} BpGpu;
typedef struct { uint64_t wall_ns, cpu_ns, metadata_ns, payload_ns, stage_query_ns[4]; } BpTimes;
typedef struct { const char *source; int length; } BpShader;
BpGpu *bp_gpu_new(int width, int height, int software, int flags, const BpShader sources[5]);
void bp_gpu_free(BpGpu *gpu);
int bp_gpu_render(BpGpu *gpu, int scene, int frame, int index);
int bp_gpu_full(BpGpu *gpu, int index, uint32_t *output, BpTimes *times);
int bp_gpu_compact(BpGpu *gpu, int index, int wrong_candidate, int valid,
    uint32_t *header, uint32_t *payload, BpTimes *times);
int bp_gpu_ok(void);
int bp_gpu_prime(BpGpu *gpu, int index);
void bp_gpu_rows(BpGpu *gpu, int index);
void bp_gpu_motion(BpGpu *gpu, int index);
int bp_profile_init(BpGpu *gpu);
void bp_profile_start(BpGpu *gpu, int stage);
void bp_profile_end(BpGpu *gpu);
void bp_profile_reset(BpGpu *gpu);
int bp_profile_collect(BpGpu *gpu, BpTimes *times);

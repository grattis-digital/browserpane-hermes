/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_LEASE_H
#define BPANE_LEASE_H
#include "bpane.h"
#include "lease-wire.h"
#include <damage.h>
#include <dixstruct.h>
typedef struct BpPool BpPool;
BpPool *bp_pool_new(void);
void bp_pool_free(BpPool *);
bool bp_pool_resize(BpPool *, uint32_t, uint32_t);
void bp_pool_damage(BpPool *, int32_t, int32_t, int32_t, int32_t);
bool bp_pool_begin(BpPool *, uint32_t token[3]);
bool bp_pool_end(BpPool *, const uint32_t token[3], bool commit);
bool bp_pool_rect(const BpPool *, uint32_t, uint32_t *cursor, uint32_t output[4]);

struct BpCapture {
    ScreenPtr screen;
    ClientPtr owner;
    BpPool *pool;
    DamagePtr damage;
    PixmapPtr slots[3];
    Bool supported;
};
Bool bp_capture_init(ScreenPtr);
struct gbm_device;
struct gbm_bo;
struct gbm_bo *bp_capture_padded_bo(struct gbm_device *, unsigned, unsigned);
PixmapPtr bp_capture_tiled_pixmap(ScreenPtr, unsigned, unsigned);
void bp_capture_root(ScreenPtr, PixmapPtr);
void bp_capture_close(ScreenPtr);
void bp_capture_reset(struct BpCapture *);
Bool bp_capture_export(struct BpCapture *, BpLeaseReply *, int fds[5]);
Bool bp_capture_extension(struct BpCapture *);
void bp_capture_extension_close(struct BpCapture *);
#endif

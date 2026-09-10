/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease.h"
#include <stdlib.h>
#include <string.h>

static void damaged(DamagePtr damage, RegionPtr region, void *closure) {
    (void)damage;
    struct BpCapture *capture = closure;
    int count = RegionNumRects(region);
    BoxPtr boxes = RegionRects(region);
    /* Bound callback work even if an application submits a fragmented region. */
    if (count > 1024) { boxes = RegionExtents(region); count = 1; }
    for (int i = 0; i < count; i++)
        bp_pool_damage(capture->pool, boxes[i].x1, boxes[i].y1, boxes[i].x2, boxes[i].y2);
}

void bp_capture_reset(struct BpCapture *capture) {
    for (unsigned i = 0; i < 3; i++) {
        if (capture->slots[i]) capture->screen->DestroyPixmap(capture->slots[i]);
        capture->slots[i] = NULL;
    }
    bp_pool_free(capture->pool);
    capture->pool = bp_pool_new();
    PixmapPtr root = capture->screen->GetScreenPixmap(capture->screen);
    capture->supported = bp_pool_resize(capture->pool, root->drawable.width, root->drawable.height);
    capture->owner = NULL;
}

void bp_capture_root(ScreenPtr screen, PixmapPtr root) {
    struct BpCapture *capture = bp_screen(screen)->capture;
    if (!capture) return;
    if (capture->damage) DamageUnregister(capture->damage);
    capture->supported = bp_pool_resize(capture->pool, root->drawable.width, root->drawable.height);
    if (capture->damage) DamageRegister(&root->drawable, capture->damage);
}

Bool bp_capture_init(ScreenPtr screen) {
    const char *enabled = getenv("BPANE_GPU_LEASE");
    if (!enabled || strcmp(enabled, "1")) return TRUE;
    if (BPANE_TEST_SOFTWARE || bp_screen(screen)->capture) return FALSE;
    struct BpCapture *capture = calloc(1, sizeof(*capture));
    if (!capture) return FALSE;
    capture->screen = screen;
    bp_screen(screen)->capture = capture;
    bp_capture_reset(capture);
    capture->damage = DamageCreate(damaged, NULL, DamageReportRawRegion, TRUE, screen, capture);
    if (!capture->damage || !bp_capture_extension(capture)) {
        bp_capture_close(screen);
        return FALSE;
    }
    DamageSetReportAfterOp(capture->damage, TRUE);
    DamageRegister(&screen->GetScreenPixmap(screen)->drawable, capture->damage);
    xf86DrvMsg(screen->myNum, X_INFO, "BPANE_GPU_LEASE_READY version=1 slots=3 tile=64\n");
    return TRUE;
}

void bp_capture_close(ScreenPtr screen) {
    struct BpCapture *capture = bp_screen(screen)->capture;
    if (!capture) return;
    bp_capture_extension_close(capture);
    if (capture->damage) {
        DamageUnregister(capture->damage);
        DamageDestroy(capture->damage);
    }
    for (unsigned i = 0; i < 3; i++)
        if (capture->slots[i]) screen->DestroyPixmap(capture->slots[i]);
    bp_pool_free(capture->pool);
    bp_screen(screen)->capture = NULL;
    free(capture);
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "bpane.h"
#include "lease.h"
#include <fb.h>
#include <micmap.h>
#include <mipointer.h>
#include <picturestr.h>
#include <gcstruct.h>
#include <dix.h>
#include <stdlib.h>

static int replace_window(WindowPtr window, void *old) {
    ScreenPtr screen = window->drawable.pScreen;
    if (screen->GetWindowPixmap(window) == old)
        screen->SetWindowPixmap(window, screen->GetScreenPixmap(screen));
    return WT_WALKCHILDREN;
}

Bool bp_replace_root(ScreenPtr screen, unsigned width, unsigned height) {
    if (!bp_geometry(width, height)) return FALSE;
    PixmapPtr old = screen->GetScreenPixmap(screen);
    PixmapPtr fresh = screen->CreatePixmap(screen, width, height, screen->rootDepth,
        BPANE_TEST_SOFTWARE ? 0 : GLAMOR_CREATE_NO_LARGE);
    if (!fresh) return FALSE;
    if (!BPANE_TEST_SOFTWARE && !glamor_get_pixmap_texture(fresh)) {
        screen->DestroyPixmap(fresh);
        return FALSE;
    }
    GCPtr gc = GetScratchGC(screen->rootDepth, screen);
    if (!gc) { screen->DestroyPixmap(fresh); return FALSE; }
    /* Clear before publication; never reveal recycled GPU memory after resize. */
    ChangeGCVal values[2] = {{.val = 0}, {.val = FALSE}};
    ChangeGC(NULL, gc, GCForeground | GCGraphicsExposures, values);
    ValidateGC(&fresh->drawable, gc);
    xRectangle rect = {0, 0, width, height};
    gc->ops->PolyFillRect(&fresh->drawable, gc, 1, &rect);
    if (screen->root && old) {
        unsigned copy_w = width < old->drawable.width ? width : old->drawable.width;
        unsigned copy_h = height < old->drawable.height ? height : old->drawable.height;
        gc->ops->CopyArea(&old->drawable, &fresh->drawable, gc, 0, 0, copy_w, copy_h, 0, 0);
    }
    FreeScratchGC(gc);
    /* Glamor owns allocation/modifiers and submits copies on the same context.
     * Do not map it through a CPU shadow or claim this is a scanout flip. */
    screen->SetScreenPixmap(fresh);
    if (screen->root) TraverseTree(screen->root, replace_window, old);
    bp_capture_root(screen, fresh);
    if (old) screen->DestroyPixmap(old);
    return TRUE;
}

static Bool bp_resources(ScreenPtr screen) {
    BpScreen *state = bp_screen(screen);
    screen->CreateScreenResources = state->resources;
    Bool ok = screen->CreateScreenResources(screen);
    state->resources = screen->CreateScreenResources;
    screen->CreateScreenResources = bp_resources;
    return ok && bp_replace_root(screen, screen->width, screen->height)
        && bp_capture_init(screen);
}

static Bool bp_close(ScreenPtr screen) {
    BpScreen *state = bp_screen(screen);
    bp_capture_close(screen);
    bp_present_close(screen);
    screen->CreateScreenResources = state->resources;
    screen->CloseScreen = state->close;
    xf86ScreenToScrn(screen)->vtSema = FALSE;
    return screen->CloseScreen(screen);
}
static Bool bp_save(ScreenPtr screen, int mode) { (void)screen; (void)mode; return TRUE; }

Bool bp_screen_init(ScreenPtr screen, int argc, char **argv) {
    (void)argc; (void)argv;
    ScrnInfoPtr scrn = xf86ScreenToScrn(screen);
    BpScreen *state = bp_screen(screen);
    miClearVisualTypes();
    if (!miSetVisualTypes(scrn->depth, miGetDefaultVisualMask(scrn->depth), 8, TrueColor)
        || !miSetPixmapDepths()) return FALSE;
    if (BPANE_TEST_SOFTWARE) {
        state->test_pixels = calloc(1, bp_geometry(scrn->virtualX, scrn->virtualY));
        if (!state->test_pixels) return FALSE;
    }
    if (!fbScreenInit(screen, state->test_pixels, scrn->virtualX, scrn->virtualY,
        scrn->xDpi, scrn->yDpi, scrn->displayWidth, 32)) return FALSE;
    for (int i = 0; i < screen->numVisuals; i++) {
        VisualPtr visual = &screen->visuals[i];
        if ((visual->class | DynamicClass) != DirectColor) continue;
        visual->offsetRed = scrn->offset.red; visual->redMask = scrn->mask.red;
        visual->offsetGreen = scrn->offset.green; visual->greenMask = scrn->mask.green;
        visual->offsetBlue = scrn->offset.blue; visual->blueMask = scrn->mask.blue;
    }
    if (!fbPictureInit(screen, NULL, 0)) return FALSE;
    if (!BPANE_TEST_SOFTWARE) {
        if (!glamor_init(screen, GLAMOR_USE_EGL_SCREEN | GLAMOR_NO_DRI3)
            || !glamor_supports_pixmap_import_export(screen) || !bp_dri3_init(screen)) return FALSE;
    }
    if (!bp_randr_init(screen) || !bp_present_init(screen)) return FALSE;
    xf86SetBlackWhitePixels(screen);
    xf86SetBackingStore(screen);
    if (!miDCInitialize(screen, xf86GetPointerScreenFuncs()) || !fbCreateDefColormap(screen)) return FALSE;
    screen->SaveScreen = bp_save;
    state->resources = screen->CreateScreenResources;
    screen->CreateScreenResources = bp_resources;
    state->close = screen->CloseScreen;
    screen->CloseScreen = bp_close;
    scrn->vtSema = TRUE;
    return TRUE;
}

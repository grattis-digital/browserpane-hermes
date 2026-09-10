/* SPDX-License-Identifier: AGPL-3.0-only */
#include "bpane.h"
#include <string.h>

static Bool bp_info(ScreenPtr screen, Rotation *rotations) {
    (void)screen; *rotations = RR_Rotate_0; return TRUE;
}
static Bool bp_validate(ScreenPtr screen, RROutputPtr output, RRModePtr mode) {
    uint64_t period = (uint64_t)mode->mode.hTotal * mode->mode.vTotal;
    return output == bp_screen(screen)->output && bp_geometry(mode->mode.width, mode->mode.height)
        && mode->mode.hTotal >= mode->mode.width && mode->mode.vTotal >= mode->mode.height
        && mode->mode.dotClock >= period * 59 && mode->mode.dotClock <= period * 61
        && !(mode->mode.modeFlags & (RR_Interlace | RR_DoubleScan));
}
static Bool bp_crtc(ScreenPtr screen, RRCrtcPtr crtc, RRModePtr mode,
    int x, int y, Rotation rotation, int count, RROutputPtr *outputs) {
    BpScreen *state = bp_screen(screen);
    if (crtc != state->crtc || x || y || rotation != RR_Rotate_0) return FALSE;
    if (mode && (count != 1 || outputs[0] != state->output || !bp_validate(screen, outputs[0], mode)
        || mode->mode.width != screen->width || mode->mode.height != screen->height)) return FALSE;
    if (!mode && count) return FALSE;
    return RRCrtcNotify(crtc, mode, x, y, rotation, NULL, count, outputs);
}
static Bool bp_resize(ScreenPtr screen, CARD16 width, CARD16 height, CARD32 mm_w, CARD32 mm_h) {
    if (!bp_geometry(width, height) || !mm_w || !mm_h || mm_w > 32767 || mm_h > 32767) return FALSE;
    if (width != screen->width || height != screen->height) {
        if (!bp_replace_root(screen, width, height)) return FALSE;
    }
    /* Revalidate the entire window tree, not only the root's region boxes.
     * Otherwise existing GCs keep an empty/stale clip and swallow drawing. */
    SetRootClip(screen, ROOT_CLIP_NONE);
    ScrnInfoPtr scrn = xf86ScreenToScrn(screen);
    scrn->virtualX = scrn->displayWidth = screen->width = width;
    scrn->virtualY = screen->height = height;
    screen->mmWidth = mm_w; screen->mmHeight = mm_h;
    SetRootClip(screen, ROOT_CLIP_FULL);
    RRScreenSizeNotify(screen);
    return TRUE;
}

Bool bp_randr_init(ScreenPtr screen) {
    BpScreen *state = bp_screen(screen);
    if (!RRScreenInit(screen)) return FALSE;
    rrScrPrivPtr rr = rrGetScrPriv(screen);
    rr->rrGetInfo = bp_info;
    rr->rrScreenSetSize = bp_resize;
    rr->rrCrtcSet = bp_crtc;
    rr->rrOutputValidateMode = bp_validate;
    RRScreenSetSizeRange(screen, 32, 32, 8192, 8192);
    state->crtc = RRCrtcCreate(screen, state);
    state->output = RROutputCreate(screen, "DUMMY0", 6, state);
    if (!state->crtc || !state->output) return FALSE;
    RRCrtcSetRotations(state->crtc, RR_Rotate_0);
    RRCrtcSetTransformSupport(state->crtc, FALSE);
    if (!RRCrtcGammaSetSize(state->crtc, 0)
        || !RROutputSetCrtcs(state->output, &state->crtc, 1)
        || !RROutputSetConnection(state->output, RR_Connected)) return FALSE;
    const char *name = "1280x720";
    xRRModeInfo info = {.width = 1280, .height = 720, .hTotal = 1280, .vTotal = 720,
        .dotClock = 1280 * 720 * 60, .nameLength = 8};
    RRModePtr mode = RRModeGet(&info, name);
    if (!mode) return FALSE;
    /* RROutputSetModes takes ownership of this reference; it does NOT add one.
     * Releasing it after success leaves the output pointing at a freed mode
     * when the CRTC is disabled or the server shuts down. */
    if (!RROutputSetModes(state->output, &mode, 1, 1)) {
        RRModeDestroy(mode);
        return FALSE;
    }
    return RRCrtcNotify(state->crtc, mode, 0, 0, RR_Rotate_0, NULL, 1, &state->output);
}

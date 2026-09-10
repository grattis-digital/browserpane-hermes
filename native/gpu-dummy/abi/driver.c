/* SPDX-License-Identifier: AGPL-3.0-only
 * Xorg video ABI 25: no guessed Rust layouts, DRM master, KMS or hardware input.
 */
#include "bpane.h"
#include <xf86Modes.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <xf86drm.h>
#include <epoxy/gl.h>

static void bp_free(ScrnInfoPtr scrn) {
    BpScreen *state = scrn->driverPrivate;
    if (!state) return;
    if (state->fd >= 0) close(state->fd);
    free(state->test_pixels);
    bp_clock_free(state->clock);
    free(state);
    scrn->driverPrivate = NULL;
}

static Bool bp_enter(ScrnInfoPtr scrn) { scrn->vtSema = TRUE; return TRUE; }
static void bp_leave(ScrnInfoPtr scrn) { scrn->vtSema = FALSE; }
static void bp_adjust(ScrnInfoPtr scrn, int x, int y) { (void)scrn; (void)x; (void)y; }
static Bool bp_switch(ScrnInfoPtr scrn, DisplayModePtr mode) {
    return mode->HDisplay == scrn->virtualX && mode->VDisplay == scrn->virtualY;
}
static ModeStatus bp_mode(ScrnInfoPtr scrn, DisplayModePtr mode, Bool verbose, int flags) {
    (void)scrn; (void)verbose; (void)flags;
    return bp_geometry(mode->HDisplay, mode->VDisplay) && !(mode->Flags & (V_INTERLACE | V_DBLSCAN))
        ? MODE_OK : MODE_BAD;
}

static Bool bp_gpu(ScrnInfoPtr scrn) {
    BpScreen *state = scrn->driverPrivate;
    /* Fixed container alias is deliberately not an arbitrary option/file path. */
    state->fd = open("/dev/bpane-render", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    if (state->fd < 0 || drmGetNodeTypeFromFd(state->fd) != DRM_NODE_RENDER) return FALSE;
    drmVersionPtr version = drmGetVersion(state->fd);
    Bool supported = version && version->name_len == 3 && memcmp(version->name, "v3d", 3) == 0;
    if (version) drmFreeVersion(version);
    if (!supported || !xf86LoadSubModule(scrn, GLAMOR_EGL_MODULE_NAME)) return FALSE;
    if (!glamor_egl_init(scrn, state->fd)) return FALSE;
    const char *renderer = (const char *)glGetString(GL_RENDERER);
    if (!renderer || !strstr(renderer, "V3D") || strstr(renderer, "llvmpipe")) return FALSE;
    xf86DrvMsg(scrn->scrnIndex, X_INFO, "BPANE_V3D_EGL_READY\n");
    return TRUE;
}

static Bool bp_preinit(ScrnInfoPtr scrn, int flags) {
    if ((flags & PROBE_DETECT) || scrn->numEntities != 1) return FALSE;
    BpScreen *state = calloc(1, sizeof(*state));
    if (!state) return FALSE;
    state->fd = -1;
    scrn->driverPrivate = state;
    scrn->monitor = scrn->confScreen->monitor;
    scrn->chipset = "BrowserPane render-node virtual display";
    if (!xf86SetDepthBpp(scrn, 24, 0, 32, Support32bppFb) || scrn->depth != 24 || scrn->bitsPerPixel != 32)
        return FALSE;
    rgb weight = {0, 0, 0};
    Gamma gamma = {0, 0, 0};
    if (!xf86SetWeight(scrn, weight, weight) || !xf86SetDefaultVisual(scrn, TrueColor)
        || !xf86SetGamma(scrn, gamma)) return FALSE;
    xf86SetDpi(scrn, 96, 96);
    scrn->rgbBits = 8;
    scrn->virtualX = scrn->displayWidth = 1280;
    scrn->virtualY = 720;
    scrn->videoRam = 65536;
    scrn->progClock = TRUE;
    scrn->modes = xf86CVTMode(1280, 720, 60, TRUE, FALSE);
    if (!scrn->modes) return FALSE;
    scrn->modes->next = scrn->modes->prev = scrn->modes;
    scrn->currentMode = scrn->modes;
    if (!xf86LoadSubModule(scrn, "fb")) return FALSE;
    state->clock = bp_clock_new(bp_now(), 60);
    if (!state->clock) return FALSE;
    if (BPANE_TEST_SOFTWARE) {
        xf86DrvMsg(scrn->scrnIndex, X_WARNING, "BPANE_TEST_SOFTWARE_ONLY: NOT GPU QUALIFICATION\n");
        return TRUE;
    }
    if (!bp_gpu(scrn)) {
        xf86DrvMsgVerb(scrn->scrnIndex, X_ERROR, 0, "BPANE_GPU_INIT_FAILED: requires V3D render-node EGL; no software fallback\n");
        return FALSE;
    }
    return TRUE;
}

static Bool bp_probe(DriverPtr driver, int flags) {
    GDevPtr *sections = NULL;
    if (flags & PROBE_DETECT) return FALSE;
    int count = xf86MatchDevice("bpane", &sections);
    if (count != 1) { free(sections); return FALSE; }
    int entity = xf86ClaimNoSlot(driver, 0, sections[0], TRUE);
    free(sections);
    ScrnInfoPtr scrn = xf86AllocateScreen(driver, 0);
    if (!scrn || entity < 0) return FALSE;
    xf86AddEntityToScreen(scrn, entity);
    scrn->driverVersion = 1;
    scrn->driverName = "bpane";
    scrn->name = "BPANE";
    scrn->Probe = bp_probe;
    scrn->PreInit = bp_preinit;
    scrn->ScreenInit = bp_screen_init;
    scrn->SwitchMode = bp_switch;
    scrn->AdjustFrame = bp_adjust;
    scrn->EnterVT = bp_enter;
    scrn->LeaveVT = bp_leave;
    scrn->FreeScreen = bp_free;
    scrn->ValidMode = bp_mode;
    return TRUE;
}

static Bool bp_function(ScrnInfoPtr scrn, xorgDriverFuncOp op, void *data) {
    (void)scrn;
    if (op != GET_REQUIRED_HW_INTERFACES) return FALSE;
    *(CARD32 *)data = HW_SKIP_CONSOLE;
    return TRUE;
}
static const OptionInfoRec *bp_options(int chip, int bus) { (void)chip; (void)bus; return NULL; }
static void bp_identify(int flags) { (void)flags; }
static DriverRec driver = {
    .driverVersion = 1, .driverName = "bpane", .Identify = bp_identify,
    .Probe = bp_probe, .AvailableOptions = bp_options, .driverFunc = bp_function,
};
static void *bp_setup(void *module, void *options, int *major, int *minor) {
    static Bool registered;
    (void)options; (void)minor;
    if (registered) { if (major) *major = LDR_ONCEONLY; return NULL; }
    registered = TRUE;
    xf86AddDriver(&driver, module, HaveDriverFuncs);
    return module;
}
static XF86ModuleVersionInfo version = {
    "bpane", "BrowserPane Hermes", MODINFOSTRING1, MODINFOSTRING2,
    XORG_VERSION_CURRENT, 0, 1, 0, ABI_CLASS_VIDEODRV, ABI_VIDEODRV_VERSION,
    MOD_CLASS_VIDEODRV, {0, 0, 0, 0}
};
_X_EXPORT XF86ModuleData bpaneModuleData = { &version, bp_setup, NULL };

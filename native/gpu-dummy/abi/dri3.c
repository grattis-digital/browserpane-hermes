/* SPDX-License-Identifier: AGPL-3.0-only
 * Mesa owns buffer import/export, formats and modifiers; this DDX owns FD access.
 */
#include "bpane.h"
#include <dri3.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

static int bp_open_client(ClientPtr client, ScreenPtr screen, RRProviderPtr provider, int *output) {
    (void)client;
    if (provider) return BadMatch;
    /* A fresh open gives each DRI3 client a separate DRM file context. dup() would
     * share the server's context. Never authenticate a primary/KMS device here. */
    int fd = open("/dev/bpane-render", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    struct stat opened, original;
    if (fd < 0) return BadAlloc;
    if (fstat(fd, &opened) || fstat(bp_screen(screen)->fd, &original)
        || !S_ISCHR(opened.st_mode) || opened.st_rdev != original.st_rdev) {
        close(fd);
        return BadMatch;
    }
    *output = fd;
    return Success;
}

Bool bp_dri3_init(ScreenPtr screen) {
    static const dri3_screen_info_rec callbacks = {
        .version = 2, .open_client = bp_open_client,
        .pixmap_from_fd = glamor_pixmap_from_fd, .pixmap_from_fds = glamor_pixmap_from_fds,
        .fd_from_pixmap = glamor_fd_from_pixmap, .fds_from_pixmap = glamor_fds_from_pixmap,
        .get_formats = glamor_get_formats, .get_modifiers = glamor_get_modifiers,
        .get_drawable_modifiers = glamor_get_drawable_modifiers,
    };
    return dri3_screen_init(screen, &callbacks);
}

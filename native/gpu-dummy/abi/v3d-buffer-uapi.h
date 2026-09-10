/* SPDX-License-Identifier: MIT
 * Copyright © 2014-2018 Broadcom
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */
#ifndef BPANE_V3D_BUFFER_UAPI_H
#define BPANE_V3D_BUFFER_UAPI_H
#include <drm.h>
#include <stddef.h>
/* Minimal public allocation UAPI from Mesa mesa-25.0.7,
 * include/drm-uapi/v3d_drm.h; Debian libdrm-dev omits this V3D header.
 * No command submission, CPU mapping or private Mesa ABI is vendored. */
struct bp_v3d_create_bo { __u32 size, flags, handle, offset; };
#define BP_V3D_CREATE_BO DRM_IOWR(DRM_COMMAND_BASE + 0x02, struct bp_v3d_create_bo)
_Static_assert(sizeof(struct bp_v3d_create_bo)==16,"V3D BO UAPI size");
_Static_assert(offsetof(struct bp_v3d_create_bo,handle)==8,"V3D BO UAPI handle");
#endif

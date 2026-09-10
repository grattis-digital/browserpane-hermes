/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_LEASE_CLIENT_H
#define BPANE_LEASE_CLIENT_H
#include "lease-wire.h"
#include <xcb/xcb.h>
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <gbm.h>
#include <assert.h>
typedef struct {
    BpLeaseReply wire;
    int fds[5];
    EGLImageKHR image;
    GLuint texture, framebuffer;
} LeaseFrame;
typedef struct { int fd; struct gbm_device *gbm; EGLDisplay display; EGLContext context; } LeaseGpu;
xcb_connection_t *lease_connect(void);
BpLeaseReply *lease_request(xcb_connection_t *, unsigned minor, const BpLeaseReply *, unsigned bytes, unsigned error);
LeaseFrame lease_acquire(xcb_connection_t *, unsigned status);
void lease_release(xcb_connection_t *, LeaseFrame *);
LeaseGpu lease_gpu(void);
void lease_import(LeaseGpu *, LeaseFrame *);
void lease_destroy(LeaseGpu *, LeaseFrame *);
void lease_gpu_close(LeaseGpu *);
void lease_pixels(LeaseFrame *, uint32_t background, uint32_t patch);
void lease_diff(LeaseFrame *, LeaseFrame *, unsigned expected, double timing[3]);
void lease_scroll_checks(xcb_connection_t *, xcb_screen_t *, xcb_gcontext_t, LeaseGpu *);
double lease_now(void);
#endif

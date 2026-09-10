/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-client.h"
#include <xcb/xcbext.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <stdio.h>

static xcb_extension_t extension = {BP_LEASE_NAME, 0};

xcb_connection_t *lease_connect(void) {
    xcb_connection_t *connection = xcb_connect(NULL, NULL);
    assert(connection && !xcb_connection_has_error(connection));
    const xcb_query_extension_reply_t *info = xcb_get_extension_data(connection, &extension);
    assert(info && info->present);
    return connection;
}

BpLeaseReply *lease_request(xcb_connection_t *connection, unsigned minor,
                          const BpLeaseReply *token, unsigned bytes, unsigned error) {
    assert(bytes <= 20 && bytes % 4 == 0);
    struct { BpLeaseRequest wire; uint32_t trailing; } request = {0};
    if (token) {
        request.wire.slot = token->slot; request.wire.lease = token->lease;
        request.wire.generation = token->generation;
    }
    struct iovec parts[4] = {{0}};
    parts[2].iov_base = &request;
    parts[2].iov_len = bytes;
    xcb_protocol_request_t protocol = {.count = 2, .ext = &extension, .opcode = minor, .isvoid = 0};
    unsigned sequence = xcb_send_request(connection, XCB_REQUEST_CHECKED | XCB_REQUEST_REPLY_FDS, parts + 2, &protocol);
    xcb_generic_error_t *failure = NULL;
    BpLeaseReply *reply = xcb_wait_for_reply(connection, sequence, &failure);
    if (error) {
        assert(failure && failure->error_code == error && !reply);
        free(failure);
        return NULL;
    }
    if (failure) fprintf(stderr, "lease X error=%u minor=%u\n", failure->error_code, minor);
    assert(!failure && reply && reply->length == 24 && reply->version == BP_LEASE_VERSION);
    assert(reply->nfd <= 5);
    return reply;
}

LeaseFrame lease_acquire(xcb_connection_t *connection, unsigned status) {
    BpLeaseReply *reply = lease_request(connection, BP_ACQUIRE, NULL, 16, 0);
    assert(reply->status == status);
    LeaseFrame frame = {.wire = *reply, .fds = {-1, -1, -1, -1, -1}};
    if (status == BP_OK) {
        assert(reply->planes >= 1 && reply->planes <= 4 && reply->nfd == reply->planes + 1);
        int *fds = xcb_get_reply_fds(connection, reply, sizeof(*reply));
        for (unsigned i = 0; i < reply->nfd; i++) { assert(fds[i] >= 0); frame.fds[i] = fds[i]; }
    } else assert(!reply->nfd);
    free(reply);
    return frame;
}

void lease_release(xcb_connection_t *connection, LeaseFrame *frame) {
    /* Caller has completed all GPU reads, including any asynchronous analysis. */
    free(lease_request(connection, BP_RELEASE, &frame->wire, 16, 0));
    for (unsigned i = 0; i < 5; i++) {
        if (frame->fds[i] >= 0) close(frame->fds[i]);
        frame->fds[i] = -1;
    }
}

double lease_now(void) {
    struct timespec time;
    assert(clock_gettime(CLOCK_MONOTONIC, &time) == 0);
    return time.tv_sec * 1000.0 + time.tv_nsec / 1000000.0;
}

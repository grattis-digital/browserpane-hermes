/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease.h"
#include <extnsionst.h>
#include <dix.h>
#include <unistd.h>

/* This DDX supports exactly one screen. No worker shares Xorg's EGL context. */
static struct BpCapture *active;

static void client_state(CallbackListPtr *list, void *closure, void *data) {
    (void)list;
    struct BpCapture *capture = closure;
    ClientPtr client = ((NewClientInfoRec *)data)->client;
    if (client == capture->owner && (client->clientState == ClientStateGone || client->clientState == ClientStateRetained))
        bp_capture_reset(capture);
}

static int acquire(ClientPtr client, struct BpCapture *capture, BpLeaseReply *reply) {
    if (!capture->supported) { reply->status = BP_UNAVAILABLE; return Success; }
    uint32_t token[3];
    if (!bp_pool_begin(capture->pool, token)) { reply->status = BP_BUSY; return Success; }
    reply->slot = token[0]; reply->lease = token[1]; reply->generation = token[2];
    int fds[5] = {-1, -1, -1, -1, -1};
    Bool ok = bp_capture_export(capture, reply, fds);
    if (ok) {
        for (unsigned i = 0; i < reply->nfd; i++) {
            if (WriteFdToClient(client, fds[i], TRUE) < 0) {
                /* Queued FDs belong to Xtrans. Close only those not transferred. */
                MarkClientException(client);
                ok = FALSE;
                break;
            }
            fds[i] = -1;
        }
    }
    for (unsigned i = 0; i < 5; i++) if (fds[i] >= 0) close(fds[i]);
    if (!ok) {
        bp_pool_end(capture->pool, token, false);
        return BadAlloc;
    }
    capture->owner = client;
    bp_pool_end(capture->pool, token, true);
    return Success;
}

static int dispatch(ClientPtr client) {
    if (!active || !client->local || client->swapped) return BadAccess;
    if (client->req_len != sizeof(BpLeaseRequest) / 4) return BadLength;
    BpLeaseRequest *request = client->requestBuffer;
    if (request->minor > BP_RELEASE) return BadRequest;
    if (request->minor != BP_RELEASE && (request->slot || request->lease || request->generation)) return BadValue;
    if (request->minor != BP_QUERY && active->owner && active->owner != client) return BadAccess;
    BpLeaseReply reply = {.type = X_Reply, .sequence = client->sequence,
                         .length = (sizeof(reply) - 32) / 4, .version = BP_LEASE_VERSION};
    int result = Success;
    // Additive query capability: old drivers report zero and cannot run video
    // concurrently with both tile snapshots. Frame and release ABI is unchanged.
    if (request->minor == BP_QUERY) reply.reserved[0] = 3;
    if (request->minor == BP_ACQUIRE) result = acquire(client, active, &reply);
    if (request->minor == BP_RELEASE) {
        uint32_t token[3] = {request->slot, request->lease, request->generation};
        if (active->owner != client || !bp_pool_end(active->pool, token, false)) return BadValue;
    }
    if (result != Success) return result;
    WriteToClient(client, sizeof(reply), &reply);
    return Success;
}

Bool bp_capture_extension(struct BpCapture *capture) {
    if (active || CheckExtension(BP_LEASE_NAME)) return FALSE;
    if (!AddCallback(&ClientStateCallback, client_state, capture)) return FALSE;
    if (!AddExtension(BP_LEASE_NAME, 0, 0, dispatch, dispatch, NULL, StandardMinorOpcode)) {
        DeleteCallback(&ClientStateCallback, client_state, capture);
        return FALSE;
    }
    active = capture;
    return TRUE;
}

void bp_capture_extension_close(struct BpCapture *capture) {
    if (active != capture) return;
    DeleteCallback(&ClientStateCallback, client_state, capture);
    active = NULL;
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_LEASE_WIRE_H
#define BPANE_LEASE_WIRE_H
#include <stdint.h>
#define BP_LEASE_NAME "BPANE-GPU-LEASE"
#define BP_LEASE_VERSION 1
enum { BP_QUERY = 0, BP_ACQUIRE = 1, BP_RELEASE = 2 };
enum { BP_OK = 0, BP_BUSY = 1, BP_UNAVAILABLE = 2 };
/* Experimental, native-endian local X11 only. Every request has exact size. */
typedef struct {
    uint8_t major, minor;
    uint16_t length;
    uint32_t slot, lease, generation;
} BpLeaseRequest;
typedef struct {
    uint8_t type, nfd;
    uint16_t sequence;
    uint32_t length;
    uint32_t status, slot, lease, generation, width, height;
    uint32_t fourcc, planes;
    uint64_t modifier;
    uint32_t strides[4], offsets[4];
    uint32_t copied_pixels, version, reserved[10];
} BpLeaseReply;
_Static_assert(sizeof(BpLeaseRequest) == 16, "request ABI");
_Static_assert(sizeof(BpLeaseReply) == 128, "reply ABI");
#endif

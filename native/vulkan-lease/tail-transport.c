/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"
#include <sys/socket.h>
#include <unistd.h>
#include <errno.h>

uint8_t *tail_transport(const TailPacket *packet, double *milliseconds) {
    int sockets[2]; REQUIRE(!socketpair(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0,sockets));
    uint8_t *received=malloc(packet->size); REQUIRE(received);
    size_t sent=0,read=0; double start=lease_now();
    while (read<packet->size) {
        if (sent<packet->size) {
            size_t remaining=packet->size-sent; if (remaining>65536) remaining=65536;
            // Directly from the final mapped GPU buffer. No CPU repacking or
            // encoder, and no extra user-space sender-side memcpy.
            ssize_t n=send(sockets[0],packet->bytes+sent,remaining,MSG_DONTWAIT|MSG_NOSIGNAL);
            REQUIRE(n>0 || errno==EAGAIN || errno==EINTR); if (n>0) sent+=(size_t)n;
        }
        if (read<sent) {
            ssize_t n=recv(sockets[1],received+read,sent-read,0);
            REQUIRE(n>0 || errno==EINTR); if (n>0) read+=(size_t)n;
        }
    }
    REQUIRE(sent==packet->size); *milliseconds=lease_now()-start;
    close(sockets[0]); close(sockets[1]); return received;
}

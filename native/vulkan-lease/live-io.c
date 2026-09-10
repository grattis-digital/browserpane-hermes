/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include <errno.h>
#include <poll.h>
#include <unistd.h>

uint32_t live_u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
uint64_t live_u64(const uint8_t *p) { return live_u32(p) | (uint64_t)live_u32(p+4)<<32; }

void live_write(const void *buffer, size_t length) {
    const uint8_t *bytes=buffer;
    double end=lease_now()+5000;
    while (length) {
        struct pollfd fd={STDOUT_FILENO,POLLOUT,0};
        int remaining=(int)(end-lease_now()); REQUIRE(remaining>0);
        int ready=poll(&fd,1,remaining);
        if (ready<0 && errno==EINTR) continue;
        REQUIRE(ready>0 && !(fd.revents&(POLLERR|POLLHUP|POLLNVAL)));
        ssize_t written=write(STDOUT_FILENO,bytes,length>4096?4096:length);
        if (written<0 && (errno==EINTR || errno==EAGAIN)) continue;
        REQUIRE(written>0); bytes+=written; length-=(size_t)written;
    }
}

bool live_read(uint8_t command[16]) {
    size_t at=0;
    double end=lease_now()+1000;
    while (at<16) {
        struct pollfd fd={STDIN_FILENO,POLLIN,0};
        int remaining=(int)(end-lease_now()); REQUIRE(remaining>0);
        int ready=poll(&fd,1,remaining);
        if (ready<0 && errno==EINTR) continue;
        REQUIRE(ready>0);
        ssize_t n=read(STDIN_FILENO,command+at,16-at);
        if (n<0 && (errno==EINTR || errno==EAGAIN)) continue;
        if (!n) { REQUIRE(!at); return false; }
        REQUIRE(n>0); at+=(size_t)n;
    }
    return true;
}

void live_begin(uint64_t epoch, uint32_t serial) {
    uint8_t frame[19]={11,14,0,0,0,0x0d,1};
    for (unsigned i=0;i<8;i++) frame[7+i]=(uint8_t)(epoch>>(8*i));
    for (unsigned i=0;i<4;i++) frame[15+i]=(uint8_t)(serial>>(8*i));
    live_write(frame,sizeof(frame));
}

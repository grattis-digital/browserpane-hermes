/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-wire.h"
#include <assert.h>
#include <stddef.h>
#include <string.h>
int main(void) {
    _Static_assert(offsetof(BpLeaseReply, modifier) == 40, "modifier offset");
    _Static_assert(offsetof(BpLeaseReply, copied_pixels) == 80, "copy count offset");
    _Static_assert(offsetof(BpLeaseReply, reserved) == 88, "reserved offset");
    const BpLeaseRequest request = {.major = 201, .minor = 2, .length = 4,
                                   .slot = 1, .lease = 0x12345678, .generation = 9};
#if __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    const unsigned char bytes[16] = {201, 2, 4, 0, 1, 0, 0, 0, 0x78, 0x56, 0x34, 0x12, 9, 0, 0, 0};
    const unsigned char reply_bytes[128] = {
        [0]=1, [1]=2, [2]=0x56, [3]=0x34, [4]=24, [12]=1,
        [16]=0x78, [17]=0x56, [18]=0x34, [19]=0x12, [20]=9,
        [25]=5, [28]=0xd0, [29]=2, [32]=0x41, [33]=0x52, [34]=0x32, [35]=0x34,
        [36]=1, [41]=1, [45]=2, [49]=20, [81]=16, [84]=1
    };
#else
    const unsigned char bytes[16] = {201, 2, 0, 4, 0, 0, 0, 1, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 9};
    const unsigned char reply_bytes[128] = {
        [0]=1, [1]=2, [2]=0x34, [3]=0x56, [7]=24, [15]=1,
        [16]=0x12, [17]=0x34, [18]=0x56, [19]=0x78, [23]=9,
        [26]=5, [30]=2, [31]=0xd0, [32]=0x34, [33]=0x32, [34]=0x52, [35]=0x41,
        [39]=1, [42]=2, [46]=1, [50]=20, [82]=16, [87]=1
    };
#endif
    const BpLeaseReply reply = {.type=1, .nfd=2, .sequence=0x3456, .length=24,
        .slot=1, .lease=0x12345678, .generation=9, .width=1280, .height=720,
        .fourcc=0x34325241, .planes=1, .modifier=UINT64_C(0x20000000100),
        .strides={5120}, .copied_pixels=4096, .version=1};
    assert(!memcmp(&request, bytes, sizeof(bytes)));
    assert(!memcmp(&reply, reply_bytes, sizeof(reply_bytes)));
    return 0;
}

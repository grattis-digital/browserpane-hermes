/* SPDX-License-Identifier: AGPL-3.0-only */
/* Independent receiving-side oracle for standard QOI, not a CPU encoder. */
#include "tail.h"
#include <string.h>

bool tail_qoi_decode(const uint8_t *data, size_t size, uint32_t **pixels, unsigned *width, unsigned *height) {
    if (size<23 || memcmp(data,"qoif",4) || data[4] || data[5] || data[6] ||
        data[8] || data[9] || data[10] || data[12]!=4 || data[13]!=0) return false;
    unsigned w=data[7],h=data[11]; if (!w || w>64 || !h || h>64) return false;
    uint32_t *out=malloc(w*h*4); REQUIRE(out);
    uint32_t index[64]={0},value=0xff000000; unsigned used=0; size_t at=14;
    while (used<w*h && at<size-8) {
        uint8_t tag=data[at++]; unsigned run=1;
        int r=value&255,g=(value>>8)&255,b=(value>>16)&255,a=value>>24;
        if (tag==0xfe || tag==0xff) {
            unsigned n=tag==0xfe?3:4; if (at+n>size-8) goto bad;
            r=data[at++]; g=data[at++]; b=data[at++]; if (n==4) a=data[at++];
        } else if ((tag&0xc0)==0) {
            value=index[tag]; r=value&255; g=(value>>8)&255; b=(value>>16)&255; a=value>>24;
        } else if ((tag&0xc0)==0x40) {
            r+=((tag>>4)&3)-2; g+=((tag>>2)&3)-2; b+=(tag&3)-2;
        } else if ((tag&0xc0)==0x80) {
            if (at>=size-8) goto bad;
            int dg=(tag&63)-32; uint8_t next=data[at++];
            r+=dg+(next>>4)-8; g+=dg; b+=dg+(next&15)-8;
        } else run=(tag&63)+1;
        value=(uint32_t)(r&255)|((uint32_t)(g&255)<<8)|((uint32_t)(b&255)<<16)|((uint32_t)(a&255)<<24);
        index[((r&255)*3+(g&255)*5+(b&255)*7+(a&255)*11)%64]=value;
        if (run>w*h-used) goto bad;
        while (run--) out[used++]=value;
    }
    static const uint8_t ending[8]={0,0,0,0,0,0,0,1};
    if (used!=w*h || at+8!=size || memcmp(data+at,ending,8)) goto bad;
    *pixels=out; *width=w; *height=h; return true;
bad:
    free(out); return false;
}

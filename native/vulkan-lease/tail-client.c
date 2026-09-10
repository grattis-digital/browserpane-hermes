/* SPDX-License-Identifier: AGPL-3.0-only */
/* Transactional receiving-side test peer. Never used by the GPU sender. */
#include "tail.h"
#include <string.h>

static unsigned u16(const uint8_t *p) { return (unsigned)p[0]|((unsigned)p[1]<<8); }
static uint32_t u32(const uint8_t *p) { return u16(p)|((uint32_t)u16(p+2)<<16); }
static uint64_t u64(const uint8_t *p) { return u32(p)|((uint64_t)u32(p+4)<<32); }

void tail_client_evict(TailClient *c) {
    for (unsigned i=0;i<1024;i++) { free(c->cache[i].pixels); c->cache[i]=(ClientTile){0}; }
    c->cursor=0;
}
void tail_client_close(TailClient *c) { tail_client_evict(c); free(c->canvas); *c=(TailClient){0}; }

static const ClientTile *find(const TailClient *c, ClientTile *pending, unsigned count, uint64_t token, bool reset) {
    for (unsigned i=0;i<count;i++) if (pending[i].token==token) return &pending[i];
    if (!reset) for (unsigned i=0;i<1024;i++) if (c->cache[i].pixels && c->cache[i].token==token) return &c->cache[i];
    return NULL;
}

bool tail_client_decode(TailClient *c, const uint8_t *bytes, size_t size, unsigned serial) {
    unsigned w=c->width,h=c->height,count=0;
    uint32_t *canvas=NULL; ClientTile pending[512]={0}; bool reset=false,ended=false,scrolled=false;
    if (w && h) { canvas=malloc((size_t)w*h*4); REQUIRE(canvas); memcpy(canvas,c->canvas,(size_t)w*h*4); }
    size_t at=0;
    VideoRect video=c->video;
    while (at<size) {
        if (size-at<5 || bytes[at]!=11) goto bad;
        unsigned n=u32(bytes+at+1); at+=5;
        if (!n || n>size-at || ended) goto bad;
        const uint8_t *data=bytes+at; at+=n; unsigned tag=data[0];
        if (tag==1) {
            if (at!=16 || n!=11 || u16(data+1)!=64) goto bad;
            w=u16(data+7); h=u16(data+9);
            if (w<32 || h<32 || w>1920 || h>1080 || u16(data+3)!=(w+63)/64 || u16(data+5)!=(h+63)/64) goto bad;
            free(canvas); canvas=calloc((size_t)w*h,4); REQUIRE(canvas); reset=true; continue;
        }
        if (!canvas) goto bad;
        if (tag==5) {
            if (n!=9) goto bad;
            video=(VideoRect){u16(data+1),u16(data+3),u16(data+5),u16(data+7)};
            if (!video_rect_valid(video,w,h)) goto bad;
            continue;
        }
        if (tag==6) { if (n!=5 || u32(data+1)!=serial || serial<=c->serial) goto bad; ended=true; continue; }
        if (tag==7) {
            if (n!=11 || scrolled || reset || u16(data+1)!=0 || u16(data+5)!=0 || u16(data+7)!=h || u16(data+9)!=w) goto bad;
            int dy=(int16_t)u16(data+3); if (!dy || dy<-64 || dy>64) goto bad;
            uint32_t *old=malloc((size_t)w*h*4); REQUIRE(old); memcpy(old,canvas,(size_t)w*h*4);
            for (unsigned y=0;y<h;y++) {
                int source=(int)y+dy;
                if (source>=0 && source<(int)h) memcpy(canvas+y*w,old+source*w,w*4);
            }
            free(old); scrolled=true; continue;
        }
        if ((tag==2 && n!=13) || (tag==3 && n!=9) || (tag==4 && n<40) || (tag!=2 && tag!=3 && tag!=4)) goto bad;
        unsigned x=u16(data+1)*64,y=u16(data+3)*64;
        if (x>=w || y>=h) goto bad;
        unsigned tw=w-x<64?w-x:64,th=h-y<64?h-y:64; const uint32_t *pixels=NULL;
        if (tag==2) {
            const ClientTile *tile=find(c,pending,count,u64(data+5),reset);
            if (!tile || tile->width!=tw || tile->height!=th) goto bad;
            pixels=tile->pixels;
        } else if (tag==4) {
            if (count==512 || u32(data+13)!=n-17) goto bad;
            ClientTile *tile=&pending[count];
            if (!tail_qoi_decode(data+17,n-17,&tile->pixels,&tile->width,&tile->height)) goto bad;
            tile->token=u64(data+5); count++;
            if (!tile->token || tile->width!=tw || tile->height!=th || find(c,pending,count-1,tile->token,reset)) goto bad;
            pixels=tile->pixels;
        }
        for (unsigned yy=0;yy<th;yy++) for (unsigned xx=0;xx<tw;xx++)
            canvas[(y+yy)*w+x+xx]=tag==3?u32(data+5):pixels[yy*tw+xx];
    }
    if (!ended) goto bad;
    if (reset) tail_client_evict(c);
    for (unsigned i=0;i<count;i++) {
        unsigned slot=c->cursor++%1024; free(c->cache[slot].pixels); c->cache[slot]=pending[i];
    }
    free(c->canvas); c->canvas=canvas; c->width=w; c->height=h; c->serial=serial;
    c->video=video;
    return true;
bad:
    for (unsigned i=0;i<count;i++) free(pending[i].pixels);
    free(canvas); return false;
}

void tail_client_check(const TailClient *c, unsigned scenario) {
    for (unsigned y=0;y<c->height;y++) for (unsigned x=0;x<c->width;x++) {
        uint32_t expected=fixture_color(x,y,c->width,c->height,scenario);
        uint32_t value=c->canvas[y*c->width+x];
        uint32_t actual=((value&255)<<16)|(value&0xff00)|((value>>16)&255);
        if (actual!=expected || (value>>24)!=255) {
            fprintf(stderr,"tail pixel mismatch scenario=%u at %u,%u got=%08x want=%08x\n",scenario,x,y,actual,expected);
            REQUIRE(false);
        }
    }
}

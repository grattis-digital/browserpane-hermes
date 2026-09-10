/* SPDX-License-Identifier: AGPL-3.0-only */
/* Disposable display only: deterministic moving pixels, no browser/profile. */
#include <assert.h>
#include <stdbool.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <xcb/xcb.h>

static double now(void) {
    struct timespec t; assert(!clock_gettime(CLOCK_MONOTONIC,&t));
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
}
static uint32_t u32(const uint8_t *p) { return p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24; }
static unsigned u16(const uint8_t *p) { return p[0]|(unsigned)p[1]<<8; }
static void put(uint8_t *p,uint64_t n,unsigned bytes) { for (unsigned i=0;i<bytes;i++) p[i]=n>>(8*i); }
static void exact(int fd,uint8_t *p,unsigned n) {
    while(n) {
        struct pollfd pollfd={fd,POLLIN,0}; assert(poll(&pollfd,1,2000)>0);
        ssize_t got=read(fd,p,n); assert(got>0); p+=got; n-=got;
    }
}
int main(void) {
    assert(getenv("BPANE_GPU_VIDEO_TEST") && !strcmp(getenv("BPANE_GPU_VIDEO_TEST"),"1"));
    assert(getuid()==10000);
    xcb_connection_t *x=xcb_connect(NULL,NULL); assert(x && !xcb_connection_has_error(x));
    xcb_screen_t *screen=xcb_setup_roots_iterator(xcb_get_setup(x)).data;
    assert(screen && screen->width_in_pixels==1280 && screen->height_in_pixels==720);
    xcb_gcontext_t gc=xcb_generate_id(x); xcb_create_gc(x,gc,screen->root,0,NULL);
    int fd=socket(AF_UNIX,SOCK_STREAM|SOCK_CLOEXEC,0); assert(fd>=0);
    struct sockaddr_un address={.sun_family=AF_UNIX}; strcpy(address.sun_path,"/tmp/.X11-unix/bpane-gpu-tail.sock");
    assert(!connect(fd,(struct sockaddr *)&address,sizeof(address)));
    uint8_t *payload=malloc(9*1024*1024); assert(payload);
    uint8_t ack[16]={0x0e,1},hint[16]={0x10,1};
    unsigned rect[4]={0},batches=0,video=0,moved=0,after_exit=0,measured=0;
    uint64_t last_pts=0;
    double start=now(),paint_at=0,hint_at=0,ack_at=0,last_video=0,max_gap=0;
    bool pending=false,inside=false;
    while(now()-start<12000) {
        double t=now()-start;
        unsigned left=t<8000?32:160;
        if(t>=paint_at) {
            uint32_t color=(unsigned)(t/250)%2?0xd22823:0x1eb432;
            xcb_change_gc(x,gc,XCB_GC_FOREGROUND,&color);
            xcb_rectangle_t r={left,64,640,360};
            xcb_poly_fill_rectangle(x,screen->root,gc,1,&r); xcb_flush(x); paint_at=t+1000.0/30;
        }
        if(t>=hint_at) {
            unsigned values[]={t<10000?left:0,t<10000?64:0,t<10000?640:0,t<10000?360:0,1280,720};
            for(unsigned i=0;i<6;i++) put(hint+2+2*i,values[i],2);
            assert(write(fd,hint,16)==16); hint_at=t+100;
        }
        if(pending && t>=ack_at) { assert(write(fd,ack,16)==16); pending=false; }
        struct pollfd pollfd={fd,POLLIN,0}; int ready=poll(&pollfd,1,2); assert(ready>=0);
        if(!ready) continue;
        uint8_t header[5]; exact(fd,header,5);
        unsigned n=u32(header+1); assert(n && n<=9*1024*1024); exact(fd,payload,n);
        if(header[0]==0x80) {
            assert(!inside && n>=29 && n<=1048600 && payload[0]==2 && !payload[1]);
            for(unsigned i=0;i<4;i++) assert(u16(payload+2+2*i)==rect[i]);
            assert(rect[2] && u16(payload+10)==1280 && u16(payload+12)==720);
            uint64_t pts=u32(payload+14)|(uint64_t)u32(payload+18)<<32;
            assert(pts>last_pts); last_pts=pts; video++;
            if(t>=2000 && t<7000) { measured++; if(last_video && t-last_video>max_gap) max_gap=t-last_video; last_video=t; }
            if(t>=8500 && t<9800) { assert(rect[0]==160); moved++; }
            if(t>=11000) after_exit++;
        } else {
            assert(header[0]==11);
            if(payload[0]==13) { assert(!inside && n==14); inside=true; memcpy(ack+2,payload+2,12); }
            else if(payload[0]==5) { assert(inside && n==9); for(unsigned i=0;i<4;i++) rect[i]=u16(payload+1+2*i); }
            else if(payload[0]==6) { assert(inside && n==5 && u32(payload+1)==u32(ack+10)); inside=false; pending=true; ack_at=t+250; batches++; }
            else assert(inside);
        }
    }
    close(fd); xcb_disconnect(x); free(payload);
    printf("{\"videoFrames\":%u,\"tileBatches\":%u,\"delayedTileAckMs\":250,\"measuredFps\":%.2f,\"maxGapMs\":%.2f,\"movedFrames\":%u,\"afterExitFrames\":%u}\n",
        video,batches,measured/5.0,max_gap,moved,after_exit);
    assert(measured>=100 && video>batches*3 && moved>=15 && !after_exit);
    return 0;
}

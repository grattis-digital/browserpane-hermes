/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"

static uint32_t original_color(unsigned x, unsigned y) {
    uint32_t color=0x123456;
    if (y%37<17) color=0x315779;
    if (x%83<11) color=0x84a2c6;
    if (y<48) color=0x223344;
    return color;
}

uint32_t fixture_color(unsigned x, unsigned y, unsigned width, unsigned height, unsigned scenario) {
    uint32_t color=original_color(x,y);
    switch (scenario) {
    case 0: break;
    case 1: if (x>=4 && x<28 && y>=8 && y<32) color=0xabcdef; break;
    case 2: color=0xfedcba; break;
    case 3: if (x==width-1 && y==height-1) color^=1; break;
    case 4:
        if (y>=48) {
            color=y+13<height?original_color(x,y+13):0x365478;
            if (x>=100 && x<132 && y>=100 && y<132) color=0xaccdef;
        }
        break;
    case 5:
        if (x>=128 && x<192 && y>=128 && y<192) color=original_color(x-64,y);
        break;
    case 6:
        if (x>=128 && x<192 && y>=128 && y<192) {
            uint32_t v=x+y*width; v^=v>>16; v*=0x7feb352d; v^=v>>15;
            v*=0x846ca68b; color=(v^(v>>16))&0xffffff;
        }
        break;
    case 7:
        if (x>=128 && x<192 && y>=128 && y<192) color=(x-128)<<16 | (y-128)<<8 | (x+y-256);
        break;
    case 8:
        color=0xfedcba;
        if (x==width-1 && y==height-1) color^=1;
        break;
    default: REQUIRE(!"Unknown fixture");
    }
    return color;
}

static void paint(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                  uint32_t color, unsigned x, unsigned y, unsigned width, unsigned height) {
    xcb_change_gc(c,gc,XCB_GC_FOREGROUND,&color);
    xcb_rectangle_t rect={x,y,width,height};
    xcb_poly_fill_rectangle(c,screen->root,gc,1,&rect);
}

void fixture_x11(xcb_connection_t *c, xcb_screen_t *screen, xcb_gcontext_t gc,
                 unsigned width, unsigned height, unsigned scenario) {
    if (scenario==0) {
        paint(c,screen,gc,0x123456,0,0,width,height);
        for (unsigned y=0;y<height;y+=37) paint(c,screen,gc,0x315779,0,y,width,height-y<17?height-y:17);
        for (unsigned x=0;x<width;x+=83) paint(c,screen,gc,0x84a2c6,x,0,width-x<11?width-x:11,height);
        paint(c,screen,gc,0x223344,0,0,width,48);
    } else if (scenario==1) paint(c,screen,gc,0xabcdef,4,8,24,24);
    else if (scenario==2) paint(c,screen,gc,0xfedcba,0,0,width,height);
    else if (scenario==3) paint(c,screen,gc,original_color(width-1,height-1)^1,width-1,height-1,1,1);
    else if (scenario==4) {
        // Keep header fixed, scroll by 13 (not a tile multiple), move an overlay.
        xcb_copy_area(c,screen->root,screen->root,gc,0,61,0,48,width,height-61);
        paint(c,screen,gc,0x365478,0,height-13,width,13);
        paint(c,screen,gc,0xaccdef,100,100,32,32);
    } else if (scenario==5) xcb_copy_area(c,screen->root,screen->root,gc,64,128,128,128,64,64);
    else if (scenario==6 || scenario==7) {
        // Synthetic fixture construction is outside candidate timing.
        for (unsigned y=128;y<192;y++) for (unsigned x=128;x<192;x++)
            paint(c,screen,gc,fixture_color(x,y,width,height,scenario),x,y,1,1);
    } else if (scenario==8) {
        paint(c,screen,gc,0xfedcba,0,0,width,height);
        paint(c,screen,gc,0xfedcba^1,width-1,height-1,1,1);
    } else REQUIRE(!"Unknown X11 fixture");
}

void frame_check(LeaseFrame *frame, unsigned scenario) {
    unsigned width=frame->wire.width,height=frame->wire.height;
    uint8_t *pixels=malloc(width*height*4); REQUIRE(pixels);
    glBindFramebuffer(GL_FRAMEBUFFER,frame->framebuffer);
    glReadPixels(0,0,width,height,GL_RGBA,GL_UNSIGNED_BYTE,pixels);
    REQUIRE(glGetError()==GL_NO_ERROR);
    for (unsigned y=0;y<height;y++) for (unsigned x=0;x<width;x++) {
        const uint8_t *q=pixels+(y*width+x)*4;
        uint32_t actual=(uint32_t)q[0]<<16 | (uint32_t)q[1]<<8 | q[2];
        uint32_t expected=fixture_color(x,y,width,height,scenario);
        if (actual!=expected) {
            fprintf(stderr,"source mismatch scenario=%u x=%u y=%u actual=%06x expected=%06x\n",
                scenario,x,y,actual,expected);
            REQUIRE(false);
        }
    }
    free(pixels);
}

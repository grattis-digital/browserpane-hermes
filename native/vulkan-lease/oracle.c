/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include <string.h>

static uint32_t rgba(uint32_t color) {
    return UINT32_C(0xff000000)|(color>>16)|((color&0xff)<<16)|(color&0xff00);
}

void oracle_build(Params params, Oracle *o) {
    *o=(Oracle){0};
    unsigned columns=(params.width+63)/64,rows=(params.height+63)/64;
    for (unsigned ty=0;ty<rows;ty++) for (unsigned tx=0;tx<columns;tx++) {
        unsigned tile=ty*columns+tx;
        uint32_t first=fixture_color(tx*64,ty*64,params.width,params.height,params.scenario);
        for (unsigned y=ty*64;y<(ty+1)*64 && y<params.height;y++)
            for (unsigned x=tx*64;x<(tx+1)*64 && x<params.width;x++) {
                uint32_t value=fixture_color(x,y,params.width,params.height,params.scenario);
                if (value!=fixture_color(x,y,params.width,params.height,0)) o->flags[tile]|=1;
                if (value!=first) o->flags[tile]|=2;
            }
        o->colors[tile]=rgba(first);
        if (o->flags[tile]&1) o->mask[tile/32]|=1u<<(tile%32);
    }
}

void result_check(Pipeline *p, Params params, const Oracle *o, bool empty) {
    uint32_t *out=p->result;
    unsigned columns=(params.width+63)/64,tiles=columns*((params.height+63)/64);
    REQUIRE(out[2]==tiles && out[3]==1);
    if (empty) { REQUIRE(out[0]==0 && out[1]==0); return; }
    unsigned commands=0,raw=0;
    for (unsigned tile=0;tile<tiles;tile++) {
        if (!(o->flags[tile]&1)) continue;
        REQUIRE(commands<out[0]);
        uint32_t *cmd=out+4+4*commands++;
        REQUIRE(cmd[0]==tile && cmd[2]==o->colors[tile]);
        if (!(o->flags[tile]&2)) { REQUIRE(cmd[1]==1 && cmd[3]==0); continue; }
        REQUIRE(cmd[1]==2 && cmd[3]==raw && raw<out[1]);
        const uint32_t *pixels=out+HEADER_WORDS+raw++*TILE_WORDS;
        for (unsigned dy=0;dy<64;dy++) for (unsigned dx=0;dx<64;dx++) {
            unsigned x=(tile%columns)*64+dx,y=(tile/columns)*64+dy;
            uint32_t expected=(x<params.width && y<params.height)?
                rgba(fixture_color(x,y,params.width,params.height,params.scenario)):0;
            if (pixels[dy*64+dx]!=expected) {
                fprintf(stderr,"payload mismatch tile=%u x=%u y=%u actual=%08x expected=%08x\n",
                    tile,x,y,pixels[dy*64+dx],expected);
                REQUIRE(false);
            }
        }
    }
    REQUIRE(commands==out[0] && raw==out[1]);
}

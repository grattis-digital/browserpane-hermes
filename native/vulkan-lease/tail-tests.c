/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"

void tail_decoder_tests(void) {
    uint8_t black[]={113,111,105,102,0,0,0,1,0,0,0,1,4,0,0xc0,0,0,0,0,0,0,0,1};
    uint32_t *pixels=NULL; unsigned w=0,h=0;
    REQUIRE(tail_qoi_decode(black,sizeof(black),&pixels,&w,&h));
    REQUIRE(w==1 && h==1 && pixels[0]==0xff000000); free(pixels);
    for (size_t size=0;size<sizeof(black);size++) REQUIRE(!tail_qoi_decode(black,size,&pixels,&w,&h));
    black[14]=0xc1; REQUIRE(!tail_qoi_decode(black,sizeof(black),&pixels,&w,&h)); // run beyond tile
    black[14]=0xfe; REQUIRE(!tail_qoi_decode(black,sizeof(black),&pixels,&w,&h)); // truncated RGB
    black[14]=0xc0; black[22]=0; REQUIRE(!tail_qoi_decode(black,sizeof(black),&pixels,&w,&h));
    black[22]=1; black[7]=0; REQUIRE(!tail_qoi_decode(black,sizeof(black),&pixels,&w,&h));
}

void tail_client_negative(TailClient *client, uint8_t *bytes, size_t size, unsigned serial) {
    unsigned before=client->serial; uint32_t *canvas=client->canvas;
    REQUIRE(size>=10 && !tail_client_decode(client,bytes,size-1,serial));
    REQUIRE(!tail_client_decode(client,bytes,size,serial+1));
    uint8_t saved=bytes[0]; bytes[0]=255;
    REQUIRE(!tail_client_decode(client,bytes,size,serial)); bytes[0]=saved;
    REQUIRE(client->serial==before && client->canvas==canvas);
}

void tail_export(FILE *file, const TailPacket *packet, unsigned scenario) {
    if (!file) return;
    // Only the final, already encoded stream is exported. Synthetic receiving-
    // side interoperability evidence, outside sender/transport timing.
    REQUIRE(ftell(file)>=0 && ftell(file)+(long)packet->size+16<=32*1024*1024);
    uint32_t values[]={packet->size,scenario,packet->serial,0}; uint8_t header[16];
    for (unsigned i=0;i<4;i++) for (unsigned j=0;j<4;j++) header[4*i+j]=(uint8_t)(values[i]>>(8*j));
    REQUIRE(fwrite(header,1,sizeof(header),file)==sizeof(header));
    REQUIRE(fwrite(packet->bytes,1,packet->size,file)==packet->size);
}

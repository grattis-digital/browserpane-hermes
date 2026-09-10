/* SPDX-License-Identifier: AGPL-3.0-only */
#include "video-gpu.h"
#include <math.h>
#include <string.h>
static unsigned component(unsigned pixel,unsigned c) { return (pixel>>(8*(2-c)))&255; }
static unsigned reference(unsigned pixel) {
    return (unsigned)lround(16+(46.5594*component(pixel,0)+156.6288*component(pixel,1)+15.8118*component(pixel,2))/255);
}
void video_gpu_test(Pipeline *p) {
    REQUIRE(p->software);
    REQUIRE(video_rect_valid((VideoRect){0},1280,720));
    REQUIRE(!video_rect_valid((VideoRect){0,0,0,64},1280,720));
    REQUIRE(!video_rect_valid((VideoRect){UINT32_MAX,0,64,64},1280,720));
    REQUIRE(!video_rect_valid((VideoRect){0,0,65,64},1280,720));
    FrameImage frames[]={image_owned(p,1280,720),image_owned(p,1280,720)};
    images_bind(p,frames); images_prepare(p,frames,(Params){1280,720,3,0});
    VideoRect cases[]={{0,0,1280,720},{14,22,642,362},{1216,656,64,64}};
    for (unsigned c=0;c<3;c++) {
        VideoRect r=cases[c]; unsigned stride=(r.w+31)&~31u,rows=c==1?r.h:(r.h+15)&~15u;
        VideoCodec codec={.input_bytes=stride*rows*3/2}; VideoGpu gpu;
        REQUIRE(video_gpu_open(&gpu,p,&codec));
        REQUIRE(video_gpu_convert(&gpu,&frames[1],(VideoParams){r,stride,rows}));
        const uint8_t *bytes=gpu.raw.mapped;
        for (unsigned y=0;y<rows;y++) for (unsigned x=0;x<stride;x++) {
            unsigned expected=x<r.w && y<r.h?reference(fixture_color(r.x+x,r.y+y,1280,720,3)):16;
            REQUIRE(abs((int)bytes[y*stride+x]-(int)expected)<=1);
        }
        for (unsigned y=0;y<rows;y+=2) for (unsigned x=0;x<stride;x+=2) {
            double rgb[3]={0};
            for (unsigned yy=0;yy<2;yy++) for (unsigned xx=0;xx<2;xx++) {
                unsigned px=x+xx<r.w && y+yy<r.h?fixture_color(r.x+x+xx,r.y+y+yy,1280,720,3):0;
                for (unsigned k=0;k<3;k++) rgb[k]+=component(px,k)/1020.0;
            }
            int u=lround(128-25.6642*rgb[0]-86.3358*rgb[1]+112*rgb[2]);
            int v=lround(128+112*rgb[0]-101.7303*rgb[1]-10.2697*rgb[2]);
            unsigned at=stride*rows+y/2*stride+x;
            REQUIRE(abs(bytes[at]-u)<=1 && abs(bytes[at+1]-v)<=1);
        }
        video_gpu_close(&gpu);
    }
    image_destroy(p,&frames[0]); image_destroy(p,&frames[1]);
    fprintf(stderr,"GPU NV12 oracle: crop, stride, padding, BT.709 luma/chroma passed\n");
}
int video_probe(Pipeline *p) {
    REQUIRE(!p->software);
    FrameImage frames[]={image_owned(p,1280,720),image_owned(p,1280,720)};
    images_bind(p,frames); images_prepare(p,frames,(Params){1280,720,3,0});
    VideoCodec codec; VideoGpu gpu;
    const char *path=getenv("BPANE_GPU_VIDEO_DEVICE"); if (!path) path="/dev/bpane-video-encode";
    REQUIRE(video_codec_open(&codec,path,642,362));
    REQUIRE(video_gpu_open(&gpu,p,&codec));
    FILE *output=fopen("/tmp/bpane-gpu-video.h264","wb"); REQUIRE(output);
    size_t total=0;
    for (unsigned i=0;i<5;i++) {
        REQUIRE(video_gpu_convert(&gpu,&frames[1],(VideoParams){{14,22,642,362},codec.stride,codec.rows}));
        REQUIRE(video_codec_encode(&codec,1000000+i*33333));
        REQUIRE(fwrite(codec.access_unit,1,codec.size,output)==codec.size); total+=codec.size;
    }
    REQUIRE(!fclose(output));
    video_gpu_close(&gpu); video_codec_close(&codec);
    image_destroy(p,&frames[0]); image_destroy(p,&frames[1]);
    printf("{\"frames\":5,\"encodedBytes\":%zu,\"rawCpuMappings\":0,\"validationErrors\":%u}\n",total,p->validation_errors);
    return 0;
}

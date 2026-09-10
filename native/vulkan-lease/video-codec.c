/* SPDX-License-Identifier: AGPL-3.0-only */
#include "video-codec.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

bool video_rect_valid(VideoRect r,unsigned w,unsigned h) {
    if (!r.w && !r.h) return !r.x && !r.y;
    return r.w>=64 && r.h>=64 && !((r.x|r.y|r.w|r.h)&1u) &&
        w<=1920 && h<=1080 && r.x<=w && r.y<=h && r.w<=w-r.x && r.h<=h-r.y;
}
bool video_rect_equal(VideoRect a,VideoRect b) { return a.x==b.x && a.y==b.y && a.w==b.w && a.h==b.h; }

static bool control(int fd,unsigned id,int value) {
    struct v4l2_control c={.id=id,.value=value}; return !ioctl(fd,VIDIOC_S_CTRL,&c);
}
static bool format(VideoCodec *c,unsigned type,unsigned fourcc) {
    struct v4l2_format f={.type=type};
    f.fmt.pix_mp=(struct v4l2_pix_format_mplane){.width=c->width,.height=c->height,
        .pixelformat=fourcc,.field=V4L2_FIELD_NONE,.num_planes=1,
        .colorspace=V4L2_COLORSPACE_REC709,.ycbcr_enc=V4L2_YCBCR_ENC_709,
        .quantization=V4L2_QUANTIZATION_LIM_RANGE,.xfer_func=V4L2_XFER_FUNC_709};
    if (fourcc==V4L2_PIX_FMT_NV12) f.fmt.pix_mp.plane_fmt[0].bytesperline=(c->width+31u)&~31u;
    int result=ioctl(c->fd,VIDIOC_S_FMT,&f);
    fprintf(stderr,"GPU video format type=%u requested=%ux%u returned=%ux%u fourcc=%08x planes=%u result=%d errno=%d\n",
        type,c->width,c->height,f.fmt.pix_mp.width,f.fmt.pix_mp.height,f.fmt.pix_mp.pixelformat,f.fmt.pix_mp.num_planes,result,errno);
    if (result || f.fmt.pix_mp.pixelformat!=fourcc ||
        f.fmt.pix_mp.num_planes!=1 || f.fmt.pix_mp.width!=c->width ||
        f.fmt.pix_mp.height!=c->height) return false;
    if (type==V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE) {
        c->stride=f.fmt.pix_mp.plane_fmt[0].bytesperline;
        // This video encoder accepts even heights; 16-row alignment is a
        // decoder/image-encoder rule, not the NV12 chroma-plane offset here.
        c->rows=f.fmt.pix_mp.height;
        c->input_bytes=f.fmt.pix_mp.plane_fmt[0].sizeimage;
        fprintf(stderr,"GPU video NV12 layout stride=%u rows=%u sizeimage=%u\n",c->stride,c->rows,c->input_bytes);
        if (c->stride<c->width || c->stride>2048 || c->stride%4 ||
            c->input_bytes<c->stride*c->rows*3/2 || c->input_bytes>4*1024*1024) return false;
    }
    return true;
}
static bool buffers(VideoCodec *c,unsigned type) {
    struct v4l2_requestbuffers req={.type=type,.memory=V4L2_MEMORY_MMAP,.count=2};
    if (ioctl(c->fd,VIDIOC_REQBUFS,&req) || !req.count || req.count>VIDEO_CAPTURE_BUFFERS) return false;
    for (unsigned i=0;i<req.count;i++) {
        struct v4l2_plane plane={0};
        struct v4l2_buffer b={.type=type,.memory=V4L2_MEMORY_MMAP,.index=i,.length=1,.m.planes=&plane};
        if (ioctl(c->fd,VIDIOC_QUERYBUF,&b) || b.length!=1) return false;
        if (type==V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE) {
            if (i) continue; // Exactly one raw frame in flight; never CPU-map it.
            struct v4l2_exportbuffer exp={.type=type,.index=0,.plane=0,.flags=O_RDWR|O_CLOEXEC};
            if (plane.length<c->input_bytes || plane.length>4*1024*1024 ||
                ioctl(c->fd,VIDIOC_EXPBUF,&exp)) return false;
            c->dma_fd=exp.fd; c->allocation_bytes=plane.length;
        } else {
            if (!plane.length || plane.length>VIDEO_MAX_BYTES) return false;
            void *ptr=mmap(NULL,plane.length,PROT_READ|PROT_WRITE,MAP_SHARED,c->fd,plane.m.mem_offset);
            if (ptr==MAP_FAILED) return false;
            c->compressed[i]=ptr; c->lengths[i]=plane.length; c->captures=i+1;
            if (ioctl(c->fd,VIDIOC_QBUF,&b)) return false;
        }
    }
    return true;
}
bool video_codec_open(VideoCodec *c,const char *path,unsigned w,unsigned h) {
    const char *stage="open";
    *c=(VideoCodec){.fd=-1,.dma_fd=-1,.width=w,.height=h};
    if (!video_rect_valid((VideoRect){0,0,w,h},w,h) || !w) return false;
    c->fd=open(path,O_RDWR|O_NONBLOCK|O_CLOEXEC); if (c->fd<0) goto fail;
    stage="capabilities";
    struct v4l2_capability cap={0};
    if (ioctl(c->fd,VIDIOC_QUERYCAP,&cap) || strcmp((char *)cap.driver,"bcm2835-codec") ||
        !(cap.device_caps&V4L2_CAP_VIDEO_M2M_MPLANE) || !(cap.device_caps&V4L2_CAP_STREAMING)) goto fail;
    stage="formats";
    if (!format(c,V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE,V4L2_PIX_FMT_H264) ||
        !format(c,V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE,V4L2_PIX_FMT_NV12)) goto fail;
    unsigned bitrate=w*h*5u; if (bitrate<1000000) bitrate=1000000; if (bitrate>8000000) bitrate=8000000;
    bitrate=((bitrate+24999)/25000)*25000;
    stage="controls";
    if (!control(c->fd,V4L2_CID_MPEG_VIDEO_BITRATE,bitrate) ||
        !control(c->fd,V4L2_CID_MPEG_VIDEO_H264_PROFILE,V4L2_MPEG_VIDEO_H264_PROFILE_BASELINE) ||
        !control(c->fd,V4L2_CID_MPEG_VIDEO_H264_LEVEL,V4L2_MPEG_VIDEO_H264_LEVEL_4_2) ||
        !control(c->fd,V4L2_CID_MPEG_VIDEO_H264_I_PERIOD,30) ||
        !control(c->fd,V4L2_CID_MPEG_VIDEO_REPEAT_SEQ_HEADER,1)) goto fail;
    struct v4l2_streamparm rate={.type=V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE};
    stage="rate/buffers";
    rate.parm.output.timeperframe=(struct v4l2_fract){1,30};
    if (ioctl(c->fd,VIDIOC_S_PARM,&rate) || !buffers(c,V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE) ||
        !buffers(c,V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE)) goto fail;
    c->access_unit=malloc(VIDEO_MAX_BYTES); if (!c->access_unit) goto fail;
    unsigned type=V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    stage="streamon";
    if (ioctl(c->fd,VIDIOC_STREAMON,&type)) goto fail;
    c->capture_on=true; type=V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
    if (ioctl(c->fd,VIDIOC_STREAMON,&type)) goto fail;
    c->output_on=true;
    fprintf(stderr,"GPU video: bcm2835-codec NV12 %ux%u stride=%u DMA-BUF export, no raw CPU mapping\n",w,h,c->stride);
    return true;
fail:
    fprintf(stderr,"GPU video: hardware setup unavailable at %s (errno=%d); retaining lossless tiles\n",stage,errno);
    video_codec_close(c); return false;
}
void video_codec_close(VideoCodec *c) {
    if (c->fd>=0) {
        unsigned type=V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE;
        if (c->output_on) ioctl(c->fd,VIDIOC_STREAMOFF,&type);
        type=V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
        if (c->capture_on) ioctl(c->fd,VIDIOC_STREAMOFF,&type);
    }
    for (unsigned i=0;i<c->captures;i++) munmap(c->compressed[i],c->lengths[i]);
    if (c->dma_fd>=0) close(c->dma_fd);
    if (c->fd>=0) close(c->fd);
    free(c->access_unit); *c=(VideoCodec){.fd=-1,.dma_fd=-1};
}

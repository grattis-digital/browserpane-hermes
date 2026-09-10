/* SPDX-License-Identifier: AGPL-3.0-only */
#include "video-codec.h"
#include <errno.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
static double milliseconds(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1000.0+t.tv_nsec/1e6;
}
static bool has_slice(const uint8_t *p,size_t n) {
    for (size_t i=0;i+3<n;i++) if (!p[i] && !p[i+1] && p[i+2]==1 &&
        ((p[i+3]&31)==1 || (p[i+3]&31)==5)) return true;
    return false;
}
bool video_codec_encode(VideoCodec *c,uint64_t pts) {
    struct v4l2_plane plane={.bytesused=c->input_bytes,.length=c->allocation_bytes};
    struct v4l2_buffer b={.type=V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE,.memory=V4L2_MEMORY_MMAP,
        .index=0,.length=1,.m.planes=&plane,.field=V4L2_FIELD_NONE,
        .timestamp={.tv_sec=pts/1000000,.tv_usec=pts%1000000}};
    if (ioctl(c->fd,VIDIOC_QBUF,&b)) return false;
    c->size=0; bool input_done=false,frame_done=false;
    double deadline=milliseconds()+500;
    while (!input_done || !frame_done) {
        int wait=(int)(deadline-milliseconds()); if (wait<=0) return false;
        // Wait for compressed output, not general output-queue writability:
        // spare input buffers must not turn encoder waits into a CPU spin.
        struct pollfd p={c->fd,(short)(frame_done?POLLOUT:POLLIN),0};
        int status=poll(&p,1,wait);
        if (status<0 && errno==EINTR) continue;
        if (status<=0 || (p.revents&(POLLERR|POLLHUP|POLLNVAL))) return false;
        if (!input_done) {
            plane=(struct v4l2_plane){0}; b=(struct v4l2_buffer){.type=V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE,
                .memory=V4L2_MEMORY_MMAP,.length=1,.m.planes=&plane};
            if (!ioctl(c->fd,VIDIOC_DQBUF,&b)) { if (b.index || b.flags&V4L2_BUF_FLAG_ERROR) return false; input_done=true; }
            else if (errno!=EAGAIN && errno!=EINTR) return false;
        }
        plane=(struct v4l2_plane){0}; b=(struct v4l2_buffer){.type=V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE,
            .memory=V4L2_MEMORY_MMAP,.length=1,.m.planes=&plane};
        if (ioctl(c->fd,VIDIOC_DQBUF,&b)) { if (errno==EAGAIN || errno==EINTR) continue; return false; }
        if (b.index>=c->captures || b.length!=1 || b.flags&V4L2_BUF_FLAG_ERROR ||
            plane.bytesused>c->lengths[b.index] || plane.data_offset>plane.bytesused ||
            plane.bytesused-plane.data_offset>VIDEO_MAX_BYTES-c->size) return false;
        size_t n=plane.bytesused-plane.data_offset;
        memcpy(c->access_unit+c->size,(uint8_t *)c->compressed[b.index]+plane.data_offset,n); c->size+=n;
        frame_done=has_slice(c->access_unit,c->size);
        plane.bytesused=0; plane.data_offset=0;
        if (ioctl(c->fd,VIDIOC_QBUF,&b)) return false;
    }
    return true;
}

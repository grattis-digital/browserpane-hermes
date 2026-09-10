/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_VIDEO_CODEC_H
#define BPANE_VIDEO_CODEC_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define VIDEO_MAX_BYTES (1024u*1024u)
#define VIDEO_CAPTURE_BUFFERS 4u
typedef struct { uint32_t x,y,w,h; } VideoRect;
typedef struct {
    int fd, dma_fd;
    uint32_t width,height,stride,rows,input_bytes,allocation_bytes;
    unsigned captures;
    void *compressed[VIDEO_CAPTURE_BUFFERS];
    size_t lengths[VIDEO_CAPTURE_BUFFERS];
    bool output_on,capture_on;
    uint8_t *access_unit;
    size_t size;
} VideoCodec;
bool video_codec_open(VideoCodec *, const char *, unsigned, unsigned);
void video_codec_close(VideoCodec *);
bool video_codec_encode(VideoCodec *, uint64_t pts_us);
bool video_rect_valid(VideoRect, unsigned, unsigned);
bool video_rect_equal(VideoRect, VideoRect);
#endif

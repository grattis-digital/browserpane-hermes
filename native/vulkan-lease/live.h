/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_GPU_LIVE_H
#define BPANE_GPU_LIVE_H
#include "tail.h"
#include "video-gpu.h"
#include <xcb/damage.h>
#include <pthread.h>
typedef struct { FrameImage image; LeaseFrame lease; } LiveImage;
typedef struct {
    VideoRect rect;
    unsigned width,height,generation;
    uint64_t revision;
    double hint_at;
    bool authorized,failed,stop;
} VideoControl;
typedef struct {
    pthread_t thread;
    pthread_mutex_t control,output;
    pthread_cond_t wake;
    VideoControl state;
    bool started;
    unsigned frames,discarded;
    uint64_t bytes;
    double capture_ms,convert_ms,encode_ms,write_ms;
} VideoWorker;
typedef struct {
    Pipeline *pipeline;
    Tail tail;
    xcb_connection_t *x;
    xcb_damage_damage_t damage;
    uint8_t damage_event;
    LiveImage acknowledged, current;
    uint64_t epoch;
    bool dirty, parked;
    double sent_at, captured_at;
    unsigned frames, resets;
    VideoWorker video;
    VideoRect desired_video,active_video;
    unsigned video_width,video_height;
    double video_hint_at;
    bool video_enabled;
} Live;
void live_write(const void *, size_t);
bool live_read(uint8_t command[16]);
uint32_t live_u32(const uint8_t *);
uint64_t live_u64(const uint8_t *);
void live_begin(uint64_t, uint32_t);
void live_release(Live *, LiveImage *);
void live_reset(Live *);
void live_capture(Live *);
bool live_command(Live *, const uint8_t[16]);
bool live_video_hint(Live *, const uint8_t[16]);
void live_video_stop(Live *);
VideoRect live_video_select(Live *, unsigned, unsigned);
void live_video_ack(Live *);
void live_video_start(Live *);
void live_video_join(Live *);
void *live_video_worker(void *);
void live_video_write(VideoCodec *, VideoControl, uint64_t);
int live_main(Pipeline *, int heartbeat);
int live_listen(void);
#endif

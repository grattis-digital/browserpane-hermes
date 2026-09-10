/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include <errno.h>
#include <time.h>

// Only this thread owns these Vulkan/V4L2 objects. No queue, command buffer,
// mutable image, or encoder input is shared with the tile processor.
typedef struct {
    Pipeline pipeline;
    VideoCodec codec;
    VideoGpu gpu;
    uint64_t revision;
    bool opened;
} Encoder;

static void close_encoder(Encoder *e) {
    video_gpu_close(&e->gpu); video_codec_close(&e->codec);
    if (e->opened) pipeline_close(&e->pipeline);
    *e=(Encoder){.codec={.fd=-1,.dma_fd=-1}};
}

static bool eligible(VideoControl c,double now) {
    return c.authorized && !c.failed && !c.stop && c.rect.w && now-c.hint_at<=700;
}

static VideoControl next_frame(VideoWorker *v,double deadline) {
    REQUIRE(!pthread_mutex_lock(&v->control));
    for (;;) {
        double now=lease_now();
        if (v->state.stop || (eligible(v->state,now) && now>=deadline)) break;
        double delay=eligible(v->state,now)?deadline-now:100;
        struct timespec until; REQUIRE(!clock_gettime(CLOCK_REALTIME,&until));
        uint64_t nanos=(uint64_t)until.tv_nsec+(uint64_t)(delay*1000000);
        until.tv_sec+=nanos/1000000000; until.tv_nsec=nanos%1000000000;
        int result=pthread_cond_timedwait(&v->wake,&v->control,&until);
        REQUIRE(!result || result==ETIMEDOUT);
    }
    VideoControl c=v->state;
    REQUIRE(!pthread_mutex_unlock(&v->control));
    return c;
}

static bool encode(Encoder *e,Live *s,VideoControl frame,uint64_t pts) {
    if (!e->opened || e->revision!=frame.revision) {
        close_encoder(e);
        pipeline_open_video(&e->pipeline); e->opened=true;
        const char *path=getenv("BPANE_GPU_VIDEO_DEVICE"); if (!path) path="/dev/bpane-video-encode";
        if (!video_codec_open(&e->codec,path,frame.rect.w,frame.rect.h) ||
            !video_gpu_open(&e->gpu,&e->pipeline,&e->codec)) return false;
        e->revision=frame.revision;
    }
    double start=lease_now();
    // Same XCB connection preserves the driver's single capture owner. Main
    // holds at most two leases; this worker holds one until GPU completion.
    LeaseFrame lease=lease_acquire(s->x,BP_OK);
    if (lease.wire.width!=frame.width || lease.wire.height!=frame.height || lease.wire.generation!=frame.generation) {
        lease_release(s->x,&lease); s->video.discarded++; return true;
    }
    FrameImage image=image_import(&e->pipeline,&lease);
    double acquired=lease_now();
    bool ok=video_gpu_convert(&e->gpu,&image,(VideoParams){frame.rect,e->codec.stride,e->codec.rows});
    double converted=lease_now();
    image_destroy(&e->pipeline,&image); lease_release(s->x,&lease);
    // Release the raw snapshot before encoding/writing. Only compressed bytes
    // cross to the CPU, with one AU in flight and no catch-up frame backlog.
    if (ok) ok=video_codec_encode(&e->codec,pts);
    double encoded=lease_now();
    s->video.capture_ms+=acquired-start; s->video.convert_ms+=converted-acquired;
    s->video.encode_ms+=encoded-converted;
    if (!ok) return false;
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    VideoControl current=s->video.state;
    if (eligible(current,lease_now()) && current.revision==frame.revision) {
        // Lock order is control -> output. Tile writes never take control
        // while holding output. Revocation cannot overtake an accepted old AU.
        REQUIRE(!pthread_mutex_lock(&s->video.output));
        live_video_write(&e->codec,frame,pts);
        REQUIRE(!pthread_mutex_unlock(&s->video.output));
        s->video.frames++; s->video.bytes+=e->codec.size;
    } else s->video.discarded++;
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
    s->video.write_ms+=lease_now()-encoded;
    return true;
}

void *live_video_worker(void *arg) {
    Live *s=arg;
    Encoder e={.codec={.fd=-1,.dma_fd=-1}};
    double deadline=0;
    for (;;) {
        VideoControl frame=next_frame(&s->video,deadline);
        if (frame.stop) break;
        double start=lease_now();
        bool ok=encode(&e,s,frame,(uint64_t)(start*1000));
        if (!ok) {
            close_encoder(&e);
            REQUIRE(!pthread_mutex_lock(&s->video.control));
            if (s->video.state.revision==frame.revision) s->video.state.failed=true;
            REQUIRE(!pthread_mutex_unlock(&s->video.control));
            fprintf(stderr,"GPU video: hardware encoder failed; repairing with lossless tiles, no CPU encoding\n");
        }
        deadline=start+1000.0/30;
        double now=lease_now();
        if (deadline<now) deadline=now;
    }
    close_encoder(&e);
    fprintf(stderr,"GPU video independent: frames=%u discarded=%u bytes=%llu captureMs=%.3f convertMs=%.3f encodeMs=%.3f writeMs=%.3f\n",
        s->video.frames,s->video.discarded,(unsigned long long)s->video.bytes,
        s->video.capture_ms,s->video.convert_ms,s->video.encode_ms,s->video.write_ms);
    return NULL;
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include <string.h>

void live_video_stop(Live *s) {
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    s->video.state.authorized=false;
    s->video.state.revision++;
    REQUIRE(!pthread_cond_signal(&s->video.wake));
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
    s->active_video=(VideoRect){0};
}

bool live_video_hint(Live *s,const uint8_t command[16]) {
    if (command[14] || command[15]) return false;
    unsigned values[6];
    for (unsigned i=0;i<6;i++) values[i]=command[2+2*i]|((unsigned)command[3+2*i]<<8);
    VideoRect r={values[0],values[1],values[2],values[3]};
    if (!video_rect_valid(r,values[4],values[5]) || values[4]<32 || values[5]<32) return false;
    bool changed=!video_rect_equal(r,s->desired_video) || s->video_width!=values[4] || s->video_height!=values[5];
    if (changed) { s->dirty=true; live_video_stop(s); }
    s->desired_video=r; s->video_width=values[4]; s->video_height=values[5];
    s->video_hint_at=lease_now();
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    s->video.state.hint_at=s->video_hint_at;
    if (changed) s->video.state.failed=false;
    REQUIRE(!pthread_cond_signal(&s->video.wake));
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
    return true;
}

VideoRect live_video_select(Live *s,unsigned width,unsigned height) {
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    bool failed=s->video.state.failed;
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
    VideoRect wanted=s->desired_video;
    if (!s->video_enabled || failed || lease_now()-s->video_hint_at>700 ||
        s->video_width!=width || s->video_height!=height || !video_rect_valid(wanted,width,height)) wanted=(VideoRect){0};
    if (!video_rect_equal(wanted,s->active_video)) live_video_stop(s);
    s->active_video=wanted;
    return wanted;
}

void live_video_ack(Live *s) {
    VideoRect r=live_video_select(s,s->tail.width,s->tail.height);
    if (!r.w || !video_rect_equal(r,s->tail.acked_video)) return;
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    VideoControl *c=&s->video.state;
    c->rect=r; c->width=s->tail.width; c->height=s->tail.height;
    c->generation=s->acknowledged.lease.wire.generation;
    c->authorized=true;
    REQUIRE(!pthread_cond_signal(&s->video.wake));
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
}

void live_video_start(Live *s) {
    REQUIRE(!pthread_mutex_init(&s->video.control,NULL));
    REQUIRE(!pthread_mutex_init(&s->video.output,NULL));
    REQUIRE(!pthread_cond_init(&s->video.wake,NULL));
    if (!s->video_enabled) return;
    BpLeaseReply *query=lease_request(s->x,BP_QUERY,NULL,16,0);
    REQUIRE(query->reserved[0]>=3); free(query);
    REQUIRE(!pthread_create(&s->video.thread,NULL,live_video_worker,s));
    s->video.started=true;
}

void live_video_join(Live *s) {
    REQUIRE(!pthread_mutex_lock(&s->video.control));
    s->video.state.stop=true;
    REQUIRE(!pthread_cond_signal(&s->video.wake));
    REQUIRE(!pthread_mutex_unlock(&s->video.control));
    if (s->video.started) REQUIRE(!pthread_join(s->video.thread,NULL));
    REQUIRE(!pthread_cond_destroy(&s->video.wake));
    REQUIRE(!pthread_mutex_destroy(&s->video.control));
    REQUIRE(!pthread_mutex_destroy(&s->video.output));
}

void live_video_write(VideoCodec *c,VideoControl frame,uint64_t pts) {
    REQUIRE(c->size && c->size<=VIDEO_MAX_BYTES);
    // Version 2 explicitly permits multiple AUs between complete tile batches.
    uint8_t header[29]={0x80,0,0,0,0,2,0};
    unsigned length=24+c->size;
    for (unsigned i=0;i<4;i++) header[1+i]=(uint8_t)(length>>(i*8));
    unsigned values[]={frame.rect.x,frame.rect.y,frame.rect.w,frame.rect.h,frame.width,frame.height};
    for (unsigned i=0;i<6;i++) for (unsigned b=0;b<2;b++) header[7+2*i+b]=(uint8_t)(values[i]>>(8*b));
    for (unsigned i=0;i<8;i++) header[19+i]=(uint8_t)(pts>>(8*i));
    live_write(header,sizeof(header)); live_write(c->access_unit,c->size);
}

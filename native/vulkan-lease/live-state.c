/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include <string.h>

void live_release(Live *s, LiveImage *held) {
    if (!held->image.handle) return;
    image_destroy(s->pipeline,&held->image);
    lease_release(s->x,&held->lease);
    *held=(LiveImage){0};
}

void live_reset(Live *s) {
    live_video_stop(s);
    if (s->tail.pending) tail_reject(&s->tail,true);
    else tail_reset(&s->tail);
    live_release(s,&s->current); live_release(s,&s->acknowledged);
    s->dirty=true; s->parked=false; s->resets++;
}

bool live_command(Live *s, const uint8_t command[16]) {
    if (command[1]!=1 || command[15]!=0) return false;
    if (command[0]==0x10) return live_video_hint(s,command);
    if (command[0]==0x09) {
        for (unsigned i=2;i<15;i++) if (command[i]) return false;
        live_reset(s); return true;
    }
    if (command[0]!=0x0e || command[14]>1) return false;
    if (live_u64(command+2)!=s->epoch || !s->tail.pending ||
        live_u32(command+10)!=s->tail.serial) return true; // stale ACK cannot advance ownership
    if (command[14]) { live_reset(s); return true; }
    REQUIRE(tail_ack(&s->tail,live_u32(command+10)));
    live_release(s,&s->acknowledged);
    s->acknowledged=s->current; s->current=(LiveImage){0};
    live_video_ack(s);
    return true;
}

void live_capture(Live *s) {
    REQUIRE(!s->tail.pending && !s->current.image.handle);
    s->captured_at=lease_now();
    // Acknowledge XDamage before acquisition; later changes remain pending.
    xcb_damage_subtract(s->x,s->damage,XCB_NONE,XCB_NONE);
    xcb_flush(s->x); s->dirty=false;
    s->current.lease=lease_acquire(s->x,BP_OK);
    unsigned w=s->current.lease.wire.width,h=s->current.lease.wire.height;
    REQUIRE(w>=32 && h>=32 && w<=1920 && h<=1080);
    if (s->acknowledged.image.handle &&
        (s->acknowledged.lease.wire.generation!=s->current.lease.wire.generation ||
         s->tail.width!=w || s->tail.height!=h)) {
        live_video_stop(s); tail_reset(&s->tail); live_release(s,&s->acknowledged);
    }
    s->current.image=image_import(s->pipeline,&s->current.lease);
    s->tail.video=live_video_select(s,w,h);
    TailPacket packet=tail_encode(&s->tail,s->acknowledged.image.handle?&s->acknowledged.image:NULL,
        &s->current.image,w,h,16);
    REQUIRE(!pthread_mutex_lock(&s->video.output));
    live_begin(s->epoch,packet.serial);
    // Only final encoded bytes cross the process boundary. The GPU span stays
    // owned and immutable until a matching applied-frame ACK or explicit reset.
    live_write(packet.bytes,packet.size);
    REQUIRE(!pthread_mutex_unlock(&s->video.output));
    s->sent_at=lease_now(); s->frames++;
}

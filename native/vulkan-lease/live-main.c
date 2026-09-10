/* SPDX-License-Identifier: AGPL-3.0-only */
#include "live.h"
#include "live-watch.h"
#include <errno.h>
#include <poll.h>
#include <sys/random.h>
#include <string.h>
#include <unistd.h>

int live_main(Pipeline *p, int heartbeat) {
    double last_pulse=0;
    REQUIRE(live_pulse(heartbeat,&last_pulse));
    REQUIRE(!p->software);
    p->live=true;
    Live s={.pipeline=p,.dirty=true};
    const char *video=getenv("BPANE_GPU_VIDEO");
    REQUIRE(!video || !strcmp(video,"0") || !strcmp(video,"1"));
    s.video_enabled=video && !strcmp(video,"1");
    REQUIRE(getrandom(&s.epoch,sizeof(s.epoch),0)==sizeof(s.epoch) && s.epoch);
    tail_open(&s.tail,p); s.x=lease_connect();
    live_video_start(&s);
    xcb_screen_t *screen=xcb_setup_roots_iterator(xcb_get_setup(s.x)).data; REQUIRE(screen);
    const xcb_query_extension_reply_t *ext=xcb_get_extension_data(s.x,&xcb_damage_id);
    REQUIRE(ext && ext->present); s.damage_event=ext->first_event+XCB_DAMAGE_NOTIFY;
    xcb_damage_query_version_reply_t *version=xcb_damage_query_version_reply(s.x,
        xcb_damage_query_version(s.x,1,1),NULL); REQUIRE(version); free(version);
    s.damage=xcb_generate_id(s.x);
    xcb_generic_error_t *error=xcb_request_check(s.x,xcb_damage_create_checked(s.x,s.damage,
        screen->root,XCB_DAMAGE_REPORT_LEVEL_NON_EMPTY)); REQUIRE(!error);
    fprintf(stderr,"GPU tail live: V3DV leases, bounded ACK pipeline, no CPU image capture\n");
    for (;;) {
        // Progress, not pixel changes: static screens and parked ACKs are healthy.
        REQUIRE(live_pulse(heartbeat,&last_pulse));
        REQUIRE(!xcb_connection_has_error(s.x));
        xcb_generic_event_t *event;
        while ((event=xcb_poll_for_event(s.x))) {
            REQUIRE((event->response_type&127)!=0);
            if ((event->response_type&127)==s.damage_event) s.dirty=true;
            free(event);
        }
        struct pollfd input={STDIN_FILENO,POLLIN,0};
        int ready=poll(&input,1,0); REQUIRE(ready>=0 || errno==EINTR);
        if (ready>0) {
            uint8_t command[16];
            if (!live_read(command)) break;
            REQUIRE(live_command(&s,command));
        }
        double now=lease_now();
        REQUIRE(!pthread_mutex_lock(&s.video.control));
        bool video_failed=s.video.state.failed;
        REQUIRE(!pthread_mutex_unlock(&s.video.control));
        if (s.active_video.w && video_failed) s.dirty=true;
        if (s.active_video.w && now-s.video_hint_at>700) s.dirty=true;
        if (s.tail.pending && now-s.sent_at>5000) {
            // No receiver: release leases and park until an explicit join/reset.
            live_reset(&s); s.parked=true;
            fprintf(stderr,"GPU tail: ACK timeout; parked until refresh\n");
        }
        if (!s.parked && !s.tail.pending && s.dirty && now-s.captured_at>=16) {
            live_capture(&s); continue;
        }
        struct pollfd fds[]={{STDIN_FILENO,POLLIN,0},{xcb_get_file_descriptor(s.x),POLLIN,0}};
        int wait=s.dirty && !s.parked && !s.tail.pending?1:50;
        ready=poll(fds,2,wait); REQUIRE(ready>=0 || errno==EINTR);
    }
    live_reset(&s); live_video_join(&s); tail_close(&s.tail);
    xcb_damage_destroy(s.x,s.damage); xcb_disconnect(s.x);
    fprintf(stderr,"GPU tail stopped: frames=%u resets=%u videoFrames=%u videoBytes=%llu\n",
        s.frames,s.resets,s.video.frames,(unsigned long long)s.video.bytes);
    return 0;
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>

typedef struct { FrameImage image; LeaseFrame lease; } Held;
typedef struct {
    Pipeline *p;
    xcb_connection_t *connection;
    xcb_screen_t *screen;
    xcb_gcontext_t gc;
} Source;

static Held acquire(Source *s, unsigned w, unsigned h, unsigned scenario) {
    Held result={0};
    if (s->p->software) {
        // Never overwrite the retained acknowledged image during fixture setup.
        FrameImage pair[]={image_owned(s->p,w,h),image_owned(s->p,w,h)};
        images_bind(s->p,pair); images_prepare(s->p,pair,(Params){w,h,scenario,0});
        image_destroy(s->p,&pair[0]); result.image=pair[1];
    } else {
        fixture_x11(s->connection,s->screen,s->gc,w,h,0);
        if (scenario) fixture_x11(s->connection,s->screen,s->gc,w,h,scenario);
        result.lease=lease_acquire(s->connection,BP_OK);
        REQUIRE(result.lease.wire.width==w && result.lease.wire.height==h);
        result.image=image_import(s->p,&result.lease);
    }
    return result;
}

static void release(Source *s, Held *frame) {
    if (!frame->image.handle) return;
    image_destroy(s->p,&frame->image);
    if (!s->p->software) lease_release(s->connection,&frame->lease);
}

static void resize(Source *s, unsigned w, unsigned h) {
    if (s->p->software) return;
    Display *display=XOpenDisplay(NULL); REQUIRE(display);
    XRRSetScreenSize(display,DefaultRootWindow(display),w,h,w*254/960,h*254/960);
    XSync(display,False); XCloseDisplay(display);
}

int tail_main(Pipeline *p, bool validation, bool export_wire) {
    tail_decoder_tests();
    FILE *wire=export_wire?fopen("/tmp/bpane-gpu-tail.wire","wx"):NULL; REQUIRE(!export_wire || wire);
    Tail tail; tail_open(&tail,p); TailClient client={0}; Source source={.p=p}; Held old={0};
    if (!p->software) {
        source.connection=lease_connect();
        source.screen=xcb_setup_roots_iterator(xcb_get_setup(source.connection)).data; REQUIRE(source.screen);
        source.gc=xcb_generate_id(source.connection);
        xcb_create_gc(source.connection,source.gc,source.screen->root,0,NULL);
    }
    // Dropped packets retain the ACK image; cache misses reset the sender only.
    // The receiver retains its last complete canvas until the next full refresh.
    const struct { unsigned scenario,flags; const char *name; unsigned action; } steps[]={
        {0,0,"cold",0},{0,0,"unchanged",0},{5,0,"tile-copy",0},{0,0,"restore",0},
        {4,0,"scroll",0},{4,0,"scroll-unchanged",0},{6,0,"noise",0},{7,0,"gradient",0},
        {0,4,"collision-restore",0},{3,4,"collision-last-pixel",0},
        {1,0,"dropped",1},{1,0,"after-drop",0},{0,0,"before-eviction",0},
        {5,0,"cache-miss",2},{5,0,"cache-recovery",0},
        {0,8,"motion-disabled",0},{2,0,"solid",0},{2,0,"solid-unchanged",0},
        {8,0,"solid-last-pixel",0},{2,0,"solid-repair",0},
        {0,0,"reconnect",3}
    };
    unsigned dimensions[][2]={{1280,720},{1365,767},{1920,1080}};
    unsigned accepted=0,dropped=0,recovered=0;
    printf("{\"schema\":1,\"mode\":\"vulkan-gpu-tail\",\"software\":%s,\"validation\":%s,"
        "\"intermediateReadbacks\":0,\"senderRawPixelCopies\":0,\"steps\":[",
        p->software?"true":"false",validation?"true":"false");
    for (unsigned geometry=0;geometry<3;geometry++) {
        unsigned w=dimensions[geometry][0],h=dimensions[geometry][1],last_scenario=0;
        release(&source,&old); tail_reset(&tail); resize(&source,w,h);
        for (unsigned step=0;step<sizeof(steps)/sizeof(steps[0]);step++) {
            unsigned scenario=steps[step].scenario,action=steps[step].action;
            if (action==2) tail_client_evict(&client);
            if (action==3) { tail_reset(&tail); release(&source,&old); }
            double prepare=lease_now(); Held current=acquire(&source,w,h,scenario); prepare=lease_now()-prepare;
            TailPacket packet=tail_encode(&tail,old.image.handle?&old.image:NULL,&current.image,w,h,steps[step].flags);
            REQUIRE(!tail_ack(&tail,packet.serial-1) && tail.pending);
            double transport=0,decode=0;
            if (action==1) {
                tail_reject(&tail,false); release(&source,&current); dropped++;
                tail_client_check(&client,last_scenario);
            } else {
                uint8_t *received=tail_transport(&packet,&transport);
                if (step==0) tail_client_negative(&client,received,packet.size,packet.serial);
                double start=lease_now(); bool success=tail_client_decode(&client,received,packet.size,packet.serial);
                decode=lease_now()-start; free(received);
                if (action==2) {
                    REQUIRE(packet.refs && !success); tail_reject(&tail,true); release(&source,&current); recovered++;
                    tail_client_check(&client,last_scenario);
                } else {
                    REQUIRE(success); tail_client_check(&client,scenario);
                    tail_export(wire,&packet,scenario);
                    REQUIRE(tail_ack(&tail,packet.serial) && !tail_ack(&tail,packet.serial));
                    release(&source,&old); old=current; last_scenario=scenario; accepted++;
                }
            }
            if (step==1 || step==5 || step==17) REQUIRE(packet.size==10 && packet.skipped==((w+63)/64)*((h+63)/64));
            if (step==2) REQUIRE(packet.refs>=1);
            if (step==16) REQUIRE(packet.fills==((w+63)/64)*((h+63)/64) && !packet.qoi);
            if (step==18) REQUIRE(packet.qoi==1 && !packet.fills && !packet.refs);
            if (step==19) REQUIRE(packet.fills==1 && !packet.qoi && packet.size==24);
            // Repetitive textures can have several equivalent displacements.
            // Require useful reuse AND the complete pixel oracle, not a guessed
            // physical scroll offset. Uncovered/fixed/dynamic pixels are repaired.
            if (step==4) REQUIRE(packet.scroll && packet.skipped>packet.qoi);
            if (step==14 || action==3) REQUIRE(!packet.skipped && !packet.refs && !packet.scroll);
            if (geometry || step) printf(",");
            printf("{\"width\":%u,\"height\":%u,\"name\":\"%s\",\"scenario\":%u,\"serial\":%u,"
                "\"flags\":%u,\"action\":%u,\"outputBytes\":%u,\"skipped\":%u,\"fills\":%u,\"refs\":%u,\"qoi\":%u,"
                "\"scroll\":%d,\"prepareMs\":%.6f,\"recordMs\":%.6f,\"completionMs\":%.6f,\"cpuMs\":%.6f,"
                "\"transportMs\":%.6f,\"decodeMs\":%.6f,\"pixelErrors\":0}",
                w,h,steps[step].name,scenario,packet.serial,steps[step].flags,action,packet.size,
                packet.skipped,packet.fills,packet.refs,packet.qoi,packet.scroll,
                prepare,packet.record_ms,packet.completion_ms,packet.cpu_ms,transport,decode);
            fflush(stdout);
        }
    }
    release(&source,&old); tail_close(&tail); tail_client_close(&client);
    if (wire) REQUIRE(!fclose(wire));
    if (source.connection) { xcb_free_gc(source.connection,source.gc); xcb_disconnect(source.connection); }
    REQUIRE(!p->validation_errors);
    printf("],\"accepted\":%u,\"dropped\":%u,\"cacheMisses\":%u,\"validationErrors\":0,\"pixelErrors\":0}\n",
        accepted,dropped,recovered);
    return 0;
}

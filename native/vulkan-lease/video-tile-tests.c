/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"
static void boundary_motion(Pipeline *p) {
    for (unsigned scenario=9;scenario<=10;scenario++) {
        FrameImage frames[]={image_owned(p,1280,720),image_owned(p,1280,720)};
        images_bind(p,frames); images_prepare(p,frames,(Params){1280,720,scenario,0});
        Tail t; tail_open(&t,p); TailClient client={0};
        t.video=(VideoRect){130,66,642,362};
        TailPacket first=tail_encode(&t,NULL,&frames[0],1280,720,16);
        REQUIRE(tail_client_decode(&client,first.bytes,first.size,first.serial));
        REQUIRE(tail_ack(&t,first.serial));
        TailPacket motion=tail_encode(&t,&frames[0],&frames[1],1280,720,16);
        // Pure video motion: zero lossless tile commands, even at odd grid edges.
        // A one-pixel change just outside the crop must still repair its cell.
        REQUIRE(motion.skipped==(scenario==9?240u:239u));
        REQUIRE(tail_client_decode(&client,motion.bytes,motion.size,motion.serial));
        REQUIRE(tail_ack(&t,motion.serial));
        for (unsigned y=0;y<720;y++) for (unsigned x=0;x<1280;x++) {
            if (x>=130 && x<772 && y>=66 && y<428) continue;
            uint32_t rgb=scenario==10 && x==129 && y==66?0xfedcba:fixture_color(x,y,1280,720,0);
            uint32_t rgba=0xff000000|(rgb>>16)|(rgb&0xff00)|((rgb&255)<<16);
            REQUIRE(client.canvas[y*1280+x]==rgba);
        }
        // ACK image now contains suppressed pixels: they must not inherit
        // older client cache tokens. Repetition and exit must remain exact.
        TailPacket again=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
        REQUIRE(again.skipped==240 && tail_client_decode(&client,again.bytes,again.size,again.serial));
        REQUIRE(tail_ack(&t,again.serial));
        t.video=(VideoRect){0};
        TailPacket leaving=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
        REQUIRE(tail_client_decode(&client,leaving.bytes,leaving.size,leaving.serial));
        for (unsigned y=66;y<428;y++) for (unsigned x=130;x<772;x++) REQUIRE(client.canvas[y*1280+x]==0xffefcdab);
        REQUIRE(tail_ack(&t,leaving.serial));
        tail_close(&t); tail_client_close(&client);
        image_destroy(p,&frames[0]); image_destroy(p,&frames[1]);
    }
}
void video_tile_tests(Pipeline *p) {
    REQUIRE(p->software);
    boundary_motion(p);
    for (unsigned pass=0;pass<2;pass++) {
    unsigned scenario=pass?7:2;
    FrameImage frames[]={image_owned(p,1280,720),image_owned(p,1280,720)};
    images_bind(p,frames); images_prepare(p,frames,(Params){1280,720,scenario,0});
    Tail t; tail_open(&t,p); TailClient client={0};
    VideoRect r={130,66,642,362}; t.video=r;
    TailPacket first=tail_encode(&t,NULL,&frames[1],1280,720,16);
    REQUIRE(tail_client_decode(&client,first.bytes,first.size,first.serial));
    REQUIRE(video_rect_equal(client.video,r)); tail_client_check(&client,scenario);
    REQUIRE(tail_ack(&t,first.serial));
    // Subsequent fully owned tiles skip encoding, including cache metadata.
    TailPacket second=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
    // Including unaligned boundary cells: an unchanged region must not force
    // repair/refill every frame merely because it intersects previousVideo.
    REQUIRE(second.scroll==0 && second.skipped==240);
    REQUIRE(tail_client_decode(&client,second.bytes,second.size,second.serial));
    REQUIRE(tail_ack(&t,second.serial));
    // A decoded overlay is not lossless content. Poison its framebuffer pixels
    // to prove exit repairs happen even when old/current GPU images are equal.
    for (unsigned y=r.y;y<r.y+r.h;y++) for (unsigned x=r.x;x<r.x+r.w;x++) client.canvas[y*1280+x]=0;
    VideoRect moved={332,168,642,362}; t.video=moved;
    TailPacket moving=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
    REQUIRE(moving.scroll==0 && tail_client_decode(&client,moving.bytes,moving.size,moving.serial));
    REQUIRE(video_rect_equal(client.video,moved)); tail_client_check(&client,scenario);
    REQUIRE(tail_ack(&t,moving.serial));
    for (unsigned y=moved.y;y<moved.y+moved.h;y++) for (unsigned x=moved.x;x<moved.x+moved.w;x++) client.canvas[y*1280+x]=0;
    t.video=(VideoRect){0};
    TailPacket leaving=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
    REQUIRE(leaving.fills+leaving.qoi+leaving.refs>0 && leaving.scroll==0);
    REQUIRE(tail_client_decode(&client,leaving.bytes,leaving.size,leaving.serial));
    REQUIRE(!client.video.w); tail_client_check(&client,scenario); REQUIRE(tail_ack(&t,leaving.serial));
    // A rejected transition must not commit its exclusion region.
    t.video=r; TailPacket rejected=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
    REQUIRE(rejected.serial>leaving.serial); tail_reject(&t,true);
    t.video=(VideoRect){0};
    TailPacket repair=tail_encode(&t,&frames[1],&frames[1],1280,720,16);
    REQUIRE(tail_client_decode(&client,repair.bytes,repair.size,repair.serial));
    tail_client_check(&client,scenario); REQUIRE(tail_ack(&t,repair.serial));
    tail_close(&t); tail_client_close(&client);
    image_destroy(p,&frames[0]); image_destroy(p,&frames[1]);
    }
    fprintf(stderr,"GPU video tiles: warm-up, masking, move/exit repair, rejected transition, flat/QOI/cache passed\n");
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include "live.h"
#include "live-watch.h"
#include "video-gpu.h"
#include "compare-kernel.h"
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <string.h>

enum { WARMUP=2, ROUNDS=8 };

static void gl_samples(CompareKernel kernels[COMPARE_VARIANTS], LeaseFrame frames[2], const Oracle *o) {
    GLsync fence=glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE,0); REQUIRE(fence);
    GLenum status=glClientWaitSync(fence,GL_SYNC_FLUSH_COMMANDS_BIT,UINT64_C(2000000000));
    REQUIRE(status==GL_ALREADY_SIGNALED || status==GL_CONDITION_SATISFIED); glDeleteSync(fence);
    printf("\"gles\":[");
    for (unsigned round=0;round<WARMUP+ROUNDS;round++) for (unsigned k=0;k<2;k++) {
        unsigned variant=((k+round)%2)?5:0;
        double cpu=thread_now();
        CompareTimes t=compare_run(&kernels[variant],&frames[1],&frames[0],o->mask);
        cpu=thread_now()-cpu;
        if (round>=WARMUP) printf("%s{\"variant\":\"%s\",\"round\":%u,\"totalMs\":%.6f,\"cpuMs\":%.6f}",
            round==WARMUP && k==0?"":",",kernels[variant].name,round-WARMUP,t.total,cpu);
    }
    printf("],");
}

static void vk_samples(Pipeline *p, Params params, const Oracle *o) {
    printf("\"samples\":[");
    for (unsigned round=0;round<WARMUP+ROUNDS;round++) for (unsigned k=0;k<2;k++) {
        bool empty=(round+k)%2==0;
        record_pipeline(p,params,empty); // cached programs; recording is outside timing
        Sample s=pipeline_run(p);
        result_check(p,params,o,empty);
        if (round>=WARMUP) printf("%s{\"variant\":\"%s\",\"round\":%u,\"submitMs\":%.6f,\"waitMs\":%.6f,"
            "\"copyMs\":%.6f,\"totalMs\":%.6f,\"cpuMs\":%.6f,\"outputBytes\":%u,\"commands\":%u,\"rawTiles\":%u}",
            round==WARMUP && k==0?"":",",empty?"empty":"pipeline",round-WARMUP,
            s.submit_ms,s.wait_ms,s.copy_ms,s.total_ms,s.cpu_ms,s.bytes,p->result[0],p->result[1]);
    }
    printf("]");
}

int main(int argc, char **argv) {
    if (argc==2 && !strcmp(argv[1],"--health")) return live_health_check(LIVE_HEALTH_PATH);
    if (argc==2 && !strcmp(argv[1],"--video-probe")) {
        REQUIRE(getenv("BPANE_GPU_VIDEO_TEST") && !strcmp(getenv("BPANE_GPU_VIDEO_TEST"),"1"));
        Pipeline p; pipeline_open(&p,false,true);
        int result=video_probe(&p); pipeline_close(&p); return result;
    }
    if (argc==2 && !strcmp(argv[1],"--listen")) {
        REQUIRE(getenv("BPANE_GPU_TAIL") && !strcmp(getenv("BPANE_GPU_TAIL"),"1"));
        return live_listen();
    }
    if (argc==2 && !strcmp(argv[1],"--serve")) {
        REQUIRE(getenv("BPANE_GPU_TAIL") && !strcmp(getenv("BPANE_GPU_TAIL"),"1"));
        Pipeline p; pipeline_open(&p,false,false);
        int result=live_main(&p,-1); pipeline_close(&p); return result;
    }
    bool software=false,validation=false,inspect_inputs=false,audit=false,counters=false,tail=false,export_wire=false;
    for (int i=1;i<argc;i++) {
        if (!strcmp(argv[i],"--software")) software=true;
        else if (!strcmp(argv[i],"--validate")) validation=true;
        else if (!strcmp(argv[i],"--inspect-inputs")) inspect_inputs=true;
        else if (!strcmp(argv[i],"--audit")) audit=true;
        else if (!strcmp(argv[i],"--tail")) tail=true;
        else if (!strcmp(argv[i],"--tail-export")) { tail=true; export_wire=true; }
        else if (!strcmp(argv[i],"--audit-counters")) { audit=true; counters=true; }
        else { fprintf(stderr,"Unknown argument: %s\n",argv[i]); return 2; }
    }
    REQUIRE(!(audit && inspect_inputs) && !(counters && software));
    REQUIRE(!(tail && (audit || inspect_inputs)));
    REQUIRE(software || (getenv("BPANE_GPU_VULKAN_PILOT") && !strcmp(getenv("BPANE_GPU_VULKAN_PILOT"),"1")));
    Pipeline p; pipeline_open(&p,software,validation);
    if (software) { video_gpu_test(&p); video_tile_tests(&p); }
    if (tail) { int result=tail_main(&p,validation,export_wire); pipeline_close(&p); return result; }
    LeaseGpu gl={0}; CompareKernel kernels[COMPARE_VARIANTS];
    xcb_connection_t *connection=NULL; xcb_screen_t *screen=NULL; xcb_gcontext_t gc=0;
    if (!software) {
        gl=lease_gpu(); compare_init(kernels); connection=lease_connect();
        screen=xcb_setup_roots_iterator(xcb_get_setup(connection)).data; REQUIRE(screen);
        gc=xcb_generate_id(connection); xcb_create_gc(connection,gc,screen->root,0,NULL);
    }
    if (audit) {
        printf("{\"schema\":1,\"mode\":\"vulkan-stack-audit\",\"software\":%s,\"validation\":%s,"
            "\"counters\":%s,\"warmup\":1,\"rounds\":6,\"intermediateReadbacks\":0,\"timedOutputCopies\":0,",
            software?"true":"false",validation?"true":"false",counters?"true":"false");
        audit_clocks(); printf("\"cases\":[");
    } else printf("{\"schema\":1,\"mode\":\"vulkan-lease-pipeline\",\"software\":%s,\"validation\":%s,\"inputOracleFirst\":%s,"
        "\"warmup\":%u,\"rounds\":%u,\"intermediateReadbacks\":0,\"cases\":[",
        software?"true":"false",validation?"true":"false",inspect_inputs?"true":"false",WARMUP,ROUNDS);
    unsigned dimensions[][2]={{1280,720},{1365,767},{1920,1080}};
    for (unsigned size=0;size<3;size++) {
        unsigned width=dimensions[size][0],height=dimensions[size][1];
        if (!software && size) {
            Display *display=XOpenDisplay(NULL); REQUIRE(display);
            XRRSetScreenSize(display,DefaultRootWindow(display),width,height,width*254/960,height*254/960);
            XSync(display,False); XCloseDisplay(display);
        }
        for (unsigned scenario=0;scenario<5;scenario++) {
            Params params={width,height,scenario,0}; Oracle oracle; oracle_build(params,&oracle);
            LeaseFrame leases[2]; FrameImage frames[2];
            double import_start=lease_now();
            if (software) {
                frames[0]=image_owned(&p,width,height); frames[1]=image_owned(&p,width,height);
            } else {
                fixture_x11(connection,screen,gc,width,height,0); leases[0]=lease_acquire(connection,BP_OK);
                if (scenario) fixture_x11(connection,screen,gc,width,height,scenario);
                leases[1]=lease_acquire(connection,BP_OK);
                REQUIRE(leases[0].wire.width==width && leases[0].wire.height==height &&
                    leases[1].wire.width==width && leases[1].wire.height==height &&
                    leases[0].wire.generation==leases[1].wire.generation);
                for (unsigned i=0;i<2;i++) { frames[i]=image_import(&p,&leases[i]); lease_import(&gl,&leases[i]); }
            }
            double import_ms=lease_now()-import_start;
            if (!software && inspect_inputs) { frame_check(&leases[0],0); frame_check(&leases[1],scenario); }
            if (size || scenario) printf(",");
            printf("{\"width\":%u,\"height\":%u,\"scenario\":%u,\"importMs\":%.6f,",width,height,scenario,import_ms);
            images_bind(&p,frames);
            double prepare=lease_now(); images_prepare(&p,frames,params); prepare=lease_now()-prepare;
            printf("\"prepareMs\":%.6f,",prepare);
            if (audit) audit_samples(&p,params,&oracle,counters);
            else vk_samples(&p,params,&oracle);
            images_release(&p,frames);
            printf(",");
            if (!software) {
                // V3D 25 CSD does not consume the EGL native in_fence_fd.
                // Vulkan explicitly waits producer semaphores; run GLES only
                // after Vulkan completes AND returns foreign ownership. No
                // CPU pixel read or fabricated sleep establishes readiness.
                if (!audit) gl_samples(kernels,leases,&oracle);
                // Full CPU image oracles only after the complete timed case.
                frame_check(&leases[0],0); frame_check(&leases[1],scenario);
            }
            printf("\"pixelErrors\":0}");
            for (unsigned i=0;i<2;i++) {
                image_destroy(&p,&frames[i]);
                if (!software) { lease_destroy(&gl,&leases[i]); lease_release(connection,&leases[i]); }
            }
        }
    }
    if (!software) { compare_close(kernels); lease_gpu_close(&gl); xcb_disconnect(connection); }
    pipeline_close(&p);
    puts("],\"validationErrors\":0,\"pixelErrors\":0}");
    return 0;
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "audit.h"
#include <sys/resource.h>
#include <time.h>

static double process_now(void) {
    struct timespec t; REQUIRE(!clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t));
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
}

void audit_clocks(void) {
    volatile double sink=0;
    const unsigned count=10000;
    double (*clocks[])(void)={lease_now,thread_now,process_now};
    const char *names[]={"monotonic","threadCpu","processCpu"};
    printf("\"clockReadMeanNs\":{");
    for (unsigned k=0;k<3;k++) {
        double start=lease_now();
        for (unsigned i=0;i<count;i++) sink+=clocks[k]();
        printf("%s\"%s\":%.3f",k?",":"",names[k],(lease_now()-start)*1000000.0/count);
    }
    (void)sink; printf("},");
}

static double usage_ms(struct timeval t) { return t.tv_sec*1000.0+t.tv_usec/1000.0; }

static void sample(Pipeline *p, Params params, const Oracle *o, unsigned stage,
                   unsigned mode, unsigned round, bool counters) {
    const char *stages[]={"empty","bare","classify","compact","full"};
    const char *modes[]={"single","serial8","batch8"};
    unsigned submits=mode==AUDIT_SERIAL?AUDIT_REPEAT:1;
    unsigned repeats=mode==AUDIT_BATCH?AUDIT_REPEAT:1;
    audit_record(p,params,stage,repeats);
    AuditCounters before={0},after={0};
    struct rusage rb,ra; REQUIRE(!getrusage(RUSAGE_SELF,&rb));
    if (counters) audit_counters(&before);
    double cpu=thread_now(),process=process_now(),start=lease_now();
    // No clock reads, result copies, oracle checks, logging or allocations in
    // the serial loop. Only API submission/reset/wait remains on the CPU.
    for (unsigned i=0;i<submits;i++) {
        VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&p->command};
        VK_OK(vkResetFences(p->device,1,&p->fence)); VK_OK(vkQueueSubmit(p->queue,1,&submit,p->fence));
        VK_OK(pipeline_wait(p));
    }
    double elapsed=lease_now()-start;
    process=process_now()-process; cpu=thread_now()-cpu;
    if (counters) audit_counters(&after);
    REQUIRE(!getrusage(RUSAGE_SELF,&ra));
    if (round>=AUDIT_WARMUP) {
        printf("{\"stage\":\"%s\",\"mode\":\"%s\",\"round\":%u,\"operations\":%u,\"waits\":%u,"
            "\"wallMs\":%.6f,\"threadCpuMs\":%.6f,\"processCpuMs\":%.6f,"
            "\"userCpuMs\":%.6f,\"systemCpuMs\":%.6f,\"voluntarySwitches\":%ld,\"involuntarySwitches\":%ld",
            stages[stage],modes[mode],round-AUDIT_WARMUP,submits*repeats,submits,elapsed,cpu,process,
            usage_ms(ra.ru_utime)-usage_ms(rb.ru_utime),usage_ms(ra.ru_stime)-usage_ms(rb.ru_stime),
            ra.ru_nvcsw-rb.ru_nvcsw,ra.ru_nivcsw-rb.ru_nivcsw);
        if (counters) audit_counter_print(&before,&after);
        printf("}");
    }
    // Validate every stage/mode, including all pixels in a gathered raw tile.
    // This readback is after all clocks/counters; next sample re-records commands.
    audit_check(p,params,o,stage);
}

void audit_samples(Pipeline *p, Params params, const Oracle *o, bool counters) {
    printf("\"samples\":[");
    bool first=true;
    for (unsigned round=0;round<AUDIT_WARMUP+AUDIT_ROUNDS;round++) {
        // Rotate modes and stages so they do not have a fixed temperature/cache
        // ordering. All runs use the same immutable GPU-resident input pair.
        for (unsigned s=0;s<AUDIT_STAGES;s++) for (unsigned m=0;m<AUDIT_MODES;m++) {
            unsigned stage=(s+round)%AUDIT_STAGES,mode=(m+round)%AUDIT_MODES;
            if (round>=AUDIT_WARMUP) { if (!first) printf(","); first=false; }
            sample(p,params,o,stage,mode,round,counters);
        }
    }
    printf("]");
}

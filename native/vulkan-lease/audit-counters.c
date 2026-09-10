/* SPDX-License-Identifier: AGPL-3.0-only */
#include "audit.h"
#include <dirent.h>
#include <inttypes.h>
#include <string.h>

static const char *engines[AUDIT_ENGINES]={"bin","render","tfu","csd","cache_clean","cpu"};

void audit_counters(AuditCounters *out) {
    *out=(AuditCounters){0};
    DIR *directory=opendir("/proc/self/fdinfo"); REQUIRE(directory);
    struct dirent *entry;
    while ((entry=readdir(directory))) {
        if (entry->d_name[0]=='.') continue;
        char path[320],line[512];
        REQUIRE(snprintf(path,sizeof(path),"/proc/self/fdinfo/%s",entry->d_name)>0);
        FILE *file=fopen(path,"r"); if (!file) continue; // transient directory FD
        AuditClient client={0}; bool v3d=false,id=false; unsigned ns=0,jobs=0;
        while (fgets(line,sizeof(line),file)) {
            char name[48],driver[32]; uint64_t value;
            if (sscanf(line,"drm-driver: %31s",driver)==1) v3d=!strcmp(driver,"v3d");
            if (sscanf(line,"drm-client-id: %" SCNu64,&value)==1) { client.id=value; id=true; }
            if (sscanf(line,"drm-engine-%47[^:]: %" SCNu64,name,&value)==2)
                for (unsigned i=0;i<AUDIT_ENGINES;i++) if (!strcmp(name,engines[i])) {
                    client.ns[i]=value; ns|=1u<<i;
                }
            if (sscanf(line,"v3d-jobs-%47[^:]: %" SCNu64,name,&value)==2)
                for (unsigned i=0;i<AUDIT_ENGINES;i++) if (!strcmp(name,engines[i])) {
                    client.jobs[i]=value; jobs|=1u<<i;
                }
        }
        REQUIRE(!ferror(file)); fclose(file);
        if (!v3d) continue;
        REQUIRE(id && ns==((1u<<AUDIT_ENGINES)-1) && jobs==ns);
        bool duplicate=false;
        for (unsigned i=0;i<out->count;i++) if (out->clients[i].id==client.id) duplicate=true;
        if (!duplicate) { REQUIRE(out->count<AUDIT_CLIENTS); out->clients[out->count++]=client; }
    }
    closedir(directory);
    REQUIRE(out->count>0); // unsupported stats must never appear as zero GPU work
}

void audit_counter_print(const AuditCounters *before, const AuditCounters *after) {
    REQUIRE(before->count==after->count);
    uint64_t ns[AUDIT_ENGINES]={0},jobs[AUDIT_ENGINES]={0};
    for (unsigned i=0;i<before->count;i++) {
        const AuditClient *a=&before->clients[i],*b=NULL;
        for (unsigned j=0;j<after->count;j++) if (after->clients[j].id==a->id) b=&after->clients[j];
        REQUIRE(b);
        for (unsigned e=0;e<AUDIT_ENGINES;e++) {
            REQUIRE(b->ns[e]>=a->ns[e] && b->jobs[e]>=a->jobs[e]);
            ns[e]+=b->ns[e]-a->ns[e]; jobs[e]+=b->jobs[e]-a->jobs[e];
        }
    }
    printf(",\"engines\":{");
    for (unsigned e=0;e<AUDIT_ENGINES;e++) printf("%s\"%s\":{\"activeMs\":%.6f,\"jobs\":%" PRIu64 "}",
        e?",":"",engines[e],ns[e]/1000000.0,jobs[e]);
    printf("}");
}

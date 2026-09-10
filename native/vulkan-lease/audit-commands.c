/* SPDX-License-Identifier: AGPL-3.0-only */
#include "audit.h"
#include <string.h>

static void barrier(Pipeline *p, VkPipelineStageFlags src, VkPipelineStageFlags dst,
                    VkAccessFlags read, VkAccessFlags write) {
    VkMemoryBarrier b={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,.srcAccessMask=read,.dstAccessMask=write};
    vkCmdPipelineBarrier(p->command,src,dst,0,1,&b,0,NULL,0,NULL);
}

static void begin(Pipeline *p) {
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo info={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&info));
}

static void compute_barrier(Pipeline *p) {
    barrier(p,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT|VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT|
        VK_ACCESS_TRANSFER_READ_BIT|VK_ACCESS_TRANSFER_WRITE_BIT,
        VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT);
}

static void dispatch(Pipeline *p, VkPipeline shader, unsigned x, unsigned y) {
    vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,shader);
    vkCmdDispatch(p->command,x,y,1);
}

void audit_record(Pipeline *p, Params params, unsigned stage, unsigned repeats) {
    REQUIRE(stage<AUDIT_STAGES && (repeats==1 || repeats==AUDIT_REPEAT));
    unsigned x=(params.width+63)/64,y=(params.height+63)/64;
    begin(p);
    vkCmdBindDescriptorSets(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->layout,0,1,&p->set,0,NULL);
    vkCmdPushConstants(p->command,p->layout,VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(params),&params);
    for (unsigned i=0;i<repeats;i++) {
        // Reused output/scratch have explicit RAW/WAR/WAW dependencies, including
        // between repetitions. Batching must not obtain speed from data races.
        compute_barrier(p);
        if (stage==AUDIT_EMPTY) { dispatch(p,p->empty,1,1); continue; }
        dispatch(p,stage==AUDIT_BARE?p->bare:p->diff,x,y);
        if (stage>=AUDIT_COMPACT) { compute_barrier(p); dispatch(p,p->compact,1,1); }
        if (stage==AUDIT_FULL) { compute_barrier(p); dispatch(p,p->gather,x*y,1); }
    }
    // Same final host visibility contract in all modes. No copy occurs here.
    barrier(p,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_HOST_BIT,
        VK_ACCESS_SHADER_WRITE_BIT,VK_ACCESS_HOST_READ_BIT);
    VK_OK(vkEndCommandBuffer(p->command));
}

static void scratch_read_for_oracle(Pipeline *p) {
    // Diagnostic correctness read AFTER the complete timed sample. This is not
    // an intermediate readback in the measured or production processing path.
    begin(p);
    barrier(p,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_ACCESS_SHADER_WRITE_BIT,VK_ACCESS_TRANSFER_READ_BIT|VK_ACCESS_TRANSFER_WRITE_BIT);
    VkBufferCopy copy={.size=2*CAPACITY*sizeof(uint32_t)};
    vkCmdCopyBuffer(p->command,p->intermediate.handle,p->output.handle,1,&copy);
    barrier(p,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_HOST_BIT,
        VK_ACCESS_TRANSFER_WRITE_BIT,VK_ACCESS_HOST_READ_BIT);
    VK_OK(vkEndCommandBuffer(p->command));
    VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&p->command};
    VK_OK(vkResetFences(p->device,1,&p->fence)); VK_OK(vkQueueSubmit(p->queue,1,&submit,p->fence));
    VK_OK(pipeline_wait(p));
}

void audit_check(Pipeline *p, Params params, const Oracle *o, unsigned stage) {
    unsigned tiles=((params.width+63)/64)*((params.height+63)/64);
    if (stage==AUDIT_BARE || stage==AUDIT_CLASSIFY) {
        scratch_read_for_oracle(p);
        const uint32_t *out=p->output.mapped;
        for (unsigned i=0;i<tiles;i++) {
            REQUIRE(out[i]==(stage==AUDIT_BARE?(o->flags[i]&1):o->flags[i]));
            if (stage==AUDIT_CLASSIFY) REQUIRE(out[CAPACITY+i]==o->colors[i]);
        }
    } else {
        const uint32_t *out=p->output.mapped;
        REQUIRE(out[2]==tiles && out[3]==1 && out[0]<=tiles && out[1]<=out[0]);
        if (stage==AUDIT_COMPACT) {
            unsigned commands=0,raw=0;
            for (unsigned i=0;i<tiles;i++) if (o->flags[i]&1) {
                REQUIRE(commands<out[0]);
                const uint32_t *c=out+4+4*commands++;
                bool r=(o->flags[i]&2)!=0;
                REQUIRE(c[0]==i && c[1]==(r?2u:1u) && c[2]==o->colors[i] && c[3]==(r?raw:0));
                if (r) raw++;
            }
            REQUIRE(commands==out[0] && raw==out[1]);
        } else {
            memcpy(p->result,out,(4+4*out[0])*sizeof(uint32_t));
            memcpy(p->result+HEADER_WORDS,out+HEADER_WORDS,(size_t)out[1]*TILE_WORDS*sizeof(uint32_t));
            result_check(p,params,o,stage==AUDIT_EMPTY);
        }
    }
    REQUIRE(!p->validation_errors);
}

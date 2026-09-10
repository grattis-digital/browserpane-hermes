/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include <string.h>
#include <time.h>

double thread_now(void) {
    struct timespec t; REQUIRE(!clock_gettime(CLOCK_THREAD_CPUTIME_ID,&t));
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
}

static void storage_barrier(Pipeline *p) {
    VkMemoryBarrier barrier={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask=VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT,
        .dstAccessMask=VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT};
    vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
        0,1,&barrier,0,NULL,0,NULL);
}

void record_pipeline(Pipeline *p, Params params, bool empty) {
    REQUIRE(((params.width+63)/64)*((params.height+63)/64)<=CAPACITY);
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&begin));
    vkCmdBindDescriptorSets(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->layout,0,1,&p->set,0,NULL);
    vkCmdPushConstants(p->command,p->layout,VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(params),&params);
    storage_barrier(p);
    vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,empty?p->empty:p->diff);
    vkCmdDispatch(p->command,empty?1:(params.width+63)/64,empty?1:(params.height+63)/64,1);
    if (!empty) {
        storage_barrier(p);
        vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->compact);
        vkCmdDispatch(p->command,1,1,1);
        storage_barrier(p);
        vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->gather);
        vkCmdDispatch(p->command,((params.width+63)/64)*((params.height+63)/64),1,1);
    }
    VkMemoryBarrier host={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask=VK_ACCESS_SHADER_WRITE_BIT,.dstAccessMask=VK_ACCESS_HOST_READ_BIT};
    vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_HOST_BIT,
        0,1,&host,0,NULL,0,NULL);
    VK_OK(vkEndCommandBuffer(p->command));
}

Sample pipeline_run(Pipeline *p) {
    double start=lease_now(), cpu=thread_now();
    VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&p->command};
    VK_OK(vkResetFences(p->device,1,&p->fence)); VK_OK(vkQueueSubmit(p->queue,1,&submit,p->fence));
    double submitted=lease_now();
    VK_OK(pipeline_wait(p));
    double completed=lease_now();
    // The first CPU data access is AFTER the entire diff/scan/gather submission.
    const uint32_t *gpu=p->output.mapped;
    memcpy(p->result,gpu,16);
    uint32_t commands=p->result[0], raw=p->result[1], tiles=p->result[2];
    REQUIRE(tiles>0 && tiles<=CAPACITY && commands<=tiles && raw<=commands && p->result[3]==1);
    memcpy(p->result+4,gpu+4,commands*16);
    memcpy(p->result+HEADER_WORDS,gpu+HEADER_WORDS,(size_t)raw*TILE_WORDS*4);
    double copied=lease_now(), used=thread_now()-cpu;
    REQUIRE(!p->validation_errors);
    return (Sample){submitted-start,completed-submitted,copied-completed,copied-start,used,
        16+commands*16+raw*TILE_WORDS*4};
}

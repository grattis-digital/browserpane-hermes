/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"
#include <time.h>

static double process_cpu(void) {
    struct timespec t; REQUIRE(!clock_gettime(CLOCK_PROCESS_CPUTIME_ID,&t));
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
}

static void bind(Tail *t, FrameImage *old, FrameImage *current) {
    VkDescriptorImageInfo images[2]={{.imageView=old->view,.imageLayout=VK_IMAGE_LAYOUT_GENERAL},
        {.imageView=current->view,.imageLayout=VK_IMAGE_LAYOUT_GENERAL}};
    Buffer *buffers[]={&t->state,&t->encoded,&t->output};
    VkDescriptorBufferInfo info[3]; VkWriteDescriptorSet writes[5];
    for (unsigned i=0;i<5;i++) {
        writes[i]=(VkWriteDescriptorSet){.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet=t->set,.dstBinding=i,.descriptorCount=1,
            .descriptorType=i<2?VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:VK_DESCRIPTOR_TYPE_STORAGE_BUFFER};
        if (i<2) writes[i].pImageInfo=&images[i];
        else { info[i-2]=(VkDescriptorBufferInfo){buffers[i-2]->handle,0,buffers[i-2]->size};
            writes[i].pBufferInfo=&info[i-2]; }
    }
    vkUpdateDescriptorSets(t->p->device,5,writes,0,NULL);
}

static void image_boundary(Pipeline *p, FrameImage *image, bool release) {
    if (!image->external) return;
    VkImageMemoryBarrier b={.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .oldLayout=VK_IMAGE_LAYOUT_GENERAL,.newLayout=VK_IMAGE_LAYOUT_GENERAL,
        .srcAccessMask=release?VK_ACCESS_SHADER_READ_BIT:0,.dstAccessMask=release?0:VK_ACCESS_SHADER_READ_BIT,
        .srcQueueFamilyIndex=release?p->family:VK_QUEUE_FAMILY_FOREIGN_EXT,
        .dstQueueFamilyIndex=release?VK_QUEUE_FAMILY_FOREIGN_EXT:p->family,.image=image->handle,
        .subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1}};
    vkCmdPipelineBarrier(p->command,release?VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT:VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
        release?VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT:VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,0,NULL,0,NULL,1,&b);
}

static void record(Tail *t, FrameImage *old, FrameImage *current, TailParams params) {
    Pipeline *p=t->p; bind(t,old,current);
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&begin));
    image_boundary(p,current,false); if (old!=current) image_boundary(p,old,false);
    vkCmdBindDescriptorSets(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,t->layout,0,1,&t->set,0,NULL);
    vkCmdPushConstants(p->command,t->layout,VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(params),&params);
    unsigned x=(params.width+63)/64,y=(params.height+63)/64;
    for (unsigned stage=0;stage<7;stage++) {
        VkMemoryBarrier b={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,
            .srcAccessMask=VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT,
            .dstAccessMask=VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT};
        vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,1,&b,0,NULL,0,NULL);
        vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,t->stages[stage]);
        vkCmdDispatch(p->command,stage==0?129:stage==2?x:(stage==3 || stage==6)?x*y:1,stage==2?y:1,1);
    }
    image_boundary(p,current,true); if (old!=current) image_boundary(p,old,true);
    VkMemoryBarrier host={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,
        .srcAccessMask=VK_ACCESS_SHADER_WRITE_BIT,.dstAccessMask=VK_ACCESS_HOST_READ_BIT};
    vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_HOST_BIT,
        0,1,&host,0,NULL,0,NULL);
    VK_OK(vkEndCommandBuffer(p->command));
}

TailPacket tail_encode(Tail *t, FrameImage *old, FrameImage *current, unsigned w, unsigned h, unsigned flags) {
    REQUIRE(!t->pending && w>=32 && h>=32 && w<=1920 && h<=1080 && t->serial<UINT32_MAX);
    REQUIRE((flags&~28u)==0); // diagnostics plus explicit video-region integration
    REQUIRE(video_rect_valid(t->video,w,h));
    bool valid=t->valid && old && t->width==w && t->height==h;
    if (!old) old=current;
    t->width=w; t->height=h; t->serial++; t->pending_bank=1-t->bank;
    t->pending_video=(flags&16u)?t->video:(VideoRect){0};
    TailParams params={w,h,t->serial,flags|(valid?1u:2u),t->bank,t->pending_bank,0,0,
        t->pending_video,valid?t->acked_video:(VideoRect){0}};
    // Video pixels are not a lossless cache source. Do not translate them into
    // static content; motion reuse can resume after the repaired exit is ACKed.
    if (params.video.w || params.previous_video.w) params.flags|=8u;
    double cpu=process_cpu(),start=lease_now(); record(t,old,current,params);
    double recorded=lease_now();
    VkSemaphore waits[2]; unsigned count=0; FrameImage *frames[]={current,old};
    for (unsigned i=0;i<(old==current?1u:2u);i++) if (frames[i]->ready && !frames[i]->ready_consumed)
        waits[count++]=frames[i]->ready;
    VkPipelineStageFlags stages[]={VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,VK_PIPELINE_STAGE_ALL_COMMANDS_BIT};
    VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&t->p->command,
        .waitSemaphoreCount=count,.pWaitSemaphores=waits,.pWaitDstStageMask=stages};
    VK_OK(vkResetFences(t->p->device,1,&t->p->fence)); VK_OK(vkQueueSubmit(t->p->queue,1,&submit,t->p->fence));
    VK_OK(pipeline_wait(t->p));
    double done=lease_now(); cpu=process_cpu()-cpu;
    current->ready_consumed=true; old->ready_consumed=true;
    const uint32_t *out=t->output.mapped;
    REQUIRE(out[0]==0x42504754 && out[1]==1 && out[2]>=10 && out[2]<=TAIL_OUTPUT_BYTES-64 && out[3]==t->serial);
    REQUIRE(out[9]==((w+63)/64)*((h+63)/64) && out[4]+out[5]+out[6]+out[7]==out[9]);
    REQUIRE(!t->p->validation_errors); t->pending=true;
    // The CPU obtains only a final size/header and an opaque encoded byte span.
    // No raw pixels, hashes, candidate list or encoder scratch are read back.
    return (TailPacket){(const uint8_t *)(out+16),out[2],out[3],out[4],out[5],out[6],out[7],
        (int32_t)out[8],recorded-start,done-recorded,cpu};
}

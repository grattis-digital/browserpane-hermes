/* SPDX-License-Identifier: AGPL-3.0-only */
#include "video-gpu.h"

static void boundary(VideoGpu *v,FrameImage *image,bool release) {
    Pipeline *p=v->p;
    VkImageMemoryBarrier in={.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .oldLayout=VK_IMAGE_LAYOUT_GENERAL,.newLayout=VK_IMAGE_LAYOUT_GENERAL,.image=image->handle,
        .srcAccessMask=release?VK_ACCESS_SHADER_READ_BIT:0,.dstAccessMask=release?0:VK_ACCESS_SHADER_READ_BIT,
        .srcQueueFamilyIndex=release?p->family:VK_QUEUE_FAMILY_FOREIGN_EXT,
        .dstQueueFamilyIndex=release?VK_QUEUE_FAMILY_FOREIGN_EXT:p->family,
        .subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1}};
    VkBufferMemoryBarrier out={.sType=VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER,
        .srcAccessMask=release?VK_ACCESS_SHADER_WRITE_BIT:0,
        .dstAccessMask=release?0:VK_ACCESS_SHADER_WRITE_BIT,
        .srcQueueFamilyIndex=release?p->family:VK_QUEUE_FAMILY_FOREIGN_EXT,
        .dstQueueFamilyIndex=release?VK_QUEUE_FAMILY_FOREIGN_EXT:p->family,
        .buffer=v->raw.handle,.offset=0,.size=VK_WHOLE_SIZE};
    vkCmdPipelineBarrier(p->command,release?VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT:VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
        release?VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT:VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,
        0,NULL,v->external?1:0,&out,image->external?1:0,&in);
}
bool video_gpu_convert(VideoGpu *v,FrameImage *image,VideoParams params) {
    Pipeline *p=v->p;
    VkDescriptorImageInfo im={.imageView=image->view,.imageLayout=VK_IMAGE_LAYOUT_GENERAL};
    VkDescriptorBufferInfo buf={v->raw.handle,0,v->raw.size};
    VkWriteDescriptorSet writes[]={
        {.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,.dstSet=v->set,.dstBinding=0,.descriptorCount=1,
         .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,.pImageInfo=&im},
        {.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,.dstSet=v->set,.dstBinding=1,.descriptorCount=1,
         .descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.pBufferInfo=&buf}};
    vkUpdateDescriptorSets(p->device,2,writes,0,NULL);
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&begin)); boundary(v,image,false);
    vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,v->shader);
    vkCmdBindDescriptorSets(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,v->layout,0,1,&v->set,0,NULL);
    vkCmdPushConstants(p->command,v->layout,VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(params),&params);
    vkCmdDispatch(p->command,(params.stride+31)/32,(params.rows+15)/16,1);
    boundary(v,image,true);
    if (p->software) {
        VkMemoryBarrier host={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,.srcAccessMask=VK_ACCESS_SHADER_WRITE_BIT,
            .dstAccessMask=VK_ACCESS_HOST_READ_BIT};
        vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_HOST_BIT,0,1,&host,0,NULL,0,NULL);
    }
    VK_OK(vkEndCommandBuffer(p->command));
    VkPipelineStageFlags stage=VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
    VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&p->command,
        .waitSemaphoreCount=image->ready&&!image->ready_consumed?1:0,.pWaitSemaphores=&image->ready,.pWaitDstStageMask=&stage};
    VK_OK(vkResetFences(p->device,1,&p->fence)); VK_OK(vkQueueSubmit(p->queue,1,&submit,p->fence));
    // Completion/ownership only: no CPU access to the raw NV12 allocation.
    VK_OK(pipeline_wait(p));
    image->ready_consumed=true; REQUIRE(!p->validation_errors); return true;
}

/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include <drm_fourcc.h>
#include <unistd.h>

static VkImageCreateInfo image_info(unsigned width, unsigned height, VkFormat format) {
    REQUIRE(width>=32 && width<=1920 && height>=32 && height<=1080);
    return (VkImageCreateInfo){.sType=VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
        .imageType=VK_IMAGE_TYPE_2D,.format=format,.extent={width,height,1},.mipLevels=1,.arrayLayers=1,
        .samples=VK_SAMPLE_COUNT_1_BIT,.tiling=VK_IMAGE_TILING_OPTIMAL,
        .usage=VK_IMAGE_USAGE_STORAGE_BIT,.sharingMode=VK_SHARING_MODE_EXCLUSIVE,
        .initialLayout=VK_IMAGE_LAYOUT_UNDEFINED};
}

static void view_create(Pipeline *p, FrameImage *image, VkFormat format) {
    VkImageViewCreateInfo view={.sType=VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO,.image=image->handle,
        .viewType=VK_IMAGE_VIEW_TYPE_2D,.format=format,
        .subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1}};
    VK_OK(vkCreateImageView(p->device,&view,NULL,&image->view));
}

FrameImage image_owned(Pipeline *p, unsigned width, unsigned height) {
    FrameImage image={0};
    VkImageCreateInfo create=image_info(width,height,VK_FORMAT_R8G8B8A8_UNORM);
    VK_OK(vkCreateImage(p->device,&create,NULL,&image.handle));
    VkMemoryRequirements req; vkGetImageMemoryRequirements(p->device,image.handle,&req);
    VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,.allocationSize=req.size,
        .memoryTypeIndex=memory_type(p,req.memoryTypeBits,VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)};
    VK_OK(vkAllocateMemory(p->device,&alloc,NULL,&image.memory));
    VK_OK(vkBindImageMemory(p->device,image.handle,image.memory,0));
    view_create(p,&image,create.format);
    return image;
}

static void import_properties(Pipeline *p, BpLeaseReply *wire, VkFormat format) {
    VkPhysicalDeviceExternalImageFormatInfo external={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO,
        .handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT};
    VkPhysicalDeviceImageDrmFormatModifierInfoEXT modifier={
        .sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_DRM_FORMAT_MODIFIER_INFO_EXT,.pNext=&external,
        .drmFormatModifier=wire->modifier,.sharingMode=VK_SHARING_MODE_EXCLUSIVE};
    VkPhysicalDeviceImageFormatInfo2 info={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2,
        .pNext=&modifier,.format=format,.type=VK_IMAGE_TYPE_2D,
        .tiling=VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT,.usage=VK_IMAGE_USAGE_STORAGE_BIT};
    VkExternalImageFormatProperties props={.sType=VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES};
    VkImageFormatProperties2 result={.sType=VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2,.pNext=&props};
    VkResult status=vkGetPhysicalDeviceImageFormatProperties2(p->physical,&info,&result);
    if (!p->live) fprintf(stderr,"lease storage import fourcc=%08x modifier=%016llx stride=%u offset=%u %ux%u status=%d\n",
        wire->fourcc,(unsigned long long)wire->modifier,wire->strides[0],wire->offsets[0],wire->width,wire->height,status);
    // Fail closed: never hide a full-image copy or CPU conversion fallback.
    VK_OK(status);
    REQUIRE(props.externalMemoryProperties.externalMemoryFeatures&VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT);
    REQUIRE(wire->width<=result.imageFormatProperties.maxExtent.width &&
            wire->height<=result.imageFormatProperties.maxExtent.height);
}

static void import_ready(Pipeline *p, FrameImage *image, int fd) {
    VkPhysicalDeviceExternalSemaphoreInfo info={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_SEMAPHORE_INFO,
        .handleType=VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT};
    VkExternalSemaphoreProperties props={.sType=VK_STRUCTURE_TYPE_EXTERNAL_SEMAPHORE_PROPERTIES};
    vkGetPhysicalDeviceExternalSemaphoreProperties(p->physical,&info,&props);
    REQUIRE(props.externalSemaphoreFeatures&VK_EXTERNAL_SEMAPHORE_FEATURE_IMPORTABLE_BIT);
    VkSemaphoreCreateInfo create={.sType=VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO};
    VK_OK(vkCreateSemaphore(p->device,&create,NULL,&image->ready));
    VkImportSemaphoreFdInfoKHR imp={.sType=VK_STRUCTURE_TYPE_IMPORT_SEMAPHORE_FD_INFO_KHR,
        .semaphore=image->ready,.flags=VK_SEMAPHORE_IMPORT_TEMPORARY_BIT,
        .handleType=VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_SYNC_FD_BIT,.fd=dup(fd)};
    REQUIRE(imp.fd>=0);
    PFN_vkImportSemaphoreFdKHR fn=(PFN_vkImportSemaphoreFdKHR)vkGetDeviceProcAddr(p->device,"vkImportSemaphoreFdKHR");
    REQUIRE(fn); VK_OK(fn(p->device,&imp)); // successful import consumes dup, not the lease FD
}

FrameImage image_import(Pipeline *p, LeaseFrame *frame) {
    BpLeaseReply *wire=&frame->wire;
    REQUIRE(wire->planes==1 && wire->nfd==2 && wire->modifier!=DRM_FORMAT_MOD_INVALID);
    VkFormat format;
    switch (wire->fourcc) {
    case DRM_FORMAT_ARGB8888: case DRM_FORMAT_XRGB8888: format=VK_FORMAT_B8G8R8A8_UNORM; break;
    case DRM_FORMAT_ABGR8888: case DRM_FORMAT_XBGR8888: format=VK_FORMAT_R8G8B8A8_UNORM; break;
    default: REQUIRE(!"Unsupported lease fourcc"); return (FrameImage){0};
    }
    import_properties(p,wire,format);
    FrameImage image={.external=true};
    VkSubresourceLayout plane={.offset=wire->offsets[0],.rowPitch=wire->strides[0]};
    VkExternalMemoryImageCreateInfo external={.sType=VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO,
        .handleTypes=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT};
    VkImageDrmFormatModifierExplicitCreateInfoEXT modifier={
        .sType=VK_STRUCTURE_TYPE_IMAGE_DRM_FORMAT_MODIFIER_EXPLICIT_CREATE_INFO_EXT,.pNext=&external,
        .drmFormatModifier=wire->modifier,.drmFormatModifierPlaneCount=1,.pPlaneLayouts=&plane};
    VkImageCreateInfo create=image_info(wire->width,wire->height,format);
    create.tiling=VK_IMAGE_TILING_DRM_FORMAT_MODIFIER_EXT; create.pNext=&modifier;
    VK_OK(vkCreateImage(p->device,&create,NULL,&image.handle));
    VkMemoryRequirements req; vkGetImageMemoryRequirements(p->device,image.handle,&req);
    off_t fd_size=lseek(frame->fds[0],0,SEEK_END);
    REQUIRE(lseek(frame->fds[0],0,SEEK_SET)==0);
    if (!p->live) fprintf(stderr,"lease memory required=%llu alignment=%llu fdBytes=%lld\n",
        (unsigned long long)req.size,(unsigned long long)req.alignment,(long long)fd_size);
    REQUIRE(fd_size>0 && (uint64_t)fd_size>=req.size);
    VkMemoryFdPropertiesKHR fdprops={.sType=VK_STRUCTURE_TYPE_MEMORY_FD_PROPERTIES_KHR};
    PFN_vkGetMemoryFdPropertiesKHR getfd=(PFN_vkGetMemoryFdPropertiesKHR)vkGetDeviceProcAddr(p->device,"vkGetMemoryFdPropertiesKHR");
    REQUIRE(getfd); VK_OK(getfd(p->device,VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT,frame->fds[0],&fdprops));
    VkMemoryDedicatedAllocateInfo dedicated={.sType=VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO,.image=image.handle};
    VkImportMemoryFdInfoKHR imp={.sType=VK_STRUCTURE_TYPE_IMPORT_MEMORY_FD_INFO_KHR,.pNext=&dedicated,
        .handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT,.fd=dup(frame->fds[0])};
    REQUIRE(imp.fd>=0);
    VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,.pNext=&imp,
        .allocationSize=req.size,.memoryTypeIndex=memory_type(p,req.memoryTypeBits&fdprops.memoryTypeBits,0)};
    VK_OK(vkAllocateMemory(p->device,&alloc,NULL,&image.memory));
    VK_OK(vkBindImageMemory(p->device,image.handle,image.memory,0));
    view_create(p,&image,format); import_ready(p,&image,frame->fds[1]);
    return image;
}

void image_destroy(Pipeline *p, FrameImage *image) {
    if (image->ready) vkDestroySemaphore(p->device,image->ready,NULL);
    vkDestroyImageView(p->device,image->view,NULL); vkDestroyImage(p->device,image->handle,NULL);
    vkFreeMemory(p->device,image->memory,NULL); *image=(FrameImage){0};
}

void images_bind(Pipeline *p, FrameImage frames[2]) {
    VkDescriptorImageInfo images[2]; VkDescriptorBufferInfo buffers[2]; VkWriteDescriptorSet writes[4];
    for (unsigned i=0;i<4;i++) {
        writes[i]=(VkWriteDescriptorSet){.sType=VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
            .dstSet=p->set,.dstBinding=i,.descriptorCount=1};
        if (i<2) {
            images[i]=(VkDescriptorImageInfo){.imageView=frames[i].view,.imageLayout=VK_IMAGE_LAYOUT_GENERAL};
            writes[i].descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_IMAGE; writes[i].pImageInfo=&images[i];
        } else {
            Buffer *b=i==2?&p->intermediate:&p->output;
            buffers[i-2]=(VkDescriptorBufferInfo){b->handle,0,b->size};
            writes[i].descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER; writes[i].pBufferInfo=&buffers[i-2];
        }
    }
    vkUpdateDescriptorSets(p->device,4,writes,0,NULL);
}

static void image_barriers(Pipeline *p, FrameImage frames[2], bool release) {
    VkImageMemoryBarrier barriers[2];
    for (unsigned i=0;i<2;i++) barriers[i]=(VkImageMemoryBarrier){.sType=VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER,
        .oldLayout=frames[i].external?VK_IMAGE_LAYOUT_GENERAL:VK_IMAGE_LAYOUT_UNDEFINED,
        .newLayout=VK_IMAGE_LAYOUT_GENERAL,.image=frames[i].handle,
        .srcAccessMask=release?VK_ACCESS_SHADER_READ_BIT:0,
        .dstAccessMask=release?0:VK_ACCESS_SHADER_READ_BIT|VK_ACCESS_SHADER_WRITE_BIT,
        .srcQueueFamilyIndex=frames[i].external?(release?p->family:VK_QUEUE_FAMILY_FOREIGN_EXT):VK_QUEUE_FAMILY_IGNORED,
        .dstQueueFamilyIndex=frames[i].external?(release?VK_QUEUE_FAMILY_FOREIGN_EXT:p->family):VK_QUEUE_FAMILY_IGNORED,
        .subresourceRange={VK_IMAGE_ASPECT_COLOR_BIT,0,1,0,1}};
    vkCmdPipelineBarrier(p->command,release?VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT:VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
        release?VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT:VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,0,NULL,0,NULL,2,barriers);
}

static void frame_submit(Pipeline *p, FrameImage frames[2], bool wait) {
    VK_OK(vkEndCommandBuffer(p->command));
    VkSemaphore semaphores[]={frames[0].ready,frames[1].ready};
    VkPipelineStageFlags stages[]={VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,VK_PIPELINE_STAGE_ALL_COMMANDS_BIT};
    VkSubmitInfo submit={.sType=VK_STRUCTURE_TYPE_SUBMIT_INFO,.commandBufferCount=1,.pCommandBuffers=&p->command,
        .waitSemaphoreCount=wait?2:0,.pWaitSemaphores=semaphores,.pWaitDstStageMask=stages};
    VK_OK(vkResetFences(p->device,1,&p->fence)); VK_OK(vkQueueSubmit(p->queue,1,&submit,p->fence));
    VK_OK(pipeline_wait(p));
    REQUIRE(!p->validation_errors);
}

void images_prepare(Pipeline *p, FrameImage frames[2], Params params) {
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&begin)); image_barriers(p,frames,false);
    if (!frames[0].external) {
        vkCmdBindPipeline(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->fixture);
        vkCmdBindDescriptorSets(p->command,VK_PIPELINE_BIND_POINT_COMPUTE,p->layout,0,1,&p->set,0,NULL);
        vkCmdPushConstants(p->command,p->layout,VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(params),&params);
        vkCmdDispatch(p->command,(params.width+7)/8,(params.height+7)/8,1);
        VkMemoryBarrier ready={.sType=VK_STRUCTURE_TYPE_MEMORY_BARRIER,
            .srcAccessMask=VK_ACCESS_SHADER_WRITE_BIT,.dstAccessMask=VK_ACCESS_SHADER_READ_BIT};
        vkCmdPipelineBarrier(p->command,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
            0,1,&ready,0,NULL,0,NULL);
    }
    // Isolated immutable-pair benchmark: producer wait is separate and reported.
    // A live pipeline would put acquire and compute in the same queued submission.
    frame_submit(p,frames,frames[0].external);
}

void images_release(Pipeline *p, FrameImage frames[2]) {
    if (!frames[0].external) return;
    VK_OK(vkResetCommandBuffer(p->command,0));
    VkCommandBufferBeginInfo begin={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
    VK_OK(vkBeginCommandBuffer(p->command,&begin)); image_barriers(p,frames,true);
    frame_submit(p,frames,false);
}

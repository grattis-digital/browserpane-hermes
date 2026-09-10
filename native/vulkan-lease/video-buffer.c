/* SPDX-License-Identifier: AGPL-3.0-only */
#include "video-gpu.h"
#include <unistd.h>
#define TRY(call) do { VkResult status_=(call); if (status_!=VK_SUCCESS) { fprintf(stderr,"GPU video: %s status=%d\n",#call,status_); goto fail; } } while (0)
static bool import_buffer(VideoGpu *v,VideoCodec *c) {
    Pipeline *p=v->p; v->external=true;
    VkPhysicalDeviceExternalBufferInfo query={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_BUFFER_INFO,
        .usage=VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,.handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT};
    VkExternalBufferProperties props={.sType=VK_STRUCTURE_TYPE_EXTERNAL_BUFFER_PROPERTIES};
    vkGetPhysicalDeviceExternalBufferProperties(p->physical,&query,&props);
    if (!(props.externalMemoryProperties.externalMemoryFeatures&VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)) {
        fprintf(stderr,"GPU video: storage buffer DMA-BUF import not supported\n"); return false;
    }
    VkExternalMemoryBufferCreateInfo external={.sType=VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_BUFFER_CREATE_INFO,
        .handleTypes=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT};
    VkBufferCreateInfo create={.sType=VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,.pNext=&external,
        .size=c->input_bytes,.usage=VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,.sharingMode=VK_SHARING_MODE_EXCLUSIVE};
    TRY(vkCreateBuffer(p->device,&create,NULL,&v->raw.handle)); v->raw.size=c->input_bytes;
    VkMemoryRequirements req; vkGetBufferMemoryRequirements(p->device,v->raw.handle,&req);
    // QUERYBUF reports the image size, but DMA-BUF backing allocations are page
    // rounded. Vulkan's alignment requirement must fit the backing FD itself.
    off_t backing=lseek(c->dma_fd,0,SEEK_END);
    if (backing<0 || lseek(c->dma_fd,0,SEEK_SET)!=0 || (uint64_t)backing<req.size || backing>4*1024*1024) {
        fprintf(stderr,"GPU video: storage allocation required=%llu DMA-BUF bytes=%lld\n",
            (unsigned long long)req.size,(long long)backing); return false;
    }
    PFN_vkGetMemoryFdPropertiesKHR get=(PFN_vkGetMemoryFdPropertiesKHR)vkGetDeviceProcAddr(p->device,"vkGetMemoryFdPropertiesKHR");
    if (!get) return false;
    VkMemoryFdPropertiesKHR fdprops={.sType=VK_STRUCTURE_TYPE_MEMORY_FD_PROPERTIES_KHR};
    TRY(get(p->device,VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT,c->dma_fd,&fdprops));
    uint32_t bits=req.memoryTypeBits&fdprops.memoryTypeBits;
    if (!bits) { fprintf(stderr,"GPU video: incompatible DMA-BUF memory types\n"); return false; }
    int fd=dup(c->dma_fd); if (fd<0) return false;
    VkMemoryDedicatedAllocateInfo dedicated={.sType=VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO,.buffer=v->raw.handle};
    VkImportMemoryFdInfoKHR imp={.sType=VK_STRUCTURE_TYPE_IMPORT_MEMORY_FD_INFO_KHR,.pNext=&dedicated,
        .handleType=VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT,.fd=fd};
    VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,.pNext=&imp,
        .allocationSize=req.size,.memoryTypeIndex=memory_type(p,bits,0)};
    VkResult result=vkAllocateMemory(p->device,&alloc,NULL,&v->raw.memory);
    if (result!=VK_SUCCESS) { fprintf(stderr,"GPU video: import memory status=%d\n",result); close(fd); return false; }
    TRY(vkBindBufferMemory(p->device,v->raw.handle,v->raw.memory,0));
    return true;
fail: return false;
}
bool video_gpu_open(VideoGpu *v,Pipeline *p,VideoCodec *c) {
    *v=(VideoGpu){.p=p};
    if (p->software) {
        // Readable raw output exists only in the explicit software oracle.
        v->raw=buffer_create(p,c->input_bytes,VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,true);
    } else if (!import_buffer(v,c)) goto fail;
    VkDescriptorSetLayoutBinding bindings[]={
        {.binding=0,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,.descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT},
        {.binding=1,.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,.descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT}};
    VkDescriptorSetLayoutCreateInfo desc={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,.bindingCount=2,.pBindings=bindings};
    TRY(vkCreateDescriptorSetLayout(p->device,&desc,NULL,&v->descriptors));
    VkDescriptorPoolSize sizes[]={{VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,1},{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,1}};
    VkDescriptorPoolCreateInfo pool={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,.maxSets=1,.poolSizeCount=2,.pPoolSizes=sizes};
    TRY(vkCreateDescriptorPool(p->device,&pool,NULL,&v->pool));
    VkDescriptorSetAllocateInfo set={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,.descriptorPool=v->pool,
        .descriptorSetCount=1,.pSetLayouts=&v->descriptors};
    TRY(vkAllocateDescriptorSets(p->device,&set,&v->set));
    VkPushConstantRange range={VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(VideoParams)};
    VkPipelineLayoutCreateInfo layout={.sType=VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount=1,.pSetLayouts=&v->descriptors,.pushConstantRangeCount=1,.pPushConstantRanges=&range};
    TRY(vkCreatePipelineLayout(p->device,&layout,NULL,&v->layout));
    v->shader=pipeline_shader(p,"video-nv12",v->layout); return true;
fail:
    fprintf(stderr,"GPU video: DMA-BUF/storage setup failed; retaining lossless tiles\n");
    video_gpu_close(v); return false;
}
void video_gpu_close(VideoGpu *v) {
    if (!v->p) return;
    Pipeline *p=v->p;
    if (v->shader) vkDestroyPipeline(p->device,v->shader,NULL);
    if (v->layout) vkDestroyPipelineLayout(p->device,v->layout,NULL);
    if (v->pool) vkDestroyDescriptorPool(p->device,v->pool,NULL);
    if (v->descriptors) vkDestroyDescriptorSetLayout(p->device,v->descriptors,NULL);
    buffer_destroy(p,&v->raw); *v=(VideoGpu){0};
}

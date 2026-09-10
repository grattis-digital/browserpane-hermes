/* SPDX-License-Identifier: AGPL-3.0-only */
#include "pipeline.h"
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>

static VKAPI_ATTR VkBool32 VKAPI_CALL debug_message(VkDebugUtilsMessageSeverityFlagBitsEXT severity,
        VkDebugUtilsMessageTypeFlagsEXT type, const VkDebugUtilsMessengerCallbackDataEXT *data, void *user) {
    (void)type;
    Pipeline *p=user;
    if (severity & VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT) p->validation_errors++;
    fprintf(stderr,"validation: %s\n",data->pMessage);
    return VK_FALSE;
}

uint32_t memory_type(Pipeline *p, uint32_t bits, VkMemoryPropertyFlags flags) {
    for (uint32_t i=0;i<p->memory.memoryTypeCount;i++)
        if ((bits&(1u<<i)) && (p->memory.memoryTypes[i].propertyFlags&flags)==flags) return i;
    REQUIRE(!"Compatible memory type unavailable");
    return 0;
}

Buffer buffer_create(Pipeline *p, VkDeviceSize bytes, VkBufferUsageFlags usage, bool host) {
    Buffer b={.size=bytes};
    VkBufferCreateInfo info={.sType=VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,.size=bytes,
        .usage=usage,.sharingMode=VK_SHARING_MODE_EXCLUSIVE};
    VK_OK(vkCreateBuffer(p->device,&info,NULL,&b.handle));
    VkMemoryRequirements req; vkGetBufferMemoryRequirements(p->device,b.handle,&req);
    VkMemoryPropertyFlags flags=VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
    if (host) flags=VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT|VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    VkMemoryAllocateInfo alloc={.sType=VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO,
        .allocationSize=req.size,.memoryTypeIndex=memory_type(p,req.memoryTypeBits,flags)};
    VK_OK(vkAllocateMemory(p->device,&alloc,NULL,&b.memory));
    VK_OK(vkBindBufferMemory(p->device,b.handle,b.memory,0));
    // Persistent mapping is permitted only for the FINAL output allocation.
    // Intermediate storage may be HOST_VISIBLE on UMA, but is never mapped.
    if (host) VK_OK(vkMapMemory(p->device,b.memory,0,bytes,0,&b.mapped));
    return b;
}

void buffer_destroy(Pipeline *p, Buffer *b) {
    if (b->mapped) vkUnmapMemory(p->device,b->memory);
    vkDestroyBuffer(p->device,b->handle,NULL); vkFreeMemory(p->device,b->memory,NULL);
    *b=(Buffer){0};
}

static void device_open(Pipeline *p) {
    uint32_t count=0; VK_OK(vkEnumeratePhysicalDevices(p->instance,&count,NULL));
    REQUIRE(count>0 && count<=16);
    VkPhysicalDevice devices[16]; VK_OK(vkEnumeratePhysicalDevices(p->instance,&count,devices));
    struct stat node={0};
    if (!p->software) REQUIRE(!stat("/dev/bpane-render",&node) && S_ISCHR(node.st_mode));
    for (uint32_t i=0;i<count;i++) {
        VkPhysicalDeviceDrmPropertiesEXT drm={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRM_PROPERTIES_EXT};
        VkPhysicalDeviceDriverProperties driver={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES,
            .pNext=p->software?NULL:&drm};
        VkPhysicalDeviceProperties2 props={.sType=VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2,.pNext=&driver};
        vkGetPhysicalDeviceProperties2(devices[i],&props);
        bool matches=p->software ? driver.driverID==VK_DRIVER_ID_MESA_LLVMPIPE :
            driver.driverID==VK_DRIVER_ID_MESA_V3DV && drm.hasRender &&
            drm.renderMajor==major(node.st_rdev) && drm.renderMinor==minor(node.st_rdev);
        if (matches) {
            REQUIRE(!p->physical);
            p->physical=devices[i];
            fprintf(stderr,"Vulkan device=%s driver=%u api=%u\n",props.properties.deviceName,
                driver.driverID,props.properties.apiVersion);
            REQUIRE(props.properties.apiVersion>=VK_API_VERSION_1_2);
            REQUIRE(props.properties.limits.maxComputeWorkGroupInvocations>=256);
            REQUIRE(props.properties.limits.maxComputeSharedMemorySize>=4096);
            REQUIRE(props.properties.limits.maxStorageBufferRange>=OUTPUT_BYTES);
        }
    }
    REQUIRE(p->physical);
    vkGetPhysicalDeviceMemoryProperties(p->physical,&p->memory);
    VkPhysicalDeviceFeatures supported; vkGetPhysicalDeviceFeatures(p->physical,&supported);
    REQUIRE(supported.shaderStorageImageReadWithoutFormat);
    VkPhysicalDeviceFeatures enabled={.shaderStorageImageReadWithoutFormat=VK_TRUE};
    vkGetPhysicalDeviceQueueFamilyProperties(p->physical,&count,NULL);
    REQUIRE(count>0 && count<=16);
    VkQueueFamilyProperties families[16]; vkGetPhysicalDeviceQueueFamilyProperties(p->physical,&count,families);
    p->family=UINT32_MAX;
    for (uint32_t i=0;i<count;i++) if (families[i].queueCount && (families[i].queueFlags&VK_QUEUE_COMPUTE_BIT)) {
        p->family=i; break;
    }
    REQUIRE(p->family!=UINT32_MAX);
    float priority=0.25f;
    VkDeviceQueueCreateInfo queue={.sType=VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO,
        .queueFamilyIndex=p->family,.queueCount=1,.pQueuePriorities=&priority};
    const char *extensions[]={VK_KHR_EXTERNAL_MEMORY_FD_EXTENSION_NAME,
        VK_EXT_EXTERNAL_MEMORY_DMA_BUF_EXTENSION_NAME,VK_EXT_IMAGE_DRM_FORMAT_MODIFIER_EXTENSION_NAME,
        VK_KHR_EXTERNAL_SEMAPHORE_FD_EXTENSION_NAME,VK_EXT_QUEUE_FAMILY_FOREIGN_EXTENSION_NAME};
    VkDeviceCreateInfo create={.sType=VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO,.queueCreateInfoCount=1,
        .pQueueCreateInfos=&queue,.pEnabledFeatures=&enabled,
        .enabledExtensionCount=p->software?0:sizeof(extensions)/sizeof(extensions[0]),.ppEnabledExtensionNames=extensions};
    VK_OK(vkCreateDevice(p->physical,&create,NULL,&p->device));
    vkGetDeviceQueue(p->device,p->family,0,&p->queue);
}

VkPipeline pipeline_shader(Pipeline *p, const char *name, VkPipelineLayout layout) {
    char path[160]; REQUIRE(snprintf(path,sizeof(path),"/usr/share/bpane-vulkan/%s.spv",name)>0);
    FILE *file=fopen(path,"rb"); REQUIRE(file);
    REQUIRE(!fseek(file,0,SEEK_END)); long bytes=ftell(file);
    REQUIRE(bytes>0 && bytes<=131072 && bytes%4==0); rewind(file);
    uint32_t *code=malloc(bytes); REQUIRE(code && fread(code,1,bytes,file)==(size_t)bytes);
    REQUIRE(!fclose(file));
    VkShaderModule module;
    VkShaderModuleCreateInfo sm={.sType=VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,.codeSize=bytes,.pCode=code};
    VK_OK(vkCreateShaderModule(p->device,&sm,NULL,&module)); free(code);
    VkComputePipelineCreateInfo create={.sType=VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
        .stage={.sType=VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
            .stage=VK_SHADER_STAGE_COMPUTE_BIT,.module=module,.pName="main"},.layout=layout};
    VkPipeline result; VK_OK(vkCreateComputePipelines(p->device,VK_NULL_HANDLE,1,&create,NULL,&result));
    vkDestroyShaderModule(p->device,module,NULL);
    return result;
}

static VkPipeline shader(Pipeline *p, const char *name) { return pipeline_shader(p,name,p->layout); }

static void commands(Pipeline *p) {
    VkCommandPoolCreateInfo pool={.sType=VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
        .flags=VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT,.queueFamilyIndex=p->family};
    VK_OK(vkCreateCommandPool(p->device,&pool,NULL,&p->pool));
    VkCommandBufferAllocateInfo command={.sType=VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO,
        .commandPool=p->pool,.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY,.commandBufferCount=1};
    VK_OK(vkAllocateCommandBuffers(p->device,&command,&p->command));
    VkFenceCreateInfo fence={.sType=VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
    VK_OK(vkCreateFence(p->device,&fence,NULL,&p->fence));
}

static void resources(Pipeline *p) {
    VkDescriptorSetLayoutBinding bindings[4];
    for (unsigned i=0;i<4;i++) bindings[i]=(VkDescriptorSetLayoutBinding){.binding=i,
        .descriptorType=i<2?VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT};
    VkDescriptorSetLayoutCreateInfo desc={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount=4,.pBindings=bindings};
    VK_OK(vkCreateDescriptorSetLayout(p->device,&desc,NULL,&p->descriptors));
    VkDescriptorPoolSize sizes[]={{VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,2},{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,2}};
    VkDescriptorPoolCreateInfo dp={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets=1,.poolSizeCount=2,.pPoolSizes=sizes};
    VK_OK(vkCreateDescriptorPool(p->device,&dp,NULL,&p->descriptor_pool));
    VkDescriptorSetAllocateInfo ds={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool=p->descriptor_pool,.descriptorSetCount=1,.pSetLayouts=&p->descriptors};
    VK_OK(vkAllocateDescriptorSets(p->device,&ds,&p->set));
    VkPushConstantRange range={VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(Params)};
    VkPipelineLayoutCreateInfo layout={.sType=VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount=1,.pSetLayouts=&p->descriptors,.pushConstantRangeCount=1,.pPushConstantRanges=&range};
    VK_OK(vkCreatePipelineLayout(p->device,&layout,NULL,&p->layout));
    p->intermediate=buffer_create(p,2*CAPACITY*sizeof(uint32_t),
        VK_BUFFER_USAGE_STORAGE_BUFFER_BIT|VK_BUFFER_USAGE_TRANSFER_SRC_BIT,false);
    p->output=buffer_create(p,OUTPUT_BYTES,
        VK_BUFFER_USAGE_STORAGE_BUFFER_BIT|VK_BUFFER_USAGE_TRANSFER_DST_BIT,true);
    p->result=malloc(OUTPUT_BYTES); REQUIRE(p->result);
    p->fixture=shader(p,"fixture"); p->diff=shader(p,"diff");
    p->compact=shader(p,"compact"); p->gather=shader(p,"gather"); p->empty=shader(p,"empty");
    p->bare=shader(p,"bare");
}

static void open_context(Pipeline *p, bool software, bool validation, bool video) {
    *p=(Pipeline){.software=software};
    VkApplicationInfo app={.sType=VK_STRUCTURE_TYPE_APPLICATION_INFO,.pApplicationName="bpane-vulkan-pilot",
        .apiVersion=VK_API_VERSION_1_2};
    const char *layer="VK_LAYER_KHRONOS_validation", *extension=VK_EXT_DEBUG_UTILS_EXTENSION_NAME;
    VkInstanceCreateInfo create={.sType=VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,.pApplicationInfo=&app,
        .enabledLayerCount=validation?1:0,.ppEnabledLayerNames=&layer,
        .enabledExtensionCount=validation?1:0,.ppEnabledExtensionNames=&extension};
    VK_OK(vkCreateInstance(&create,NULL,&p->instance));
    if (validation) {
        VkDebugUtilsMessengerCreateInfoEXT debug={.sType=VK_STRUCTURE_TYPE_DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT,
            .messageSeverity=VK_DEBUG_UTILS_MESSAGE_SEVERITY_ERROR_BIT_EXT|VK_DEBUG_UTILS_MESSAGE_SEVERITY_WARNING_BIT_EXT,
            .messageType=VK_DEBUG_UTILS_MESSAGE_TYPE_GENERAL_BIT_EXT|VK_DEBUG_UTILS_MESSAGE_TYPE_VALIDATION_BIT_EXT|
                VK_DEBUG_UTILS_MESSAGE_TYPE_PERFORMANCE_BIT_EXT,.pfnUserCallback=debug_message,.pUserData=p};
        PFN_vkCreateDebugUtilsMessengerEXT fn=(PFN_vkCreateDebugUtilsMessengerEXT)vkGetInstanceProcAddr(p->instance,"vkCreateDebugUtilsMessengerEXT");
        REQUIRE(fn); VK_OK(fn(p->instance,&debug,NULL,&p->messenger));
    }
    device_open(p); commands(p);
    if (!video) resources(p);
}

void pipeline_open(Pipeline *p, bool software, bool validation) {
    open_context(p,software,validation,false);
}

void pipeline_open_video(Pipeline *p) {
    open_context(p,false,false,true);
    p->live=true;
}

void pipeline_close(Pipeline *p) {
    VkPipeline shaders[]={p->fixture,p->diff,p->compact,p->gather,p->empty,p->bare};
    for (unsigned i=0;i<6;i++) vkDestroyPipeline(p->device,shaders[i],NULL);
    buffer_destroy(p,&p->intermediate); buffer_destroy(p,&p->output); free(p->result);
    vkDestroyPipelineLayout(p->device,p->layout,NULL);
    vkDestroyDescriptorPool(p->device,p->descriptor_pool,NULL);
    vkDestroyDescriptorSetLayout(p->device,p->descriptors,NULL);
    vkDestroyFence(p->device,p->fence,NULL); vkDestroyCommandPool(p->device,p->pool,NULL);
    vkDestroyDevice(p->device,NULL);
    if (p->messenger) {
        PFN_vkDestroyDebugUtilsMessengerEXT fn=(PFN_vkDestroyDebugUtilsMessengerEXT)vkGetInstanceProcAddr(p->instance,"vkDestroyDebugUtilsMessengerEXT");
        REQUIRE(fn); fn(p->instance,p->messenger,NULL);
    }
    vkDestroyInstance(p->instance,NULL);
    REQUIRE(!p->validation_errors);
}

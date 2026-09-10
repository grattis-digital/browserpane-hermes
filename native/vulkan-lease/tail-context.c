/* SPDX-License-Identifier: AGPL-3.0-only */
#include "tail.h"

void tail_open(Tail *t, Pipeline *p) {
    *t=(Tail){.p=p};
    VkDescriptorSetLayoutBinding bindings[5];
    for (unsigned i=0;i<5;i++) bindings[i]=(VkDescriptorSetLayoutBinding){.binding=i,
        .descriptorType=i<2?VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,
        .descriptorCount=1,.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT};
    VkDescriptorSetLayoutCreateInfo desc={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
        .bindingCount=5,.pBindings=bindings};
    VK_OK(vkCreateDescriptorSetLayout(p->device,&desc,NULL,&t->descriptors));
    VkDescriptorPoolSize sizes[]={{VK_DESCRIPTOR_TYPE_STORAGE_IMAGE,2},{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,3}};
    VkDescriptorPoolCreateInfo pool={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
        .maxSets=1,.poolSizeCount=2,.pPoolSizes=sizes};
    VK_OK(vkCreateDescriptorPool(p->device,&pool,NULL,&t->pool));
    VkDescriptorSetAllocateInfo set={.sType=VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO,
        .descriptorPool=t->pool,.descriptorSetCount=1,.pSetLayouts=&t->descriptors};
    VK_OK(vkAllocateDescriptorSets(p->device,&set,&t->set));
    VkPushConstantRange range={VK_SHADER_STAGE_COMPUTE_BIT,0,sizeof(TailParams)};
    VkPipelineLayoutCreateInfo layout={.sType=VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO,
        .setLayoutCount=1,.pSetLayouts=&t->descriptors,.pushConstantRangeCount=1,.pPushConstantRanges=&range};
    VK_OK(vkCreatePipelineLayout(p->device,&layout,NULL,&t->layout));
    t->state=buffer_create(p,TAIL_STATE_BYTES,VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,false);
    t->encoded=buffer_create(p,CAPACITY*TAIL_SLOT_WORDS*4,VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,false);
    t->output=buffer_create(p,TAIL_OUTPUT_BYTES,VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,true);
    const char *names[]={"tail-index","tail-select","tail-analyze","tail-qoi","tail-scan","tail-clear","tail-pack"};
    for (unsigned i=0;i<7;i++) t->stages[i]=pipeline_shader(p,names[i],t->layout);
}

void tail_close(Tail *t) {
    REQUIRE(!t->pending);
    Pipeline *p=t->p;
    for (unsigned i=0;i<7;i++) vkDestroyPipeline(p->device,t->stages[i],NULL);
    buffer_destroy(p,&t->state); buffer_destroy(p,&t->encoded); buffer_destroy(p,&t->output);
    vkDestroyPipelineLayout(p->device,t->layout,NULL);
    vkDestroyDescriptorPool(p->device,t->pool,NULL);
    vkDestroyDescriptorSetLayout(p->device,t->descriptors,NULL);
}

bool tail_ack(Tail *t, uint32_t serial) {
    if (!t->pending || serial!=t->serial) return false;
    t->bank=t->pending_bank; t->acked=serial; t->valid=true; t->pending=false;
    t->acked_video=t->pending_video;
    return true;
}

void tail_reject(Tail *t, bool reset) {
    REQUIRE(t->pending); t->pending=false;
    if (reset) t->valid=false;
}

void tail_reset(Tail *t) { REQUIRE(!t->pending); t->valid=false; }

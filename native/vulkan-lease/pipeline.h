/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_VULKAN_PIPELINE_H
#define BPANE_VULKAN_PIPELINE_H
#include <vulkan/vulkan.h>
#include "lease-client.h"
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#define CAPACITY 512u
#define TILE 64u
#define TILE_WORDS (TILE * TILE)
#define HEADER_WORDS (4u + 4u * CAPACITY)
#define OUTPUT_BYTES ((HEADER_WORDS + CAPACITY * TILE_WORDS) * sizeof(uint32_t))
#define REQUIRE(c) do { if (!(c)) { fprintf(stderr, "check failed: %s (%s:%d)\n", #c, __FILE__, __LINE__); exit(1); } } while (0)
#define VK_OK(c) do { VkResult r_ = (c); if (r_ != VK_SUCCESS) { fprintf(stderr, "Vulkan %s: %d (%s:%d)\n", #c, r_, __FILE__, __LINE__); exit(1); } } while (0)
typedef struct { VkBuffer handle; VkDeviceMemory memory; VkDeviceSize size; void *mapped; } Buffer;
typedef struct {
    VkImage handle;
    VkDeviceMemory memory;
    VkImageView view;
    VkSemaphore ready;
    bool external;
    bool ready_consumed;
} FrameImage;
typedef struct {
    VkInstance instance;
    VkPhysicalDevice physical;
    VkDevice device;
    VkPhysicalDeviceMemoryProperties memory;
    VkQueue queue;
    uint32_t family;
    VkCommandPool pool;
    VkCommandBuffer command;
    VkFence fence;
    VkDescriptorSetLayout descriptors;
    VkDescriptorPool descriptor_pool;
    VkDescriptorSet set;
    VkPipelineLayout layout;
    VkPipeline fixture, diff, compact, gather, empty, bare;
    Buffer intermediate, output;
    uint32_t *result;
    bool software;
    bool live;
    unsigned validation_errors;
    VkDebugUtilsMessengerEXT messenger;
} Pipeline;
typedef struct { uint32_t width, height, scenario, spare; } Params;
typedef struct { double submit_ms, wait_ms, copy_ms, total_ms, cpu_ms; uint32_t bytes; } Sample;
typedef struct { uint32_t flags[CAPACITY], colors[CAPACITY], mask[16]; } Oracle;
void pipeline_open(Pipeline *, bool software, bool validation);
void pipeline_open_video(Pipeline *);
void pipeline_close(Pipeline *);
VkResult pipeline_wait(Pipeline *);
Buffer buffer_create(Pipeline *, VkDeviceSize, VkBufferUsageFlags, bool host);
void buffer_destroy(Pipeline *, Buffer *);
uint32_t memory_type(Pipeline *, uint32_t bits, VkMemoryPropertyFlags flags);
FrameImage image_owned(Pipeline *, unsigned width, unsigned height);
FrameImage image_import(Pipeline *, LeaseFrame *);
void image_destroy(Pipeline *, FrameImage *);
void images_bind(Pipeline *, FrameImage frames[2]);
void images_prepare(Pipeline *, FrameImage frames[2], Params);
void images_release(Pipeline *, FrameImage frames[2]);
void record_pipeline(Pipeline *, Params, bool empty);
Sample pipeline_run(Pipeline *);
uint32_t fixture_color(unsigned x, unsigned y, unsigned width, unsigned height, unsigned scenario);
void fixture_x11(xcb_connection_t *, xcb_screen_t *, xcb_gcontext_t, unsigned, unsigned, unsigned);
void oracle_build(Params, Oracle *);
void result_check(Pipeline *, Params, const Oracle *, bool empty);
void frame_check(LeaseFrame *, unsigned scenario);
double thread_now(void);
void audit_samples(Pipeline *, Params, const Oracle *, bool counters);
void audit_clocks(void);
VkPipeline pipeline_shader(Pipeline *, const char *, VkPipelineLayout);
int tail_main(Pipeline *, bool validation, bool export_wire);
#endif

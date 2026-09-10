/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_VIDEO_GPU_H
#define BPANE_VIDEO_GPU_H
#include "pipeline.h"
#include "video-codec.h"
typedef struct {
    Pipeline *p;
    Buffer raw;
    VkDescriptorSetLayout descriptors;
    VkDescriptorPool pool;
    VkDescriptorSet set;
    VkPipelineLayout layout;
    VkPipeline shader;
    bool external;
} VideoGpu;
typedef struct { VideoRect rect; uint32_t stride,rows; } VideoParams;
bool video_gpu_open(VideoGpu *, Pipeline *, VideoCodec *);
void video_gpu_close(VideoGpu *);
bool video_gpu_convert(VideoGpu *, FrameImage *, VideoParams);
void video_gpu_test(Pipeline *);
int video_probe(Pipeline *);
#endif

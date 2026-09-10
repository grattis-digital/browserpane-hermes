/* SPDX-License-Identifier: AGPL-3.0-only */
#ifndef BPANE_GPU_TAIL_H
#define BPANE_GPU_TAIL_H
#include "pipeline.h"
#include "video-codec.h"
#define TAIL_STATE_BYTES (7813u*4u)
#define TAIL_SLOT_WORDS 4104u
#define TAIL_OUTPUT_BYTES (9u*1024u*1024u)
typedef struct {
    uint32_t width,height,serial,flags,read_bank,write_bank,spare0,spare1;
    VideoRect video,previous_video;
} TailParams;
typedef struct {
    Pipeline *p;
    VkDescriptorSetLayout descriptors;
    VkDescriptorPool pool;
    VkDescriptorSet set;
    VkPipelineLayout layout;
    VkPipeline stages[7];
    Buffer state,encoded,output;
    uint32_t serial,acked,bank,width,height,pending_bank;
    bool pending,valid;
    VideoRect video,acked_video,pending_video;
} Tail;
typedef struct {
    const uint8_t *bytes;
    uint32_t size,serial,skipped,fills,refs,qoi;
    int32_t scroll;
    double record_ms,completion_ms,cpu_ms;
} TailPacket;
void tail_open(Tail *, Pipeline *);
void tail_close(Tail *);
TailPacket tail_encode(Tail *, FrameImage *, FrameImage *, unsigned, unsigned, unsigned);
bool tail_ack(Tail *, uint32_t);
void tail_reject(Tail *, bool reset);
void tail_reset(Tail *);
typedef struct { uint64_t token; uint32_t width,height; uint32_t *pixels; } ClientTile;
typedef struct {
    unsigned width,height,serial;
    uint32_t *canvas;
    ClientTile cache[1024];
    unsigned cursor;
    VideoRect video;
} TailClient;
void tail_client_close(TailClient *);
void tail_client_evict(TailClient *);
bool tail_client_decode(TailClient *, const uint8_t *, size_t, unsigned serial);
void tail_client_check(const TailClient *, unsigned scenario);
uint8_t *tail_transport(const TailPacket *, double *milliseconds);
bool tail_qoi_decode(const uint8_t *, size_t, uint32_t **, unsigned *, unsigned *);
void tail_decoder_tests(void);
void video_tile_tests(Pipeline *);
void tail_client_negative(TailClient *, uint8_t *, size_t, unsigned serial);
void tail_export(FILE *, const TailPacket *, unsigned scenario);
#endif

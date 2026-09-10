/* SPDX-License-Identifier: AGPL-3.0-only */
#include "compare-kernel.h"
#include <stdio.h>
#include <string.h>

static const char *preamble =
    "#version 310 es\nprecision highp float; precision highp int;\n"
    "layout(local_size_x=8,local_size_y=8) in;\n"
    "layout(binding=0) uniform highp sampler2D currentFrame;\n"
    "layout(binding=1) uniform highp sampler2D previousFrame;\n"
    "layout(std430,binding=0) buffer Dirty { uint bits[16]; };\n";

static const char *reduction =
    "shared uint changed;\n"
    "void main() {\n"
    " if(gl_LocalInvocationIndex==0u) changed=0u; barrier();\n"
    " ivec2 size=textureSize(currentFrame,0);\n"
    " ivec2 base=ivec2(gl_WorkGroupID.xy)*EDGE+ivec2(gl_LocalInvocationID.xy);\n"
    " uint different=0u;\n"
    " for(int y=0;y<EDGE;y+=8) for(int x=0;x<EDGE;x+=8) {\n"
    "  ivec2 p=base+ivec2(x,y);\n"
    "  if(all(lessThan(p,size))) different |= uint(any(notEqual(texelFetch(currentFrame,p,0).rgb,texelFetch(previousFrame,p,0).rgb)));\n"
    " }\n"
    " if(different!=0u) atomicOr(changed,1u); barrier();\n"
    " if(gl_LocalInvocationIndex==0u && changed!=0u) {\n"
    "  uvec2 p=gl_WorkGroupID.xy*uint(EDGE);\n"
    "  uint tile=(p.y/64u)*uint((size.x+63)/64)+p.x/64u;\n"
    "  atomicOr(bits[tile/32u],1u<<(tile%32u));\n"
    " }\n}\n";

static const char *pixel_atomic =
    "void main() {\n"
    " ivec2 size=textureSize(currentFrame,0), p=ivec2(gl_GlobalInvocationID.xy);\n"
    " if(all(lessThan(p,size)) && any(notEqual(texelFetch(currentFrame,p,0).rgb,texelFetch(previousFrame,p,0).rgb))) {\n"
    "  uint tile=uint((p.y/64)*((size.x+63)/64)+p.x/64);\n"
    "  atomicOr(bits[tile/32u],1u<<(tile%32u));\n"
    " }\n}\n";

/* A positive sample proves the tile dirty; negative samples never omit pixels.
 * quick is not written after its publication barrier, so all lanes take the
 * same early return and none strand their peers at a later shared barrier. */
static const char *probe_first =
    "shared uint quick; shared uint changed;\n"
    "void main() {\n"
    " if(gl_LocalInvocationIndex==0u) {quick=0u;changed=0u;} barrier();\n"
    " ivec2 size=textureSize(currentFrame,0);\n"
    " ivec2 base=ivec2(gl_WorkGroupID.xy)*64;\n"
    " ivec2 probe=base+ivec2(gl_LocalInvocationID.xy)*8;\n"
    " if(all(lessThan(probe,size)) && any(notEqual(texelFetch(currentFrame,probe,0).rgb,texelFetch(previousFrame,probe,0).rgb))) atomicOr(quick,1u);\n"
    "#ifdef BIDIRECTIONAL\n"
    " ivec2 back=base+min(ivec2(63),size-base-1)-ivec2(gl_LocalInvocationID.xy)*8;\n"
    " if(all(greaterThanEqual(back,base)) && any(notEqual(texelFetch(currentFrame,back,0).rgb,texelFetch(previousFrame,back,0).rgb))) atomicOr(quick,1u);\n"
    "#endif\n"
    " barrier();\n"
    " uint tile=gl_WorkGroupID.y*gl_NumWorkGroups.x+gl_WorkGroupID.x;\n"
    " if(quick!=0u) {if(gl_LocalInvocationIndex==0u) atomicOr(bits[tile/32u],1u<<(tile%32u)); return;}\n"
    " bool different=false;\n"
    " for(int y=0;y<64;y+=8) for(int x=0;x<64;x+=8) {\n"
    "  ivec2 p=base+ivec2(gl_LocalInvocationID.xy)+ivec2(x,y);\n"
    "  if(all(lessThan(p,size))) different=different || any(notEqual(texelFetch(currentFrame,p,0).rgb,texelFetch(previousFrame,p,0).rgb));\n"
    " }\n"
    " if(different) atomicOr(changed,1u); barrier();\n"
    " if(gl_LocalInvocationIndex==0u && changed!=0u) atomicOr(bits[tile/32u],1u<<(tile%32u));\n"
    "}\n";

static GLuint compile(const char *const *parts, unsigned count) {
    GLuint shader = glCreateShader(GL_COMPUTE_SHADER);
    glShaderSource(shader, count, parts, NULL); glCompileShader(shader);
    GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[4096]; glGetShaderInfoLog(shader, sizeof(log), NULL, log); fprintf(stderr, "%s\n", log); }
    assert(ok);
    GLuint program = glCreateProgram(); glAttachShader(program, shader); glLinkProgram(program);
    glGetProgramiv(program, GL_LINK_STATUS, &ok); assert(ok);
    glDeleteShader(shader);
    return program;
}

void compare_init(CompareKernel kernels[COMPARE_VARIANTS]) {
    const char *names[] = {"reference_cached", "branchless64", "reduce16", "reduce8", "pixel_atomic", "probe_first64", "probe_both64"};
    const unsigned edges[] = {64, 64, 16, 8, 8, 64, 64};
    for (unsigned i = 0; i < COMPARE_VARIANTS; i++) {
        char define[64]; snprintf(define, sizeof(define), "#define EDGE %u\n%s", edges[i], i == 6 ? "#define BIDIRECTIONAL 1\n" : "");
        const char *parts[] = {preamble, define, i >= 5 ? probe_first : i == 4 ? pixel_atomic : reduction};
        const char *original = lease_diff_reference_source();
        kernels[i] = (CompareKernel){.name = names[i], .edge = edges[i],
                                    .program = compile(i == 0 ? &original : parts, i == 0 ? 1 : 3)};
        glGenBuffers(1, &kernels[i].buffer);
        glBindBuffer(GL_SHADER_STORAGE_BUFFER, kernels[i].buffer);
        glBufferData(GL_SHADER_STORAGE_BUFFER, 64, NULL, GL_STREAM_READ);
    }
    assert(glGetError() == GL_NO_ERROR);
}

CompareTimes compare_run(CompareKernel *kernel, LeaseFrame *current, LeaseFrame *previous,
                        const uint32_t expected[16]) {
    uint32_t mask[16] = {0};
    double start = lease_now();
    glUseProgram(kernel->program);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, current->texture);
    glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, previous->texture);
    glBindBuffer(GL_SHADER_STORAGE_BUFFER, kernel->buffer);
    glBufferSubData(GL_SHADER_STORAGE_BUFFER, 0, sizeof(mask), mask);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, kernel->buffer);
    double prepared = lease_now();
    glDispatchCompute((current->wire.width + kernel->edge - 1) / kernel->edge,
                      (current->wire.height + kernel->edge - 1) / kernel->edge, 1);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);
    double submitted = lease_now();
    void *mapped = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, sizeof(mask), GL_MAP_READ_BIT);
    assert(mapped); memcpy(mask, mapped, sizeof(mask)); assert(glUnmapBuffer(GL_SHADER_STORAGE_BUFFER));
    double completed = lease_now();
    if (memcmp(mask, expected, sizeof(mask))) {
        fprintf(stderr, "Comparison oracle failed variant=%s\n", kernel->name);
        for (unsigned i = 0; i < 16; i++) fprintf(stderr, "%u: %08x expected %08x\n", i, mask[i], expected[i]);
        assert(!memcmp(mask, expected, sizeof(mask)));
    }
    assert(glGetError() == GL_NO_ERROR);
    return (CompareTimes){prepared - start, submitted - prepared, completed - submitted, completed - start};
}

void compare_close(CompareKernel kernels[COMPARE_VARIANTS]) {
    for (unsigned i = 0; i < COMPARE_VARIANTS; i++) {
        glDeleteBuffers(1, &kernels[i].buffer);
        glDeleteProgram(kernels[i].program);
    }
}

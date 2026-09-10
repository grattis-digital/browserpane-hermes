/* SPDX-License-Identifier: AGPL-3.0-only */
#include "lease-client.h"
#include <stdio.h>
#include <string.h>

/* Independent exact RGB comparison, not a lossy hash or movement estimator.
 * Reads imported GPU textures directly. Only a 64-byte dirty mask reaches CPU.
 * Shader compilation/allocation and pixel oracle are outside the timing scope. */
static const char *source =
    "#version 310 es\n"
    "precision highp float; precision highp int;\n"
    "layout(local_size_x=8,local_size_y=8) in;\n"
    "layout(binding=0) uniform highp sampler2D currentFrame;\n"
    "layout(binding=1) uniform highp sampler2D previousFrame;\n"
    "layout(std430,binding=0) buffer Dirty { uint bits[16]; };\n"
    "shared uint changed;\n"
    "void main() {\n"
    " if(gl_LocalInvocationIndex==0u) changed=0u; barrier();\n"
    " ivec2 size=textureSize(currentFrame,0);\n"
    " ivec2 base=ivec2(gl_WorkGroupID.xy)*64+ivec2(gl_LocalInvocationID.xy);\n"
    " bool different=false;\n"
    " for(int y=0;y<64;y+=8) for(int x=0;x<64;x+=8) {\n"
    "  ivec2 p=base+ivec2(x,y);\n"
    "  if(all(lessThan(p,size))) different=different || any(notEqual(texelFetch(currentFrame,p,0).rgb,texelFetch(previousFrame,p,0).rgb));\n"
    " }\n"
    " if(different) atomicOr(changed,1u); barrier();\n"
    " if(gl_LocalInvocationIndex==0u && changed!=0u) {\n"
    "  uint tile=gl_WorkGroupID.y*gl_NumWorkGroups.x+gl_WorkGroupID.x;\n"
    "  atomicOr(bits[tile/32u],1u<<(tile%32u));\n"
    " }\n"
    "}\n";

const char *lease_diff_reference_source(void) { return source; }

void lease_diff(LeaseFrame *current, LeaseFrame *previous, unsigned expected, double timing[3]) {
    assert(current->wire.width == previous->wire.width && current->wire.height == previous->wire.height);
    GLuint shader = glCreateShader(GL_COMPUTE_SHADER);
    glShaderSource(shader, 1, &source, NULL); glCompileShader(shader);
    GLint ok = 0; glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) { char log[2048]; glGetShaderInfoLog(shader, sizeof(log), NULL, log); fprintf(stderr, "%s\n", log); }
    assert(ok);
    GLuint program = glCreateProgram(); glAttachShader(program, shader); glLinkProgram(program);
    glGetProgramiv(program, GL_LINK_STATUS, &ok); assert(ok);
    uint32_t mask[16] = {0};
    GLuint buffer; glGenBuffers(1, &buffer); glBindBuffer(GL_SHADER_STORAGE_BUFFER, buffer);
    glBufferData(GL_SHADER_STORAGE_BUFFER, sizeof(mask), mask, GL_STREAM_READ);
    glBindBufferBase(GL_SHADER_STORAGE_BUFFER, 0, buffer);
    glUseProgram(program);
    glActiveTexture(GL_TEXTURE0); glBindTexture(GL_TEXTURE_2D, current->texture);
    glActiveTexture(GL_TEXTURE1); glBindTexture(GL_TEXTURE_2D, previous->texture);
    double start = lease_now();
    glDispatchCompute((current->wire.width + 63) / 64, (current->wire.height + 63) / 64, 1);
    glMemoryBarrier(GL_BUFFER_UPDATE_BARRIER_BIT);
    double submitted = lease_now();
    void *mapped = glMapBufferRange(GL_SHADER_STORAGE_BUFFER, 0, sizeof(mask), GL_MAP_READ_BIT);
    assert(mapped); memcpy(mask, mapped, sizeof(mask)); assert(glUnmapBuffer(GL_SHADER_STORAGE_BUFFER));
    double read = lease_now();
    unsigned count = 0;
    for (unsigned i = 0; i < 16; i++) count += __builtin_popcount(mask[i]);
    assert(count == expected && glGetError() == GL_NO_ERROR);
    if (expected == 1) assert(mask[0] == 1); // Patch is entirely within tile 0.
    timing[0] = submitted - start; timing[1] = read - submitted; timing[2] = read - start;
    glDeleteBuffers(1, &buffer); glDeleteProgram(program); glDeleteShader(shader);
}

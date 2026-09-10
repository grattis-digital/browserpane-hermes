// SPDX-License-Identifier: AGPL-3.0-only
#extension GL_EXT_shader_image_load_formatted : require
layout(set=0,binding=0) readonly uniform image2D oldFrame;
layout(set=0,binding=1) readonly uniform image2D newFrame;
layout(set=0,binding=2,std430) buffer State {
    uvec4 control; // signed source dy, stream-prefix bytes, unused, unused
    uvec4 metadata[1024]; // two ACK-controlled banks: fingerprints, token low/high
    uvec4 work[512]; // Skip=0 Fill=1 Ref=2 Qoi=3, value/token, token high, QOI length
    uint offsets[512];
    uint lookup[1024]; // 256 buckets, four bounded candidates each
    uint motion[129]; // distributed GPU-only candidate scores, never read by CPU
};
layout(set=0,binding=3,std430) buffer Encoded { uint encoded[]; };
layout(set=0,binding=4,std430) buffer Final { uint outputWords[]; };
layout(push_constant) uniform TailParams {
    uint width; uint height; uint serial; uint flags;
    uint readBank; uint writeBank; uint spare0; uint spare1;
    uvec4 video; uvec4 previousVideo;
} p;
const uint SLOT_WORDS=4104u;
bool acknowledged() { return (p.flags&1u)!=0u; }
uint columns() { return (p.width+63u)/64u; }
uint tiles() { return columns()*((p.height+63u)/64u); }
uvec2 origin(uint tile) { return uvec2(tile%columns(),tile/columns())*64u; }
uvec2 extent(uint tile) { return min(uvec2(64),uvec2(p.width,p.height)-origin(tile)); }
uint pixel(vec4 value) { return packUnorm4x8(vec4(value.rgb,1)); }
uint mix32(uint v) { v^=v>>16; v*=0x7feb352du; v^=v>>15; v*=0x846ca68bu; return v^(v>>16); }
uint frame_size(uint tile) {
    uint mode=work[tile].x;
    return mode==0u?0u:mode==1u?14u:mode==2u?18u:22u+work[tile].w;
}

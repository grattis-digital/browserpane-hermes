import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('experimental video maps only an explicit encoder in the display service', () => {
  const layer=readFileSync('compose.gpu-video.yaml','utf8');
  const [browser,display]=layer.split('  gpu-display:');
  assert.match(browser,/BPANE_H264_MODE: video_tiles/);
  assert.doesNotMatch(browser,/devices:/);
  assert.match(display,/BPANE_GPU_VIDEO: "1"/);
  assert.match(display,/BPANE_GPU_VIDEO_DEVICE:\?[^\n]+\/dev\/bpane-video-encode:rw/);
  assert.match(display,/BPANE_GPU_VIDEO_GID:\?/);
  assert.doesNotMatch(layer,/privileged:|ports:|network_mode: host|device_cgroup_rules|\/dev\/dma_heap/);
  for (const path of ['compose.yaml','compose.gpu.yaml']) {
    assert.doesNotMatch(readFileSync(path,'utf8'),/BPANE_GPU_VIDEO:|bpane-video-encode/);
  }
});

test('video never starts the old CPU capture/encoding path', () => {
  const session=readFileSync('upstream/code/apps/bpane-host/src/session.rs','utf8');
  assert.match(session,/!gpu_tail && h264_mode\.starts_enabled\(\)/);
  assert.match(session,/let tile_thread = if gpu_tail \{\s*None/);
  const video=readFileSync('native/vulkan-lease/video-buffer.c','utf8');
  assert.match(video,/VK_EXTERNAL_MEMORY_HANDLE_TYPE_DMA_BUF_BIT_EXT/);
  assert.doesNotMatch(video,/vkMapMemory\(/);
  const codec=readFileSync('native/vulkan-lease/video-codec.c','utf8');
  assert.match(codec,/VIDIOC_EXPBUF/);
  assert.doesNotMatch(codec,/x11grab|libx264|\/dev\/video0/);
});

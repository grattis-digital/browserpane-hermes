import { GpuStatusError } from './gpu-status-error.mjs';

/** Backend readiness only: actual playback needs per-player Media evidence. */
export class GpuVideoStatus {
  static validate(gpu) {
    GpuStatusError.require(['enabled', 'enabled_force'].includes(gpu?.featureStatus?.video_decode),
      'GPU_VIDEO_DECODE_DISABLED');
    const profiles = gpu?.videoDecoding;
    GpuStatusError.require(Array.isArray(profiles) && profiles.length <= 256,
      'GPU_VIDEO_H264_UNAVAILABLE');
    // Pi's modern V4L2 pipeline can decode H.264 while the legacy CDP profile
    // list is empty. Treat this as unreported, never as verified support.
    if (profiles.length === 0) return { h264Profiles: 'unreported', playbackVerified: false };
    const usable = profiles.some(profile => {
      if (!profile || typeof profile.profile !== 'string') return false;
      const name = profile.profile.replace(/[^a-z0-9]/gi, '').toLowerCase();
      if (!['h264baseline', 'h264main', 'h264high', 'h264profilebaseline',
        'h264profilemain', 'h264profilehigh'].includes(name)) return false;
      const min = profile.minResolution, max = profile.maxResolution;
      return [min?.width, min?.height, max?.width, max?.height]
        .every(value => Number.isSafeInteger(value) && value > 0) &&
        min.width <= 1280 && min.height <= 720 && max.width >= 1280 && max.height >= 720;
    });
    GpuStatusError.require(usable, 'GPU_VIDEO_H264_UNAVAILABLE');
    return { h264Profiles: 'advertised', playbackVerified: false };
  }
}

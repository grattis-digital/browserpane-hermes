/** Stable, content-free readiness reasons. Never include raw CDP data or URLs. */
export class GpuStatusError extends Error {
  static codes = Object.freeze(['GPU_STATUS_MISSING', 'GPU_RENDERER_MISMATCH', 'GPU_SANDBOX_INACTIVE',
    'GPU_PROCESS_CRASHED', 'GPU_COMPOSITING_DISABLED', 'GPU_RASTERIZATION_DISABLED',
    'GPU_CDP_HTTP_TIMEOUT', 'GPU_CDP_HTTP_UNAVAILABLE', 'GPU_CDP_HTTP_STATUS',
    'GPU_CDP_METADATA_INVALID', 'GPU_CDP_ENDPOINT_NOT_PRIVATE', 'GPU_CDP_SOCKET_FAILED',
    'GPU_CDP_SOCKET_CLOSED', 'GPU_CDP_QUERY_TIMEOUT', 'GPU_CDP_QUERY_REJECTED',
    'GPU_CDP_RESPONSE_INVALID', 'GPU_CHECK_FAILED']);

  constructor(code) { super(code); this.code = code; }
  static code(error) { return this.codes.includes(error?.code) ? error.code : 'GPU_CHECK_FAILED'; }
  static require(condition, code) { if (!condition) throw new GpuStatusError(code); }
}

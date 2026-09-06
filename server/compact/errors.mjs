export class PaneError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PaneError';
    this.code = code;
  }

  static describe(error) {
    return { code: error instanceof PaneError ? error.code : 'BROWSER_ERROR',
      message: String(error?.message ?? error).slice(0, 800) };
  }
}

/** A bounded observation validation failure; messages never contain page content. */
export class ObservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObservationError';
    this.code = code;
  }
}

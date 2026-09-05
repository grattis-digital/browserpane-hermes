import { isIP } from 'node:net';

export class ConfigurationError extends Error {
  constructor(setting, requirement) {
    super(`${setting} ${requirement}`);
    this.name = 'ConfigurationError';
    this.code = 'INVALID_CONFIGURATION';
  }
}

/** Validates public configuration only; never includes configured values in errors. */
export class RuntimeSettings {
  static fromEnvironment(env) {
    const origin = this.#httpsOrigin(env.VIEWER_ORIGIN, 'VIEWER_ORIGIN', env.BPANE_PIPELINE_TEST === '1');
    const gateway = this.#httpsOrigin(env.GATEWAY_URL, 'GATEWAY_URL');
    if (origin.hostname !== gateway.hostname) {
      throw new ConfigurationError('GATEWAY_URL', 'must use the viewer hostname');
    }
    const base = (env.VIEWER_BASE ?? '/browser').replace(/\/+$/, '');
    if (base !== '' && !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(base)) {
      throw new ConfigurationError('VIEWER_BASE', 'must be a plain absolute path without traversal');
    }
    if (env.VIEWER_HOST !== undefined && env.VIEWER_HOST.toLowerCase() !== origin.hostname) {
      throw new ConfigurationError('VIEWER_HOST', 'must match the HTTPS hostname');
    }
    if (env.BIND_ADDRESS !== undefined &&
        (isIP(env.BIND_ADDRESS) !== 4 || env.BIND_ADDRESS === '0.0.0.0' ||
         Number(env.BIND_ADDRESS.split('.')[0]) >= 224)) {
      throw new ConfigurationError('BIND_ADDRESS', 'must be one explicit unicast IPv4 address');
    }
    return Object.freeze({ origin: origin.origin, gatewayUrl: gateway.href, base });
  }

  static #httpsOrigin(value, setting, loopbackTest = false) {
    let url;
    try { url = new URL(value); } catch { throw new ConfigurationError(setting, 'must be an HTTPS origin'); }
    const testOrigin = loopbackTest && url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname);
    if ((!testOrigin && url.protocol !== 'https:') || url.port === '0' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || !this.#hostname(url.hostname)) {
      throw new ConfigurationError(setting, 'must be an HTTPS origin without credentials, path or query');
    }
    return url;
  }

  static #hostname(value) {
    if (isIP(value) === 4) return true;
    return value.length <= 253 && value.split('.').every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  }
}

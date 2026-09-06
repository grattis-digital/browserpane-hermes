import { PaneError } from './errors.mjs';

export class ElementGuard {
  #handle;
  #signature;

  constructor(handle, signature) { this.#handle = handle; this.#signature = signature; }
  get handle() { return this.#handle; }

  static describe = element => {
    if (!element.isConnected) return null;
    return JSON.stringify([element.tagName, element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('aria-labelledby'), element.getAttribute('href'), element.getAttribute('type'),
      element.getAttribute('name'), element.getAttribute('title'), element.textContent?.slice(0, 4096)]);
  };

  async assert() {
    const current = await this.#handle.evaluate(ElementGuard.describe);
    if (current === null || current !== this.#signature) throw new PaneError('TARGET_CHANGED', 'Observed element changed; batch stopped. Observe again.');
  }

  async dispose() { await this.#handle.dispose(); }
}

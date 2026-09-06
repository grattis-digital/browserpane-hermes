import { PaneError } from './errors.mjs';

export class ActionSteps {
  #browser;
  #uploads;
  constructor(browser, uploads) { this.#browser = browser; this.#uploads = uploads; }

  async perform(tab, step, guards, timeout, signal) {
    const handle = step.ref ? guards.get(step.ref).handle : undefined;
    const options = { timeout };
    const document = tab.document, mutation = tab.mutation, popup = this.#browser.popupVersion;
    const ready = () => {
      if (signal?.aborted || tab.document !== document || tab.mutation !== mutation || tab.dialog || this.#browser.popupVersion !== popup) {
        throw new PaneError('INPUT_INTERRUPTED', 'Input sequence interrupted; no subsequent input was started.');
      }
    };
    ready();
    switch (step.op) {
      case 'navigate': await tab.page.goto(step.url, { ...options, waitUntil: 'domcontentloaded' }); break;
      case 'back': await tab.page.goBack({ ...options, waitUntil: 'domcontentloaded' }); break;
      case 'activate': await tab.page.bringToFront(); break;
      case 'close': await this.#browser.closeTab(tab); break;
      case 'click': await handle.click(options); break;
      case 'hover': await handle.hover(options); break;
      case 'fill': await handle.fill(step.text, options); break;
      case 'type':
        await handle.click(options);
        ready();
        await handle.type(step.text, options);
        break;
      case 'press': await handle.press(step.key, options); break;
      case 'select': await handle.selectOption(step.values, options); break;
      case 'check': await handle.setChecked(step.checked, options); break;
      case 'drag': {
        // Real pointer input, not JavaScript drag events. Both pinned nodes must
        // remain actionable; never re-resolve to a replacement element.
        await handle.hover(options);
        ready();
        await tab.page.mouse.down();
        try { ready(); await guards.get(step.to).handle.hover(options); }
        finally { await tab.page.mouse.up(); }
        break;
      }
      case 'scroll':
        await handle.hover(options);
        ready();
        await tab.page.mouse.wheel(step.dx ?? 0, step.dy);
        break;
      case 'upload': {
        const files = await this.#uploads.resolve(step.paths);
        ready(); await handle.setInputFiles(files, options); break;
      }
      default: throw new PaneError('UNKNOWN_OPERATION', 'Unsupported browser input.');
    }
  }

  async wait(tab, condition) {
    if (!condition) return;
    const timeout = condition.timeoutMs ?? 5000;
    if (condition.url !== undefined) {
      await tab.page.waitForURL(url => url.href === condition.url, { timeout, waitUntil: 'domcontentloaded' });
    } else {
      await tab.page.getByText(condition.text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    }
  }
}

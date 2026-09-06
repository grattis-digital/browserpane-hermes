import { PaneError } from './errors.mjs';
import { PaneSchemas } from './schemas.mjs';

const fields = {
  new: [[], ['url']], navigate: [['url'], []], back: [[], []], activate: [[], []], close: [[], []],
  click: [['ref'], []], hover: [['ref'], []], fill: [['ref', 'text'], []], type: [['ref', 'text'], []],
  press: [['ref', 'key'], []], select: [['ref', 'values'], []], check: [['ref', 'checked'], []],
  scroll: [['ref', 'dy'], ['dx']], drag: [['ref', 'to'], []], upload: [['ref', 'paths'], []],
  dialog: [['accept'], ['text']],
};

export class PaneValidation {
  static parse(name, input) {
    const tool = PaneSchemas.tools().find(value => value.name === name);
    if (!tool) throw new PaneError('UNKNOWN_TOOL', 'Unknown compact browser tool.');
    this.#validate(tool.inputSchema, input, 'arguments');
    if (name === 'pane_act') this.#actions(input);
    if (name === 'pane_read') {
      if (input.mode === 'summary' && (input.column === undefined || input.offset !== undefined || input.limit !== undefined)) this.#fail('summary column/pagination');
      if (input.mode !== 'summary' && input.column !== undefined) this.#fail('column');
      if (input.mode === 'table' && input.limit > 100) this.#fail('table limit (max 100)');
    }
    if (input.ref !== undefined && !/^f?\d*e\d+$/.test(input.ref)) this.#fail('ref');
    return structuredClone(input);
  }

  static #fail(path) { throw new PaneError('INVALID_ARGUMENT', `Invalid ${path}. See the tool schema.`); }

  static #validate(schema, value, path) {
    if (schema.enum && !schema.enum.includes(value)) this.#fail(path);
    if (schema.type === 'object') {
      if (!value || Array.isArray(value) || typeof value !== 'object') this.#fail(path);
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) this.#fail(`${path}.${key}`);
        this.#validate(schema.properties[key], value[key], `${path}.${key}`);
      }
      for (const key of schema.required) if (!Object.hasOwn(value, key)) this.#fail(`${path}.${key}`);
    } else if (schema.type === 'array') {
      if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) this.#fail(path);
      value.forEach((item, index) => this.#validate(schema.items, item, `${path}[${index}]`));
    } else if (schema.type === 'string') {
      if (typeof value !== 'string' || value.length > schema.maxLength || value.includes('\0')) this.#fail(path);
    } else if (schema.type === 'integer') {
      if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) this.#fail(path);
    } else if (schema.type === 'boolean' && typeof value !== 'boolean') this.#fail(path);
  }

  static #actions(input) {
    for (const step of input.steps) {
      const [required, optional] = fields[step.op];
      for (const key of required) if (!Object.hasOwn(step, key)) this.#fail(`step.${key}`);
      for (const key of Object.keys(step)) if (key !== 'op' && !required.includes(key) && !optional.includes(key)) this.#fail(`step.${key}`);
      for (const key of ['ref', 'to']) if (step[key] !== undefined && !/^f?\d*e\d+$/.test(step[key])) this.#fail(`step.${key}`);
      if (step.url !== undefined) this.url(step.url);
      if (['new', 'navigate', 'back', 'activate', 'close', 'dialog'].includes(step.op) && input.steps.length !== 1) this.#fail('standalone step');
    }
    if (input.steps[0].op === 'new') {
      if (input.tab !== undefined || input.view !== undefined) this.#fail('new tab/view');
    } else if (!input.tab || !input.view) this.#fail('tab/view');
    if (input.wait) {
      if ((input.wait.text === undefined) === (input.wait.url === undefined)) this.#fail('wait (exactly one of text/url)');
      if (input.wait.text === '') this.#fail('wait.text');
      if (input.wait.url !== undefined) this.url(input.wait.url);
    }
  }

  static url(value) {
    let url;
    try { url = new URL(value); } catch { this.#fail('URL'); }
    if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') this.#fail('URL scheme');
    if (url.username || url.password) this.#fail('URL credentials');
    return value;
  }
}

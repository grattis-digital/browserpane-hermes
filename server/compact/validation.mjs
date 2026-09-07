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
    if (name === 'pane_flow') this.#flow(input);
    if (name === 'pane_view') {
      if (input.cursor !== undefined && Object.keys(input).some(key => !['cursor', 'limit', 'maxChars'].includes(key))) this.#fail('cursor options');
      if (input.query) this.#query(input.query);
      if (input.state !== undefined && input.since !== undefined) this.#fail('state/since');
    }
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
    if (input.wait) this.#wait(input.wait);
  }

  static #flow(input) {
    let count = 0;
    for (const [stageIndex, stage] of input.stages.entries()) {
      count += stage.steps.length;
      if (stageIndex < input.stages.length - 1 && !stage.wait) this.#fail(`stages[${stageIndex}].wait`);
      for (const step of stage.steps) {
        if (step.op === 'navigate') {
          if (stage.steps.length !== 1 || step.target !== undefined || step.url === undefined ||
            Object.keys(step).some(key => !['op', 'url'].includes(key))) this.#fail('flow navigate step');
          this.url(step.url); continue;
        }
        if (!step.target) this.#fail('flow target');
        this.#query(step.target);
        const [required, optional] = fields[step.op];
        const withoutRef = required.filter(key => key !== 'ref');
        for (const key of withoutRef) if (!Object.hasOwn(step, key)) this.#fail(`flow step.${key}`);
        const allowed = new Set(['op', 'target', ...optional, ...withoutRef]);
        for (const key of Object.keys(step)) if (!allowed.has(key)) this.#fail(`flow step.${key}`);
      }
      if (stage.wait) this.#wait(stage.wait);
    }
    if (count > 8) this.#fail('flow action limit');
  }

  static #query(query) {
    if (query.role === undefined && query.name === undefined) this.#fail('query');
    if (query.role !== undefined && !/^[a-z][a-z0-9-]{0,39}$/.test(query.role)) this.#fail('query.role');
    if (query.name !== undefined && query.name.length === 0) this.#fail('query.name');
    if (query.name === undefined && query.exact !== undefined) this.#fail('query.exact');
  }

  static #wait(wait) {
    if ((wait.text === undefined) === (wait.url === undefined)) this.#fail('wait (exactly one of text/url)');
    if (wait.text === '') this.#fail('wait.text');
    if (wait.url !== undefined) this.url(wait.url);
  }

  static url(value) {
    let url;
    try { url = new URL(value); } catch { this.#fail('URL'); }
    if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') this.#fail('URL scheme');
    if (url.username || url.password) this.#fail('URL credentials');
    return value;
  }
}

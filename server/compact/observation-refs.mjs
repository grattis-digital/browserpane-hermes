import { ObservationError } from './observation-error.mjs';
import { ObservationInput } from './observation-input.mjs';

/** Reads the pinned snapshot's structural reference suffix, never text/property values. */
export class ObservationRefs {
  static from(snapshot) {
    const refs = new Map();
    for (const line of ObservationInput.snapshot(snapshot)) {
      const ref = this.reference(line);
      if (!ref) continue;
      if (refs.has(ref)) throw new ObservationError('ambiguous_ref', 'Snapshot contains a duplicate structural reference.');
      refs.set(ref, line);
    }
    return refs;
  }

  static reference(line) {
    const key = this.#key(line);
    if (!/^[a-z][a-z0-9-]*(?: |$)/.test(key)) return undefined;
    const suffix = key.match(/\[ref=([a-z0-9]+)\](?: \[cursor=pointer\])?$/);
    if (!suffix) return undefined;
    // Names use JSON string quoting inside the (possibly YAML-quoted) key.
    let quoted = false, escaped = false;
    for (let index = 0; index < suffix.index; index++) {
      const char = key[index];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
    }
    return quoted ? undefined : suffix[1];
  }

  static isControl(line) {
    return /^(button|link|textbox|searchbox|combobox|checkbox|radio|switch|slider|spinbutton|option|menuitem|menuitemcheckbox|menuitemradio|tab|treeitem)(?: |$)/.test(this.#key(line));
  }

  static #key(line) {
    if (typeof line !== 'string') return '';
    const prefix = line.match(/^ *- /);
    if (!prefix) return '';
    const value = line.slice(prefix[0].length);
    // Playwright yamlEscapeKeyIfNeeded wraps keys in single quotes and doubles '.
    if (value.startsWith("'")) {
      let key = '';
      for (let index = 1; index < value.length; index++) {
        if (value[index] !== "'") { key += value[index]; continue; }
        if (value[index + 1] === "'") { key += "'"; index++; continue; }
        return value.length === index + 1 || value[index + 1] === ':' ? key : '';
      }
      return '';
    }
    let quoted = false, escaped = false;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
      if (!quoted && char === ':' && (index + 1 === value.length || value[index + 1] === ' '))
        return value.slice(0, index);
    }
    return quoted ? '' : value;
  }
}

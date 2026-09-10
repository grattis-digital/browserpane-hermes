import { ObservationError } from './observation-error.mjs';
import { ObservationInput } from './observation-input.mjs';

/** Reads the pinned snapshot's structural reference suffix, never text/property values. */
export class ObservationRefs {
  /** Semantic ref key independent of subtree indentation and cursor inheritance. */
  static signature(line) { return this.#key(line).replace(/ \[cursor=pointer\]$/, ''); }

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

  /** Parses only Playwright's role/name key prefix. Page values never become selectors. */
  static semantic(line) {
    const key = this.#key(line), match = key.match(/^([a-z][a-z0-9-]*)(?: |$)/);
    if (!match) return undefined;
    const ref = this.reference(line), rest = key.slice(match[0].length);
    let name = '';
    if (rest.startsWith('"')) {
      let escaped = false, end = -1;
      for (let index = 1; index < rest.length; index++) {
        if (escaped) { escaped = false; continue; }
        if (rest[index] === '\\') { escaped = true; continue; }
        if (rest[index] === '"') { end = index; break; }
      }
      if (end > 0) {
        try { name = JSON.parse(rest.slice(0, end + 1)); } catch { return undefined; }
      }
    }
    return { role: match[1], name, ref };
  }

  static matches(line, query) {
    const semantic = this.semantic(line);
    if (!semantic?.ref) return false;
    if (query.role !== undefined && semantic.role !== query.role) return false;
    if (query.name === undefined) return true;
    const actual = semantic.name.toLocaleLowerCase('en-US'), expected = query.name.toLocaleLowerCase('en-US');
    return query.exact !== false ? actual === expected : actual.includes(expected);
  }

  static find(snapshot, query, limit = 2) {
    const matches = new Map();
    for (const line of ObservationInput.snapshot(snapshot)) {
      if (!this.matches(line, query)) continue;
      const ref = this.reference(line);
      if (matches.has(ref)) throw new ObservationError('ambiguous_ref', 'Snapshot contains a duplicate structural reference.');
      matches.set(ref, line);
      if (matches.size >= limit) break;
    }
    return matches;
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

import { ObservationRefs } from './observation-refs.mjs';

/** Pure line projection; source YAML and reference identities are never rewritten. */
export class ObservationProjection {
  static create(lines, options) {
    const parents = this.#parents(lines), selected = this.#select(lines, parents, options);
    const { offset, limit, maxChars } = options;
    const items = this.#items(lines, parents, selected, offset, limit);
    const rendered = [], refs = new Map(), truncatedLines = [];
    let chars = 0, bytes = 0, consumed = 0, stopped = false;
    for (const item of items) {
      const separator = rendered.length ? 1 : 0;
      const result = this.#line(item.line, maxChars - chars - separator, 24576 - bytes - separator);
      if (!result) { stopped = true; break; }
      rendered.push(result.text);
      chars += result.text.length + separator;
      bytes += Buffer.byteLength(result.text, 'utf8') + separator;
      if (!item.context) consumed++;
      if (result.truncated) truncatedLines.push(item.position);
      else {
        const ref = ObservationRefs.reference(item.line);
        if (ref) refs.set(ref, item.line);
      }
    }
    const next = offset + consumed < selected.length ? offset + consumed : undefined;
    return { text: rendered.join('\n'), refs, total: selected.length, next,
      truncated: stopped || truncatedLines.length > 0, truncatedLines };
  }

  static #parents(lines) {
    const stack = [], parents = new Int32Array(lines.length).fill(-1);
    for (let index = 0; index < lines.length; index++) {
      const indent = lines[index].match(/^ */)[0].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      if (stack.length) parents[index] = stack.at(-1).index;
      stack.push({ index, indent });
    }
    return parents;
  }

  static #select(lines, parents, { detail, filter }) {
    const selected = new Uint8Array(lines.length), needle = filter.toLowerCase();
    for (let index = 0; index < lines.length; index++) {
      if (detail === 'controls' && !ObservationRefs.isControl(lines[index])) continue;
      if (needle && !lines[index].toLowerCase().includes(needle)) continue;
      // Each ancestor is marked at most once, including deeply nested snapshots.
      for (let row = index; row >= 0 && !selected[row]; row = parents[row]) selected[row] = 1;
    }
    const indices = [];
    for (let index = 0; index < selected.length; index++) if (selected[index]) indices.push(index);
    return indices;
  }

  static #items(lines, parents, selected, offset, limit) {
    if (offset >= selected.length) return [];
    const context = [];
    for (let row = parents[selected[offset]]; row >= 0; row = parents[row]) context.push(row);
    context.reverse();
    const positions = new Map(selected.map((row, position) => [row, position]));
    return [
      ...context.map(index => ({ line: lines[index], context: true, position: positions.get(index) })),
      ...selected.slice(offset, offset + limit).map((index, order) => ({
        line: lines[index], context: false, position: offset + order,
      })),
    ];
  }

  static #line(line, availableChars, availableBytes) {
    const maxChars = Math.min(2048, availableChars);
    if (line.length <= maxChars && Buffer.byteLength(line, 'utf8') <= availableBytes)
      return { text: line, truncated: false };
    const marker = ' … [truncated]';
    if (maxChars < marker.length || availableBytes < Buffer.byteLength(marker, 'utf8')) return undefined;
    // A shortened name/state cannot authorize an action, even when its ref came first.
    const safe = line.replace(/\[ref=[^\]]*\]/g, '');
    let text = '', bytes = Buffer.byteLength(marker, 'utf8');
    for (const char of safe) {
      const size = Buffer.byteLength(char, 'utf8');
      if (text.length + char.length + marker.length > maxChars || bytes + size > availableBytes) break;
      text += char; bytes += size;
    }
    return { text: text + marker, truncated: true };
  }
}

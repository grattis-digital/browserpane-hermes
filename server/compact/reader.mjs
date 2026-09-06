import { PaneError } from './errors.mjs';

export class PaneReader {
  // Runs in Chromium as a read-only, closed declarative query. No model-provided
  // source, selectors, expressions or callable functions enter this boundary.
  static read = (element, args) => {
    if (!element.isConnected) return { error: 'TARGET_DETACHED' };
    const shown = node => [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0) &&
      !['hidden', 'collapse'].includes(getComputedStyle(node).visibility);
    if (!shown(element)) return { error: 'TARGET_NOT_VISIBLE' };
    if (args.mode === 'text') {
      const text = element.innerText ?? element.textContent ?? '';
      const offset = args.offset ?? 0, limit = args.limit ?? 2000;
      return { text: text.slice(offset, offset + limit), total: text.length,
        ...(offset + limit < text.length ? { next: offset + limit, truncated: true } : {}) };
    }
    if (element.tagName !== 'TABLE') return { error: 'NOT_HTML_TABLE' };
    const bodies = [...element.tBodies];
    const total = bodies.reduce((count, body) => count + body.rows.length, 0);
    if (total > 10000) return { error: 'TABLE_LIMIT', rows: total };
    const rows = bodies.flatMap(body => [...body.rows]);
    const visible = rows.filter(shown);
    const cellText = cell => shown(cell) ? (cell.innerText ?? '').trim() : '';
    const headerCells = [...(element.tHead?.rows[0]?.cells ?? [])];
    if (headerCells.length > 100) return { error: 'COLUMN_LIMIT' };
    const headers = headerCells.map(cellText);
    if (JSON.stringify(headers).length > 12000) return { error: 'READ_LIMIT' };
    const cells = row => [...row.cells].map(cellText);
    if (args.mode === 'summary') {
      if (visible.length && (visible[0].cells.length > 100 || visible.at(-1).cells.length > 100)) return { error: 'COLUMN_LIMIT' };
      const column = args.column;
      let sum = 0, min = null, max = null, count = 0, nonNumeric = 0;
      for (const row of visible) {
        const value = row.cells[column] ? cellText(row.cells[column]) : '';
        // Decimal/scientific only: locale separators/currency/empty cells must
        // be explicit nonNumeric, never silently converted to zero.
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) { nonNumeric++; continue; }
        const number = Number(value);
        if (!Number.isFinite(number)) { nonNumeric++; continue; }
        sum += number; min = min === null ? number : Math.min(min, number);
        max = max === null ? number : Math.max(max, number); count++;
      }
      if (!Number.isFinite(sum)) return { error: 'NUMERIC_OVERFLOW' };
      const result = { headers, rows: visible.length, first: visible.length ? cells(visible[0]) : [],
        last: visible.length ? cells(visible.at(-1)) : [], numeric: { column, count, nonNumeric, sum, min, max } };
      return JSON.stringify(result).length <= 12000 ? result : { error: 'READ_LIMIT' };
    }
    const offset = args.offset ?? 0, limit = args.limit ?? 25;
    const result = { headers, rows: [], total: visible.length };
    let chars = JSON.stringify(headers).length;
    for (let index = offset; index < Math.min(offset + limit, visible.length); index++) {
      if (visible[index].cells.length > 100) return { error: 'COLUMN_LIMIT' };
      const row = cells(visible[index]); chars += JSON.stringify(row).length;
      if (chars > 12000) {
        if (!result.rows.length) return { error: 'READ_LIMIT' };
        result.next = index; result.truncated = true; break;
      }
      result.rows.push(row);
    }
    if (result.next === undefined && offset + result.rows.length < visible.length) result.next = offset + result.rows.length;
    return result;
  };

  static async extract(handle, args) {
    const result = await handle.evaluate(PaneReader.read, args);
    if (result.error) throw new PaneError(result.error, 'Read exceeds supported scope or limits; narrow the observation.');
    if (Buffer.byteLength(JSON.stringify(result)) > 24576) throw new PaneError('READ_LIMIT', 'Read exceeds 24 KiB; request fewer rows or text characters.');
    return result;
  }
}

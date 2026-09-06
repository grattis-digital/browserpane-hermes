import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PaneReader } from '../server/compact/reader.mjs';
import { PaneValidation } from '../server/compact/validation.mjs';

function fixture(t, html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  // JSDOM has no layout/innerText. Explicit deterministic fixture geometry;
  // actual Chromium behavior is independently tested by the MCP benchmark.
  for (const element of dom.window.document.querySelectorAll('*')) {
    element.getClientRects = () => [{ width: element.hasAttribute('data-zero') ? 0 : 100, height: 20 }];
    Object.defineProperty(element, 'innerText', { get: () => element.textContent });
  }
  return { element: dom.window.document.querySelector('table,section'),
    read: dom.window.eval(`(${PaneReader.read.toString()})`) };
}

test('table summary counts only visible rows and explicitly rejects non-decimal cells', t => {
  const { element, read } = fixture(t, '<table><thead><tr><th>ID</th><th>Value</th></tr></thead><tbody>' +
    ['1.5', '-2', '3e1', '', '1,000', '$2', '0x10'].map((value, index) => `<tr><td>${index}</td><td>${value}</td></tr>`).join('') +
    '<tr style="visibility:collapse"><td>x</td><td>99</td></tr><tr data-zero><td>y</td><td>99</td></tr></tbody></table>');
  const result = JSON.parse(JSON.stringify(read(element, { mode: 'summary', column: 1 })));
  assert.equal(result.rows, 7);
  assert.deepEqual(result.numeric, { column: 1, count: 3, nonNumeric: 4, sum: 29.5, min: -2, max: 30 });
  assert.deepEqual(result.first, ['0', '1.5']); assert.deepEqual(result.last, ['6', '0x10']);
});

test('pagination exposes exact continuation without repeating rows or silently truncating cells', t => {
  const { element, read } = fixture(t, '<table><tbody><tr><td>first</td></tr><tr><td>second</td></tr><tr><td>third</td></tr></tbody></table>');
  const first = read(element, { mode: 'table', limit: 2 });
  assert.equal(first.next, 2); assert.equal(first.total, 3); assert.equal(first.rows.length, 2);
  const last = read(element, { mode: 'table', offset: first.next, limit: 2 });
  assert.equal(last.rows[0][0], 'third'); assert.equal(last.next, undefined);
});

test('oversized first row and header fail rather than returning no-progress continuation', t => {
  const { element, read } = fixture(t, `<table><tbody><tr><td>${'x'.repeat(12001)}</td></tr></tbody></table>`);
  assert.equal(read(element, { mode: 'table' }).error, 'READ_LIMIT');
  assert.equal(read(element, { mode: 'summary', column: 0 }).error, 'READ_LIMIT');
});

test('bounded text exposes continuation and refuses detached or hidden targets', t => {
  const { element, read } = fixture(t, '<section>abcdef</section>');
  const first = read(element, { mode: 'text', limit: 3 });
  assert.equal(first.text, 'abc'); assert.equal(first.next, 3); assert.equal(first.truncated, true);
  element.style.visibility = 'collapse'; assert.equal(read(element, { mode: 'text' }).error, 'TARGET_NOT_VISIBLE');
  element.remove(); assert.equal(read(element, { mode: 'text' }).error, 'TARGET_DETACHED');
});

test('closed declarative read schema rejects source code and invalid mode combinations', () => {
  const base = { tab: 't1', view: 'v1', ref: 'e1', mode: 'summary', column: 0 };
  assert.deepEqual(PaneValidation.parse('pane_read', base), base);
  for (const input of [{ ...base, code: 'alert(1)' }, { ...base, limit: 3 }, { ...base, column: -1 },
    { ...base, column: undefined }, { ...base, mode: 'text' }, { ...base, ref: 'css=table' }]) {
    assert.throws(() => PaneValidation.parse('pane_read', input), { code: 'INVALID_ARGUMENT' });
  }
});

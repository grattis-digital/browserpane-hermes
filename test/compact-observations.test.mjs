import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationStore } from '../server/compact/observations.mjs';
import { ObservationRefs } from '../server/compact/observation-refs.mjs';

const make = (prefix = 'v') => { let sequence = 0; return new ObservationStore({ idFactory: () => `${prefix}${++sequence}` }); };
const capture = (store, extra = {}) => store.capture({ tab: 't1', document: 1,
  url: 'https://fixture.invalid/', title: 'Synthetic fixture', snapshot: '- button "Save" [ref=e1]', ...extra });
const list = count => Array.from({ length: count }, (_, index) => `- button "Action ${index}" [ref=e${index + 1}]`).join('\n');
const reconstruct = (base, view) => {
  if (view.mode === 'full') return view.text;
  const lines = base === '' ? [] : base.split('\n');
  lines.splice(view.splice.start, view.splice.deleteCount, ...view.splice.lines);
  return lines.join('\n');
};

test('full mode preserves exact YAML indentation, metadata and original ref signatures', () => {
  const store = make(), snapshot = '- main [ref=e1]:\n  - button "Save" [ref=e2]\n  - text: page content';
  const view = capture(store, { snapshot });
  assert.equal(view.text, snapshot); assert.equal(view.mode, 'full'); assert.equal(view.total, 3);
  assert.equal(view.url, 'https://fixture.invalid/'); assert.equal(view.title, 'Synthetic fixture');
  assert.equal(Object.hasOwn(view, 'refs'), false); assert.equal(Object.hasOwn(view, 'detail'), false);
  assert.deepEqual([...store.inspect(view.view).refs], [['e1', '- main [ref=e1]:'], ['e2', '  - button "Save" [ref=e2]']]);
  assert.equal(store.inspect(view.view).snapshot, snapshot);
});

test('only structural refs are accepted, including quoted YAML keys and iframe refs', () => {
  const lines = ['- button "Name [ref=evil]" [ref=e1]',
    '- \'button "Name: it\'\'s [ref=evil2]" [ref=e2]\': "text [ref=evil3]"',
    '- link "A\\\" [ref=evil4]" [ref=f2e3] [cursor=pointer]:',
    '  - /url: https://fixture.invalid/[ref=evil5]', '- text: [ref=evil6]',
    '- "text [ref=evil7]"', '- button "Name [ref=evil8]"', '- button [ref=BAD]', '- button [ref=e-7]'];
  assert.deepEqual([...ObservationRefs.from(lines.join('\n')).keys()], ['e1', 'e2', 'f2e3']);
  assert.throws(() => ObservationRefs.from('- button [ref=e1]\n- link [ref=e1]'), { code: 'ambiguous_ref' });
});

test('pagination retains parent context but no refs from unreturned siblings', () => {
  const store = make(), snapshot = '- main [ref=e1]:\n  - group [ref=e2]:\n    - button "A" [ref=e3]\n    - button "B" [ref=e4]\n  - link "C" [ref=e5]';
  const view = capture(store, { snapshot, offset: 3, limit: 1 });
  assert.equal(view.text, '- main [ref=e1]:\n  - group [ref=e2]:\n    - button "B" [ref=e4]');
  assert.equal(view.total, 5); assert.equal(view.next, 4); assert.equal(view.offset, 3);
  assert.deepEqual([...store.inspect(view.view).refs.keys()], ['e1', 'e2', 'e4']);
});

test('controls/filter are explicit projections with structural ancestor context', () => {
  const store = make(), snapshot = '- main [ref=e1]:\n  - paragraph [ref=e2]: Other content\n  - button "SAVE" [ref=e3]\n  - link "Other" [ref=e4]';
  const full = capture(store, { snapshot }), filtered = capture(store, { snapshot, detail: 'controls', filter: 'save' });
  assert.equal(full.text, snapshot); assert.equal(filtered.text, '- main [ref=e1]:\n  - button "SAVE" [ref=e3]');
  assert.equal(filtered.detail, 'controls'); assert.equal(filtered.filter, 'save');
  assert.deepEqual([...store.inspect(filtered.view).refs.keys()], ['e1', 'e3']);
});

test('deltas are opt-in and exactly reconstruct insertion, deletion, reordering and no change', () => {
  for (const transform of [lines => [...lines.slice(0, 4), '- button "NEW" [ref=e99]', ...lines.slice(4)],
    lines => lines.filter((_, index) => index !== 5), lines => [lines[1], lines[0], ...lines.slice(2)], lines => lines]) {
    const store = make(), base = capture(store, { snapshot: list(20) });
    const snapshot = transform(base.text.split('\n')).join('\n');
    const view = capture(store, { snapshot, since: base.view });
    assert.equal(view.mode, 'delta'); assert.equal(view.base, base.view);
    assert.equal(reconstruct(base.text, view), snapshot);
    assert.equal(store.inspect(view.view).text, snapshot);
    assert.equal(capture(store, { snapshot }).mode, 'full');
  }
});

test('unknown, cross-tab/document/client/projection and evicted bases reset to full', () => {
  for (const change of [{ since: 'unknown' }, { tab: 't2' }, { document: 2 }, { detail: 'controls' },
    { filter: 'Action' }, { offset: 1 }, { limit: 119 }, { maxChars: 6100 }]) {
    const store = make(), base = capture(store, { snapshot: list(20) });
    const view = capture(store, { snapshot: list(20), since: base.view, ...change });
    assert.equal(view.mode, 'full'); assert.equal(view.reset, true);
  }
  const left = make('left'), right = make('right'), base = capture(left, { snapshot: list(20) });
  assert.equal(capture(right, { snapshot: list(20), since: base.view }).reset, true);
  for (let index = 0; index < 4; index++) capture(left);
  assert.equal(left.inspect(base.view), undefined);
  assert.equal(capture(left, { since: base.view }).reset, true);
});

test('metadata and control-state changes always create a new view; deltas never suppress them', () => {
  const store = make(), base = capture(store, { snapshot: list(20) });
  const next = capture(store, { snapshot: list(20), title: 'Changed', url: 'https://fixture.invalid/new', since: base.view });
  assert.notEqual(next.view, base.view); assert.equal(next.title, 'Changed'); assert.equal(next.url, 'https://fixture.invalid/new');
  assert.deepEqual(next.splice, { start: 20, deleteCount: 0, lines: [] });
  const state = capture(store, { snapshot: list(20).replace('[ref=e1]', '[disabled] [ref=e1]'), since: next.view });
  assert.notEqual(state.view, next.view); assert.match(reconstruct(list(20), state), /\[disabled\]/);
});

test('full fallback is preferred to a larger delta, including complete deletion', () => {
  const store = make(), base = capture(store), same = capture(store, { since: base.view });
  assert.equal(same.mode, 'full'); assert.equal(same.reset, true);
  const empty = capture(store, { snapshot: '', since: same.view });
  assert.equal(empty.text, ''); assert.equal(empty.total, 0); assert.equal(empty.mode, 'full');
});

test('truncated target lines visibly lose all refs and obey both character and UTF8 budgets', () => {
  const store = make();
  for (const snapshot of ['- button "' + 'x'.repeat(4000) + '" [ref=e1]',
    '- button [ref=e1]: ' + '😀'.repeat(4000)]) {
    const view = capture(store, { snapshot, maxChars: 64 });
    assert.equal(view.truncated, true); assert.deepEqual(view.truncatedLines, [0]);
    assert.match(view.text, /\[truncated\]/); assert.doesNotMatch(view.text, /\[ref=/);
    assert.equal(store.inspect(view.view).refs.size, 0); assert(view.text.length <= 64);
    assert(!/[\uD800-\uDBFF]$/.test(view.text));
  }
  const view = capture(store, { snapshot: Array.from({ length: 20 }, () => '- text: ' + '😀'.repeat(1000)).join('\n'), maxChars: 24576 });
  assert(Buffer.byteLength(view.text, 'utf8') <= 24576); assert(view.next < view.total);
  assert(view.text.split('\n').every(line => line.length <= 2048));
});

test('char-limited pagination and context exhaustion are explicit and never authorize missing targets', () => {
  const store = make(), view = capture(store, { snapshot: list(20), maxChars: 64 });
  assert.equal(view.truncated, true); assert(view.next > 0 && view.next < view.total);
  assert(!store.inspect(view.view).refs.has('e20'));
  const nested = capture(store, { snapshot: '- main "' + 'x'.repeat(300) + '" [ref=e1]:\n  - button [ref=e2]', offset: 1, maxChars: 64 });
  assert.equal(nested.next, 1); assert.equal(nested.truncated, true); assert.equal(store.inspect(nested.view).refs.size, 0);
});

test('raw oversized/too-many-line snapshots are rejected, not silently clipped', () => {
  const store = make();
  for (const snapshot of ['x'.repeat(1024 * 1024 + 1), '😀'.repeat(262145), '\n'.repeat(32768)])
    assert.throws(() => capture(store, { snapshot }), { code: 'snapshot_too_large' });
  assert.doesNotThrow(() => capture(store, { snapshot: 'x'.repeat(1024 * 1024) }));
  assert.throws(() => capture(store, { snapshot: '- button [ref=e1]\n- link [ref=e1]', limit: 1 }), { code: 'ambiguous_ref' });
});

test('inspection is defensive, invalidation scoped, and history remains four views', () => {
  const store = make(), first = capture(store), other = capture(store, { tab: 't2' });
  const observed = store.inspect(first.view); observed.refs.clear(); observed.projection.limit = 1; observed.text = 'changed';
  assert.equal(store.inspect(first.view).refs.size, 1); assert.equal(store.inspect(first.view).projection.limit, 120);
  store.invalidateTab('t1'); assert.equal(store.inspect(first.view), undefined); assert(store.inspect(other.view));
  const views = Array.from({ length: 8 }, () => capture(store));
  assert.equal(views.filter(view => store.inspect(view.view)).length, 4);
  assert.equal(store.inspect(other.view), undefined);
});

test('invalid inputs and broken ID factories fail with stable codes', () => {
  for (const extra of [{ document: 0 }, { document: NaN }, { tab: '' }, { url: null }, { title: {} },
    { snapshot: null }, { detail: 'summary' }, { filter: 2 }, { offset: -1 }, { limit: 501 }, { maxChars: 63 }, { since: '' }])
    assert.throws(() => capture(make(), extra), error => typeof error.code === 'string');
  assert.throws(() => new ObservationStore({ idFactory: false }), { code: 'invalid_id_factory' });
  assert.throws(() => capture(new ObservationStore({ idFactory: () => '../bad' })), { code: 'invalid_view_id' });
  const collision = new ObservationStore({ idFactory: () => 'same' }); capture(collision);
  assert.throws(() => capture(collision), { code: 'view_id_collision' });
});

test('1000 deterministic edits reconstruct the exact projected slice with no stale refs', () => {
  let seed = 0x7139a; const random = maximum => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % maximum; };
  let deltas = 0;
  for (let iteration = 0; iteration < 1000; iteration++) {
    const store = make(), options = { snapshot: list(40), offset: random(10), limit: 20 + random(20) };
    const base = capture(store, options), lines = options.snapshot.split('\n');
    const at = random(lines.length), removed = lines.splice(at, random(3));
    if (random(2)) lines.splice(random(lines.length), 0, ...removed.reverse());
    if (random(2)) lines.splice(random(lines.length), 0, `- checkbox "New 😀 ${iteration}" [checked] [ref=e${100 + iteration}]`);
    const next = capture(store, { ...options, snapshot: lines.join('\n'), since: base.view });
    deltas += next.mode === 'delta' ? 1 : 0;
    const reconstructed = reconstruct(base.text, next), stored = store.inspect(next.view);
    assert.equal(reconstructed, stored.text);
    assert.deepEqual([...stored.refs], [...ObservationRefs.from(reconstructed)]);
  }
  assert(deltas > 500, 'must exercise actual deltas, not merely full resets');
});

test('pinned Playwright real-browser fixture preserves nested frame and escaped-name references', () => {
  // Captured from a fresh disposable Chromium via pinned Playwright _snapshotForAI().full.
  const snapshot = '- main [ref=e2]:\n  - \'button "Name: it\'\'s [ref=evil]" [ref=e3]\'\n' +
    '  - link "Link" [ref=e5] [cursor=pointer]:\n    - /url: https://fixture.invalid/[ref=evil3]\n' +
    '  - textbox "Name [ref=evil4]" [ref=e6]\n  - iframe [ref=e7]:\n    - button "Frame [ref=evil5]" [ref=f1e2]';
  const store = make(), view = capture(store, { snapshot });
  assert.equal(view.text, snapshot);
  assert.deepEqual([...store.inspect(view.view).refs.keys()], ['e2', 'e3', 'e5', 'e6', 'e7', 'f1e2']);
});

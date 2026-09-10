import assert from 'node:assert/strict';

// Read-only policy: reuse the sole startup fixture tab, never create a fallback
// or close unexpected tabs to hide their resource impact on a measurement.
export class PilotTab {
  static inspect(targetInfos) {
    assert(Array.isArray(targetInfos), 'Missing browser targets');
    const pages = targetInfos.filter(target => target.type === 'page');
    assert.equal(pages.length, 1, 'Test must retain one browser tab');
    assert.equal(pages[0].url, 'about:blank', 'Never operate on a website');
    assert(typeof pages[0].targetId === 'string' && pages[0].targetId.length > 0, 'Missing tab identity');
    return { count: 1, targetId: pages[0].targetId };
  }

  static assertSame(expected, actual) {
    assert(expected?.count === 1 && typeof expected.targetId === 'string' && expected.targetId.length > 0, 'Missing initial tab evidence');
    assert.deepEqual(actual, expected, 'The sole test tab changed');
  }
}

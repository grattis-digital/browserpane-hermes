import test from 'node:test';
import assert from 'node:assert/strict';
import { CompactBrowserFixture as Fixture } from './compact-browser-fixture.mjs';

const fixture = t => { const f = new Fixture(); t.after(() => f.close()); return f; };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('listing drops a title rejected by confirmed tab closure and marks the surviving default', async t => {
  const f = fixture(t), title = deferred();
  assert.equal(f.browser.tab().id, 't1');
  f.pages[0].title = () => title.promise;
  const listing = f.browser.list();
  await f.pages[0].close();
  title.reject(new Error('Target page has been closed'));
  assert.deepEqual((await listing).map(tab => [tab.tab, tab.default]), [['t2', true]]);
  assert.equal(f.browser.tab().id, 't2');
  assert.equal(f.creations, 0); assert.equal(f.pages[1].activations, 0);
});

test('one bounded event turn reconciles a close notification after its rejected title', async t => {
  const f = fixture(t), title = deferred();
  f.pages[0].title = () => title.promise;
  const listing = f.browser.list();
  title.reject(new Error('Target page has been closed'));
  setImmediate(() => { void f.pages[0].close(); });
  assert.deepEqual((await listing).map(tab => [tab.tab, tab.default]), [['t2', true]]);
});

test('listing drops an already successful title when that page closes while another title is pending', async t => {
  const f = fixture(t), first = deferred(), second = deferred();
  assert.equal(f.browser.tab().id, 't1');
  f.pages[0].title = () => first.promise; f.pages[1].title = () => second.promise;
  const listing = f.browser.list();
  first.resolve('Title read before closure');
  await Promise.resolve(); await f.pages[0].close();
  second.resolve('Surviving title');
  const tabs = await listing;
  assert.deepEqual(tabs.map(tab => [tab.tab, tab.default, tab.title]), [['t2', true, 'Surviving title']]);
});

test('listing keeps an existing default marker when only a non-default tab closes mid-title', async t => {
  const f = fixture(t), title = deferred();
  f.pages[1].title = () => title.promise;
  const listing = f.browser.list();
  await f.pages[1].close(); title.reject(new Error('Target page has been closed'));
  assert.deepEqual((await listing).map(tab => [tab.tab, tab.default]), [['t1', true]]);
});

test('title errors on live tabs are not hidden, including messages that resemble closure', async t => {
  const f = fixture(t);
  for (const message of ['Synthetic transport failure', 'Target page, context or browser has been closed']) {
    const error = new Error(message); let calls = 0;
    f.pages[0].title = async () => { calls++; throw error; };
    await assert.rejects(f.browser.list(), failure => failure === error);
    assert.equal(calls, 1, 'Failed title requests are never retried');
    assert.equal(f.browser.tab().id, 't1'); assert.equal(f.creations, 0);
  }
});

test('browser disconnection during title reads is not reported as an empty successful listing', async t => {
  const f = fixture(t), title = deferred();
  f.pages[0].title = () => title.promise;
  const listing = f.browser.list();
  f.connected = false;
  await Promise.all(f.pages.map(page => page.close()));
  title.reject(new Error('Browser connection closed'));
  await assert.rejects(listing, { code: 'DISCONNECTED' });
  await assert.rejects(f.browser.list(), { code: 'DISCONNECTED' });
});

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { CompactEngineFixture as Fixture } from './compact-engine-fixture.mjs';
import { CompactTabChecks } from './compact-tab-checks.mjs';

const fixture = new Fixture(), checks = [];
const check = (name, result) => { assert(!result?.isError, `${name}: ${JSON.stringify(result)}`); checks.push(name); };
try {
  await fixture.start();
  await CompactTabChecks.run(fixture);
  check('actual MCP HTTP clients reuse the default across navigation/reconnect and reject stale closed-tab input');
  const session = fixture.session(), observer = fixture.session();
  let page = await fixture.reset(`<label>Name<input id="name"></label><label>Agree<input id="agree" type="checkbox"></label>
    <button id="save">Save</button><p role="status" id="status"></p><script>window.events=[];
    for(const type of ['input','click'])document.addEventListener(type,e=>events.push({type,id:e.target.id,trusted:e.isTrusted}),true);
    document.getElementById('save').onclick=()=>document.getElementById('status').textContent='Saved';</script>`);
  let view = await fixture.view(session), stale = await fixture.view(observer);
  const args = { lease: session.lease, request: ++session.request, tab: view.tab, view: view.view,
    steps: [{ op: 'fill', ref: Fixture.ref(view, 'Name'), text: 'Synthetic input' },
      { op: 'check', ref: Fixture.ref(view, 'Agree'), checked: true }, { op: 'click', ref: Fixture.ref(view, 'Save') }],
    wait: { text: 'Saved', timeoutMs: 1000 } };
  const first = await fixture.call(session, 'pane_act', args); check('typed batch reaches exact state', first);
  assert.equal(first.completed, 3); assert.equal(await page.locator('#name').inputValue(), 'Synthetic input');
  assert.equal(await page.locator('#agree').isChecked(), true);
  assert.deepEqual(await page.evaluate(() => events.filter(e => e.id === 'save')), [{ type: 'click', id: 'save', trusted: true }]);
  assert.deepEqual(await fixture.call(session, 'pane_act', args), first);
  assert.equal((await page.evaluate(() => events.filter(e => e.id === 'save'))).length, 1); check('exact request replay has no extra input');
  assert.equal((await fixture.act(observer, stale, [{ op: 'click', ref: Fixture.ref(stale, 'Save') }])).error.code, 'STALE_VIEW');
  assert.equal((await fixture.call(observer, 'pane_act', args)).error.code, 'STALE_SESSION'); check('other-client stale view and old lease are rejected');

  view = await fixture.view(session); const oldRef = Fixture.ref(view, 'Save');
  await page.locator('#save').evaluate(element => { element.textContent = 'Purchase'; });
  assert.equal((await fixture.act(session, view, [{ op: 'click', ref: oldRef }])).error.code, 'STALE_REF');
  view = await fixture.view(session); const replacedRef = Fixture.ref(view, 'Purchase');
  await page.locator('#save').evaluate(element => { element.outerHTML = element.outerHTML; });
  assert.equal((await fixture.act(session, view, [{ op: 'click', ref: replacedRef }])).error.code, 'STALE_REF');
  check('renamed and replaced nodes cannot inherit old action permission');

  page = await fixture.reset('<button>First</button><button>Hidden target</button>');
  const full = await fixture.view(session); view = await fixture.view(session, { limit: 1 });
  assert.equal((await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(full, 'Hidden target') }])).error.code, 'STALE_REF');
  check('unreturned page targets are nonactionable');

  page = await fixture.reset('<label>Name<input id="name"></label><a href="about:blank">Leave</a>');
  view = await fixture.view(session);
  const navigation = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Leave') },
    { op: 'fill', ref: Fixture.ref(view, 'Name'), text: 'Must never run' }]);
  check('navigation stops remaining batch input', navigation); assert.equal(navigation.completed, 1); assert.equal(navigation.stopped, 'navigation');

  page = await fixture.reset('<button id="popup">Open popup</button><button id="after">After popup</button><script>window.afterClicks=0;popup.onclick=()=>window.open("about:blank");after.onclick=()=>afterClicks++;</script>');
  view = await fixture.view(session);
  const popup = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Open popup') },
    { op: 'click', ref: Fixture.ref(view, 'After popup') }]);
  check('popup stops remaining batch input', popup); assert.equal(popup.completed, 1); assert.equal(popup.stopped, 'new_tab');
  assert.equal(await page.evaluate(() => afterClicks), 0);
  const opened = (await fixture.call(session, 'pane_tabs')).tabs.find(tab => tab.tab !== view.tab); assert(opened);
  const popupView = await fixture.view(session, { tab: opened.tab });
  check('explicit popup cleanup', await fixture.act(session, popupView, [{ op: 'close' }]));
  await fixture.waitForTabs(1);

  page = await fixture.reset('<button id="change">Change target</button><button id="target">Preview</button><script>window.targetClicks=0;change.onclick=()=>target.textContent="Purchase";target.onclick=()=>targetClicks++;</script>');
  view = await fixture.view(session);
  const changed = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Change target') },
    { op: 'click', ref: Fixture.ref(view, 'Preview') }]);
  assert.equal(changed.error.code, 'TARGET_CHANGED'); assert.equal(changed.completed, 1);
  assert.equal(await page.evaluate(() => targetClicks), 0); check('semantic changes inside a batch stop pinned-node input');

  page = await fixture.reset('<button id="clicked">Click once</button><script>window.clicks=0;clicked.onclick=()=>clicks++;</script>');
  view = await fixture.view(session);
  const postcondition = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Click once') }],
    { wait: { text: 'Will never appear', timeoutMs: 30 } });
  assert.equal(postcondition.error.code, 'POSTCONDITION_FAILED'); assert.equal(postcondition.completed, 1);
  assert.equal(postcondition.mayHaveActed, true); assert.equal(await page.evaluate(() => clicks), 1);
  check('failed postcondition reports applied input without replay');

  page = await fixture.reset('<button id="chain">Dialogs</button><script>chain.onclick=()=>{confirm("First dialog");alert("Second dialog");window.dialogsDone=true;};</script>');
  view = await fixture.view(session);
  const pending = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Dialogs') }]);
  assert.equal(pending.stopped, 'dialog'); assert.equal(pending.pendingStep, 0);
  const one = await fixture.act(session, pending.observation, [{ op: 'dialog', accept: true }]);
  check('first dialog yields queue ownership to a second dialog', one);
  assert.equal(one.observation.dialog.message, 'Second dialog');
  const two = await fixture.act(session, one.observation, [{ op: 'dialog', accept: true }]);
  check('second dialog releases original action safely', two); assert.equal(await page.evaluate(() => window.dialogsDone), true);

  page = await fixture.reset('<label>Prompted<input id="prompted" onclick="confirm(\'Continue?\')"></label>');
  view = await fixture.view(session);
  const typing = await fixture.act(session, view, [{ op: 'type', ref: Fixture.ref(view, 'Prompted'), text: 'Must not continue after dialog' }]);
  assert.equal(typing.stopped, 'dialog');
  const accepted = await fixture.act(session, typing.observation, [{ op: 'dialog', accept: true }]);
  assert.equal(accepted.error.code, 'INTERRUPTED_ACTION');
  assert.equal(await page.locator('#prompted').inputValue(), ''); check('compound input does not resume after modal interruption');

  page = await fixture.reset('<label>Disabled<input id="disabled" disabled></label><button id="after">After</button><script>window.afterClicks=0;after.onclick=()=>afterClicks++;</script>');
  view = await fixture.view(session); const started = performance.now();
  const failed = await fixture.act(session, view, [{ op: 'fill', ref: Fixture.ref(view, 'Disabled'), text: 'No force' },
    { op: 'click', ref: Fixture.ref(view, 'After') }]);
  assert(failed.isError); assert.equal(failed.completed, 0); assert.equal(failed.failedStep, 0);
  assert.equal(await page.evaluate(() => afterClicks), 0); assert(performance.now() - started < 8000);
  check('default Playwright actionability stays enabled and failure stops input');

  const upload = fixture.sharedPath('synthetic.txt'); await writeFile(upload, 'synthetic upload', { flag: 'wx' });
  page = await fixture.reset('<label>Upload<input type="file" id="upload"></label>');
  view = await fixture.view(session); const uploaded = await fixture.act(session, view, [{ op: 'upload', ref: Fixture.ref(view, 'Upload'), paths: [upload] }]);
  check('shared upload uses exact owned bytes', uploaded);
  assert.equal(await page.locator('#upload').evaluate(async element => element.files[0].text()), 'synthetic upload');

  const existing = await fixture.view(session);
  const lastClose = await fixture.act(session, existing, [{ op: 'close' }]);
  assert.equal(lastClose.error.code, 'LAST_TAB'); assert.equal(page.isClosed(), false); check('last shared tab cannot be closed');
  const created = await fixture.act(session, undefined, [{ op: 'new', url: 'about:blank' }]); check('explicit new tab', created);
  const closed = await fixture.act(session, created.observation, [{ op: 'close' }]); check('explicit extra-tab close', closed);
  assert(['tab_closed', 'close_requested'].includes(closed.stopped), JSON.stringify(closed));
  await fixture.waitForTabs(1); assert.equal(page.isClosed(), false);

  const protectedTab = await fixture.act(session, undefined, [{ op: 'new', url: 'about:blank' }]);
  const protectedPage = fixture.pageFor(protectedTab.tab);
  await protectedPage.setContent('<button>Activate beforeunload</button><script>window.onbeforeunload=e=>{e.preventDefault();e.returnValue="";};</script>');
  view = await fixture.view(session, { tab: protectedTab.tab });
  const activated = await fixture.act(session, view, [{ op: 'click', ref: Fixture.ref(view, 'Activate beforeunload') }]);
  check('beforeunload fixture has real user activation', activated);
  const dialogEvent = protectedPage.waitForEvent('dialog', { timeout: 3000 });
  const closePending = await fixture.act(session, activated.observation, [{ op: 'close' }]);
  assert(['dialog', 'close_requested'].includes(closePending.stopped), JSON.stringify(closePending));
  assert.equal((await dialogEvent).type(), 'beforeunload');
  const closeView = await fixture.view(session, { tab: protectedTab.tab });
  assert.equal(closeView.dialog.type, 'beforeunload');
  const dismissed = await fixture.act(session, closeView, [{ op: 'dialog', accept: false }]);
  check('close confirmation is explicit and dismissal preserves tab', dismissed); assert.equal(protectedPage.isClosed(), false);
  await protectedPage.evaluate(() => { window.onbeforeunload = null; });
  view = await fixture.view(session, { tab: protectedTab.tab });
  check('explicit protected-tab cleanup', await fixture.act(session, view, [{ op: 'close' }]));
  await fixture.waitForTabs(1);
  await fixture.assertOwnership(); check('session teardown and CDP disconnect preserve the existing browser');
} finally { await fixture.close(); }
console.log(JSON.stringify({ passed: true, checks, paidModelCalls: 0, cleanup: 'Owned Chromium and disposable profile removed',
  scope: 'Fresh local headless Chromium over CDP; tab reuse also tested through actual MCP HTTP clients. Not Pi or production.' }, null, 2));

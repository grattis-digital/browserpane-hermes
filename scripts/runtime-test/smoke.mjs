// Passed by the disposable launcher on stdin after full Docker identity checks.
import assert from 'node:assert/strict';
assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
assert.match(process.env.BPANE_RUNTIME_TEST_ID ?? '', /^[a-f0-9-]{36}$/);
const timeout = () => AbortSignal.timeout(5000);
const health = await fetch('http://127.0.0.1:8090/healthz', { signal: timeout() });
assert.equal(health.status, 200);
const browser = await RuntimeCdp.browser();
let page;
try {
  const initialPage = (await RuntimeCdp.pages())[0];
  assert(initialPage, 'Shared Chromium must have an existing page');
  page = await RuntimeCdp.connect(initialPage.webSocketDebuggerUrl);
  assert.equal(await page.evaluate(() => devicePixelRatio), 1);
  const pid = async () => (await browser.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser').id;
  const before = await pid();
  for (let index = 0; index < 2; index++) {
    const response = await fetch('http://127.0.0.1:8090/browser/bootstrap', {
      method: 'POST', headers: { Origin: 'https://viewer.test' }, signal: timeout(),
    });
    assert.equal(response.status, 200, 'Viewer bootstrap failed');
    const access = await response.json();
    assert.equal(access.certHashUrl, '/browser/cert-hash');
    assert(access.connectTicket.length > 20);
  }
  assert.equal(await pid(), before, 'Viewer bootstrap must reuse the existing browser');
  const denied = await fetch('http://127.0.0.1:8090/browser/bootstrap', {
    method: 'POST', headers: { Origin: 'https://untrusted.invalid' }, signal: timeout(),
  });
  assert.equal(denied.status, 403);
  console.log(JSON.stringify({ health: true, browserDpr: 1, sharedBootstrap: true, rejectsForeignOrigin: true }));
} finally { page?.close(); browser.close(); }

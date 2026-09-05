// Passed by the disposable launcher on stdin after full Docker identity checks.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
assert.match(process.env.BPANE_RUNTIME_TEST_ID ?? '', /^[a-f0-9-]{36}$/);
const timeout = () => AbortSignal.timeout(5000);
const health = await fetch('http://127.0.0.1:8090/healthz', { signal: timeout() });
assert.equal(health.status, 200);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
try {
  const page = browser.contexts()[0].pages()[0];
  assert(page, 'Shared Chromium must have an existing page');
  assert.equal(await page.evaluate(() => devicePixelRatio), 1);
  const cdp = await browser.newBrowserCDPSession();
  const pid = async () => (await cdp.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser').id;
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
  await cdp.detach();
  console.log(JSON.stringify({ health: true, browserDpr: 1, sharedBootstrap: true, rejectsForeignOrigin: true }));
} finally { await browser.close(); }

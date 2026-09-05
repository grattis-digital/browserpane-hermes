// Stdin helper for scripts/test-runtime.mjs, never an operator/profile diagnostic.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1', 'Disposable container required');
const token = process.env.BPANE_RUNTIME_TEST_ID;
assert.match(token ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const mode = process.argv[2];
assert(['seed', 'verify'].includes(mode), 'Use the disposable launcher');
const expectedUrl = 'http://fixture:9130/' + token;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 10000 });
try {
  const context = browser.contexts()[0];
  if (mode === 'seed') {
    const page = await context.newPage();
    await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await context.addCookies([{ name: 'bpane_profile_test', value: token,
      domain: 'fixture', path: '/', sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 }]);
    await page.evaluate(value => localStorage.setItem('bpane-profile-test', value), token);
    await writeFile('/shared/profile-test-marker', token, { flag: 'wx' });
    console.log(JSON.stringify({ seededOwnedTab: true, cookie: true, localStorage: true, sharedFile: true }));
  } else {
    const page = context.pages().find(candidate => candidate.url() === expectedUrl);
    assert(page, 'Chromium did not restore the owned test tab automatically');
    // Activation may load a lazily restored tab; do not navigate to hide lost session state.
    await page.bringToFront();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    const cookie = (await context.cookies(expectedUrl)).find(item => item.name === 'bpane_profile_test');
    assert.equal(cookie?.value, token, 'Persistent cookie lost');
    assert.equal(await page.evaluate(() => localStorage.getItem('bpane-profile-test')), token, 'Site storage lost');
    assert.equal(await readFile('/shared/profile-test-marker', 'utf8'), token, 'Shared folder lost');
    const downloads = (await readdir('/shared/downloads')).filter(name => name.startsWith('browserpane-download-check-'));
    assert(downloads.length > 0, 'Genuine MCP download did not survive');
    for (const name of downloads) assert.equal(await readFile('/shared/downloads/' + name, 'utf8'), name.slice(0, -4));
    console.log(JSON.stringify({ restoredOwnedTab: true, persistentCookie: true, localStorage: true, sharedFile: true, download: true }));
  }
} finally {
  // CDP attachment close disconnects this client, not the persistent browser.
  await browser.close();
}

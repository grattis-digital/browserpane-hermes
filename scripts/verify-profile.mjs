// Stdin helper for scripts/test-runtime.mjs, never an operator/profile diagnostic.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1', 'Disposable container required');
const token = process.env.BPANE_RUNTIME_TEST_ID;
assert.match(token ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const mode = process.argv[2];
assert(['seed', 'verify'].includes(mode), 'Use the disposable launcher');
const expectedUrl = 'http://fixture:9130/' + token;
const startupUrl = expectedUrl + '#startup';
const expectedTabs = [expectedUrl, startupUrl].sort();
const exactTabs = async (expected, message) => {
  // Browser health and one restored target do not imply every target is listed yet.
  await RuntimeCdp.until(async () => {
    const urls = (await RuntimeCdp.pages()).map(target => target.url).sort();
    return urls.length === expected.length && urls.every((url, index) => url === expected[index]);
  }, message);
  assert.deepEqual((await RuntimeCdp.pages()).map(target => target.url).sort(), expected, message);
};
const browser = await RuntimeCdp.browser();
let page;
try {
  if (mode === 'seed') {
    await exactTabs([startupUrl],
      'Fresh profile must open exactly the configured startup URL');
    const created = await browser.send('Target.createTarget', { url: expectedUrl });
    await RuntimeCdp.until(async () => (await RuntimeCdp.pages()).some(target => target.id === created.targetId && target.url === expectedUrl), 'Owned seed tab did not navigate');
    ({ page } = await RuntimeCdp.pageByUrl(expectedUrl));
    await RuntimeCdp.until(() => page.evaluate(() => document.readyState !== 'loading'), 'Owned seed document did not load');
    const cookie = await page.send('Network.setCookie', { name: 'bpane_profile_test', value: token,
      url: expectedUrl, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 3600 });
    assert.equal(cookie.success, true);
    await page.evaluate(value => localStorage.setItem('bpane-profile-test', value), token);
    await writeFile('/shared/profile-test-marker', token, { flag: 'wx' });
    await exactTabs(expectedTabs, 'Seeding must add exactly one synthetic tab');
    console.log(JSON.stringify({ configuredStartupTab: true, seededOwnedTab: true, exactTabCount: 2,
      cookie: true, localStorage: true, sharedFile: true }));
  } else {
    const restored = await RuntimeCdp.pageByUrl(expectedUrl);
    page = restored.page;
    // Activation may load a lazily restored tab; do not navigate to hide lost session state.
    await browser.send('Target.activateTarget', { targetId: restored.id });
    await RuntimeCdp.until(() => page.evaluate(expected => location.href === expected && document.readyState !== 'loading', expectedUrl), 'Restored document did not load without navigation');
    await exactTabs(expectedTabs,
      'Reconnect/restart/recreation must preserve both tabs without appending a startup tab');
    const cookie = (await page.send('Network.getCookies', { urls: [expectedUrl] })).cookies.find(item => item.name === 'bpane_profile_test');
    assert.equal(cookie?.value, token, 'Persistent cookie lost');
    assert.equal(await page.evaluate(() => localStorage.getItem('bpane-profile-test')), token, 'Site storage lost');
    assert.equal(await readFile('/shared/profile-test-marker', 'utf8'), token, 'Shared folder lost');
    const downloads = (await readdir('/shared/downloads')).filter(name => name.startsWith('browserpane-download-check-'));
    assert(downloads.length > 0, 'Genuine MCP download did not survive');
    for (const name of downloads) assert.equal(await readFile('/shared/downloads/' + name, 'utf8'), name.slice(0, -4));
    console.log(JSON.stringify({ restoredOwnedTab: true, exactTabCount: 2, persistentCookie: true,
      localStorage: true, sharedFile: true, download: true }));
  }
} finally {
  page?.close(); browser.close(); // Raw sockets only; no Browser.close or download-setting commands.
}

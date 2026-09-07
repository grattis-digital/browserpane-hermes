import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
// Launcher concatenates the existing raw-CDP test helper before this module.
const token = process.env.BPANE_WORKFLOW_PILOT;
assert.match(token ?? '', /^[0-9a-f-]{36}$/);
const expected = `http://127.0.0.1:9130/${token}/report`, mode = process.argv[2] ?? 'inspect';
assert(['inspect', 'seed', 'restored'].includes(mode));
const pages = await RuntimeCdp.pages(); assert.equal(pages.length, 1);
const { page } = await RuntimeCdp.pageByUrl(expected);
try {
  const documentState = await page.evaluate(() => ({ url: location.href, title: document.title,
    ready: document.readyState, token: window.__pilot?.token, text: document.body?.innerText.slice(0, 1000),
    focused: document.hasFocus(), activeElement: document.activeElement?.id,
    viewport: { width: innerWidth, height: innerHeight } }));
  assert.equal(documentState.token, token, JSON.stringify(documentState));
  if (mode === 'seed') {
    assert.equal((await page.send('Network.setCookie', { name: 'pilot_profile', value: token,
      url: expected, expires: Math.floor(Date.now() / 1000) + 3600 })).success, true);
    await page.evaluate(value => localStorage.setItem('pilot_profile', value), token);
  }
  const state = await page.evaluate(() => ({ ...window.__pilot, profile: localStorage.getItem('pilot_profile') }));
  assert.equal(state.token, token);
  if (mode === 'restored') {
    assert.equal(state.profile, token);
    const cookies = await page.send('Network.getCookies', { urls: [expected] });
    assert.equal(cookies.cookies.find(cookie => cookie.name === 'pilot_profile')?.value, token);
  }
  const files = {};
  for (const name of await readdir('/shared/downloads')) {
    if (!/^report-\d{4}-\d{2}( \(\d+\))?\.csv$/.test(name)) continue;
    assert(Object.keys(files).length < 128);
    const data = await readFile('/shared/downloads/' + name); assert(data.length <= 32768);
    files[name] = data.toString('utf8');
  }
  console.log(JSON.stringify({ tabs: pages.length, state, files, documentState, profileVerified: mode === 'restored' }));
} finally { page.close(); }

// Run only inside the launcher's disposable container; all interaction uses its MCP.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1', 'Use only scripts/test-runtime.mjs');
assert.match(process.env.BPANE_RUNTIME_TEST_ID ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const mode = process.env.BPANE_MCP_MODE ?? 'compact';
assert(['compact', 'playwright'].includes(mode));
const marker = `browserpane-download-check-${randomUUID()}`, filename = `${marker}.log`;
const downloads = '/shared/downloads', artifacts = '/shared/mcp-artifacts';
const client = new Client({ name: 'download-isolation-check', version: '2.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'));

class DownloadDriver {
  request = 0;
  constructor(url) { this.url = url; }
  async compact(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content.find(part => part.type === 'text').text);
  }
  async legacy(code) {
    const result = await client.callTool({ name: 'browser_run_code', arguments: { code } });
    assert(!result.isError, JSON.stringify(result));
  }
  async open() {
    if (mode === 'playwright') return this.legacy(`async(page)=>{
      const target=await page.context().newPage(); await target.goto(${JSON.stringify(this.url)}); await target.bringToFront();
    }`);
    const { lease } = await this.compact('pane_tabs'); this.lease = lease;
    const result = await this.compact('pane_act', { lease, request: ++this.request,
      steps: [{ op: 'new', url: this.url }], observe: 'full' });
    assert.equal(result.completed, 1); this.tab = result.tab;
  }
  async action(op, dy) {
    if (mode === 'playwright') return this.legacy(`async(page)=>{
      const target=page.context().pages().find(p=>p.url()===${JSON.stringify(this.url)});
      if(!target)throw Error('Own fixture missing');
      ${op === 'close' ? 'await target.close();' : op === 'click'
        ? "await target.getByRole('link',{name:'Download genuine log',exact:true}).click();"
        : `await target.getByRole('region',{name:'Scroll area',exact:true}).hover(); await target.mouse.wheel(0,${dy});`}
    }`);
    const view = await this.compact('pane_view', { tab: this.tab });
    const target = op === 'click' ? 'link "Download genuine log"' : 'region "Scroll area"';
    const matches = view.text.split('\n').filter(line => line.trimStart().startsWith(`- ${target} [`));
    const ref = op === 'close' ? undefined : matches.length === 1 && matches[0].match(/\[ref=([a-zA-Z0-9]+)\]/)?.[1];
    if (op !== 'close') assert(ref, `One exact observed ${target} ref is required`);
    const step = op === 'close' ? { op } : { op, ref, ...(op === 'scroll' ? { dy } : {}) };
    const result = await this.compact('pane_act', { lease: this.lease, request: ++this.request,
      tab: this.tab, view: view.view, steps: [step], observe: 'none' });
    assert.equal(result.completed, 1);
  }
}

async function inventory() {
  return Object.fromEntries(await Promise.all((await readdir(downloads)).map(async name => {
    const info = await stat(join(downloads, name)); return [name, [info.size, info.mtimeMs]];
  })));
}
async function until(check, message) {
  const deadline = Date.now() + 10000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  throw new Error(message);
}
const fixture = createServer((request, response) => {
  if (request.url === `/${marker}/download`) {
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': `attachment; filename="${filename}"` });
    response.end(marker); return;
  }
  if (request.url !== `/${marker}`) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(`<!doctype html><title>Temporary download isolation check</title><h1>Download isolation check</h1>
    <a href="/${marker}/download">Download genuine log</a>
    <section role="region" aria-label="Scroll area" tabindex="0" style="height:220px;overflow:auto;border:2px solid">
      <div style="height:3000px">Synthetic scroll content</div></section><script>
    window.downloadCheck={wheel:0,scroll:0,click:false}; const area=document.querySelector('section');
    area.addEventListener('wheel',event=>{if(event.isTrusted)downloadCheck.wheel++});
    area.addEventListener('scroll',()=>{downloadCheck.scroll++;console.error('${marker}: scroll video error')});
    document.querySelector('a').addEventListener('click',event=>downloadCheck.click=event.isTrusted);
    for(let i=0;i<20;i++)console.error('${marker}: missing video '+i);
    </script>`);
});
await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
const driver = new DownloadDriver(`http://127.0.0.1:${fixture.address().port}/${marker}`);
let target, browser, originalPid, opened = false;
const pid = async () => (await browser.send('SystemInfo.getProcessInfo')).processInfo.find(value => value.type === 'browser').id;
try {
  browser = await RuntimeCdp.browser(); originalPid = await pid();
  await client.connect(transport);
  const { tools } = await client.listTools();
  if (mode === 'compact') assert.deepEqual(tools.map(tool => tool.name).sort(), ['pane_act', 'pane_image', 'pane_read', 'pane_tabs', 'pane_view']);
  else assert(tools.some(tool => tool.name === 'browser_run_code'));
  const before = await inventory();
  await driver.open(); opened = true;
  ({ page: target } = await RuntimeCdp.pageByUrl(driver.url));
  await driver.action('scroll', 900);
  await until(() => target.evaluate(() => document.querySelector('section').scrollTop > 0), 'MCP wheel did not scroll down');
  await driver.action('scroll', -900);
  await until(() => target.evaluate(() => document.querySelector('section').scrollTop === 0 && downloadCheck.scroll >= 2), 'MCP wheel did not return to the top');
  assert.equal(await target.evaluate(() => downloadCheck.wheel), 2, 'Wheel input must be trusted and occur exactly twice');
  if (mode === 'playwright') await until(async () => {
    for (const name of await readdir(artifacts).catch(() => [])) {
      if (name.startsWith('console-') && (await readFile(join(artifacts, name), 'utf8')).includes(marker)) return true;
    }
    return false;
  }, 'Legacy console diagnostics were not recorded outside downloads');
  assert.deepEqual(await inventory(), before, 'Console errors changed the watched download folder');
  await driver.action('click');
  await until(async () => (await readFile(join(downloads, filename), 'utf8').catch(() => '')) === marker, 'Genuine .log download was not forwarded');
  assert.equal(await target.evaluate(() => downloadCheck.click), true, 'Download requires genuine MCP browser input');
  const after = await inventory(); delete after[filename]; assert.deepEqual(after, before, 'Unexpected additional downloaded files');
  assert.equal(await pid(), originalPid, 'MCP operations must reuse Chromium');
  console.log(JSON.stringify({ mode, mcpTools: tools.length, consoleIsolation: 'passed', scrollTop: 'passed',
    genuineLogDownload: 'passed', trustedWheelEvents: 2, browserPid: originalPid, testFilename: filename }));
} finally {
  try { if (opened) await driver.action('close'); }
  finally {
    try {
      target?.close(); // Only disconnect the page observer; MCP owns fixture-tab cleanup.
      await transport.terminateSession().catch(() => {}); await client.close();
      if (browser) assert.equal(await pid(), originalPid, 'MCP disconnect must not replace Chromium');
    } finally {
      browser?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
    }
  }
}

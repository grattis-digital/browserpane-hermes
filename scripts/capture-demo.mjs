// A real streamed screenshot from a strictly disposable, local-only container.
// Start scripts/start-pipeline-probe.sh in viewer mode first. No model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const info = JSON.parse(execFileSync('docker', ['inspect', 'browserpane-pipeline-viewer'], { encoding: 'utf8' }))[0];
assert.equal(info.Config.Labels?.['browserpane.test'], 'pipeline');
assert(info.Config.Env.includes('BPANE_PIPELINE_TEST=1'));
assert.equal(info.State.Running, true);
assert.deepEqual(info.Mounts, [], 'No persistent volumes or host mounts in the demo');
for (const entries of Object.values(info.HostConfig.PortBindings ?? {})) {
  for (const binding of entries ?? []) assert.equal(binding.HostIp, '127.0.0.1');
}
assert(info.HostConfig.PortBindings['8090/tcp'].some(value => value.HostPort === '18090'));
const id = info.Id;
function docker(args, input) {
  return execFileSync('docker', args, { input, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
}
const html = await readFile(`${root}docs/demo/index.html`, 'utf8');
const serving = `require('node:http').createServer((req,res)=>{
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
 res.end(${JSON.stringify(html)});
}).listen(8765,'127.0.0.1');`;
// This server exists only for the lifetime of the owned disposable container.
docker(['exec', '-d', id, 'node', '-e', serving]);
const mcp = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
assert.equal(process.env.BPANE_PIPELINE_TEST,'1');
const require=createRequire('/app/package.json');
const {Client,StreamableHTTPClientTransport}=require('playwright-core/lib/mcpBundle');
const client=new Client({name:'public-demo-capture',version:'1.0'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'));
try {
 await client.connect(transport);
 const result=await client.callTool({name:'browser_run_code',arguments:{code:process.env.BPANE_DEMO_CODE}});
 assert(!result.isError,'Demo MCP operation failed');
} finally {await transport.terminateSession().catch(()=>{});await client.close();}
`;
function call(code) { docker(['exec', '-i', '-e', `BPANE_DEMO_CODE=${code}`, id, 'node', '--input-type=module', '-'], mcp); }
const url = 'http://127.0.0.1:8765/';
let browser;
try {
  call(`async(page)=>{const target=await page.context().newPage();await target.goto('${url}');
    await target.locator('#handoff').fill('Ready for your review · edited through MCP');
    await target.locator('h1').click();await target.bringToFront();}`);
  browser = await chromium.launch({ headless: true,
    args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
    ...(process.env.BPANE_TEST_BROWSER_PATH ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH }
      : { channel: process.env.BPANE_TEST_BROWSER_CHANNEL || 'chrome' }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://localhost:18090/browser/');
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.startsWith('Connected')
    && window.browserpaneSession?.getTileCacheStats().zstdDecodes > 0, undefined, { timeout: 45000 });
  await page.selectOption('#resolution', '1280x720');
  await page.selectOption('#density', '1');
  await page.waitForFunction(() => document.querySelector('#screen canvas')?.width === 1280
    && document.querySelector('#screen canvas')?.height === 720, undefined, { timeout: 20000 });
  await page.mouse.move(1410, 890);
  await page.waitForTimeout(2500); // settle the real transport before freezing pixels
  assert.deepEqual(errors, []);
  await mkdir(`${root}docs/images`, { recursive: true });
  await page.screenshot({ path: `${root}docs/images/shared-session.png` });
  await mkdir(`${root}test-results`, { recursive: true });
  await writeFile(`${root}test-results/demo-capture.json`, JSON.stringify({
    image: info.Image, container: id, realWebTransportViewer: true,
    fixture: 'docs/demo/index.html', editedThroughMcp: true, paidModelCalls: 0,
    viewer: { width: 1440, height: 920 }, capture: { width: 1280, height: 720 },
  }, null, 2) + '\n');
  console.log('Captured docs/images/shared-session.png from the real streamed demo.');
} finally {
  await browser?.close();
  call(`async(page)=>{for(const target of page.context().pages())if(target.url()==='${url}')await target.close();}`);
}

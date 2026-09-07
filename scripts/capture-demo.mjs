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
assert(!info.Config.Env.some(value => value.startsWith('BPANE_MCP_MODE=') && value !== 'BPANE_MCP_MODE=compact'),
  'The public demo qualifies compact MCP, not the optional legacy toolset');
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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
assert.equal(process.env.BPANE_PIPELINE_TEST,'1');
const client=new Client({name:'public-demo-capture',version:'1.0'});
const transport=new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'));
async function call(name,args={}) {
 const result=await client.callTool({name,arguments:args});
 assert(!result.isError,JSON.stringify(result));
 return JSON.parse(result.content.find(part=>part.type==='text').text);
}
try {
 await client.connect(transport);
 assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name).sort(),['pane_act','pane_flow','pane_image','pane_read','pane_tabs','pane_view']);
 const initial=await call('pane_tabs');
 if(process.env.BPANE_DEMO_STAGE==='setup') {
  const opened=await call('pane_act',{lease:initial.lease,request:1,steps:[{op:'new',url:'http://127.0.0.1:8765/'}],observe:'full'});
  assert.equal(opened.completed,1);
  const view=await call('pane_view',{tab:opened.tab});
  const ref=(role,name)=>{
   const line=view.text.split('\\n').filter(line=>line.trimStart().startsWith('- '+role+' '+JSON.stringify(name)+' ['));
   assert.equal(line.length,1);const value=line[0].match(/\\[ref=([a-zA-Z0-9]+)\\]/)?.[1];assert(value);return value;
  };
  const edited=await call('pane_act',{lease:initial.lease,request:2,tab:opened.tab,view:view.view,observe:'none',steps:[
   {op:'fill',ref:ref('textbox','Handoff note'),text:'Ready for your review · edited through MCP'},
   {op:'click',ref:ref('heading','One browser. Shared control.')},{op:'activate'}]});
  assert.equal(edited.completed,3);
 } else {
  assert.equal(process.env.BPANE_DEMO_STAGE,'cleanup');let request=0;
  for(const tab of initial.tabs.filter(tab=>tab.url==='http://127.0.0.1:8765/')) {
   const view=await call('pane_view',{tab:tab.tab});
   const closed=await call('pane_act',{lease:initial.lease,request:++request,tab:tab.tab,view:view.view,steps:[{op:'close'}],observe:'none'});
   assert.equal(closed.completed,1);
  }
 }
} finally {await transport.terminateSession().catch(()=>{});await client.close();}
`;
function call(stage) { docker(['exec', '-i', '-e', `BPANE_DEMO_STAGE=${stage}`, id, 'node', '--input-type=module', '-'], mcp); }
let browser;
try {
  call('setup');
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
  call('cleanup');
}

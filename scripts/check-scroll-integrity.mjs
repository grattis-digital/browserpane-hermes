import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ViewerDiagnostics } from './viewer-diagnostics.mjs';

// Deliberately fixed local-only targets with disposable storage and synthetic pages.
const containerName = 'browserpane-pipeline-viewer';
const viewerUrl = 'http://localhost:18090/browser/';
const outputDir = fileURLToPath(new URL('../test-results', import.meta.url));
const inspect = JSON.parse(execFileSync('docker', ['inspect', containerName], { encoding: 'utf8' }))[0];
assert.equal(inspect.Config.Labels?.['browserpane.test'], 'pipeline', 'Refusing a non-test container');
assert.equal(inspect.State.Running, true, 'Disposable viewer container must be running');
assert(inspect.Config.Env.includes('BPANE_PIPELINE_TEST=1'), 'Missing disposable runtime guard');
for (const bindings of Object.values(inspect.HostConfig.PortBindings ?? {})) {
  for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1', 'Test ports must be loopback-only');
}
assert(inspect.HostConfig.PortBindings?.['8090/tcp']?.some(binding => binding.HostPort === '18090'), 'Inspected container must own the fixed viewer port');
const containerId = inspect.Id; // Pin the inspected identity; do not follow a replacement by name.
const token = randomUUID();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await mkdir(outputDir, { recursive: true });

// Native CDP is kept inside the disposable container. Only the marked test tab
// is created/evaluated/closed. Closing this WebSocket never closes Chromium.
const remoteSource = `
import assert from 'node:assert/strict';
assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
const task = JSON.parse(process.env.BPANE_VIEWER_CHECK_TASK);
const endpoint = await fetch('http://127.0.0.1:9222/json/version').then(r => r.json());
const socket = new WebSocket(endpoint.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id); clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function call(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 12000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
let createdTarget;
try {
  const targetId = task.op === 'create' ? (await call('Target.createTarget', { url: 'about:blank' })).targetId : task.targetId;
  if (task.op === 'create') createdTarget = targetId;
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  if (task.op !== 'create') {
    const marker = await call('Runtime.evaluate', { expression:'window.__pipelineFixtureToken', returnByValue:true }, sessionId);
    assert.equal(marker.result.value, task.token, 'Refusing an unowned CDP tab');
  }
  let output;
  if (task.op === 'close') {
    output = await call('Target.closeTarget', { targetId });
  } else {
    const result = await call('Runtime.evaluate', { expression:task.expression, returnByValue:true, awaitPromise:true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    output = task.op === 'create' ? { targetId, result: result.result.value } : result.result.value;
    await call('Page.bringToFront', {}, sessionId);
  }
  process.stdout.write(JSON.stringify(output));
} catch (error) {
  if (createdTarget) await call('Target.closeTarget', { targetId:createdTarget }).catch(() => {});
  throw error;
} finally { socket.close(); }
`;
let targetId;
function remote(op, fn) {
  const task = { op, targetId, token, expression: fn ? `(${fn.toString()})(${JSON.stringify(token)})` : undefined };
  const output = execFileSync('docker', [
    'exec', '-i', '-e', `BPANE_VIEWER_CHECK_TASK=${JSON.stringify(task)}`,
    containerId, 'node', '--input-type=module', '-',
  ], { input: remoteSource, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(output);
}


const label = process.argv[2] ?? 'scroll-integrity';
assert(/^[a-z0-9-]{1,60}$/.test(label), 'Expected a short result label');
assert.equal(inspect.Mounts.length, 0, 'No persistent data may be mounted');
let browser, page;
const diagnostics = new ViewerDiagnostics();
const checkpoints = [], pageErrors = [], downloads = [];
const report = {
  label, image: inspect.Image, containerId, date: new Date().toISOString(),
  harnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  scope: 'Disposable CPU/X11 host and local Chrome viewer; exact RGBA against direct X11 capture, not a latency benchmark',
  checkpoints, pageErrors, downloads,
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function viewerPixels() {
  return page.evaluate(async () => {
    const session = window.browserpaneSession;
    await session.tileCompositor.tileBatchSequencer.flush();
    const canvas = document.querySelector('#screen canvas'), { width, height } = canvas;
    const gl = canvas.getContext('webgl2');
    let pixels;
    if (gl) {
      const bottomUp = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
      pixels = new Uint8Array(bottomUp.length);
      for (let y = 0; y < height; y++) pixels.set(bottomUp.subarray((height-y-1)*width*4, (height-y)*width*4), y*width*4);
    } else pixels = canvas.getContext('2d').getImageData(0,0,width,height).data;
    let binary = '';
    for (let i=0; i<pixels.length; i+=32768) binary += String.fromCharCode(...pixels.subarray(i,i+32768));
    return { width, height, data:btoa(binary), cache:session.getTileCacheStats(), sessionStats:session.getSessionStats(),blits:window.__scrollOracleBlits,
      grid:session.tileCompositor.getGridConfig(), render:session.getRenderDiagnostics() };
  });
}
function x11Pixels(width, height) {
  assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 4096 && height <= 2160);
  const pixels = execFileSync('docker', ['exec', containerId, 'ffmpeg',
    '-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0',
    '-video_size', width+'x'+height, '-i', ':99+0,0', '-frames:v', '1',
    '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
  ], { timeout:15000, maxBuffer:64*1024*1024 });
  assert.equal(pixels.length,width*height*4,'Unexpected X11 framebuffer length');
  return pixels;
}
function x11Size() {
  const output=execFileSync('docker',['exec',containerId,'xrandr','--current'],{encoding:'utf8',timeout:15000});
  const match=output.match(/\bcurrent\s+(\d+)\s+x\s+(\d+)\b/);
  assert(match,'X11 did not report its current physical dimensions');
  return {width:Number(match[1]),height:Number(match[2])};
}
function compare(expected, actual, width, height) {
  assert.equal(actual.length, expected.length);
  let pixels=0, minX=width, minY=height, maxX=-1, maxY=-1;
  const tiles=new Set(), examples=[];
  for(let i=0;i<expected.length;i+=4) {
    if(expected[i]===actual[i] && expected[i+1]===actual[i+1] && expected[i+2]===actual[i+2] && expected[i+3]===actual[i+3]) continue;
    const x=(i/4)%width,y=Math.floor(i/4/width);
    pixels++; minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
    tiles.add(Math.floor(x/64)+','+Math.floor(y/64));
    if(examples.length<8) examples.push({x,y,expected:[...expected.subarray(i,i+4)],actual:[...actual.subarray(i,i+4)]});
  }
  return { pixels, tiles:[...tiles], bounds:pixels?{minX,minY,maxX,maxY}:null, examples, expectedHash:hash(expected),actualHash:hash(actual) };
}
async function checkpoint(name) {
  await delay(450);
  let last;
  for(let attempt=0;attempt<4;attempt++) {
    const first=await viewerPixels();
    const displayBefore=x11Size();
    const reference=x11Pixels(first.width,first.height);
    const second=await viewerPixels();
    const referenceAfter=x11Pixels(first.width,first.height);
    const displayAfter=x11Size();
    if(first.width!==second.width || first.height!==second.height || !reference.equals(referenceAfter)
      || displayBefore.width!==displayAfter.width || displayBefore.height!==displayAfter.height) {
      await delay(200); continue; // Reject moving truth, never compare unrelated frames.
    }
    last={name,width:first.width,height:first.height,...compare(reference,Buffer.from(second.data,'base64'),first.width,first.height),
      physicalDisplay:displayAfter,geometryMatches:first.width===displayAfter.width&&first.height===displayAfter.height,
      cache:second.cache,grid:second.grid,blits:second.blits,transfer:second.sessionStats.transfer,scrollHealth:second.sessionStats.tiles.scrollHealth};
    if(last.pixels===0&&last.geometryMatches) break;
    await delay(250);
  }
  assert(last,'X11 reference did not settle at '+name);
  last.document = remote('eval',()=>({x:scrollX,y:scrollY,scrollHeight:document.documentElement.scrollHeight,innerHeight,nestedY:document.querySelector('#nested')?.scrollTop??null}));
  checkpoints.push(last);
  console.log(JSON.stringify({stage:name,mismatchedPixels:last.pixels,tiles:last.tiles.length,geometryMatches:last.geometryMatches,scrollCopies:last.cache.scrollCopies,cacheHits:last.cache.hits,batches:last.cache.batchesQueued,document:last.document}));
  if(last.pixels) await page.screenshot({path:outputDir+'/'+label+'-'+name+'.png'});
  return last;
}
try {
  targetId=remote('create',fixtureToken=>{
    window.__pipelineFixtureToken=fixtureToken;
    document.title='DISPOSABLE exact scroll pixel oracle';
    const style=document.createElement('style');
    style.textContent='*{box-sizing:border-box}html{scroll-behavior:auto}body{margin:0;background:#eee;font:17px monospace}section{height:61px;display:flex;width:1664px}section>div{flex:0 0 104px;border:1px solid #161d29;padding:8px 4px;color:#111}#fixed{position:fixed;left:0;top:0;right:0;height:35px;background:#ff269f;z-index:20;color:#121212}#footer{position:fixed;bottom:0;left:0;right:0;height:27px;background:#182838;color:white;z-index:20}.sticky{position:sticky;top:35px;height:29px;background:#d5ec21;color:#121212;z-index:10}#nested{position:fixed;right:15px;bottom:45px;width:277px;height:181px;overflow:auto;border:3px solid #123;background:white;z-index:22}#nested>div{width:600px;height:49px;white-space:nowrap;border-bottom:1px solid #121212}';
    document.head.append(style);
    const fixed=document.createElement('div');fixed.id='fixed';fixed.textContent='FIXED 35px HEADER · exact pixels · boundary oracle';document.body.append(fixed);
    for(let n=0;n<150;n++){
      if(n%15===0){const sticky=document.createElement('div');sticky.className='sticky';sticky.textContent='Sticky group '+n;document.body.append(sticky);}
      const row=document.createElement('section');
      for(let col=0;col<16;col++){const cell=document.createElement('div');cell.style.background='rgb('+(110+(n*17+col*23)%140)+','+(110+(n*31+col*11)%140)+','+(110+(n*7+col*37)%140)+')';cell.textContent=n+':'+col+' #'+((n*113+col*97)%997);row.append(cell);}document.body.append(row);
    }
    const footer=document.createElement('div');footer.id='footer';footer.textContent='FIXED FOOTER · should never scroll into content';document.body.append(footer);
    const nested=document.createElement('div');nested.id='nested';
    for(let n=0;n<70;n++){const row=document.createElement('div');row.textContent='NESTED '+n+' '+('independent scroll bounds '.repeat(3));row.style.background=n%2?'#c1edff':'#fbd4b3';nested.append(row);}document.body.append(nested);
    document.activeElement?.blur();
    return true;
  }).targetId;
  browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1'],
    ...(process.env.BPANE_TEST_BROWSER_PATH ? { executablePath:process.env.BPANE_TEST_BROWSER_PATH }
      : {channel:process.env.BPANE_TEST_BROWSER_CHANNEL||'chrome'})});
  report.viewerVersion=browser.version();
  page=await browser.newPage({viewport:{width:1280,height:771},deviceScaleFactor:2});
  await diagnostics.observe(page, 'primary');
  await page.addInitScript(()=>{
    window.__scrollOracleBlits=0;
    const original=WebGL2RenderingContext.prototype.blitFramebuffer;
    WebGL2RenderingContext.prototype.blitFramebuffer=function(...args){
      if(args[0]!==args[2]&&args[1]!==args[3]&&args[4]!==args[6]&&args[5]!==args[7]) window.__scrollOracleBlits++;
      return original.apply(this,args);
    };
  });
  page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('download',download=>{downloads.push(download.suggestedFilename());void download.cancel();});
  await page.goto(viewerUrl);
  await page.waitForFunction(()=>window.browserpaneSession?.getTileCacheStats().zstdDecodes>0,{},{timeout:45000});
  await checkpoint('initial');
  // Non-tile-aligned scroll steps, pauses, exposed strips, direction reversals.
  await page.mouse.move(600,400);
  for(const [name,steps,pause] of [
    ['irregular-down',[17,31,65,127,9,63,129],95],
    ['fast-reversal',[191,-83,7,133,-257,61,-17,239,-29],18],
    // Headless Chrome's CDP wheel deltas are halved at this viewer's DPR 2.
    // Include enough negative movement to cross the client's 60px accumulator
    // threshold; tiny events alone can legitimately remain pending.
    ['small-up',[-1,-3,-9,-17,-31,-65,-129,-193],80],
  ]) {
    for(const dy of steps){await page.mouse.wheel(0,dy);await delay(pause);}
    await checkpoint(name);
  }
  remote('eval',()=>{window.scrollTo(0,1376);return true;});
  await checkpoint('half-tile-offset');
  remote('eval',()=>{window.scrollTo(113,1911);return true;});
  await checkpoint('horizontal-and-vertical');
  // Independent nested scroller must not be mistaken for full viewport motion.
  remote('eval',()=>{const n=document.querySelector('#nested');n.scrollTop=173;n.scrollLeft=87;return true;});
  await checkpoint('nested-scroll');
  remote('eval',()=>{document.querySelector('#nested').remove();window.scrollTo(0,0);return true;});
  await checkpoint('occluder-removal');
  remote('eval',async()=>{
    document.querySelector('#fixed').style.display='none';
    document.querySelector('#footer').style.display='none';
    document.querySelectorAll('.sticky').forEach(node=>node.remove());
    document.querySelectorAll('section').forEach(row=>{row.style.height='64px';});
    await new Promise(resolve=>setTimeout(resolve,350));
    return true;
  });
  await checkpoint('simple-list-ready');
  remote('eval',async()=>{
    for(let n=0;n<16;n++){window.scrollBy(0,32);await new Promise(resolve=>setTimeout(resolve,100));}
    return true;
  });
  await checkpoint('half-tile-list-scroll');
  remote('eval',async()=>{
    for(let n=0;n<16;n++){window.scrollBy(0,64);await new Promise(resolve=>setTimeout(resolve,100));}
    return true;
  });
  await checkpoint('retained-list-scroll');
  // Lose actual decoded entries, then continue scrolling. A repair must converge
  // without an extra user scroll and without following deltas copying a hole.
  await page.evaluate(()=>{
    window.__scrollCacheLossCompositor=window.browserpaneSession.tileCompositor;
    window.__scrollCacheLossBefore=window.__scrollCacheLossCompositor.stats.cacheMisses;
    window.__scrollCacheLossCompositor.getCache().clear();
  });
  remote('eval',async()=>{
    for(const dy of [64,64,-32,64,-96,32]){window.scrollBy(0,dy);await new Promise(resolve=>setTimeout(resolve,45));}
    return true;
  });
  await checkpoint('cache-loss-during-scroll');
  report.cacheLoss=await page.evaluate(()=>({misses:window.__scrollCacheLossCompositor.stats.cacheMisses-window.__scrollCacheLossBefore}));
  assert(report.cacheLoss.misses>0,'Cache loss did not exercise an actual missing decoded tile');
  // Inject one local decoder failure into an actual received tile. QUIC does
  // not corrupt payloads: this is a recovery fault test, not a network claim.
  await page.evaluate(()=>{
    const compositor=window.browserpaneSession.tileCompositor, original=compositor.processCommand;
    window.__scrollFaultCompositor=compositor;
    window.__scrollFaultBefore=compositor.stats.cacheMisses;
    window.__scrollFaultSession=window.browserpaneSession;
    window.__scrollInjectedFailure=null;
    compositor.processCommand=function(command){
      if(command.type==='zstd'||command.type==='qoi'){
        compositor.processCommand=original;
        window.__scrollInjectedFailure={type:command.type,col:command.col,row:command.row};
        return original.call(this,{...command,hash:0n,data:new Uint8Array([0])});
      }
      return original.call(this,command);
    };
  });
  remote('eval',()=>{
    document.querySelector('#fixed').style.display='block';
    document.querySelector('#fixed').style.background='repeating-linear-gradient(90deg,#00ffd5 0 3px,#521755 3px 7px)';
    document.querySelector('#fixed').textContent='New pixels must repair without scrolling again';
    return true;
  });
  await page.waitForFunction(()=>window.__scrollInjectedFailure!==null,{},{timeout:10000});
  report.decoderFault=await page.evaluate(()=>window.__scrollInjectedFailure);
  await checkpoint('decoder-failure-idle-repair');
  report.decoderRecovery=await page.evaluate(()=>({misses:window.__scrollFaultCompositor.stats.cacheMisses-window.__scrollFaultBefore,sameSession:window.__scrollFaultSession===window.browserpaneSession,awaitingSnapshot:Boolean(window.__scrollFaultCompositor.awaitingSnapshot)}));
  assert(report.decoderRecovery.misses>0,'Injected payload never exercised the decoder failure path');
  await page.setViewportSize({width:1360,height:819});
  await checkpoint('resize-edge-tiles');
  remote('eval',()=>{window.scrollTo(0,2017);return true;});
  await checkpoint('resized-offset');
  await page.evaluate(()=>{window.__oldScrollSession=window.browserpaneSession;});
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await page.waitForFunction(()=>window.browserpaneSession!==window.__oldScrollSession&&window.browserpaneSession?.getTileCacheStats().zstdDecodes>0,{},{timeout:45000});
  await checkpoint('reconnect-at-offset');
  assert.equal(downloads.length,0);
  assert.equal(pageErrors.length,0);
  assert(checkpoints.some(c=>c.cache.scrollCopies>0),'No real scroll-copy commands observed');
  assert(checkpoints.some(c=>c.cache.hits>0),'No real content-cache reuse observed');
  const beforeRetained=checkpoints.find(c=>c.name==='half-tile-list-scroll'),afterRetained=checkpoints.find(c=>c.name==='retained-list-scroll');
  assert(afterRetained.cache.scrollCopies-beforeRetained.cache.scrollCopies>=8,'Insufficient retained-scroll stress coverage');
  assert(afterRetained.blits-beforeRetained.blits>=16,'Retained copies did not issue real nonempty GPU blits');
  assert(checkpoints.find(c=>c.name==='irregular-down').document.y>0,'Viewer wheel input did not move the document');
  const beforeUp=checkpoints.find(c=>c.name==='fast-reversal'),afterUp=checkpoints.find(c=>c.name==='small-up');
  assert(afterUp.document.y<beforeUp.document.y,'Upward wheel input never moved the document upward');
  assert(afterUp.transfer.txByChannel.input.frames>beforeUp.transfer.txByChannel.input.frames,'Upward wheel stage sent no input');
  assert(checkpoints.find(c=>c.name==='horizontal-and-vertical').document.x>0,'Horizontal offset was not exercised');
  assert(checkpoints.find(c=>c.name==='nested-scroll').document.nestedY>0,'Nested scroller never moved');
  report.passed=checkpoints.every(c=>c.pixels===0&&c.geometryMatches);
  if(!report.passed) process.exitCode=1;
} catch(error) {
  report.passed=false;report.error=error.stack??String(error);process.exitCode=1;console.error(error);
  if (page && !page.isClosed()) report.connectionDiagnostics = await diagnostics.snapshot(page);
} finally {
  await writeFile(outputDir+'/'+label+'.json',JSON.stringify(report,null,2)+'\n');
  if(targetId) try{remote('close');}catch(error){console.error('Owned fixture cleanup failed:',error.message);process.exitCode=1;}
  await browser?.close();
}

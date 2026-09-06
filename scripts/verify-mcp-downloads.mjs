// Run inside the disposable check container. Uses only a newly created test tab.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1', 'Use only scripts/test-runtime.mjs');
assert.match(process.env.BPANE_RUNTIME_TEST_ID ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const endpoint = 'http://127.0.0.1:8931/mcp';
// Reuse the SDK bundled with the pinned runtime, including heartbeat handling.
const require = createRequire(join(process.cwd(), 'package.json'));
const { Client, StreamableHTTPClientTransport } = require('playwright-core/lib/mcpBundle');
const client = new Client({ name: 'download-isolation-check', version: '1.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));
async function run(code) {
  const result = await client.callTool({ name: 'browser_run_code', arguments: { code } });
  assert(!result.isError, JSON.stringify(result));
  return result;
}
const marker = `browserpane-download-check-${randomUUID()}`;
const downloads = '/shared/downloads';
const artifacts = '/shared/mcp-artifacts';
async function inventory() {
  return Object.fromEntries(await Promise.all((await readdir(downloads)).map(async name => {
    const info = await stat(join(downloads, name));
    return [name, [info.size, info.mtimeMs]];
  })));
}
async function until(check, message) {
  const deadline = Date.now() + 10000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(message);
}
const findPage = `const target = page.context().pages().find(p => p.url() === ${JSON.stringify('about:blank#' + marker)}); if (!target) throw Error('Own test page missing');`;
let created = false;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert(tools.tools.some(tool => tool.name === 'browser_run_code'));
  await run(`async (page) => {
    const target = await page.context().newPage();
    await target.goto(${JSON.stringify('about:blank#' + marker)});
    await target.setContent('<title>Temporary download isolation check</title><h1>Download isolation check</h1><div style="height:3000px"></div>');
    return { dpr: await target.evaluate(() => devicePixelRatio) };
  }`);
  created = true;
  const before = await inventory();
  await run(`async (page) => { ${findPage}
    await target.evaluate(marker => {
      window.addEventListener('scroll', () => console.error(marker + ': scroll video error'));
      for (let i = 0; i < 20; i++) console.error(marker + ': missing video ' + i);
      scrollTo(0, 2000);
    }, ${JSON.stringify(marker)});
    await target.evaluate(() => scrollTo(0, 0));
  }`);
  await until(async () => {
    for (const name of await readdir(artifacts).catch(() => [])) {
      if (name.startsWith('console-') && (await readFile(join(artifacts, name), 'utf8')).includes(marker)) return true;
    }
    return false;
  }, 'Console errors were not recorded in the diagnostic directory');
  assert.deepEqual(await inventory(), before, 'Console errors changed the watched download folder');

  // A genuine .log download must still work; do not filter by filename extension.
  const filename = marker + '.log';
  await run(`async (page) => { ${findPage}
    const downloaded = target.waitForEvent('download');
    await target.evaluate(({ name, text }) => {
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      anchor.download = name; anchor.click();
      setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }, { name: ${JSON.stringify(filename)}, text: ${JSON.stringify(marker)} });
    const result = await downloaded;
    const failure = await result.failure();
    if (failure) throw Error('Test browser download failed: ' + failure);
  }`);
  await until(async () => (await readFile(join(downloads, filename), 'utf8').catch(() => '')) === marker,
    'Real browser download was not forwarded');
  const after = await inventory();
  delete after[filename];
  assert.deepEqual(after, before, 'Unexpected additional downloaded files');
  console.log(JSON.stringify({ mcpTools: tools.tools.length, consoleIsolation: 'passed', scrollTop: 'passed', genuineLogDownload: 'passed', testFilename: filename }));
} finally {
  if (created) await run(`async (page) => { ${findPage} await target.close(); }`).catch(console.error);
  await transport.terminateSession().catch(() => {});
  await client.close();
}

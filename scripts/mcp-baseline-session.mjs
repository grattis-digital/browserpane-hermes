import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Owns a fresh browser/profile and the actual pinned MCP CLI; accepts no existing endpoints. */
export class McpBaselineSession {
  #temporary;
  #temporaryReal;
  #context;
  #child;
  #transport;
  #client;
  #metadata;
  #blockedRequests = [];
  #errors = [];
  static async deadline(operation, milliseconds = 3000) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned MCP cleanup operation exceeded deadline')), milliseconds);
      })]);
    } finally { clearTimeout(timer); }
  }
  async start(fixture, { engine = 'playwright' } = {}) {
    assert(['playwright', 'compact'].includes(engine));
    const require = createRequire(import.meta.url);
    assert.equal(require('@playwright/mcp/package.json').version, '0.0.68', 'Requalify the benchmark when updating MCP');
    const sdk = JSON.parse(await readFile(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8')).version;
    assert.equal(sdk, '1.30.0', 'Requalify the benchmark when updating the MCP client SDK');
    this.#temporary = await mkdtemp(join(tmpdir(), 'bpane-mcp-baseline-'));
    this.#temporaryReal = await realpath(this.#temporary);
    const profile = join(this.#temporary, 'profile'), output = join(this.#temporary, 'artifacts');
    await mkdir(output);
    const args = ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-background-networking'];
    this.#context = await chromium.launchPersistentContext(profile, { executablePath: chromium.executablePath(),
      headless: true, chromiumSandbox: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      serviceWorkers: 'block', handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false, args, timeout: 20000 });
    const version = this.#context.browser().version();
    assert.match(version, /^146\./, 'Only the installed pinned Chromium146 is qualified');
    await this.#context.route('**/*', route => {
      if (new URL(route.request().url()).origin === fixture.origin()) return route.continue();
      this.#blockedRequests.push(route.request().url()); return route.abort('blockedbyclient');
    });
    this.#context.on('page', page => page.on('pageerror', error => this.#errors.push(error.message)));
    for (const page of this.#context.pages()) page.on('pageerror', error => this.#errors.push(error.message));
    const [rawPort] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n');
    assert.match(rawPort, /^\d+$/); const port = Number(rawPort); assert(port > 0 && port <= 65535);
    const cli = join(dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
    const mcpArgs = engine === 'compact' ? [fileURLToPath(new URL('./mcp-compact-session.mjs', import.meta.url)),
      `http://127.0.0.1:${port}`, output] : [cli, '--host', '127.0.0.1', '--port', '0', '--cdp-endpoint', `http://127.0.0.1:${port}`,
      '--shared-browser-context', '--caps', 'vision,pdf', '--codegen', 'none', '--output-dir', output,
      '--allowed-origins', fixture.origin(), '--block-service-workers'];
    this.#child = spawn(process.execPath, mcpArgs, { cwd: this.#temporary, stdio: ['ignore', 'ignore', 'pipe'],
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    const endpoint = await this.#waitForEndpoint();
    this.#client = new Client({ name: 'isolated-mcp-baseline', version: '1.0.0' });
    this.#transport = new StreamableHTTPClientTransport(new URL(endpoint + '/mcp'));
    const started = performance.now(); await this.#client.connect(this.#transport, { timeout: 10000 });
    this.#metadata = { chromium: version, playwright: require('playwright/package.json').version,
      clientSdk: sdk, transport: 'Separate owned MCP child / StreamableHTTP / CDP, loopback only', engine,
      browser: { headless: true, sandbox: true, viewport: { width: 1280, height: 720 }, dpr: 1, extraArgs: args,
        shutdownOwner: 'Benchmark AbortController; Playwright automatic process-exit signal handlers disabled' },
      mcp: engine === 'playwright' ? { version: '0.0.68', sharedBrowserContext: true, capabilities: ['vision', 'pdf'], codegen: 'none',
        snapshotMode: 'incremental (default)', initPageDownloadHook: false } : { implementation: 'server/compact', sharedBrowserContext: true,
        snapshotMode: 'bounded full/delta, paginated for equal-information observations', downloadEventHook: true },
      connectMs: performance.now() - started, freshProfile: true };
  }
  #waitForEndpoint() {
    const child = this.#child;
    return new Promise((resolve, reject) => {
      let output = '';
      const finish = (error, endpoint) => {
        clearTimeout(timer); child.stderr.off('data', read); child.off('error', fail); child.off('exit', exited);
        if (error) reject(error); else resolve(endpoint);
      };
      const fail = error => finish(error), exited = code => finish(new Error(`MCP exited before readiness: ${code}`));
      const read = chunk => {
        output = (output + chunk).slice(-8192);
        const match = output.match(/Listening on (http:\/\/(?:localhost|127\.0\.0\.1):\d+)/);
        if (match) finish(null, match[1]);
      };
      const timer = setTimeout(() => finish(new Error('Owned MCP endpoint did not start within10s')), 10000);
      child.stderr.on('data', read); child.once('error', fail); child.once('exit', exited);
    });
  }
  client() { assert(this.#client); assert.equal(this.#child.exitCode, null, 'Owned MCP process exited'); return this.#client; }
  metadata() { return this.#metadata; }
  async page(fixture, kind) {
    const pages = this.#context.pages().filter(page => page.url() === fixture.url(kind));
    assert.equal(pages.length, 1, 'Exactly one owned fixture page must exist'); return pages[0];
  }
  assertHealthy() { assert.deepEqual(this.#blockedRequests, [], 'Unexpected browser network request'); assert.deepEqual(this.#errors, []); }
  async close() {
    const failures = [];
    const attempt = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    await attempt(() => McpBaselineSession.deadline(async () => { if (this.#transport?.sessionId) await this.#transport.terminateSession(); }));
    await attempt(() => McpBaselineSession.deadline(async () => { await this.#client?.close(); }));
    await attempt(async () => {
      if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) return;
      const exited = once(this.#child, 'exit'); this.#child.kill('SIGTERM');
      const timer = setTimeout(() => this.#child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    });
    await attempt(async () => { await this.#context?.close(); });
    await attempt(async () => {
      if (!this.#temporary) return;
      assert(basename(this.#temporary).startsWith('bpane-mcp-baseline-'));
      assert.equal(await realpath(this.#temporary), this.#temporaryReal);
      await rm(this.#temporary, { recursive: true }); this.#temporary = undefined;
    });
    if (failures.length) throw new AggregateError(failures, 'Owned MCP benchmark cleanup failed');
  }
}

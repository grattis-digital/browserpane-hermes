import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpBaselineSession } from './mcp-baseline-session.mjs';

/** A real click completes input immediately but its navigation takes >3 seconds. */
class ClickCompletionFixture {
  #token = randomUUID(); #server; #origin; #timers = new Set();
  requests = 0; forbidden = 0;
  origin() { return this.#origin; }
  url(kind) { assert(['report', 'complete'].includes(kind)); return `${this.#origin}/${this.#token}/${kind}`; }
  async start() {
    this.#server = createServer((request, response) => {
      if (request.url === `/${this.#token}/report`) {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        response.end(`<h1>Click completion fixture</h1><a href="/${this.#token}/complete">Continue</a>
          <button onclick="fetch('/${this.#token}/forbidden')">Must not click</button>`);
      } else if (request.url === `/${this.#token}/complete`) {
        this.requests++;
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Completion confirmed</h1>');
        }, 3600);
        this.#timers.add(timer);
      } else {
        if (request.url === `/${this.#token}/forbidden`) this.forbidden++;
        response.writeHead(404).end();
      }
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', resolve);
    });
    this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
  }
  async close() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#server?.closeAllConnections();
    if (this.#server) await new Promise(resolve => this.#server.close(resolve));
  }
}

async function main() {
  const fixture = new ClickCompletionFixture(), session = new McpBaselineSession();
  try {
    await fixture.start(); await session.start(fixture, { engine: 'compact' });
    await session.initialPage().goto(fixture.url('report'));
    const call = async (name, args = {}) => {
      const reply = await session.client().callTool({ name, arguments: args }, undefined, { timeout: 15000 });
      return JSON.parse(reply.content[0].text);
    };
    const view = await call('pane_view');
    const ref = name => {
      const line = view.text.split('\n').find(line => line.includes(`"${name}"`));
      const value = line?.match(/\[ref=([^\]]+)\]/)?.[1]; assert(value); return value;
    };
    const args = { lease: view.lease, tab: view.tab, view: view.view, request: 1, observe: 'none',
      steps: [{ op: 'click', ref: ref('Continue') }, { op: 'click', ref: ref('Must not click') }] };
    const result = await call('pane_act', args);
    assert.equal(result.completed, 1, JSON.stringify(result));
    assert.equal(result.stopped, 'navigation'); assert(!result.error);
    assert.equal(fixture.requests, 1); assert.equal(fixture.forbidden, 0);
    assert.equal(session.initialPage().url(), fixture.url('complete'));
    assert.deepEqual(await call('pane_act', args), result);
    assert.equal(fixture.requests, 1); assert.equal(fixture.forbidden, 0);
    session.assertHealthy();
    console.log(JSON.stringify({ passed: true, delayedCompletionMs: 3600, requests: 1, laterInputs: 0, replayedInputs: 0 }));
  } finally { await session.close(); await fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

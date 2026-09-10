import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Fixed owned-fixture diagnostic, not a workflow runner or a latency benchmark. */
export class PilotStress {
  #token = process.env.BPANE_WORKFLOW_PILOT;
  #client; #transport; #page; #request = 0; #completed = 0; #failed = false;
  #files = new Set();

  #url(path) { return `http://127.0.0.1:9130/${this.#token}/${path}`; }

  async #control(body) {
    const response = await fetch(this.#url('control'), { signal: AbortSignal.timeout(3000),
      headers: { 'X-Pilot': this.#token, 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    assert(response.ok); return response.json();
  }

  async #call(name, args = {}) {
    const reply = await this.#client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    assert.equal(reply.content?.length, 1); assert.equal(reply.content[0].type, 'text');
    assert(reply.content[0].text.length <= 65536);
    const value = JSON.parse(reply.content[0].text);
    if (reply.isError || value.error) {
      const error = new Error('Owned fixture MCP action failed'); error.reply = value; throw error;
    }
    return value;
  }

  async #view() {
    const view = await this.#call('pane_view', {
      query: { role: 'heading', name: 'Workflow pilot report', exact: true }, limit: 4, maxChars: 1024 });
    assert.equal(view.url, this.#url('report')); assert.equal(view.matches, 1);
    assert(!view.dialog && !view.truncated); return view;
  }

  async #export(index) {
    assert(!this.#failed && index === this.#completed + 1 && index <= 100);
    const period = '2026-06', rows = [{ code: 'ITEM-0001', quantity: index }];
    await this.#control({ op: 'select', period, rows });
    const current = await this.#view();
    const navigation = await this.#call('pane_act', { lease: current.lease, tab: current.tab, view: current.view,
      request: ++this.#request, steps: [{ op: 'navigate', url: this.#url('report') }], observe: 'none' });
    assert.equal(navigation.completed, 1);
    const view = await this.#view();
    const flow = await this.#call('pane_flow', { lease: view.lease, tab: view.tab, view: view.view,
      request: ++this.#request, observe: 'none', stages: [{ steps: [
        { op: 'fill', target: { role: 'textbox', name: 'Reporting period', exact: true }, text: period },
        { op: 'click', target: { role: 'link', name: 'Export report', exact: true } },
      ], wait: { text: 'Report exported', timeoutMs: 5000 } }] });
    assert.equal(flow.completed, 2); assert.equal(flow.stages, 1); assert(!flow.stopped);
    await this.#view();
    const deadline = Date.now() + 5000;
    let added;
    do {
      added = (await readdir('/shared/downloads')).filter(name =>
        /^report-2026-06(?: \(\d+\))?\.csv$/.test(name) && !this.#files.has(name));
      if (added.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.equal(added.length, 1); assert.match(added[0], /^report-2026-06(?: \(\d+\))?\.csv$/);
    assert.equal(await readFile('/shared/downloads/' + added[0], 'utf8'),
      `period,code,quantity\n${period},ITEM-0001,${index}\n`);
    const state = await this.#page.evaluate(() => ({ ...window.__pilot, url: location.href }));
    assert.equal(state.token, this.#token); assert.equal(state.url, this.#url('report'));
    assert.equal(state.clicks, 1); assert.equal(state.trusted, true); assert.equal(state.period, period);
    assert.equal((await RuntimeCdp.pages()).length, 1);
    assert.equal((await this.#control()).requests, 1);
    this.#files.add(added[0]); this.#completed++;
    return { completed: this.#completed, verified: true };
  }

  async serve() {
    assert.match(this.#token ?? '', /^[0-9a-f-]{36}$/);
    assert.equal((await RuntimeCdp.pages()).length, 1);
    this.#page = (await RuntimeCdp.pageByUrl(this.#url('report'))).page;
    assert.deepEqual(await readdir('/shared/downloads'), [], 'Fresh owned artifacts required');
    this.#client = new Client({ name: 'owned-pilot-action-diagnostic', version: '1.0.0' });
    this.#transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8931/mcp'));
    try {
      await this.#client.connect(this.#transport, { timeout: 10000 });
      console.log(JSON.stringify({ ready: true }));
      for await (const line of createInterface({ input: process.stdin })) {
        assert(line.length <= 1024); const request = JSON.parse(line);
        if (request.fixture === 'close') break;
        try {
          assert.equal(request.fixture, 'export');
          console.log(JSON.stringify(await this.#export(request.index)));
        } catch (error) {
          this.#failed = true; // Never repeat failed or uncertain input, even on another command.
          console.log(JSON.stringify({ failed: true, completed: this.#completed,
            error: String(error.message).slice(0, 1000), reply: error.reply }));
        }
      }
    } finally {
      this.#page.close();
      if (this.#transport.sessionId) await this.#transport.terminateSession();
      await this.#client.close();
    }
  }
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WorkflowReportOracle } from './workflow-report-oracle.mjs';

/** Owned loopback-only report export, including deliberately misleading success cases. */
export class WorkflowReportFixture {
  #token; #server; #origin; #case; #requests = [];
  constructor(token) { assert.match(token, /^[0-9a-f-]{36}$/); this.#token = token; }
  async start() {
    this.#server = createServer((request, response) => this.#handle(request, response));
    await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', resolve); });
    this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
  }
  origin() { assert(this.#origin); return this.#origin; }
  url(kind) { assert.equal(kind, 'report'); return `${this.origin()}/${this.#token}/report`; }
  select(period, fault = 'none') {
    assert(WorkflowReportOracle.period(period));
    assert(['none', 'wrong-period', 'empty', 'wrong-schema', 'wrong-value'].includes(fault));
    this.#case = { period, fault }; this.#requests = [];
    return { period, rows: [1, 2, 3].map(index => ({ code: `ITEM-000${index}`, quantity: index * Number(period.slice(-2)) })) };
  }
  #handle(request, response) {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (request.method !== 'GET' || !this.#case) { response.writeHead(404).end(); return; }
    if (url.pathname === `/${this.#token}/report`) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'" });
      response.end(this.#html()); return;
    }
    if (url.pathname !== `/${this.#token}/export`) { response.writeHead(404).end(); return; }
    const period = url.searchParams.get('period');
    if (!WorkflowReportOracle.period(period)) { response.writeHead(400).end(); return; }
    this.#requests.push(period);
    const contentPeriod = this.#case.fault === 'wrong-period' ? '1999-12' : period;
    const header = this.#case.fault === 'wrong-schema' ? 'period,description,quantity' : 'period,code,quantity';
    const rows = [1, 2, 3].map(index => `${contentPeriod},ITEM-000${index},${index * Number(period.slice(-2)) + (this.#case.fault === 'wrong-value' ? 1 : 0)}`);
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="report-${period}.csv"` });
    response.end(this.#case.fault === 'empty' ? '' : [header, ...rows, ''].join('\n'));
  }
  #html() {
    return `<!doctype html><meta charset="utf-8"><title>Synthetic report export</title>
      <body data-fixture="${this.#token}"><h1>Report export fixture</h1>
      <label>Reporting period<input id="period" value="2000-01"></label>
      <a id="export" href="#" download="report.csv">Export report</a><p role="status" id="status">Ready</p>
      <script>window.__workflowFixture={token:${JSON.stringify(this.#token)},clicks:0,trusted:false};
      document.getElementById('export').addEventListener('click',event=>{
        const state=window.__workflowFixture;state.clicks++;state.trusted=event.isTrusted;
        state.requestedPeriod=document.getElementById('period').value;
        document.getElementById('status').textContent='Report exported';
        event.currentTarget.href=${JSON.stringify(`/${this.#token}/export?period=`)}+encodeURIComponent(state.requestedPeriod);
      });</script>`;
  }
  async evidence(page, download, csv) {
    assert.equal(page.url(), this.url('report'));
    const state = await page.evaluate(() => ({ ...window.__workflowFixture, bodyToken: document.body.dataset.fixture }));
    assert.equal(state.token, this.#token); assert.equal(state.bodyToken, this.#token);
    return { csv, completed: await download.failure() === null, filename: download.suggestedFilename(),
      requestedPeriod: state.requestedPeriod, requests: this.#requests.length, clicks: state.clicks, trusted: state.trusted };
  }
  async diagnostics(page) {
    assert.equal(page.url(), this.url('report'));
    const state = await page.evaluate(() => window.__workflowFixture);
    assert.equal(state.token, this.#token);
    return { requestedPeriod: state.requestedPeriod, serverRequests: this.#requests.length,
      clicks: state.clicks, trusted: state.trusted };
  }
  async close() {
    if (!this.#server) return;
    const server = this.#server; this.#server = undefined;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

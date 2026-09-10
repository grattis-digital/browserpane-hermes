import assert from 'node:assert/strict';
import { createServer, request as forward } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Disposable-network fixture and controlled lost/delayed-response boundary. */
export class PilotFixture {
  #token; #state = { period: '2026-01', rows: [], requests: 0, total: 0 }; #release; #held;
  constructor(token) { assert.match(token ?? '', /^[0-9a-f-]{36}$/); this.#token = token; }
  async handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1:9130');
    if (!url.pathname.startsWith(`/${this.#token}/`)) { res.writeHead(404).end(); return; }
    const path = url.pathname.slice(this.#token.length + 2);
    let body = Buffer.alloc(0);
    for await (const chunk of req) { assert(body.length + chunk.length <= 65536); body = Buffer.concat([body, chunk]); }
    if (path === 'mcp') { await this.#proxy(req, res, body); return; }
    if (path === 'control') {
      assert.equal(req.headers['x-pilot'], this.#token);
      if (req.method === 'POST') {
        const value = JSON.parse(body);
        if (value.op === 'hold') { assert(!this.#held); this.#held = new Promise(resolve => { this.#release = resolve; }); }
        else if (value.op === 'release') { this.#release?.(); this.#held = undefined; }
        else {
          assert.equal(value.op, 'select'); assert.match(value.period, /^\d{4}-(0[1-9]|1[0-2])$/);
          assert(Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 10);
          for (const row of value.rows) { assert.match(row.code, /^ITEM-\d{4}$/); assert(Number.isSafeInteger(row.quantity) && row.quantity >= 0); }
          this.#state = { period: value.period, rows: value.rows, requests: 0, total: this.#state.total };
        }
      } else assert.equal(req.method, 'GET');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.#state)); return;
    }
    assert.equal(req.method, 'GET');
    if (path === 'report') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'" });
      res.end(this.#html()); return;
    }
    if (path === 'export') {
      const period = url.searchParams.get('period'); assert.equal(period, this.#state.period);
      this.#state.requests++; this.#state.total++;
      res.writeHead(200, { 'content-type': 'text/csv', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="report-${period}.csv"` });
      res.end('period,code,quantity\n' + this.#state.rows.map(row => `${period},${row.code},${row.quantity}\n`).join('')); return;
    }
    res.writeHead(404).end();
  }
  #html() {
    return `<!doctype html><meta charset="utf-8"><title>Reviewed Pi report pilot</title>
      <h1>Workflow pilot report</h1><p>Isolated read-only report export. The browser and profile belong to this pilot.</p>
      <label>Reporting period<input id="period" value="2000-01"></label>
      <a id="export" href="#" download="report.csv">Export report</a><p id="status">Ready</p>
      <script>window.__pilot={token:${JSON.stringify(this.#token)},clicks:0,trusted:false};
      document.getElementById('export').addEventListener('click',event=>{
        const state=window.__pilot;state.clicks++;state.trusted=event.isTrusted;
        state.period=document.getElementById('period').value;document.getElementById('status').textContent='Report exported';
        event.currentTarget.href=${JSON.stringify(`/${this.#token}/export?period=`)}+encodeURIComponent(state.period);
      });</script>`;
  }
  async #proxy(req, res, body) {
    assert(['POST', 'GET', 'DELETE'].includes(req.method));
    const message = body.length ? JSON.parse(body) : {};
    const held = this.#held;
    await new Promise((resolve, reject) => {
      const upstream = forward('http://127.0.0.1:8931/mcp', { method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:8931' } }, incoming => {
        if (message.method !== 'tools/call' || message.params.name !== 'pane_flow' || !held) {
          res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
          incoming.once('end', resolve); incoming.once('error', reject); res.once('close', () => { incoming.destroy(); resolve(); }); return;
        }
        let result = Buffer.alloc(0);
        incoming.on('data', chunk => { assert(result.length + chunk.length <= 131072); result = Buffer.concat([result, chunk]); });
        incoming.once('error', reject);
        incoming.once('end', () => held.then(() => {
          res.writeHead(incoming.statusCode, incoming.headers); res.end(result); resolve();
        }, reject));
      });
      upstream.setTimeout(25000, () => upstream.destroy(new Error('Pilot proxy timeout')));
      upstream.once('error', reject); upstream.end(body);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = new PilotFixture(process.env.BPANE_WORKFLOW_PILOT);
  const server = createServer((req, res) => fixture.handle(req, res).catch(() => { res.destroy(); }));
  server.requestTimeout = 30000;
  server.listen(9130, '127.0.0.1'); // Only the owned shared namespace; never the host or production network.
}

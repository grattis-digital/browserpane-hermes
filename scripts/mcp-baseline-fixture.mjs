import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Only synthetic pages, served at an unguessable path on a newly bound loopback port. */
export class McpBaselineFixture {
  #token = randomUUID();
  #server;
  #origin;
  static tableRows = 120;
  async start() {
    this.#server = createServer((request, response) => {
      const path = request.url?.split('?')[0], page = path?.split('/')[2];
      if (request.method !== 'GET' || path !== `/${this.#token}/${page}` || !['form', 'receipt', 'table'].includes(page)) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'" });
      response.end(this.html(page));
    });
    await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', resolve); });
    this.#origin = `http://127.0.0.1:${this.#server.address().port}`;
  }
  origin() { assert(this.#origin, 'Fixture not started'); return this.#origin; }
  token() { return this.#token; }
  url(page) { assert(['form', 'receipt', 'table'].includes(page)); return `${this.origin()}/${this.#token}/${page}`; }
  html(page) {
    const head = `<!doctype html><meta charset="utf-8"><title>Synthetic MCP ${page}</title><body data-fixture="${this.#token}"><h1>Synthetic ${page}</h1>`;
    const common = `window.__mcpFixture={token:${JSON.stringify(this.#token)},page:${JSON.stringify(page)},events:[],readyWallMs:performance.timeOrigin+performance.now()};`;
    if (page === 'form') return head + `<form id="contact"><label>Full name<input id="full-name" name="fullName" required></label>
      <label>Email address<input id="email" name="email" type="email" required></label>
      <label>Plan<select id="plan" name="plan"><option>Basic</option><option>Research</option></select></label>
      <label><input id="consent" name="consent" type="checkbox" required>Accept terms</label><button type="submit">Save contact</button></form>
      <script>${common}sessionStorage.removeItem('mcp-receipt');
      for(const type of ['input','change','click','submit'])document.addEventListener(type,event=>{
        if(window.__mcpFixture.events.length<80)window.__mcpFixture.events.push({type,target:event.target.id||event.target.tagName,
          trusted:event.isTrusted,value:event.target.type==='checkbox'?event.target.checked:event.target.value,
          wallMs:performance.timeOrigin+performance.now()});
      },true);
      document.querySelector('form').addEventListener('submit',event=>{
        event.preventDefault();const receipt={fullName:document.querySelector('#full-name').value,email:document.querySelector('#email').value,
          plan:document.querySelector('#plan').value,consent:document.querySelector('#consent').checked,events:window.__mcpFixture.events};
        sessionStorage.setItem('mcp-receipt',JSON.stringify(receipt));location.assign(${JSON.stringify(`/${this.#token}/receipt`)});
      });</script>`;
    if (page === 'receipt') return head + `<dl><dt>Full name</dt><dd id="full-name"></dd><dt>Email</dt><dd id="email"></dd>
      <dt>Plan</dt><dd id="plan"></dd><dt>Consent</dt><dd id="consent"></dd></dl><p role="status">Contact saved</p>
      <script>${common}const receipt=JSON.parse(sessionStorage.getItem('mcp-receipt'));
      window.__mcpFixture.receipt=receipt;if(receipt)for(const[id,key]of[['full-name','fullName'],['email','email'],['plan','plan'],['consent','consent']])document.getElementById(id).textContent=String(receipt[key]);</script>`;
    assert.equal(page, 'table');
    return head + '<table><thead><tr><th>Code</th><th>Description</th><th>Quantity</th></tr></thead><tbody>' +
      Array.from({ length: McpBaselineFixture.tableRows }, (_, index) => `<tr><td>ROW-${String(index).padStart(3, '0')}</td><td>Synthetic inventory item ${index}</td><td>${index + 1}</td></tr>`).join('') +
      `</tbody></table><script>${common}</script>`;
  }
  async read(page, expectedPage) {
    assert.equal(page.url(), this.url(expectedPage), 'Oracle must observe this run’s exact synthetic page');
    const state = await page.evaluate(() => ({ ...window.__mcpFixture,
      bodyToken: document.body.dataset.fixture, title: document.title, rowCount: document.querySelectorAll('tbody tr').length }));
    assert.equal(state.token, this.#token); assert.equal(state.bodyToken, this.#token); assert.equal(state.page, expectedPage);
    return state;
  }
  async close() {
    if (!this.#server) return;
    const server = this.#server; this.#server = undefined;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

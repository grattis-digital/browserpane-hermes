import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { PilotFixture } from '../scripts/workflow-pilot/fixture.mjs';

const token = '00000000-0000-4000-8000-000000000001';

test('pilot fixture bounds control authority and independently counts exact CSV exports', async t => {
  assert.throws(() => new PilotFixture('invalid'));
  const fixture = new PilotFixture(token);
  const server = createServer((req, res) => fixture.handle(req, res).catch(() => res.writeHead(400).end()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const control = (body, key = token) => fetch(`${base}/${token}/control`, {
    method: 'POST', headers: { 'X-Pilot': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(`${base}/wrong/report`)).status, 404);
  assert.equal((await control({ op: 'select' }, 'wrong')).status, 400);
  assert.equal((await control({ op: 'select', period: '2026-13', rows: [] })).status, 400);
  assert.equal((await control({ op: 'select', period: '2026-01', rows: [{ code: 'arbitrary', quantity: 1 }] })).status, 400);
  assert.equal((await control({ op: 'select', period: '2026-01', rows: [{ code: 'ITEM-0001', quantity: -1 }] })).status, 400);
  assert.equal((await control({ op: 'select', period: '2026-01', rows: [{ code: 'ITEM-0001', quantity: 7 }] })).status, 200);
  const page = await fetch(`${base}/${token}/report`);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /event\.isTrusted/);
  assert.match(html, /Reporting period/);
  assert.equal((await fetch(`${base}/${token}/export?period=2026-02`)).status, 400);
  const csv = await fetch(`${base}/${token}/export?period=2026-01`);
  assert.equal(await csv.text(), 'period,code,quantity\n2026-01,ITEM-0001,7\n');
  assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="report-2026-01.csv"');
  assert.equal(csv.headers.get('cache-control'), 'no-store');
  const state = await (await fetch(`${base}/${token}/control`, { headers: { 'X-Pilot': token } })).json();
  assert.equal(state.requests, 1); assert.equal(state.total, 1);
  assert.equal((await control({ op: 'hold' })).status, 200);
  assert.equal((await control({ op: 'hold' })).status, 400);
  assert.equal((await control({ op: 'release' })).status, 200);
});

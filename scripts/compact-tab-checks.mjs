import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CompactMcpHttpServer } from '../server/compact/http-server.mjs';

/** Actual HTTP/MCP clients against only the caller-owned disposable Chromium. */
export class CompactTabChecks {
  static async run(fixture) {
    const clients = [];
    const server = new CompactMcpHttpServer({ host: '127.0.0.1', port: 0, allowedHosts: [],
      createSession: () => fixture.session().engine });
    try {
      const { port } = await server.start();
      server.allowedHosts.add(`127.0.0.1:${port}`);
      const connect = async () => {
        const client = new Client({ name: 'synthetic-tab-reuse', version: '1' });
        clients.push(client);
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        await client.connect(transport);
        assert.equal((await client.listTools()).tools.length, 5);
        return { client, transport };
      };
      const call = async (client, name, args = {}) =>
        JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
      const a = await connect(), b = await connect();
      const initial = await call(a.client, 'pane_view');
      assert(initial.view && initial.tab);
      await fixture.waitForTabs(1);
      const created = await call(a.client, 'pane_act', { lease: initial.lease, request: 1,
        steps: [{ op: 'new', url: 'about:blank' }] });
      assert.equal(created.completed, 1); assert.notEqual(created.tab, initial.tab);
      await fixture.waitForTabs(2);
      for (let request = 2; request <= 4; request++) {
        const view = await call(a.client, 'pane_view');
        assert.equal(view.tab, initial.tab);
        const navigated = await call(a.client, 'pane_act', { lease: view.lease, request, tab: view.tab, view: view.view,
          steps: [{ op: 'navigate', url: 'about:blank' }] });
        assert.equal(navigated.completed, 1); assert.equal(navigated.tab, initial.tab);
        assert.equal((await call(b.client, 'pane_view')).tab, initial.tab);
        await fixture.waitForTabs(2);
      }
      const listed = (await call(b.client, 'pane_tabs')).tabs;
      assert.deepEqual(listed.filter(tab => tab.default).map(tab => tab.tab), [initial.tab]);
      await a.transport.terminateSession();
      const replacement = await connect(), fresh = await call(replacement.client, 'pane_view');
      assert.equal(fresh.tab, initial.tab); assert.notEqual(fresh.lease, initial.lease);
      await fixture.waitForTabs(2);
      const expired = await call(replacement.client, 'pane_act', { lease: initial.lease, request: 1,
        steps: [{ op: 'new' }] });
      assert.equal(expired.error.code, 'STALE_SESSION');
      const closed = await call(replacement.client, 'pane_act', { lease: fresh.lease, request: 1,
        tab: fresh.tab, view: fresh.view, steps: [{ op: 'close' }] });
      assert.equal(closed.completed, 1); await fixture.waitForTabs(1);
      assert.equal((await call(replacement.client, 'pane_view')).tab, created.tab);
      assert.equal((await call(b.client, 'pane_view')).tab, created.tab);
      const stale = await call(replacement.client, 'pane_act', { lease: fresh.lease, request: 2,
        tab: fresh.tab, view: fresh.view, steps: [{ op: 'navigate', url: 'about:blank' }] });
      assert.equal(stale.error.code, 'UNKNOWN_TAB');
      await fixture.waitForTabs(1);
    } finally {
      await Promise.all(clients.map(client => client.close()));
      await server.close();
    }
  }
}

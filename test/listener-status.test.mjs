import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ListenerStatus } from '../server/listener-status.mjs';

const header = '  sl  local_address rem_address st\n';
const row = (port, address = '0100007F', state = '0A') =>
  ` 0: ${address}:${port.toString(16).toUpperCase()} 00000000:0000 ${state}\n`;

test('reports loopback admin/CDP and private-network MCP without sensitive metadata', () => {
  assert.deepEqual(ListenerStatus.inspect(header + row(9222) + row(8932) + row(8931, '00000000')), {
    cdpLoopback: true, adminLoopback: true, cdpProxyDisabled: true, mcpListening: true,
  });
});

test('detects public listener even alongside a private listener and ignores established sockets', () => {
  const state = ListenerStatus.inspect(header + row(9222) + row(8932) + row(8932, '00000000') +
    row(9223, '00000000') + row(8931, '00000000', '01'));
  assert.equal(state.adminLoopback, false);
  assert.equal(state.cdpProxyDisabled, false);
  assert.equal(state.mcpListening, false);
});

test('missing and IPv6 wildcard listeners cannot accidentally pass loopback assertion', () => {
  assert.equal(ListenerStatus.inspect(header).cdpLoopback, false);
  assert.equal(ListenerStatus.inspect(header + row(9222), header +
    row(9222, '00000000000000000000000000000000')).cdpLoopback, false);
});

test('runtime explicitly disables proxy and pins Chromium/admin to loopback', async () => {
  const start = await readFile('runtime/start.sh', 'utf8');
  assert.match(start, /BPANE_CDP_PROXY_ENABLE=0 BPANE_CHROMIUM_DEBUG_ADDRESS=127\.0\.0\.1/);
  assert(start.indexOf('check-settings.mjs') < start.indexOf('setsid bash'));
  const gateway = await readFile('server/gateway-process.mjs', 'utf8');
  assert.match(gateway, /'--api-bind', '127\.0\.0\.1'/);
  const mcp = await readFile('server/mcp-process.mjs', 'utf8');
  assert.match(mcp, /browserpane:8931,localhost:8931,127\.0\.0\.1:8931/);
  assert(!/172\.|192\.168\./.test(mcp));
});

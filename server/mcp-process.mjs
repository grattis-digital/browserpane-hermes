import { spawn } from 'node:child_process';
import { resolvePlaywrightMcpCommand } from '../dist/playwright-mcp-runtime.mjs';

const command = resolvePlaywrightMcpCommand('http://127.0.0.1:9222');
const child = spawn(command.command, [
  ...command.args, '--host', '0.0.0.0', '--port', '8931',
  '--allowed-hosts', 'browserpane:8931,localhost:8931,127.0.0.1:8931',
  '--shared-browser-context', '--caps', 'vision,pdf',
  // The host auto-forwards files from /shared/downloads. MCP diagnostics must
  // stay elsewhere; only genuine page download events are forwarded there.
  '--output-dir', '/shared/mcp-artifacts',
  '--init-page', '/app/server/mcp-downloads.cjs', '--codegen', 'none',
], { stdio: 'inherit', cwd: '/shared' });
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));

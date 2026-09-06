import { CompactRuntime } from './main.mjs';

// Runtime/start.sh has already verified loopback CDP readiness. No separate
// browser is launched and no operator-controlled endpoint is accepted here.
const runtime = await CompactRuntime.create();
try { await runtime.start(); }
catch (error) { await runtime.close(); throw error; }
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  try { await runtime.close(); process.exitCode = 0; }
  catch { console.error('Compact MCP shutdown failed'); process.exitCode = 1; }
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
console.log('Compact MCP v1 ready on private port 8931; Chromium is shared, not owned.');

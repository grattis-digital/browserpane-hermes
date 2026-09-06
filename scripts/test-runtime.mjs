// Creates all resources; never accepts an existing container or profile path.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DisposableRun } from './runtime-test/disposable-run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = new DisposableRun(root, process.argv[2] ?? 'browserpane-hermes:test', process.argv[3] ?? 'compact');
let interrupted = false;
const interrupt = signal => {
  if (interrupted) return;
  interrupted = true;
  try { run.cleanup(); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
};
const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
try {
  console.log('Starting disposable browser, isolated fixture and fresh profile/shared volumes');
  await run.prepare();
  await run.startBrowser('first');
  run.assertBrowser();
  console.log(run.docker(['exec', run.browserId, 'node', '/app/server/doctor.mjs']));
  const profile = await readFile(new URL('./verify-profile.mjs', import.meta.url), 'utf8');
  const downloads = await readFile(new URL('./verify-mcp-downloads.mjs', import.meta.url), 'utf8');
  const smoke = await readFile(new URL('./runtime-test/smoke.mjs', import.meta.url), 'utf8');
  const cdp = await readFile(new URL('./runtime-test/cdp.mjs', import.meta.url), 'utf8');
  const script = (source, args = []) => run.script(`${cdp}\n${source}`, args);
  console.log(script(smoke));
  console.log(script(profile, ['seed']));
  console.log(script(downloads));
  console.log(script(profile, ['verify'])); // reconnect must not replace Chromium/profile
  console.log('Restarting only this run’s browser container');
  await run.restart();
  console.log(script(profile, ['verify']));
  run.remove(run.browserId);
  console.log('Recreating browser container with only this run’s original volumes');
  await run.startBrowser('recreated');
  run.assertBrowser();
  console.log(run.docker(['exec', run.browserId, 'node', '/app/server/doctor.mjs']));
  console.log(script(profile, ['verify']));
  console.log(script(smoke));
  console.log(JSON.stringify({ image: run.image, runtime: true, mcp: true, mcpMode: run.mcpMode,
    profileAfterReconnect: true, profileAfterRestart: true, profileAfterRecreate: true,
    exactTabsAfterReconnectRestartRecreate: 2, paidModelCalls: 0 }));
} finally {
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  if (!interrupted) run.cleanup();
}

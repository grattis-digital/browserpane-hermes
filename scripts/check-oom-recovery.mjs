// Explicit destructive fault injection, restricted to fresh disposable resources.
// Never part of npm test or normal runtime tests; accepts an image, not a container.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DisposableRun } from './runtime-test/disposable-run.mjs';

assert.equal(process.argv[2], '--induce-oom', 'Explicit --induce-oom is required');
assert.equal(process.argv.length, 4, 'Usage: node scripts/check-oom-recovery.mjs --induce-oom IMAGE');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = new DisposableRun(root, process.argv[3]);
let interrupted = false;
const interrupt = signal => {
  if (interrupted) return;
  interrupted = true;
  try { run.cleanup(); } finally { process.exit(signal === 'SIGINT' ? 130 : 143); }
};
const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
try {
  const profile = await readFile(new URL('./verify-profile.mjs', import.meta.url), 'utf8');
  const cdp = await readFile(new URL('./runtime-test/cdp.mjs', import.meta.url), 'utf8');
  const downloads = await readFile(new URL('./verify-mcp-downloads.mjs', import.meta.url), 'utf8');
  const check = mode => run.script(`${cdp}\n${profile}`, [mode]);
  await run.prepare();
  await run.startBrowser('oom-proof');
  console.log(check('seed'));
  console.log(run.script(`${cdp}\n${downloads}`));
  console.log(check('verify'));
  run.assertBrowser();
  run.docker(['update', '--memory', '1g', '--memory-swap', '1g', '--restart', 'unless-stopped', run.browserId]);
  // Let Docker's restart monitor observe a successful initial startup.
  await delay(11000);
  run.assertBrowser();
  const before = run.inspect('container', run.browserId).RestartCount;
  const victim = `const fs=require('fs');fs.writeFileSync('/proc/self/oom_score_adj','1000');
    const b=[];setInterval(()=>{if(b.length>=128)process.exit(70);b.push(Buffer.alloc(16*1024*1024,7));},100);`;
  try {
    run.docker(['exec', run.browserId, 'node', '-e', victim], undefined, 45000);
    assert.fail('Expected OOM victim exit');
  } catch (error) {
    assert.equal(error.status, 137, 'Victim must be killed inside its own memory cgroup');
  }
  const deadline = performance.now() + 90000;
  let observed = false;
  while (performance.now() < deadline) {
    run.assertBrowser();
    const current = run.inspect('container', run.browserId);
    if (current.RestartCount === before + 1 && current.State.Running) { observed = true; break; }
    assert(current.RestartCount <= before + 1, 'Unexpected recovery loop');
    await delay(500);
  }
  assert(observed, 'Supervisor must exit and Docker must restart after renderer-like OOM');
  await run.ready();
  console.log(check('verify'));
  await delay(6000);
  assert.equal(run.inspect('container', run.browserId).RestartCount, before + 1);
  console.log(JSON.stringify({ realBrowserOomRecovery: true, profileAfterOomRecovery: true, restartCount: before + 1 }));
} finally {
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  if (!interrupted) run.cleanup();
}

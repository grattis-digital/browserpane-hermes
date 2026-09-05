// Lifecycle wrapper for the retained real-X11 scroll/display oracles.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ViewerDiagnostics } from './viewer-diagnostics.mjs';
import { ViewerOracleRunner } from './viewer-oracle-runner.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'browserpane-pipeline-viewer';
const image = process.argv[2] ?? 'browserpane-hermes:test';
const token = randomUUID();
const execute = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, ...options });
assert(!execute(['container', 'ls', '--all', '--format', '{{.Names}}']).split('\n').includes(name),
  'Refusing existing viewer container; inspect it yourself before retrying');
let id;
let failed = false;
try {
  // The launcher refuses an existing name and uses no mounts, only tmpfs.
  const result = spawnSync('bash', ['scripts/start-pipeline-probe.sh'], { cwd: root, stdio: 'inherit',
    env: { ...process.env, BPANE_PIPELINE_IMAGE: image, BPANE_PIPELINE_NAME: name,
      BPANE_PIPELINE_RUN_ID: token, BPANE_PIPELINE_VIEWER: '1' } });
  // Read identity even after failed readiness so cleanup is exact, not by name.
  const state = JSON.parse(execute(['inspect', name]))[0];
  assert.equal(state.Config.Labels?.['browserpane.test'], 'pipeline');
  assert.equal(state.Config.Labels?.['browserpane.test.run'], token, 'Never adopt another run’s container');
  assert.deepEqual(state.Mounts, []);
  assert(state.Config.Env.includes('BPANE_PIPELINE_TEST=1'));
  id = state.Id;
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Disposable viewer failed startup');
  ViewerOracleRunner.run(['check-scroll-integrity.mjs', 'check-display-controls.mjs'],
    script => spawnSync(process.execPath, [`scripts/${script}`], { cwd: root, stdio: 'inherit' }));
} catch (error) {
  failed = true;
  throw error;
} finally {
  if (id) {
    const state = JSON.parse(execute(['inspect', id]))[0];
    assert.equal(state.Id, id);
    assert.equal(state.Config.Labels?.['browserpane.test'], 'pipeline');
    assert.equal(state.Config.Labels?.['browserpane.test.run'], token);
    assert.deepEqual(state.Mounts, []);
    if (failed) {
      // Read only the exact owned, synthetic container before removing it.
      try {
        const logs = spawnSync('docker', ['logs', '--tail', '100', id], { encoding: 'utf8', timeout: 10000, maxBuffer: 262144 });
        const output = ViewerDiagnostics.redact(((logs.stdout ?? '') + (logs.stderr ?? '')).slice(-16384));
        mkdirSync(join(root, 'test-results'), { recursive: true });
        writeFileSync(join(root, 'test-results/viewer-container-failure.log'), output);
        console.error(output);
      } catch { console.error('Owned test-container diagnostics unavailable'); }
    }
    execute(['stop', '--time', '45', id]);
    execute(['rm', id]);
  }
}

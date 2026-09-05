// Lifecycle wrapper for the retained real-X11 scroll/display oracles.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'browserpane-pipeline-viewer';
const image = process.argv[2] ?? 'browserpane-hermes:test';
const token = randomUUID();
const execute = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, ...options });
assert(!execute(['container', 'ls', '--all', '--format', '{{.Names}}']).split('\n').includes(name),
  'Refusing existing viewer container; inspect it yourself before retrying');
let id;
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
  for (const script of ['check-scroll-integrity.mjs', 'check-display-controls.mjs']) {
    const test = spawnSync(process.execPath, [`scripts/${script}`], { cwd: root, stdio: 'inherit' });
    if (test.error) throw test.error;
    assert.equal(test.status, 0, `${script} failed`);
  }
} finally {
  if (id) {
    const state = JSON.parse(execute(['inspect', id]))[0];
    assert.equal(state.Id, id);
    assert.equal(state.Config.Labels?.['browserpane.test'], 'pipeline');
    assert.equal(state.Config.Labels?.['browserpane.test.run'], token);
    assert.deepEqual(state.Mounts, []);
    execute(['stop', '--time', '45', id]);
    execute(['rm', id]);
  }
}

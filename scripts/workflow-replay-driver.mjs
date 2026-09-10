import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Invokes the actual Python/SDK CLI against owned fixture resources only. */
export class WorkflowReplayDriver {
  #python; #root; #session; #fixture; #signal; #paths; #child;
  constructor(python, root, session, fixture, signal) {
    assert(python); this.#python = python; this.#root = root; this.#session = session;
    this.#fixture = fixture; this.#signal = signal;
  }
  async prepare(expected, suffix = 'run', endpoint = this.#session.endpoint(), { store, catalog, pacing = null } = {}) {
    assert(/^[a-z0-9-]{1,32}$/.test(suffix));
    const directory = join(this.#root, suffix);
    await mkdir(directory, { mode: 0o700 });
    const recipe = { schema: 1, id: 'report-export', version: 1, url: this.#fixture.url('report'),
      marker: { role: 'heading', name: 'Report export fixture' }, periodTarget: { role: 'textbox', name: 'Reporting period' },
      exportTarget: { role: 'link', name: 'Export report' }, readyText: 'Report exported', verifier: 'report-csv-v1' };
    const recipePath = join(directory, 'recipe.json'), bindingsPath = join(directory, 'bindings.json');
    await writeFile(recipePath, JSON.stringify(recipe), { flag: 'wx', mode: 0o600 });
    await writeFile(bindingsPath, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
    this.#paths = ['--recipe', recipePath, '--bindings', bindingsPath, '--endpoint', endpoint,
      '--downloads', this.#session.artifactDirectory(), '--store', store ?? join(directory, 'journal'), '--pacing', 'off'];
    if (pacing !== null) {
      const pacingPath = join(directory, 'pacing.json');
      await writeFile(pacingPath, JSON.stringify(pacing), { flag: 'wx', mode: 0o600 });
      this.#paths[this.#paths.length - 1] = pacingPath;
    }
    // Test-owned review acknowledgement only. Never run this auto-approval helper on operator inputs.
    const review = await this.command('review');
    assert.equal(review.exitCode, 0);
    assert.equal('pacing' in review.result, pacing !== null);
    const approved = await this.command('approve', ['--digest', review.result.digest]);
    assert.equal(approved.exitCode, 0); assert.equal(approved.result.state, 'approved');
    if (catalog) {
      const registered = await this.command('register', ['--run-id', approved.result.runId, '--catalog', catalog]);
      assert.equal(registered.exitCode, 0, JSON.stringify(registered));
    }
    return approved.result.runId;
  }
  command(op, args = []) {
    assert(this.#paths && ['review', 'approve', 'register', 'run', 'status', 'cancel', 'reconcile', 'abandon'].includes(op));
    this.#signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const child = spawn(this.#python, ['-m', 'workflow_runner.cli', op, ...this.#paths, ...args], {
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1',
          PYTHONPATH: fileURLToPath(new URL('../hermes', import.meta.url)) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#child = child;
      let stdout = '', stderr = '', failure;
      const stop = () => { failure = new Error('Owned recipe CLI interrupted'); child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 60000);
      this.#signal?.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 65536) stop(); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.once('error', error => { failure = error; });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer); this.#signal?.removeEventListener('abort', stop); this.#child = undefined;
        if (failure) { reject(failure); return; }
        if (signal) { resolve({ exitCode, signal, wallMs: performance.now() - started }); return; }
        try { resolve({ exitCode, result: JSON.parse(stdout), wallMs: performance.now() - started }); }
        catch (error) { reject(new Error(`Owned recipe CLI returned no JSON: ${stderr}`, { cause: error })); }
      });
    });
  }
  interruptOwnedChild() { assert(this.#child && this.#child.exitCode === null); this.#child.kill('SIGKILL'); }
}

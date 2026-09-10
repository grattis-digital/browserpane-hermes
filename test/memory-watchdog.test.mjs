import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

async function fixture(t, initial, updates) {
  const root = await mkdtemp(join(tmpdir(), 'bpane-memory-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'events'), initial);
  const writes = updates.map((value, index) => `${index + 1}) printf '%s\\n' '${value}' > "$EVENTS";;`).join('\n');
  await writeFile(join(root, 'bin/sleep'), `#!/bin/bash
count=0
if [ -f "$COUNTER" ]; then read -r count < "$COUNTER"; fi
count=$((count + 1)); printf '%s' "$count" > "$COUNTER"
case "$count" in
${writes}
*) exit 1;;
esac
`, { mode: 0o700 });
  const run = () => execFileSync('bash', [resolve('runtime/watch-memory.sh'), join(root, 'events'), '0.01'], {
    timeout: 1500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, EVENTS: join(root, 'events'), COUNTER: join(root, 'count') },
  });
  return { run, root };
}

test('existing OOM history is a baseline, not a permanent restart loop', async t => {
  const f = await fixture(t, 'oom 3\noom_kill 1\n', ['oom 4\noom_kill 1', 'oom 4\noom_kill 1']);
  f.run();
  assert.equal(await readFile(join(f.root, 'count'), 'utf8'), '3');
});

test('a new renderer OOM requests recovery on the first sample', async t => {
  const f = await fixture(t, 'oom_kill 1\n', ['oom_kill 2']);
  assert.throws(f.run, error => error.status === 1 && /OOM counter changed/.test(error.stderr));
  assert.equal(await readFile(join(f.root, 'count'), 'utf8'), '1');
});

test('counter read failures are bounded and successful reads reset the failure count', async t => {
  const f = await fixture(t, 'oom_kill 0\n', ['bad', 'bad', 'oom_kill 0', 'bad', 'bad', 'bad']);
  assert.throws(f.run, error => error.status === 1 && /counter unavailable/.test(error.stderr));
  assert.equal(await readFile(join(f.root, 'count'), 'utf8'), '6');
});

test('malformed initial counters and counter resets fail closed', async t => {
  for (const value of ['oom 1', 'oom_kill -1', 'oom_kill 01', 'oom_kill 1 extra', 'oom_kill 1\noom_kill 2']) {
    const f = await fixture(t, value, []);
    assert.throws(f.run, error => error.status === 1 && /initial OOM counter/.test(error.stderr));
  }
  const reset = await fixture(t, 'oom_kill 2', ['oom_kill 0']);
  assert.throws(reset.run, error => error.status === 1 && /OOM counter changed/.test(error.stderr));
});

test('wrapper supervises memory before browser startup and retains graceful shutdown', async () => {
  const script = await readFile('runtime/start.sh', 'utf8');
  assert(script.indexOf('bash /app/runtime/watch-memory.sh') < script.indexOf('setsid bash'));
  assert.match(script, /wait -n "\$\{children\[@\]\}"/);
  assert.match(script, /node \/app\/server\/close-browser.mjs/);
  assert.match(script, /Memory watchdog unavailable: cgroup v2/);
});

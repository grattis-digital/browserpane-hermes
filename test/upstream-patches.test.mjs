import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);

test('tracked patches reverse and reproduce current vendored source without touching it', async () => {
  const root = resolve('.');
  const patches = (await readdir(join(root, 'patches')))
    .filter(name => name.endsWith('.patch')).sort();
  assert(patches.length > 0, 'optimizations must be tracked outside ignored upstream');
  const paths = new Set();
  for (const patch of patches) {
    const contents = await readFile(join(root, 'patches', patch), 'utf8');
    // Without this metadata git apply can interpret /dev/null as an ordinary
    // path during reversal, making a broken new-file patch roundtrip locally
    // while failing on a genuinely pristine upstream snapshot.
    for (const section of contents.split(/^diff --git /m).slice(1)) {
      if (/^--- \/dev\/null$/m.test(section)) {
        assert.match(section, /^new file mode [0-7]{6}$/m, `${patch}: new files need explicit mode metadata`);
      }
      if (/^\+\+\+ \/dev\/null$/m.test(section)) {
        assert.match(section, /^deleted file mode [0-7]{6}$/m, `${patch}: deleted files need explicit mode metadata`);
      }
    }
    for (const match of contents.matchAll(/^(?:--- a|\+\+\+ b)\/(.+)$/gm)) {
      const path = match[1];
      assert(!path.startsWith('/') && !path.split('/').includes('..'), 'patch paths stay in snapshot');
      paths.add(path);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'bpane-patch-roundtrip-'));
  const expected = new Map();
  try {
    for (const path of paths) {
      const source = join(root, 'upstream', path);
      try {
        expected.set(path, await readFile(source));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue; // A patch may delete a formerly tracked upstream file.
      }
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await copyFile(source, join(directory, path));
    }
    for (const patch of [...patches].reverse()) {
      const path = join(root, 'patches', patch);
      await execute('git', ['apply', '--reverse', '--check', '--whitespace=error-all', path], { cwd: directory });
      await execute('git', ['apply', '--reverse', '--whitespace=error-all', path], { cwd: directory });
    }
    await assert.rejects(readFile(join(directory, 'dev/null')), { code: 'ENOENT' }, 'reversal must never materialize /dev/null');
    for (const patch of patches) {
      const path = join(root, 'patches', patch);
      await execute('git', ['apply', '--check', '--whitespace=error-all', path], { cwd: directory });
      await execute('git', ['apply', '--whitespace=error-all', path], { cwd: directory });
    }
    for (const [path, bytes] of expected) {
      assert.deepEqual(await readFile(join(directory, path)), bytes, path);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('source fetch is pinned and packaging excludes local build artifacts', async () => {
  const fetch = await readFile('scripts/fetch-upstream.sh', 'utf8');
  assert.equal((await readFile('UPSTREAM_COMMIT', 'utf8')).trim(), '91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3');
  assert.match(fetch, /< UPSTREAM_COMMIT/);
  assert.match(fetch, /upstream already exists/);
  assert.match(fetch, /openapi\/bpane-control-v1\.operations\.json/);
  assert.match(fetch, /git apply --check/);
  const pack = await readFile('scripts/package-source.sh', 'utf8');
  const ignore = await readFile('.dockerignore', 'utf8');
  for (const directory of ['target', 'node_modules', '__pycache__']) {
    assert(pack.includes(`--exclude='*/${directory}'`), `source archive excludes ${directory}`);
  }
  assert(ignore.split('\n').includes('upstream'), 'Docker prepares its own clean source snapshot');
  assert.match(pack, /runtime scripts server test upstream/);
  assert.match(pack, /UPSTREAM_COMMIT/);
  assert.match(pack, /\.github/);
});

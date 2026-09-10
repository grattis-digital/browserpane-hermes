import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaywrightSnapshotPatch as Patch } from '../scripts/playwright-patch/apply.mjs';
import { SnapshotProtocolPatch } from '../scripts/playwright-patch/protocol.mjs';

test('installed snapshot extension exactly reverses to every pinned dependency hash', async () => {
  const result = await Patch.run(process.cwd(), true);
  assert.equal(result.patchedFiles, 0); assert.equal(result.verifiedFiles, 4);
});

test('patch anchors reject missing/duplicate/drifted source, and reverse exactly', () => {
  const changes = [['old', 'new']];
  assert.equal(Patch.replace('old', changes), 'new');
  assert.equal(Patch.replace('new', changes, true), 'old');
  for (const value of ['missing', 'old old']) assert.throws(() => Patch.replace(value, changes));
  const source = "const source = 'one\\ntwo';";
  const injected = [['one\ntwo', "three\n'four'"]];
  assert.equal(Patch.rewrite(Patch.rewrite(source, injected, true), injected, true, true), source);
});

test('unqualified versions fail before touching files; image and npm install include the patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bpane-patch-fixture-'));
  try {
    await mkdir(join(root, 'node_modules/playwright-core'), { recursive: true });
    await writeFile(join(root, 'node_modules/playwright-core/package.json'), JSON.stringify({ version: 'unqualified' }));
    await assert.rejects(Patch.run(root), /Requalify scoped snapshots/);
  } finally { await rm(root, { recursive: true }); }
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(pkg.scripts.postinstall, 'node scripts/playwright-patch/apply.mjs');
  const docker = await readFile('Dockerfile', 'utf8');
  assert(docker.indexOf('COPY scripts/playwright-patch scripts/playwright-patch') < docker.indexOf('RUN npm ci'));
  assert.equal(docker.split('COPY scripts/playwright-patch scripts/playwright-patch').length - 1, 2);
});

test('qualified dependency copies survive revert/apply/check and drift causes no partial rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bpane-patch-roundtrip-'));
  const files = ['package.json', ...SnapshotProtocolPatch.files().map(file => file.path), 'lib/generated/injectedScriptSource.js'];
  const target = join(root, 'node_modules/playwright-core');
  try {
    for (const file of files) {
      const path = join(target, file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, await readFile(join('node_modules/playwright-core', file)));
    }
    assert.equal((await Patch.run(root, false, true)).patchedFiles, 4);
    await assert.rejects(Patch.run(root, true), /patch missing/);
    const first = join(target, 'lib/client/page.js'), last = join(target, 'lib/generated/injectedScriptSource.js');
    const firstBefore = await readFile(first, 'utf8'), lastBefore = await readFile(last, 'utf8');
    await writeFile(last, `${lastBefore}\n// unqualified drift\n`);
    await assert.rejects(Patch.run(root));
    assert.equal(await readFile(first, 'utf8'), firstBefore);
    await writeFile(last, lastBefore);
    assert.equal((await Patch.run(root)).patchedFiles, 4);
    assert.equal((await Patch.run(root)).patchedFiles, 0);
    assert.equal((await Patch.run(root, true)).verifiedFiles, 4);
  } finally { await rm(root, { recursive: true }); }
});

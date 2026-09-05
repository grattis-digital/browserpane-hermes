import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import downloads from '../server/mcp-downloads.cjs';
const { default: attachDownloads, forwardDownload } = downloads;

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bpane-download-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const download = (name, text) => ({
  suggestedFilename: () => name,
  saveAs: path => writeFile(path, text),
});

test('MCP diagnostics are outside the host auto-download directory', async () => {
  const source = await readFile('server/mcp-process.mjs', 'utf8');
  assert.match(source, /'--output-dir', '\/shared\/mcp-artifacts'/);
  assert.doesNotMatch(source, /'--output-dir', '\/shared\/downloads'/);
  assert.match(source, /'--init-page', '\/app\/server\/mcp-downloads.cjs'/);
});

test('only real download events are forwarded, including legitimate .log files', async t => {
  const directory = await temporaryDirectory(t);
  const page = new EventEmitter();
  attachDownloads({ page, downloadDirectory: directory });
  attachDownloads({ page, downloadDirectory: directory });
  assert.equal(page.listenerCount('download'), 1);
  page.emit('console', { type: () => 'error', text: () => 'Missing video' });
  page.emit('pageerror', new Error('Missing video'));
  assert.deepEqual(await readdir(directory), []);
  const target = await forwardDownload(download('console-user-requested.log', 'real download'), directory);
  assert.equal(await readFile(target, 'utf8'), 'real download');
});

test('publishes only completed files and preserves concurrent same-name downloads', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'report.txt'), 'existing');
  const targets = await Promise.all(['first', 'second'].map(text => forwardDownload({
    suggestedFilename: () => 'report.txt',
    saveAs: async path => {
      assert.deepEqual((await readdir(directory)).filter(name => !name.startsWith('.')), ['report.txt']);
      await writeFile(path, text);
    },
  }, directory)));
  assert.equal(new Set(targets).size, 2);
  assert.equal(await readFile(join(directory, 'report.txt'), 'utf8'), 'existing');
  assert.deepEqual((await Promise.all(targets.map(path => readFile(path, 'utf8')))).sort(), ['first', 'second']);
  assert.equal((await readdir(directory)).filter(name => name.startsWith('.')).length, 0);
});

test('cleans failed partial downloads without publishing them', async t => {
  const directory = await temporaryDirectory(t);
  await assert.rejects(forwardDownload({
    suggestedFilename: () => 'broken.txt',
    saveAs: async path => { await writeFile(path, 'partial'); throw new Error('cancelled'); },
  }, directory), /cancelled/);
  assert.deepEqual(await readdir(directory), []);
});

test('confines suggested filenames to the download directory', async t => {
  const directory = await temporaryDirectory(t);
  for (const name of ['../../escape.txt', '..\\escape.txt', '.hidden', 'x\0y.txt', '🚀'.repeat(200) + '.txt']) {
    const target = await forwardDownload(download(name, 'safe'), directory);
    assert.equal(target, join(directory, basename(target)));
    assert(!basename(target).startsWith('.'));
    assert(Buffer.byteLength(basename(target)) <= 255);
    assert.equal(await readFile(target, 'utf8'), 'safe');
  }
});

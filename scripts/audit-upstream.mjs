// Independent pristine replay, not a reverse-only roundtrip. No checkout edits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

class UpstreamAudit {
  constructor(root, localRepository) { this.root = root; this.localRepository = localRepository; }
  command(program, args, cwd, input) {
    return execFileSync(program, args, { cwd, input, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  }
  async files(directory, prefix = '') {
    const paths = [];
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (['target', 'code/web/bpane-client/node_modules'].includes(path)) continue;
      assert(!entry.isSymbolicLink(), `Unexpected source symlink: ${path}`);
      if (entry.isDirectory()) paths.push(...await this.files(directory, path));
      else { assert(entry.isFile(), `Unexpected source type: ${path}`); paths.push(path); }
    }
    return paths.sort();
  }
  async run() {
    const commit = (await readFile(join(this.root, 'UPSTREAM_COMMIT'), 'utf8')).trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    const scratch = await mkdtemp(join(tmpdir(), 'bpane-pristine-audit-'));
    try {
      const source = join(scratch, 'source');
      await mkdir(source);
      let repository = this.localRepository && resolve(this.localRepository);
      if (!repository) {
        repository = join(scratch, 'repository');
        this.command('git', ['init', '--quiet', repository], scratch);
        this.command('git', ['fetch', '--quiet', '--depth', '1', 'https://github.com/ITmedes/browserpane.git', commit], repository);
      }
      assert.equal(this.command('git', ['rev-parse', `${commit}^{commit}`], repository).toString().trim(), commit);
      const archive = this.command('git', ['archive', commit,
        'Cargo.toml', 'Cargo.lock', 'code/shared', 'code/apps', 'code/web/bpane-client/js',
        'code/integrations/mcp-bridge/src/playwright-mcp-runtime.ts',
        'openapi/bpane-control-v1.operations.json', 'deploy/xorg-dummy.conf',
        'deploy/start-host.sh', 'deploy/host-runtime.env', 'deploy/bpane-ext',
        'deploy/chromium-policies/managed'], repository);
      this.command('tar', ['-x', '-C', source], scratch, archive);
      const patches = (await readdir(join(this.root, 'patches'))).filter(name => name.endsWith('.patch')).sort();
      assert(patches.length > 0);
      for (const name of patches) {
        const path = join(this.root, 'patches', name);
        this.command('git', ['apply', '--check', '--whitespace=error-all', path], source);
        this.command('git', ['apply', '--whitespace=error-all', path], source);
      }
      const actual = join(this.root, 'upstream');
      const expectedFiles = await this.files(source);
      assert.deepEqual(await this.files(actual), expectedFiles, 'Generated source path manifest differs');
      for (const path of expectedFiles) {
        assert.deepEqual(await readFile(join(actual, path)), await readFile(join(source, path)), path);
      }
      console.log(JSON.stringify({ upstreamCommit: commit, patches: patches.length,
        sourceFiles: expectedFiles.length, strictPristineReplay: true, exactSourceBytes: true }));
    } finally {
      // Exact owned mkdtemp only; never the user's source or git object store.
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

await new UpstreamAudit(fileURLToPath(new URL('../', import.meta.url)), process.env.BPANE_UPSTREAM_REPO).run();

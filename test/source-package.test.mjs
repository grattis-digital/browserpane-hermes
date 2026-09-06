import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

test('local source archive keeps public configuration but excludes nested operator state', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'bph-source-package-'));
  try {
    const files = ['.dockerignore', '.gitignore', '.gitattributes', '.env.example', 'AGENTS.md', 'Dockerfile',
      'Dockerfile.pipeline-test', 'compose.yaml', 'package.json', 'package-lock.json',
      'vitest.config.mjs', 'LICENSE', 'README.md', 'UPSTREAM.md', 'UPSTREAM_COMMIT',
      'NODEJS_STANDARDS.md', 'RUST_STANDARDS.md', 'upstream/Cargo.lock', 'config/Caddyfile'];
    const dirs = ['.github', 'client', 'config', 'docs', 'hermes', 'patches', 'runtime',
      'scripts', 'server', 'test', 'upstream'];
    for (const directory of dirs) await mkdir(join(scratch, directory), { recursive: true });
    for (const path of files) await writeFile(join(scratch, path), 'public synthetic source\n');
    const excluded = ['config/.env.production', 'docs/nested/.env.local', 'hermes/.env',
      'config/private.key', 'config/private.pem', 'config/caddy-root.crt',
      'docs/secrets/token.txt', 'scripts/test-results/trace.txt', 'docs/.git/config',
      'hermes/__pycache__/bootstrap.pyc', 'upstream/target/artifact',
      'upstream/code/web/bpane-client/node_modules/dependency.js', 'server/.access.json'];
    for (const path of excluded) {
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), 'SYNTHETIC_SECRET_DO_NOT_ARCHIVE\n');
    }
    await copyFile('scripts/package-source.sh', join(scratch, 'scripts/package-source.sh'));
    execFileSync('sh', ['scripts/package-source.sh'], { cwd: scratch, timeout: 15000 });
    const entries = execFileSync('tar', ['-tzf', 'source.tar.gz'], { cwd: scratch, encoding: 'utf8' }).split('\n');
    assert(entries.includes('.env.example'));
    assert(entries.includes('config/Caddyfile'));
    assert(entries.includes('upstream/Cargo.lock'));
    for (const path of excluded) assert(!entries.includes(path), `Archive leaked ${path}`);
    const contents = execFileSync('tar', ['-xOzf', 'source.tar.gz'], { cwd: scratch, encoding: 'utf8' });
    assert(!contents.includes('SYNTHETIC_SECRET_DO_NOT_ARCHIVE'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InjectedSnapshotPatch } from './injected.mjs';
import { SnapshotProtocolPatch } from './protocol.mjs';

/** Reproducible dependency rewrite. Refuses changed pins/bytes; idempotent by reverse verification. */
export class PlaywrightSnapshotPatch {
  static replace(source, changes, reverse = false) {
    for (const [before, after, count = 1] of reverse ? [...changes].reverse() : changes) {
      const from = reverse ? after : before, to = reverse ? before : after;
      assert.equal(source.split(from).length - 1, count, `Pinned patch anchor changed: ${from.slice(0, 90)}`);
      source = source.split(from).join(to);
    }
    return source;
  }

  static rewrite(source, changes, injected, reverse = false) {
    if (!injected) return this.replace(source, changes, reverse);
    // The pinned generated module embeds a single-quoted JS literal. Replace
    // escaped anchors directly; never evaluate dependency text or reformat it.
    const escape = text => text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    return this.replace(source, changes.map(([before, after, count]) => [escape(before), escape(after), count]), reverse);
  }

  static async run(root, check = false, revert = false) {
    const target = join(root, 'node_modules/playwright-core');
    const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.59.0-alpha-1771104257000', 'Requalify scoped snapshots before changing Playwright');
    const files = [...SnapshotProtocolPatch.files(), { path: 'lib/generated/injectedScriptSource.js',
      sha256: '21b38d8d209a656d72d19a19e88794a54ca207ad619efa28125e620b3029727c', injected: true, changes: InjectedSnapshotPatch.changes() }];
    const digest = source => createHash('sha256').update(source).digest('hex');
    const planned = [];
    // Validate every file before changing any dependency bytes.
    for (const file of files) {
      const path = join(target, file.path), source = await readFile(path, 'utf8');
      if (digest(source) === file.sha256) {
        if (revert) continue;
        assert(!check, `Scoped snapshot patch missing: ${file.path}`);
        const output = this.rewrite(source, file.changes, file.injected);
        assert.equal(this.rewrite(output, file.changes, file.injected, true), source);
        planned.push({ path, output });
      } else {
        const original = this.rewrite(source, file.changes, file.injected, true);
        assert.equal(digest(original), file.sha256, `Unexpected dependency bytes: ${file.path}`);
        if (revert) planned.push({ path, output: original });
      }
    }
    for (const { path, output } of planned) await writeFile(path, output);
    return { version: pkg.version, patchedFiles: planned.length, verifiedFiles: files.length };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  console.log(JSON.stringify(await PlaywrightSnapshotPatch.run(root, process.argv.includes('--check'), process.argv.includes('--revert'))));
}

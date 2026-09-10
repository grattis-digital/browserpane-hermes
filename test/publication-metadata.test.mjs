import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Calendar/run identity is not needed to interpret synthetic elapsed durations.
// Dependency versions and license attribution remain part of source provenance.
class PublicationMetadata {
  static date = /\b(?:19|20)\d{2}[-/]\d{2}[-/]\d{2}\b|\b20\d{6}(?:T\d{6}Z)?\b/;
  static privateBranch = /\b(?:experiment|feature)\/[a-z0-9_-]+/i;
  static forbiddenKey = /^(?:date|timestamp|createdAt|startedAt|finishedAt|capturedAt|generatedAt|branch|commit|revision|base|reviewedBase|runId|rawReportSha256|engineSha256|sha256)$/i;

  static documents(root) {
    return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? this.documents(path) : /\.(md|json)$/.test(path) ? [path] : [];
    });
  }

  static checkText(text, path) {
    assert.doesNotMatch(path, this.date, `Dated publication filename: ${path}`);
    assert.doesNotMatch(text, this.date, `Calendar metadata in ${path}`);
    assert.doesNotMatch(text, this.privateBranch, `Private development branch in ${path}`);
  }

  static checkRecord(value, path) {
    if (Array.isArray(value)) return value.forEach((item, index) => this.checkRecord(item, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.doesNotMatch(key, this.forbiddenKey, `Run/history metadata in ${path}.${key}`);
      this.checkRecord(item, `${path}.${key}`);
    }
  }
}

test('published guides and measurements exclude calendar and development-history metadata', () => {
  for (const path of ['README.md', 'SECURITY.md', 'UPSTREAM.md', ...PublicationMetadata.documents('docs')]) {
    const text = readFileSync(path, 'utf8');
    PublicationMetadata.checkText(text, path);
    if (path.startsWith('docs/benchmarks/') && path.endsWith('.json')) {
      PublicationMetadata.checkRecord(JSON.parse(text), path);
    }
  }
});

test('publication metadata policy rejects nested identifiers but keeps elapsed measurements', () => {
  for (const value of [{ date: 'private' }, { runs: [{ createdAt: 123 }] }, { branch: 'private' },
    { engineSha256: {} }, { samples: [{ timestamp: 123 }] }]) {
    assert.throws(() => PublicationMetadata.checkRecord(value, 'fixture'));
  }
  PublicationMetadata.checkRecord({ samples: [{ totalMs: 30, gpuMs: 5 }], runtime: { chromium: '152.0' } }, 'fixture');
});

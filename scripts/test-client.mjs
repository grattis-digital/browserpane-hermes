import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL('node_modules/vitest/vitest.mjs', root)), 'run',
  '--config', fileURLToPath(new URL('vitest.config.mjs', root)), ...process.argv.slice(2),
], { cwd: fileURLToPath(new URL('upstream/code/web/bpane-client', root)), stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

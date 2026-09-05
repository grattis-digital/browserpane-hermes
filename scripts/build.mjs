import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['client/app.ts'], outfile: 'dist/app.js', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', minify: true,
});
await build({
  entryPoints: ['upstream/code/integrations/mcp-bridge/src/playwright-mcp-runtime.ts'],
  outfile: 'dist/playwright-mcp-runtime.mjs', format: 'esm', platform: 'node',
  target: 'node22',
});
await copyFile('client/index.html', 'dist/index.html');
await copyFile('client/style.css', 'dist/style.css');
await copyFile('upstream/code/web/bpane-client/js/audio/audio-worklet.js', 'dist/audio-worklet.js');

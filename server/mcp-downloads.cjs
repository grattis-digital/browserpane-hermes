// CJS avoids the pinned MCP CLI's unregistered ESM preflight loader.
const { link, mkdir, mkdtemp, rm } = require('node:fs/promises');
const { basename, extname, join } = require('node:path');

const attachedPages = new WeakSet();

function safeFilename(suggested) {
  let name = basename(suggested.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '_');
  if (!name || name.startsWith('.')) name = `download-${name || 'file'}`;
  const chars = Array.from(name);
  while (Buffer.byteLength(chars.join('')) > 200) chars.pop();
  return chars.join('');
}

async function forwardDownload(download, directory) {
  await mkdir(directory, { recursive: true });
  // The original watcher ignores directories. Never expose a partially saved
  // download: publish the completed file atomically, without overwriting one.
  const staging = await mkdtemp(join(directory, '.mcp-download-'));
  try {
    const temporary = join(staging, 'download.part');
    await download.saveAs(temporary);
    const name = safeFilename(download.suggestedFilename());
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let index = 0; ; index++) {
      const target = join(directory, index ? `${stem} (${index})${extension}` : name);
      try {
        // Both paths are on the same /shared bind mount. link is atomic and
        // fails with EEXIST even for symlinks and concurrent same-name files.
        await link(temporary, target);
        return target;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

// Official MCP --init-page hook. Keep the upstream browser/transport untouched.
// Multiple MCP clients share Page objects; install only one forwarding listener.
function attachDownloads({ page, downloadDirectory = process.env.BPANE_DOWNLOAD_DIR ?? '/shared/downloads' }) {
  if (attachedPages.has(page)) return;
  attachedPages.add(page);
  page.on('download', download => {
    void forwardDownload(download, downloadDirectory).catch(error => {
      console.error('Browser download forwarding failed:', error.message);
    });
  });
}

module.exports = { default: attachDownloads, forwardDownload };

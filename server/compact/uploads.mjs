import { realpath, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute, basename } from 'node:path';
import { PaneError } from './errors.mjs';

export class SharedUploads {
  #root;
  constructor(root) { this.#root = root; }

  async resolve(paths) {
    const root = await realpath(this.#root);
    const result = [];
    let bytes = 0;
    for (const path of paths) {
      if (!isAbsolute(path)) throw new PaneError('UPLOAD_PATH', 'Use an absolute path under /shared.');
      const resolved = await realpath(path);
      const inside = relative(root, resolved);
      if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new PaneError('UPLOAD_PATH', 'Upload must stay inside the shared directory.');
      const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        const actual = process.platform === 'linux' ? await realpath(`/proc/self/fd/${file.fd}`) : await realpath(resolved);
        const location = relative(root, actual), current = await stat(actual);
        if (location === '..' || location.startsWith('../') || isAbsolute(location) ||
          current.ino !== info.ino || current.dev !== info.dev) throw new PaneError('UPLOAD_CHANGED', 'File changed during upload validation.');
        if (!info.isFile() || bytes + info.size > 32 * 1024 * 1024) throw new PaneError('UPLOAD_LIMIT', 'Upload regular files only, at most 32 MiB per step.');
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) throw new PaneError('UPLOAD_CHANGED', 'File shrank during upload.');
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new PaneError('UPLOAD_CHANGED', 'File changed during upload.');
        bytes += buffer.length;
        // Pass owned bytes; Playwright must not reopen a path that can change.
        result.push({ name: basename(actual), mimeType: 'application/octet-stream', buffer });
      } finally { await file.close(); }
    }
    return result;
  }
}

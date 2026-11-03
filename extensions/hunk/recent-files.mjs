import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';

// Used only for the live working-tree pane, not historical commit reviews.
export default function recentFiles(hunk) {
  hunk.transformChangeset(async (changeset, ctx) => {
    const dated = await Promise.all(changeset.files.map(async (file, index) => {
      const info = await lstat(resolve(ctx.cwd, file.path)).catch(() => undefined);
      return { file, index, modified: info?.mtimeMs ?? -Infinity };
    }));
    dated.sort((a, b) => b.modified - a.modified || a.index - b.index);
    return { ...changeset, files: dated.map(({ file }) => file) };
  });
}

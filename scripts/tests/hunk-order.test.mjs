import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import recentFiles from '../../extensions/hunk/recent-files.mjs';

test('working-tree ordering uses modification time, preserves ties and missing files, and refreshes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'hunk-order-'));
  try {
    for (const [name, time] of [['a', 100], ['z', 200], ['tie', 200]]) {
      await writeFile(join(cwd, name), name);
      await utimes(join(cwd, name), time, time);
    }
    let transform;
    recentFiles({ transformChangeset: fn => { transform = fn; } });
    const source = { title: 'Working changes', files: ['a', 'z', 'tie', 'deleted', 'missing'].map(path => ({path})) };
    const ordered = await transform(source, {cwd});
    assert.deepEqual(ordered.files.map(f => f.path), ['z', 'tie', 'a', 'deleted', 'missing']);
    assert.equal(ordered.title, source.title);
    assert.equal(ordered.files[0], source.files[1]);
    assert.deepEqual(source.files.map(f => f.path), ['a', 'z', 'tie', 'deleted', 'missing']);
    await utimes(join(cwd, 'a'), 300, 300);
    assert.equal((await transform(source, {cwd})).files[0].path, 'a');
    await symlink('missing-target', join(cwd, 'link'));
    assert.equal((await transform({files:[{path:'deleted'}, {path:'link'}]}, {cwd})).files[0].path, 'link');
  } finally { await rm(cwd, {recursive:true, force:true}); }
});

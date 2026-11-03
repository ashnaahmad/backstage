// A linked worktree (a sandbox or verification run made from a checkout) also watches the main
// checkout it came from; a main checkout and a bare repository's worktrees add nothing. Git only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewRoots } from '../lib/diff-pane.ts';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
  { cwd, stdio: 'pipe', encoding: 'utf8' });

test('a linked worktree watches its main checkout as well as itself', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'preview-roots-')));
  const main = join(dir, 'main'), sandbox = join(dir, 'sandbox'), other = join(dir, 'other');
  try {
    git(dir, 'init', '-q', main);
    writeFileSync(join(main, 'README.md'), '# Main\n');
    git(main, 'add', '.');
    git(main, 'commit', '-qm', 'base');
    git(main, 'worktree', 'add', '-q', '--detach', sandbox, 'HEAD');
    git(dir, 'init', '-q', other);

    assert.deepEqual((await previewRoots(main)).roots, [main], 'a main checkout adds nothing');
    assert.deepEqual((await previewRoots(sandbox)).roots, [sandbox, main], 'the worktree, then its main checkout');
    assert.deepEqual((await previewRoots(join(sandbox))).missing, []);

    // Configured roots still follow, and the main checkout is not listed twice.
    git(main, 'config', '--add', 'pi.previewRoot', '../main');
    git(main, 'config', '--add', 'pi.previewRoot', '../other');
    assert.deepEqual((await previewRoots(sandbox)).roots, [sandbox, main, other]);

    // A bare repository's worktrees have no main checkout to watch.
    const bare = join(dir, 'bare.git'), linked = join(dir, 'linked');
    git(dir, 'clone', '-q', '--bare', main, bare);
    git(bare, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    assert.deepEqual((await previewRoots(linked)).roots, [linked]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Read-only identity of the source a check exercised, within explicitly chosen coverage paths of a Git checkout.
//
// Git supplies metadata only (rev-parse, ls-files, ls-tree, check-attr, config): these run no filters, hooks,
// diff drivers or fsmonitor, and GIT_OPTIONAL_LOCKS=0 stops any opportunistic index write. File content is read
// and hashed here, as raw worktree bytes in Git's blob format, so the identity is of the bytes a test read, and an
// assume-unchanged or skip-worktree flag cannot hide a change. Nothing is written to the repository.
//
// Two digests are kept apart because they answer different questions:
// - content.digest: the covered worktree files (tracked and untracked, non-ignored) as bytes. A commit of an
//   unchanged tree leaves it equal.
// - index.digest: the covered index entries (mode, object, stage, path), i.e. what is staged, not a Git tree id.
// HEAD, the branch and in-progress operations (merge, cherry-pick, revert, rebase) are recorded beside them.
// The capture runs twice; if the observations differ, the subject is uncertain rather than exact.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' };
const GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

export class CaptureError extends Error {}

async function git(root, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await run('git', [...GIT_CONFIG, '-C', root, ...args],
      { env: { ...process.env, ...GIT_ENV }, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' });
    return stdout.toString('utf8');
  } catch (error) {
    if (allowFail) return null;
    throw new CaptureError(`git ${args[0]} failed in ${root}: ${String(error.stderr ?? error.message).trim()}`);
  }
}
/** git with stdin input (check-attr --stdin); null on failure, which only drops an advisory note. */
function gitInput(root, args, input) {
  return new Promise(done => {
    const child = execFile('git', [...GIT_CONFIG, '-C', root, ...args], { env: { ...process.env, ...GIT_ENV }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => done(error ? null : stdout));
    child.stdin.end(input);
  });
}
const records = text => text.split('\0').filter(Boolean);
const sha256 = text => createHash('sha256').update(text).digest('hex');

/** Repository root and coverage paths relative to it. Coverage must be explicit and inside the checkout. */
async function resolveCoverage(checkout, coverage) {
  if (!Array.isArray(coverage) || coverage.length === 0) throw new CaptureError('coverage paths are required (use "." to cover the whole checkout explicitly)');
  let real;
  try { real = await realpath(checkout); } catch (error) { throw new CaptureError(`checkout unreadable: ${checkout} (${error.code})`); }
  const top = (await git(real, ['rev-parse', '--show-toplevel'])).trim();
  const root = await realpath(top);
  const paths = [];
  for (const item of coverage) {
    const absolute = isAbsolute(item) ? resolve(item) : resolve(root, item);
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new CaptureError(`coverage path ${item} is outside the checkout ${root}`);
    paths.push(rel === '' ? '.' : rel.split(sep).join('/'));
  }
  return { root, coverage: [...new Set(paths)].sort() };
}

/**
 * Whether every directory between the checkout root and `path` is a real directory. A symlinked ancestor would
 * make a read leave the checkout (or the coverage), so such paths are reported as gaps, never read through.
 * Leaf symlinks are source: their link text is hashed, as Git stores it.
 */
async function ancestorsAreDirectories(root, path) {
  const parts = path.split('/').slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory()) return 'blocked';
    } catch (error) {
      return error.code === 'ENOENT' ? 'missing' : 'blocked';
    }
  }
  return 'ok';
}

async function blobOf(root, path, algorithm) {
  const full = join(root, path);
  const ancestors = await ancestorsAreDirectories(root, path);
  if (ancestors === 'missing') return { kind: 'missing' };
  if (ancestors !== 'ok') return { kind: 'unreadable', reason: 'beneath a symlinked or unreadable directory' };
  let stat;
  try { stat = await lstat(full); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', reason: error.code };
  }
  let bytes;
  let kind;
  try {
    if (stat.isSymbolicLink()) { bytes = Buffer.from(await readlink(full)); kind = 'link'; }
    else if (stat.isFile()) {
      // O_NOFOLLOW: a file swapped for a symlink after the lstat is refused rather than followed.
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) return { kind: 'unreadable', reason: 'changed during the read' };
        bytes = await handle.readFile();
        kind = opened.mode & 0o111 ? 'exec' : 'file';
      } finally {
        await handle.close();
      }
    }
    else if (stat.isDirectory()) return { kind: 'directory' };
    else return { kind: 'unreadable', reason: 'not a regular file' };
  } catch (error) {
    return { kind: 'unreadable', reason: error.code };
  }
  // A directory swapped for a symlink during the read would have redirected it: check again afterwards.
  if ((await ancestorsAreDirectories(root, path)) !== 'ok') return { kind: 'unreadable', reason: 'a parent directory changed during the read' };
  const hash = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  return { kind, blob: hash, size: bytes.length };
}

async function inProgress(root) {
  const gitPath = async name => {
    const out = await git(root, ['rev-parse', '--git-path', name]);
    return resolve(root, out.trim());
  };
  const readRef = async name => {
    try { return (await readFile(await gitPath(name), 'utf8')).trim().split('\n')[0] || null; } catch { return null; }
  };
  const state = {
    merge: await readRef('MERGE_HEAD'),
    cherryPick: await readRef('CHERRY_PICK_HEAD'),
    revert: await readRef('REVERT_HEAD'),
    rebase: existsSync(await gitPath('rebase-merge')) || existsSync(await gitPath('rebase-apply')),
  };
  return state;
}

async function observe(root, coverage) {
  const format = (await git(root, ['rev-parse', '--show-object-format'], { allowFail: true }))?.trim() || 'sha1';
  const algorithm = format === 'sha256' ? 'sha256' : 'sha1';
  const head = (await git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true }))?.trim() || null;
  const branch = (await git(root, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true }))?.trim() || null;
  const operations = await inProgress(root);

  const indexLines = records(await git(root, ['ls-files', '-s', '-v', '-z', '--', ...coverage]));
  const indexEntries = [];
  for (const line of indexLines) {
    const match = line.match(/^(\S) (\d+) ([0-9a-f]+) (\d)\t(.*)$/s);
    if (!match) throw new CaptureError(`unexpected ls-files output: ${line.slice(0, 80)}`);
    const [, tag, mode, object, stage, path] = match;
    indexEntries.push({ tag, mode, object, stage: Number(stage), path });
  }
  const headBlobs = new Map();
  if (head) {
    for (const line of records(await git(root, ['ls-tree', '-r', '-z', '--full-tree', head, '--', ...coverage]))) {
      const match = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s);
      if (match) headBlobs.set(match[4], { mode: match[1], object: match[3] });
    }
  }
  const untracked = records(await git(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...coverage])).sort();

  const indexDigest = sha256(indexEntries.map(e => `${e.mode} ${e.object} ${e.stage}\t${e.path}\n`).sort().join(''));
  const unmerged = [...new Set(indexEntries.filter(e => e.stage > 0).map(e => e.path))].sort();
  const assumeUnchanged = indexEntries.filter(e => e.tag >= 'a' && e.tag <= 'z').map(e => e.path).sort();
  const skipWorktree = indexEntries.filter(e => e.tag.toUpperCase() === 'S').map(e => e.path).sort();
  const indexBlob = new Map(indexEntries.filter(e => e.stage === 0).map(e => [e.path, e]));

  const tracked = [...new Set(indexEntries.map(e => e.path))];
  const untrackedSet = new Set(untracked);
  const files = [];
  const submodules = [];
  const unreadable = [];
  let bytes = 0;
  for (const path of [...tracked, ...untracked].sort()) {
    const entry = indexBlob.get(path);
    if (entry?.mode === '160000' || headBlobs.get(path)?.mode === '160000') { submodules.push(path); continue; }
    const seen = await blobOf(root, path, algorithm);
    if (seen.kind === 'unreadable' || seen.kind === 'directory') { unreadable.push({ path, reason: seen.reason ?? 'directory' }); continue; }
    bytes += seen.size ?? 0;
    files.push({ path, kind: seen.kind, blob: seen.blob ?? null, untracked: untrackedSet.has(path) });
  }
  // Present files only: a deleted file and its later committed absence are the same covered source.
  // Each side is "<mode> <blob>" (Git's modes: 100644, 100755, 120000) so an exec-bit change is a change.
  const present = files.filter(f => f.kind !== 'missing');
  const contentDigest = sha256(present.map(f => `${f.path}\0${entryOf(f)}\n`).join(''));
  const changes = files.flatMap(f => {
    const head = headBlobs.get(f.path);
    const fromHead = head ? `${head.mode} ${head.object}` : null;
    const index = indexBlob.get(f.path);
    const fromIndex = index ? `${index.mode} ${index.object}` : null;
    const worktree = f.kind === 'missing' ? null : entryOf(f);
    if (worktree === fromHead && fromIndex === fromHead) return [];
    return [{ path: f.path, worktree, index: fromIndex, head: fromHead, untracked: f.untracked || undefined }];
  });
  // Paths in HEAD that are gone from both the index and the worktree (a staged deletion or rename source).
  const seenPaths = new Set([...files.map(f => f.path), ...submodules, ...unreadable.map(u => u.path)]);
  for (const [path, head] of headBlobs) {
    if (!seenPaths.has(path)) changes.push({ path, worktree: null, index: null, head: `${head.mode} ${head.object}` });
  }
  changes.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return {
    files: files.map(f => f.path),
    head, branch, inProgress: operations,
    index: { digest: indexDigest, entries: indexEntries.length, unmerged, assumeUnchanged, skipWorktree },
    content: { digest: contentDigest, files: files.length, bytes, untracked, missing: files.filter(f => f.kind === 'missing').map(f => f.path) },
    changes,
    gaps: { submodules, unreadable },
    algorithm,
  };
}

const MODES = { file: '100644', exec: '100755', link: '120000' };
const entryOf = f => `${MODES[f.kind]} ${f.blob}`;

async function normalizationNotes(root, paths) {
  const notes = [];
  const autocrlf = (await git(root, ['config', '--get', 'core.autocrlf'], { allowFail: true }))?.trim();
  if (autocrlf && autocrlf !== 'false') notes.push(`core.autocrlf=${autocrlf}: worktree bytes can differ from Git's stored blobs, so "differs from HEAD" may be spurious`);
  const attrs = paths.length ? await gitInput(root, ['check-attr', '-z', '--stdin', 'filter', 'eol'], paths.join('\0')) : null;
  const filtered = new Set();
  if (attrs) {
    const fields = records(attrs);
    for (let i = 0; i + 2 < fields.length; i += 3) {
      if (fields[i + 2] !== 'unspecified' && fields[i + 2] !== 'unset') filtered.add(fields[i]);
    }
  }
  // A filter defined in config (git-lfs, say) matters only for paths whose attributes select it.
  if (filtered.size) notes.push('filter or eol attributes are configured: identity is of raw worktree bytes, which may differ from Git\'s normalized blobs');
  return notes;
}

/** Coverage paths that matched nothing: a typo would otherwise look like an empty, unchanged source. */
function emptyCoverage(paths, observed) {
  const seen = [...observed.files, ...observed.gaps.submodules, ...observed.gaps.unreadable.map(g => g.path)];
  return paths.filter(p => p !== '.' && !seen.some(file => file === p || file.startsWith(`${p}/`)))
    .map(p => `coverage path ${p} matches no tracked or new file`);
}

/**
 * Capture the identity of the covered source in a checkout. Throws CaptureError when the checkout or coverage
 * cannot be read; partial coverage (submodules, unreadable files) is returned in `gaps`, never hidden.
 */
export async function captureSource(checkout, coverage) {
  const { root, coverage: paths } = await resolveCoverage(checkout, coverage);
  const first = await observe(root, paths);
  const second = await observe(root, paths);
  const same = first.head === second.head && first.index.digest === second.index.digest
    && first.content.digest === second.content.digest && JSON.stringify(first.inProgress) === JSON.stringify(second.inProgress);
  const { algorithm, files: _files, ...rest } = second;
  return {
    kind: 'captured',
    capturedAt: new Date().toISOString(),
    checkout: root,
    coverage: paths,
    ...rest,
    observations: same ? 'two-matched' : 'changed-during-capture',
    notes: [...emptyCoverage(paths, second), ...await normalizationNotes(root, [...new Set([...second.changes.map(c => c.path), ...second.content.untracked])])],
    objectFormat: algorithm,
  };
}

/** Covered worktree "<mode> <blob>" of a path at a capture (null when absent): its recorded change, otherwise HEAD's. */
async function blobAt(root, capture, path) {
  const change = capture.changes.find(c => c.path === path);
  if (change) return change.worktree;
  if (!capture.head) return null;
  const out = await git(root, ['ls-tree', '-z', '--full-tree', capture.head, '--', path], { allowFail: true });
  if (out === null) return undefined; // commit unavailable
  const match = records(out)[0]?.match(/^(\d+) \w+ ([0-9a-f]+)\t/);
  return match ? `${match[1]} ${match[2]}` : null;
}

/**
 * Compare an earlier captured subject with a fresh capture of the same checkout and coverage.
 * status: same | content-same-identity-changed | content-differs | uncertain | not-comparable
 */
export async function compareCaptures(earlier, current) {
  if (earlier.checkout !== current.checkout || JSON.stringify(earlier.coverage) !== JSON.stringify(current.coverage)) {
    return { status: 'not-comparable', reason: 'checkout or coverage differs from the evidence subject' };
  }
  if (earlier.observations !== 'two-matched' || current.observations !== 'two-matched') {
    return { status: 'uncertain', reason: 'source changed while one of the captures was being taken' };
  }
  const gaps = [...new Set([...earlier.gaps.submodules, ...current.gaps.submodules,
    ...earlier.gaps.unreadable.map(u => u.path), ...current.gaps.unreadable.map(u => u.path)])];
  const identityChanges = [];
  if (earlier.head !== current.head) identityChanges.push(`HEAD ${earlier.head?.slice(0, 12) ?? 'unborn'} -> ${current.head?.slice(0, 12) ?? 'unborn'}`);
  if (earlier.branch !== current.branch) identityChanges.push(`branch ${earlier.branch ?? 'detached'} -> ${current.branch ?? 'detached'}`);
  if (earlier.index.digest !== current.index.digest) identityChanges.push('staged index entries changed');
  if (JSON.stringify(earlier.inProgress) !== JSON.stringify(current.inProgress)) identityChanges.push('in-progress Git operation changed');
  if (earlier.content.digest === current.content.digest) {
    return { status: identityChanges.length ? 'content-same-identity-changed' : 'same', identityChanges, gaps };
  }
  const candidates = new Set([...earlier.changes.map(c => c.path), ...current.changes.map(c => c.path)]);
  if (earlier.head && current.head && earlier.head !== current.head) {
    const diff = await git(current.checkout, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', earlier.head, current.head, '--', ...current.coverage], { allowFail: true });
    if (diff === null) return { status: 'content-differs', identityChanges, changedPaths: null, gaps, reason: 'earlier HEAD is no longer available to list paths' };
    for (const path of records(diff)) candidates.add(path);
  }
  const changedPaths = [];
  for (const path of [...candidates].sort()) {
    const [before, after] = [await blobAt(current.checkout, earlier, path), await blobAt(current.checkout, current, path)];
    if (before !== after) changedPaths.push(path);
  }
  return { status: 'content-differs', identityChanges, changedPaths, gaps };
}

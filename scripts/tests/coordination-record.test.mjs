// The coordination record through its real CLI, against temporary Git repositories and record files.
// Synthetic actors and paths only; no tmux, daemon or live session is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { captureSource, compareCaptures } from '../lib/source-identity.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cliPath = join(root, 'scripts/coordination-record.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'coordination-')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const runFile = promisify(execFile);
const gitEnv = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim();

let n = 0;
function repo(files = { 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'docs/x.md': 'x\n' }) {
  const path = join(dir, `repo${++n}`);
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) write(path, file, text);
  git(path, 'add', '-A');
  git(path, 'commit', '-qm', 'base');
  return path;
}
function write(base, file, text) {
  mkdirSync(join(base, file, '..'), { recursive: true });
  writeFileSync(join(base, file), text);
}
function record() {
  const base = join(dir, `records${++n}`);
  mkdirSync(base);
  return join(base, 'record.json');
}
async function cli(recordPath, actor, ...args) {
  const env = { ...process.env, COORDINATION_RECORD: recordPath, COORDINATION_ACTOR: actor, COORDINATION_LOCK_TIMEOUT_MS: '3000' };
  try {
    const { stdout } = await runFile('node', [cliPath, ...args], { env });
    return { code: 0, out: stdout.trim() };
  } catch (error) {
    return { code: error.code, out: `${error.stdout}${error.stderr}`.trim() };
  }
}
async function ok(...args) {
  const result = await cli(...args);
  assert.equal(result.code, 0, result.out);
  return result.out;
}
const json = async (rec, ...args) => JSON.parse(await ok(rec, 'viewer', ...args, '--json'));
const stored = async (rec, id) => (await json(rec, 'show', id)).stored;
const revOf = async (rec, id) => (await stored(rec, id)).assignment.rev;
const section = (text, id) => text.slice(text.indexOf(`## ${id}:`)).split(/\n## /)[0];

test('assignment through a changed brief, a commit of the tested tree, new work, reproduction and transfers', async () => {
  const src = repo();
  const rec = record();
  const brief = join(dir, 'brief-a.md');
  writeFileSync(brief, 'v1\n');
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'parent', '--title', 'Integration', '--accountable', 'root');
  await ok(rec, 'root', 'assign', 'feat', '--title', 'Feature', '--accountable', 'owner', '--implementer', 'pi-1', '--parent', 'parent', '--brief', brief);
  await ok(rec, 'owner', 'checkout', 'feat', '--path', src, '--cover', 'src', '--writer', 'pi-1', '--expect-rev', '1');

  // Dirty tracked change plus a new file, tested before any commit.
  write(src, 'src/a.txt', 'a2\n');
  write(src, 'src/new.txt', 'new\n');
  write(src, 'docs/x.md', 'outside coverage\n');
  // Current state comes from the checkout now, before any evidence exists.
  let live = (await json(rec, 'show', 'feat')).live;
  assert.deepEqual(live.checkout.changedFromHead, ['src/a.txt', 'src/new.txt']);
  assert.deepEqual(live.checkout.untracked, ['src/new.txt']);
  assert.match(await ok(rec, 'viewer', 'handoff', 'feat'), /Current source \(observed now\): HEAD [0-9a-f]{12} on refs\/heads\/main; differs from HEAD: src\/a\.txt, src\/new\.txt \(within coverage src\)/);
  const e1 = await ok(rec, 'pi-1', 'evidence', 'feat', '--check', 'unit', '--result', 'pass', '--scope', 'source-only unit tests',
    '--env', 'local node', '--exclusion', 'live app workflow', '--capture');
  assert.match(e1, /^E1 /);
  await ok(rec, 'owner', 'inspect', 'E1', '--note', 'read the log');
  let view = await ok(rec, 'viewer', 'handoff', 'feat');
  assert.match(view, /E1 unit: pass\. Scope: source-only unit tests; environment: local node; excludes: live app workflow\./);
  assert.match(view, /reported pass by pi-1 .*; inspected by owner .*\(read the log\)/);
  assert.match(view, /covered source unchanged since/);
  assert.doesNotMatch(view, /verified|ready/i);

  // The requirement changes: old evidence stays, scoped to the earlier brief.
  writeFileSync(brief, 'v2: also handle empty input\n');
  await ok(rec, 'owner', 'update', 'feat', '--brief', brief, '--expect-rev', '2');
  // The exact tested tree is committed: identity changes, covered content does not.
  git(src, 'add', 'src');
  git(src, 'commit', '-qm', 'feature');
  view = await ok(rec, 'viewer', 'handoff', 'feat');
  assert.match(view, /covered content unchanged; HEAD [0-9a-f]{12} -> [0-9a-f]{12}, staged index entries changed/);
  assert.match(view, /brief changed since this evidence/);
  assert.doesNotMatch(view, /earlier revision/);

  // Same HEAD, new dirty work: the evidence must not look current.
  write(src, 'src/b.txt', 'b2\n');
  view = await ok(rec, 'viewer', 'handoff', 'feat');
  assert.match(view, /evidence is for an earlier revision: changed src\/b\.txt/);
  // A branch with further change.
  git(src, 'checkout', '-qb', 'next');
  git(src, 'commit', '-qam', 'b2');
  write(src, 'src/c.txt', 'c\n');
  view = await ok(rec, 'viewer', 'handoff', 'feat');
  assert.match(view, /changed src\/b\.txt, src\/c\.txt; HEAD .*branch refs\/heads\/main -> refs\/heads\/next/);

  // Reproduction on the changed tree is a new claim on its own subject; E1 keeps its own.
  const e2 = await ok(rec, 'reviewer', 'reproduce', 'E1', '--result', 'pass', '--scope', 'source-only unit tests', '--capture');
  assert.match(e2, /^E2 /);
  const shown = await stored(rec, 'feat');
  const [first, second] = shown.evidence;
  assert.equal(first.reportedBy, 'pi-1');
  assert.deepEqual(first.observations.map(o => [o.kind, o.by]), [['inspected', 'owner']]);
  assert.equal(second.reproduces, 'E1');
  assert.notEqual(second.subject.content.digest, first.subject.content.digest);
  assert.equal(second.environment, null, 'a reproduction does not inherit the environment claim');

  // The checkout writer and implementer change; accountability and the parent stay.
  await ok(rec, 'owner', 'transfer', 'feat', '--role', 'writer', '--to', 'pi-2', '--expect-rev', '3', '--note', 'exact prepared checkout');
  await ok(rec, 'owner', 'transfer', 'feat', '--role', 'implementer', '--to', 'pi-2', '--expect-rev', '4');
  const after = (await stored(rec, 'feat')).assignment;
  assert.equal(after.accountable.actor, 'owner');
  assert.equal(after.parent, 'parent');
  assert.equal(after.checkout.writer, 'pi-2');
  assert.equal(after.implementer.session, 'pi-2');
  assert.equal((await stored(rec, 'parent')).assignment.accountable.actor, 'root');

  // Map and handoff are views of the same record and agree.
  const map = await ok(rec, 'viewer', 'map');
  const handoff = await ok(rec, 'viewer', 'handoff', 'feat');
  const strip = text => text.replace(/^(- (Accountable|Implementer|Checkout)|.*generated|Generated).*$/gm, '');
  assert.equal(strip(section(map, 'feat')).trim(), strip(section(handoff, 'feat')).trim());
  assert.match(map, /\| feat \| parent \| owner \| pi-2 \| pi-2 @ /);
  assert.match(handoff, /Accountable: owner/);
  assert.match(handoff, /reproduction E2: pass by reviewer on its own subject/);
});

test('receipt and unknown subjects never take the current checkout identity; failed capture records nothing', async () => {
  const src = repo();
  const rec = record();
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'cand', '--title', 'Candidate', '--accountable', 'root');
  await ok(rec, 'root', 'checkout', 'cand', '--path', src, '--cover', 'src', '--writer', 'pi-3', '--expect-rev', '1');
  const receipt = join(dir, 'manifest.json');
  writeFileSync(receipt, '{"tree":"abc"}\n');
  const log = join(dir, 'tests.log');
  writeFileSync(log, '9 passed\n');
  write(src, 'src/a.txt', 'moved on\n');
  await ok(rec, 'pi-3', 'evidence', 'cand', '--check', 'storage', '--result', 'pass', '--scope', 'combined tree storage suite',
    '--receipt', receipt, '--stated-identity', 'tree abc', '--ref', log);
  await ok(rec, 'night', 'inspect', 'E1');
  await ok(rec, 'resources', 'inspect', 'E1');
  let view = await ok(rec, 'viewer', 'handoff', 'cand');
  assert.match(view, /receipt .*manifest\.json unchanged; reported identity "tree abc" \(not captured here\); source not compared/);
  assert.match(view, /inspected by night .*; inspected by resources/);
  const item = (await stored(rec, 'cand')).evidence[0];
  assert.equal(item.subject.kind, 'receipt');
  assert.equal(item.subject.head, undefined);
  appendFileSync(receipt, ' ');
  assert.match(await ok(rec, 'viewer', 'handoff', 'cand'), /manifest\.json changed since recorded/);

  assert.equal((await cli(rec, 'pi-3', 'evidence', 'cand', '--check', 'x', '--result', 'pass', '--scope', 's')).code, 2, 'subject must be named');
  await ok(rec, 'pi-3', 'evidence', 'cand', '--check', 'old', '--result', 'pass', '--scope', 'relayed', '--subject-unknown');
  rmSync(src, { recursive: true });
  const failed = await cli(rec, 'pi-3', 'evidence', 'cand', '--check', 'y', '--result', 'pass', '--scope', 's', '--capture');
  assert.equal(failed.code, 2);
  assert.match(failed.out, /capture failed: .*nothing was recorded/);
  const shown = await stored(rec, 'cand');
  assert.equal(shown.evidence.length, 2);
  view = await ok(rec, 'viewer', 'handoff', 'cand');
  assert.match(view, /E2 old: pass.*\n.*\n  - Subject: subject unknown/);
});

test('source capture: explicit coverage, flags, symlinks, unmerged, unborn and filters, without touching the repository', async () => {
  const src = repo({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'src/link': 'placeholder', 'other/o.txt': 'o\n', '.gitignore': 'src/*.log\n' });
  rmSync(join(src, 'src/link'));
  symlinkSync('a.txt', join(src, 'src/link'));
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'link');
  const gitDir = join(src, '.git');
  const repoState = () => [readFileSync(join(gitDir, 'index')).toString('hex'), execFileSync('find', [gitDir, '-type', 'f']).toString()];

  const base = await captureSource(src, ['src']);
  assert.equal(base.observations, 'two-matched');
  assert.equal(base.changes.length, 0);
  assert.deepEqual(await captureSource(src, ['src']).then(c => c.content.digest), base.content.digest);

  // Flags that hide changes from Git do not hide them here.
  git(src, 'update-index', '--assume-unchanged', 'src/a.txt');
  git(src, 'update-index', '--skip-worktree', 'src/b.txt');
  write(src, 'src/a.txt', 'a changed\n');
  write(src, 'src/b.txt', 'b changed\n');
  write(src, 'src/ignored.log', 'ignored\n');
  write(src, 'other/new.txt', 'outside coverage\n');
  const stateBefore = repoState();
  const flagged = await captureSource(src, ['src']);
  // The repository was not written: same index bytes and the same files under .git.
  assert.deepEqual(repoState(), stateBefore);
  assert.deepEqual(flagged.changes.map(c => c.path), ['src/a.txt', 'src/b.txt']);
  assert.deepEqual(flagged.index.assumeUnchanged, ['src/a.txt']);
  assert.deepEqual(flagged.index.skipWorktree, ['src/b.txt']);
  assert.equal((await compareCaptures(base, flagged)).status, 'content-differs');
  assert.doesNotMatch(git(src, 'status', '--porcelain'), /src\//, 'git itself sees nothing in src, which is why bytes are hashed here');
  git(src, 'update-index', '--no-assume-unchanged', 'src/a.txt');
  git(src, 'update-index', '--no-skip-worktree', 'src/b.txt');

  // A directory replaced by a symlink to outside content is a gap, not a read through the link.
  const outside = join(dir, `outside${++n}`);
  mkdirSync(outside);
  writeFileSync(join(outside, 'a.txt'), 'outside\n');
  rmSync(join(src, 'other'), { recursive: true });
  symlinkSync(outside, join(src, 'other'));
  const linked = await captureSource(src, ['other']);
  assert.deepEqual(linked.gaps.unreadable.map(g => g.path), ['other/o.txt']);
  assert.ok(!JSON.stringify(linked.changes).includes('outside'));
  // A leaf symlink is source: its link text is hashed.
  assert.ok(base.content.files >= 3);


  // A clean filter selected by attributes is never run.
  const filtered = repo({ 'src/a.txt': 'a\n', '.gitattributes': 'src/*.txt filter=marker\n' });
  const marker = join(dir, `marker${n}`);
  git(filtered, 'config', 'filter.marker.clean', `touch ${marker}; cat`);
  write(filtered, 'src/a.txt', 'changed\n');
  const f = await captureSource(filtered, ['src']);
  assert.ok(!existsSync(marker), 'the clean filter did not run');
  assert.match(f.notes.join(' '), /filter or eol attributes/);

  // Unborn HEAD and an unmerged index are reported, not hidden.
  const unborn = join(dir, `unborn${++n}`);
  mkdirSync(unborn);
  git(unborn, 'init', '-q');
  write(unborn, 'src/a.txt', 'a\n');
  const u = await captureSource(unborn, ['src']);
  assert.equal(u.head, null);
  assert.deepEqual(u.content.untracked, ['src/a.txt']);
  const conflict = repo({ 'src/a.txt': 'base\n' });
  git(conflict, 'checkout', '-qb', 'other');
  write(conflict, 'src/a.txt', 'other\n');
  git(conflict, 'commit', '-qam', 'other');
  git(conflict, 'checkout', '-q', 'main');
  write(conflict, 'src/a.txt', 'main\n');
  git(conflict, 'commit', '-qam', 'main');
  try { git(conflict, 'merge', '-q', 'other'); } catch { /* conflict expected */ }
  const c = await captureSource(conflict, ['src']);
  assert.deepEqual(c.index.unmerged, ['src/a.txt']);
  assert.match(c.inProgress.merge, /^[0-9a-f]{40}$/);

  // Committing a tested deletion or rename leaves the covered content the same; mode changes are changes.
  const moves = repo({ 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'src/run.sh': 'echo\n' });
  const clean = await captureSource(moves, ['src']);
  rmSync(join(moves, 'src/a.txt'));
  git(moves, 'mv', 'src/b.txt', 'src/renamed.txt');
  const tested = await captureSource(moves, ['src']);
  assert.deepEqual(tested.content.missing, ['src/a.txt']);
  git(moves, 'add', '-A');
  git(moves, 'commit', '-qm', 'delete and rename');
  const committed = await compareCaptures(tested, await captureSource(moves, ['src']));
  assert.equal(committed.status, 'content-same-identity-changed', JSON.stringify(committed));
  assert.deepEqual((await compareCaptures(clean, tested)).changedPaths, ['src/a.txt', 'src/b.txt', 'src/renamed.txt']);
  const beforeMode = await captureSource(moves, ['src']);
  execFileSync('chmod', ['755', join(moves, 'src/run.sh')]);
  const afterMode = await captureSource(moves, ['src']);
  assert.deepEqual(afterMode.changes.map(c => [c.path, c.worktree.split(' ')[0], c.head.split(' ')[0]]), [['src/run.sh', '100755', '100644']]);
  assert.deepEqual((await compareCaptures(beforeMode, afterMode)).changedPaths, ['src/run.sh']);
  git(moves, 'add', '-A');
  git(moves, 'commit', '-qm', 'exec');
  assert.equal((await compareCaptures(afterMode, await captureSource(moves, ['src']))).status, 'content-same-identity-changed');

  await assert.rejects(captureSource(src, []), /coverage paths are required/);
  await assert.rejects(captureSource(src, ['../elsewhere']), /outside the checkout/);
});

test('concurrent writers: appends all survive, stale transfers and pins refuse with the current state', async () => {
  const rec = record();
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'a', '--title', 'A', '--accountable', 'root', '--implementer', 'pi-1');
  await Promise.all(Array.from({ length: 16 }, (_, i) =>
    ok(rec, `w${i}`, 'evidence', 'a', '--check', `c${i}`, '--result', 'pass', '--scope', 's', '--subject-unknown')));
  const shown = await stored(rec, 'a');
  assert.equal(shown.evidence.length, 16);
  assert.deepEqual(new Set(shown.evidence.map(e => e.reportedBy)).size, 16);
  assert.equal(shown.assignment.rev, 1, 'appends do not move the assignment revision');

  const rev = await revOf(rec, 'a');
  const results = await Promise.all(['x', 'y'].map(to => cli(rec, to, 'transfer', 'a', '--role', 'accountable', '--to', to, '--expect-rev', String(rev))));
  assert.deepEqual(results.map(r => r.code).sort(), [0, 3]);
  const refused = results.find(r => r.code === 3).out;
  assert.match(refused, /conflict: a is at rev 2, not 1\. Current: accountable (x|y); implementer pi-1/);
  const pins = await Promise.all(['p', 'q'].map(label => cli(rec, 'root', 'depend', 'a', '--on', label, '--kind', 'awaits-handoff', '--expect-rev', '2')));
  assert.deepEqual(pins.map(r => r.code).sort(), [0, 3]);
  assert.equal((await stored(rec, 'a')).assignment.dependencies.length, 1);
  assert.equal((await cli(rec, 'root', 'transfer', 'a', '--role', 'implementer', '--to', 'z')).code, 2, '--expect-rev is required');
});

test('locks, malformed state, aliases and recovery fail clearly and never reset the record', async () => {
  const rec = record();
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'a', '--title', 'A', '--accountable', 'root');
  const before = readFileSync(rec, 'utf8');

  // A lock left by a dead writer: refused, with the exact recovery command.
  writeFileSync(`${rec}.lock`, JSON.stringify({ token: 'tok-1', pid: 999999, host: (await import('node:os')).hostname(), at: 'then', actor: 'ghost', command: 'transfer' }));
  const locked = await cli(rec, 'root', 'update', 'a', '--title', 'B', '--expect-rev', '1');
  assert.equal(locked.code, 4);
  assert.match(locked.out, /held by ghost \(pid 999999, not running\).*unlock --token tok-1/);
  assert.equal((await cli(rec, 'root', 'unlock', '--token', 'wrong')).code, 4);
  writeFileSync(`${rec}.lock.recover`, '');
  assert.match((await cli(rec, 'root', 'unlock', '--token', 'tok-1')).out, /another recovery is in progress/);
  rmSync(`${rec}.lock.recover`);
  await ok(rec, 'root', 'unlock', '--token', 'tok-1');
  // A holder still running here is never removed.
  writeFileSync(`${rec}.lock`, JSON.stringify({ token: 'tok-2', pid: process.pid, host: (await import('node:os')).hostname(), at: 'now' }));
  assert.match((await cli(rec, 'root', 'unlock', '--token', 'tok-2')).out, /still running on this host; not removed/);
  rmSync(`${rec}.lock`);
  writeFileSync(`${rec}.lock`, '');
  assert.match((await cli(rec, 'root', 'update', 'a', '--title', 'B', '--expect-rev', '1')).out, /no holder details/);
  rmSync(`${rec}.lock`);
  assert.equal(readFileSync(rec, 'utf8'), before);

  // A successful write keeps the previous generation; no temp files remain.
  await ok(rec, 'root', 'update', 'a', '--title', 'B', '--expect-rev', '1');
  assert.equal(readFileSync(`${rec}.prev`, 'utf8'), before);
  assert.deepEqual(readdirSync(join(rec, '..')).sort(), ['record.json', 'record.json.prev']);
  assert.equal((readFileSync(rec).length > 0), true);

  // Malformed or unsupported state is an error for reads and writes, and stays as it was.
  writeFileSync(rec, '{"schema": 1, "rev": 3, "assignments": {');
  for (const args of [['show', 'a'], ['update', 'a', '--title', 'C', '--expect-rev', '2'], ['map']]) {
    const result = await cli(rec, 'root', ...args);
    assert.equal(result.code, 5, result.out);
    assert.match(result.out, /malformed record .*left unchanged/);
  }
  assert.equal(readFileSync(rec, 'utf8'), '{"schema": 1, "rev": 3, "assignments": {');
  writeFileSync(rec, JSON.stringify({ schema: 2, rev: 0, assignments: {}, evidence: {} }));
  assert.match((await cli(rec, 'root', 'map')).out, /unsupported schema 2/);
  // Parseable but structurally broken: refused before any write, so it never rotates into .prev.
  const broken = JSON.stringify({ schema: 1, rev: 1, assignments: { broken: { id: 'broken', rev: 1 } }, evidence: {} });
  writeFileSync(rec, broken);
  for (const args of [['assign', 'new', '--title', 'New', '--accountable', 'o'], ['map']]) {
    const result = await cli(rec, 'root', ...args);
    assert.equal(result.code, 5, result.out);
    assert.match(result.out, /assignment broken has an invalid title/);
  }
  assert.equal(readFileSync(rec, 'utf8'), broken);
  // Recovery is a deliberate copy of the previous generation, not automatic.
  writeFileSync(rec, readFileSync(`${rec}.prev`));
  assert.equal((await stored(rec, 'a')).assignment.title, 'A');

  // File-level aliases would split the lock; records inside a repository are refused.
  const alias = join(dir, `alias${++n}.json`);
  symlinkSync(rec, alias);
  assert.match((await cli(alias, 'root', 'map')).out, /is a symlink; use its target/);
  const hard = join(rec, '..', 'hard.json');
  linkSync(rec, hard);
  assert.match((await cli(rec, 'root', 'map')).out, /2 hard links/);
  rmSync(hard);
  const inRepo = join(repo(), 'record.json');
  assert.match((await cli(inRepo, 'root', 'init')).out, /inside a Git work tree/);
  assert.equal(existsSync(inRepo), false);
});

test('pinned inputs show upstream movement without importing it; shared checkouts are flagged across aliases', async () => {
  const upstream = repo({ 'lib.txt': '1\n' });
  const pinned = git(upstream, 'rev-parse', 'HEAD');
  const patch = join(dir, 'frozen.patch');
  writeFileSync(patch, 'diff --git a/x b/x\n');
  const rec = record();
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'combined', '--title', 'Combined candidate', '--accountable', 'integrator');
  await ok(rec, 'integrator', 'pin', 'combined', '--label', 'upstream', '--repo', upstream, '--commit', 'main', '--track', 'main', '--expect-rev', '1');
  await ok(rec, 'integrator', 'pin', 'combined', '--label', 'feature-patch', '--receipt', patch, '--note', 'frozen; later feature patches excluded', '--expect-rev', '2');
  await ok(rec, 'integrator', 'depend', 'combined', '--on', 'resource-slot', '--kind', 'slot-order', '--note', 'after the storage run', '--expect-rev', '3');
  write(upstream, 'lib.txt', '2\n');
  git(upstream, 'commit', '-qam', 'moved');
  const view = await ok(rec, 'viewer', 'handoff', 'combined');
  assert.match(view, new RegExp(`Pinned input upstream: .* @ ${pinned.slice(0, 12)}; main has moved to [0-9a-f]{12} \\(not included\\)`));
  assert.match(view, /Pinned input feature-patch: receipt .*frozen\.patch unchanged; frozen; later feature patches excluded/);
  assert.match(view, /Dependency \(slot-order\): resource-slot \(external\): after the storage run/);
  assert.equal((await stored(rec, 'combined')).assignment.inputs[0].commit, pinned);

  const shared = repo();
  const alias = join(dir, `shared-alias${++n}`);
  symlinkSync(shared, alias);
  await ok(rec, 'root', 'assign', 'one', '--title', 'One', '--accountable', 'root');
  await ok(rec, 'root', 'assign', 'two', '--title', 'Two', '--accountable', 'root');
  await ok(rec, 'root', 'checkout', 'one', '--path', shared, '--cover', 'src', '--writer', 'pi-a', '--expect-rev', '1');
  await ok(rec, 'root', 'checkout', 'two', '--path', alias, '--cover', 'src', '--writer', 'pi-b', '--expect-rev', '1');
  const map = await ok(rec, 'viewer', 'map');
  assert.match(map, /Flag: checkout .* is claimed by one \(writer pi-a\) and two \(writer pi-b\)/);
});

test('an observation is not paired with a brief or checkout that changed while it was being taken', async () => {
  const src = repo();
  const rec = record();
  const brief = join(dir, `brief${++n}.md`);
  writeFileSync(brief, 'v1\n');
  await ok(rec, 'root', 'init');
  await ok(rec, 'root', 'assign', 'a', '--title', 'A', '--accountable', 'root', '--brief', brief);
  await ok(rec, 'root', 'checkout', 'a', '--path', src, '--cover', 'src', '--writer', 'pi-1', '--expect-rev', '1');
  // Another writer holds the lock while the evidence command observes the source and then waits for the lock.
  writeFileSync(`${rec}.lock`, JSON.stringify({ token: 'other', pid: process.pid, host: 'here', at: 'now', command: 'update' }));
  const pending = cli(rec, 'pi-1', 'evidence', 'a', '--check', 'unit', '--result', 'pass', '--scope', 's', '--capture');
  await new Promise(done => setTimeout(done, 1200));
  const current = JSON.parse(readFileSync(rec, 'utf8'));
  current.assignments.a.brief.sha256 = 'f'.repeat(64);
  current.assignments.a.rev += 1;
  current.assignments.a.history.push({ rev: current.assignments.a.rev, at: 'now', by: 'other', change: 'brief changed' });
  writeFileSync(rec, JSON.stringify(current));
  rmSync(`${rec}.lock`);
  const result = await pending;
  assert.equal(result.code, 3, result.out);
  assert.match(result.out, /changed \(rev 2 -> 3\) while the evidence subject was being observed; nothing was recorded/);
  assert.equal((await stored(rec, 'a')).evidence.length, 0);
});

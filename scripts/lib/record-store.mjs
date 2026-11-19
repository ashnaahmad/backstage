// The coordination record's only write path: an exclusive lock around read-validate-modify-write, an atomic
// replace (temp file, fsync, rename, directory fsync) and one previous generation kept beside it.
//
// The lock is never reclaimed automatically: a holder that died leaves a lock that `unlock --token` removes once
// someone has checked that no write is in progress. Unreadable or malformed state is an error, never a reset.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const SCHEMA = 1;

export class RecordError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

/** One canonical spelling of the record path, so aliases of its directory share one lock. */
export async function canonicalRecordPath(path) {
  let dir;
  try { dir = await realpath(dirname(path)); } catch (error) {
    throw new RecordError(`record directory unreadable: ${dirname(path)} (${error.code})`, 'io');
  }
  const canonical = join(dir, basename(path));
  // The record is replaced by rename, which would turn a file-level alias into a second, separate record and give
  // it a different lock. Refuse aliases instead of following them.
  let stat;
  try { stat = await lstat(canonical); } catch (error) {
    if (error.code === 'ENOENT') return canonical;
    throw new RecordError(`record unreadable: ${canonical} (${error.code})`, 'io');
  }
  if (stat.isSymbolicLink()) {
    const target = await realpath(canonical).catch(() => 'an unreadable target');
    throw new RecordError(`record path ${canonical} is a symlink; use its target ${target} directly`, 'location');
  }
  if (!stat.isFile()) throw new RecordError(`record path ${canonical} is not a regular file`, 'location');
  if (stat.nlink > 1) throw new RecordError(`record ${canonical} has ${stat.nlink} hard links; keep a single name so every writer shares one lock`, 'location');
  return canonical;
}

/** Operational state stays out of repositories: refuse a record inside a Git work tree. */
function refuseInsideRepository(path) {
  try {
    const inside = execFileSync('git', ['-C', dirname(path), 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).toString().trim();
    if (inside === 'true') throw new RecordError(`refusing a record inside a Git work tree (${dirname(path)}); keep operational state outside repositories`, 'location');
  } catch (error) {
    if (error instanceof RecordError) throw error;
  }
}

const isText = value => typeof value === 'string' && value.length > 0;
const isTime = value => isText(value) && !Number.isNaN(Date.parse(value));
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isRef = value => isObject(value) && isText(value.path) && /^[0-9a-f]{64}$/.test(value.sha256 ?? '');
const DEPENDENCY_KINDS = ['includes', 'awaits-handoff', 'slot-order', 'note'];

/** Why an assignment cannot be used by the commands and views, or null. */
function assignmentProblem(a, record) {
  if (!isText(a.title)) return 'title';
  if (a.parent !== null && !record.assignments[a.parent]) return 'parent';
  if (a.brief !== null && !isRef(a.brief)) return 'brief';
  if (!isObject(a.accountable) || !isText(a.accountable.actor) || !isTime(a.accountable.since)) return 'accountable';
  if (a.implementer !== null && (!isObject(a.implementer) || !isText(a.implementer.session))) return 'implementer';
  if (a.checkout !== null && (!isObject(a.checkout) || !isText(a.checkout.path) || !isText(a.checkout.writer)
    || !Array.isArray(a.checkout.coverage) || !a.checkout.coverage.length || !a.checkout.coverage.every(isText))) return 'checkout';
  if (a.status !== null && (!isObject(a.status) || !isText(a.status.text) || (a.status.ref !== null && !isRef(a.status.ref)))) return 'status';
  if (!Array.isArray(a.dependencies) || !a.dependencies.every(d => isObject(d) && isText(d.on) && DEPENDENCY_KINDS.includes(d.kind))) return 'dependencies';
  if (!Array.isArray(a.inputs) || !a.inputs.every(i => isObject(i) && isText(i.label)
    && (isRef(i.receipt) || (isText(i.repo) && /^[0-9a-f]{40,64}$/.test(i.commit ?? ''))))) return 'inputs';
  if (!Array.isArray(a.history) || !a.history.length || !a.history.every(h => isObject(h) && Number.isSafeInteger(h.rev) && isText(h.by) && isText(h.change))
    || a.history.at(-1).rev !== a.rev) return 'history';
  return null;
}

function subjectProblem(s) {
  if (!isObject(s)) return true;
  if (s.kind === 'unknown') return false;
  if (s.kind === 'receipt') return !isRef(s.receipt);
  if (s.kind !== 'captured') return true;
  return !isText(s.checkout) || !Array.isArray(s.coverage) || !isTime(s.capturedAt) || !isObject(s.content) || !isText(s.content.digest)
    || !isObject(s.index) || !isText(s.index.digest) || !Array.isArray(s.changes) || !isObject(s.gaps)
    || !Array.isArray(s.gaps.submodules) || !Array.isArray(s.gaps.unreadable) || !isText(s.observations) || !isObject(s.inProgress);
}

function evidenceProblem(e, record) {
  if (!record.assignments[e.assignment]) return 'assignment';
  for (const key of ['check', 'result', 'scope', 'reportedBy']) if (!isText(e[key])) return key;
  if (!isTime(e.reportedAt)) return 'reportedAt';
  if (!Array.isArray(e.exclusions) || !Array.isArray(e.references) || !e.references.every(isRef)) return 'exclusions or references';
  if (!Array.isArray(e.observations) || !e.observations.every(o => isObject(o) && isText(o.kind) && isText(o.by))) return 'observations';
  if (e.reproduces !== null && !record.evidence[e.reproduces]) return 'reproduces';
  if (subjectProblem(e.subject)) return 'subject';
  return null;
}

/** The record's shape as the commands and views use it; anything else is malformed and left as it is. */
export function validate(record, path) {
  const fail = why => { throw new RecordError(`malformed record ${path}: ${why}; it was left unchanged`, 'malformed'); };
  if (!isObject(record)) fail('not a JSON object');
  if (record.schema !== SCHEMA) fail(`unsupported schema ${JSON.stringify(record.schema)} (this CLI reads ${SCHEMA})`);
  if (!Number.isSafeInteger(record.rev) || record.rev < 0) fail('rev is not a whole number');
  for (const key of ['assignments', 'evidence']) if (!isObject(record[key])) fail(`${key} is not an object`);
  for (const [id, a] of Object.entries(record.assignments)) {
    if (!isObject(a) || a.id !== id || !Number.isSafeInteger(a.rev)) fail(`assignment ${id} lacks its id or rev`);
    const problem = assignmentProblem(a, record);
    if (problem) fail(`assignment ${id} has an invalid ${problem}`);
  }
  for (const [id, e] of Object.entries(record.evidence)) {
    if (!isObject(e) || e.id !== id) fail(`evidence ${id} lacks its id`);
    const problem = evidenceProblem(e, record);
    if (problem) fail(`evidence ${id} has an invalid ${problem}`);
  }
  return record;
}

async function readText(path) {
  try { return await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new RecordError(`record unreadable: ${path} (${error.code})`, 'io');
  }
}

export async function readRecord(path) {
  const text = await readText(path);
  if (text === null) throw new RecordError(`no record at ${path}; create one with init`, 'missing');
  let record;
  try { record = JSON.parse(text); } catch (error) {
    throw new RecordError(`malformed record ${path}: ${error.message}; it was left unchanged`, 'malformed');
  }
  return validate(record, path);
}

const sleep = ms => new Promise(done => setTimeout(done, ms));
const lockPath = path => `${path}.lock`;

function processRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM' ? true : false; }
}

const RECORD_UNLOCK = 'coordination-record.mjs unlock';

async function describeHolder(path, unlockCommand = RECORD_UNLOCK) {
  const text = await readText(lockPath(path)).catch(() => null);
  if (text === null) return 'the lock disappeared while waiting';
  let holder;
  try { holder = JSON.parse(text); } catch {
    return `the lock ${lockPath(path)} has no holder details (a writer may have died while creating it); `
      + 'check that no write is in progress, then remove that file';
  }
  const alive = holder.host === hostname() ? (processRunning(holder.pid) ? 'running' : 'not running') : `on host ${holder.host}`;
  return `held by ${holder.actor ?? 'unknown actor'} (pid ${holder.pid}, ${alive}) since ${holder.at} for "${holder.command}"; `
    + `if no write is in progress, run: ${unlockCommand} --token ${holder.token}`;
}

/**
 * The exclusive lock beside `path` (`<path>.lock`), shared with other local state files that need the same
 * contract: never reclaimed automatically; `unlock` removes a dead holder's lock by token.
 */
export async function acquireLock(path, details, { timeoutMs, unlockCommand } = {}) {
  return acquire(path, details, { timeoutMs, unlockCommand });
}

export async function releaseLock(path, token) {
  return release(path, token);
}

async function acquire(path, details, { timeoutMs: requested, unlockCommand } = {}) {
  const token = randomUUID();
  const timeoutMs = requested ?? Number(process.env.COORDINATION_LOCK_TIMEOUT_MS ?? 10_000);
  const deadline = Date.now() + timeoutMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    let handle;
    try {
      handle = await open(lockPath(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw new RecordError(`cannot create lock ${lockPath(path)} (${error.code})`, 'io');
      if (Date.now() >= deadline) throw new RecordError(`${unlockCommand ? 'state' : 'record'} is locked: ${await describeHolder(path, unlockCommand)}`, 'locked');
      await sleep(wait + Math.floor(Math.random() * wait));
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), at: new Date().toISOString(), ...details }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return token;
  }
}

async function release(path, token) {
  const text = await readText(lockPath(path)).catch(() => null);
  try {
    if (text && JSON.parse(text).token === token) await unlink(lockPath(path));
  } catch { /* someone else's lock or already gone: leave it */ }
}

/**
 * Remove a lock left by a dead writer, only when the caller names its token. Recoverers serialize on a second
 * exclusive file, so two of them cannot both pass the token check and the second remove a newer writer's lock;
 * a holder still running on this host is never removed.
 */
export async function unlock(path, token) {
  let guard;
  try {
    guard = await open(`${lockPath(path)}.recover`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new RecordError(`another recovery is in progress (${lockPath(path)}.recover); if none is, remove that file`, 'locked');
    throw new RecordError(`cannot create ${lockPath(path)}.recover (${error.code})`, 'io');
  }
  try {
    const text = await readText(lockPath(path));
    if (text === null) throw new RecordError(`${path} is not locked`, 'missing');
    let holder;
    try { holder = JSON.parse(text); } catch { throw new RecordError(`lock ${lockPath(path)} has no token; remove it by hand after checking no write is in progress`, 'locked'); }
    if (holder.token !== token) throw new RecordError(`lock token does not match (held: ${holder.token})`, 'locked');
    if (holder.host === hostname() && processRunning(holder.pid)) {
      throw new RecordError(`the lock holder (pid ${holder.pid}) is still running on this host; not removed`, 'locked');
    }
    await unlink(lockPath(path));
  } finally {
    await guard.close();
    await unlink(`${lockPath(path)}.recover`).catch(() => {});
  }
}

async function writeDurably(path, text) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/**
 * Apply `mutate(record)` under the lock and replace the record atomically. `mutate` may throw a RecordError
 * (a conflict, say) to abandon the write; its return value is passed back. A missing record is created only
 * when `create` is set.
 */
export async function updateRecord(path, mutate, { actor, command, create = false } = {}) {
  refuseInsideRepository(path);
  const token = await acquire(path, { actor, command });
  try {
    await canonicalRecordPath(path); // the alias checks again, now that the lock is held
    const previous = await readText(path);
    let record;
    if (previous === null) {
      if (!create) throw new RecordError(`no record at ${path}; create one with init`, 'missing');
      record = { schema: SCHEMA, rev: 0, createdAt: new Date().toISOString(), assignments: {}, evidence: {} };
    } else {
      if (create) throw new RecordError(`a record already exists at ${path}`, 'exists');
      try { record = JSON.parse(previous); } catch (error) {
        throw new RecordError(`malformed record ${path}: ${error.message}; it was left unchanged`, 'malformed');
      }
      validate(record, path);
    }
    const result = await mutate(record);
    record.rev += 1;
    validate(record, path);
    const temp = `${path}.tmp-${token}`;
    const prevTemp = `${path}.prev.tmp-${token}`;
    try {
      await writeDurably(temp, `${JSON.stringify(record, null, 2)}\n`);
      if (previous !== null) {
        await writeDurably(prevTemp, previous);
        await rename(prevTemp, `${path}.prev`);
      }
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      await unlink(prevTemp).catch(() => {});
      throw error instanceof RecordError ? error : new RecordError(`record write failed (${error.code ?? error.message}); the previous record is unchanged`, 'io');
    }
    try { await syncDirectory(path); } catch (error) {
      throw new RecordError(`record replaced, but the directory sync failed (${error.code}); re-read before retrying`, 'io');
    }
    return { result, rev: record.rev };
  } finally {
    await release(path, token);
  }
}

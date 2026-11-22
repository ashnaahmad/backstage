#!/usr/bin/env node
// A local coordination record for delegated work: who is accountable, which session implements, who writes the
// checkout, how assignments depend on each other, the current blocker or handoff, and evidence with its subject and
// provenance. The session map and handoff summaries are generated from it. Git and the files themselves supply
// source state; see scripts/lib/source-identity.mjs. Actors are self-reported, not authenticated.
//
// Record: --record <file> or COORDINATION_RECORD (outside any repository). Actor: --as <name> or COORDINATION_ACTOR.
// Run without arguments for usage.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { captureSource, compareCaptures, CaptureError } from './lib/source-identity.mjs';
import { canonicalRecordPath, readRecord, RecordError, unlock, updateRecord } from './lib/record-store.mjs';

const USAGE = `usage: coordination-record.mjs <command> [options]   (--record <file>, --as <actor> or env)

  init
  assign <id> --title <t> --accountable <actor> [--implementer <session>] [--parent <id>] [--brief <file>]
  update <id> --expect-rev <n> [--title <t>] [--brief <file>] [--parent <id> | --no-parent]
                [--status <text> [--status-ref <file>] | --clear-status]
  transfer <id> --role accountable|implementer|writer --to <name> --expect-rev <n> [--note <text>]
  checkout <id> --path <dir> --cover <path>... --expect-rev <n> [--writer <name>]
  depend <id> --on <id|label> --kind includes|awaits-handoff|slot-order|note [--note <text>] --expect-rev <n>
  undepend <id> --on <id|label> --kind <kind> --expect-rev <n>
  pin <id> --label <l> (--repo <dir> --commit <rev> [--track <ref>] | --receipt <file>) [--note <text>] --expect-rev <n>
  unpin <id> --label <l> --expect-rev <n>
  evidence <id> --check <name> --result <word> --scope <text> [--env <text>] [--exclusion <text>]... [--ref <file>]...
                (--capture | --receipt <file> [--stated-identity <text>] | --subject-unknown)
  inspect <evidence-id> [--note <text>]
  reproduce <evidence-id> --result <word> --scope <text> [--env <text>] [--exclusion <text>]... [--ref <file>]...
                (--capture | --receipt <file> [--stated-identity <text>] | --subject-unknown)
  capture --path <dir> --cover <path>...          print a source identity (no record needed)
  show <id> [--json]   map [--json]   handoff <id>
  brief [<id>] [--session <native session id>] [--json]
                the current brief to restore into an implementing session; without <id>, the assignment
                whose recorded implementer is exactly that session id (names are not matched)
  unlock --token <token>`;

const ROLES = { accountable: 'accountable', implementer: 'implementer', writer: 'checkout writer' };
const KINDS = ['includes', 'awaits-handoff', 'slot-order', 'note'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REPEATABLE = new Set(['cover', 'exclusion', 'ref']);
const FLAGS = new Set(['capture', 'subject-unknown', 'json', 'no-parent', 'clear-status']);

class UsageError extends Error {}

export function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2);
    if (FLAGS.has(name)) { options[name] = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (REPEATABLE.has(name)) (options[name] ??= []).push(value);
    else if (name in options) throw new UsageError(`--${name} given twice`);
    else options[name] = value;
  }
  return { positional, options };
}

const now = () => new Date().toISOString();
const short = sha => (sha ? sha.slice(0, 12) : 'none');

async function fileRef(path) {
  let real;
  let bytes;
  try { real = await realpath(path); bytes = await readFile(real); } catch (error) {
    throw new UsageError(`cannot read ${path} (${error.code})`);
  }
  return { path: real, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function refStatus(ref) {
  try {
    const bytes = await readFile(ref.path);
    return createHash('sha256').update(bytes).digest('hex') === ref.sha256 ? 'unchanged' : 'changed since recorded';
  } catch (error) {
    return `unreadable now (${error.code})`;
  }
}

function needRev(options) {
  if (options['expect-rev'] === undefined) throw new UsageError('this change replaces recorded state: pass --expect-rev <n> (see show <id>)');
  const rev = Number(options['expect-rev']);
  if (!Number.isSafeInteger(rev)) throw new UsageError('--expect-rev needs a whole number');
  return rev;
}

function getAssignment(record, id) {
  const assignment = record.assignments[id];
  if (!assignment) throw new RecordError(`no assignment ${id}`, 'missing');
  return assignment;
}

function roleSummary(a) {
  return `accountable ${a.accountable.actor}; implementer ${a.implementer?.session ?? 'none'}; `
    + `checkout ${a.checkout ? `${a.checkout.path} written by ${a.checkout.writer}` : 'none'}`;
}

/** The stale-write refusal: name the current state so the caller can decide, rather than overwrite it. */
function checkRev(assignment, expected) {
  if (assignment.rev === expected) return;
  const last = assignment.history.at(-1);
  throw new RecordError(`conflict: ${assignment.id} is at rev ${assignment.rev}, not ${expected}. `
    + `Current: ${roleSummary(assignment)}. Last change (rev ${last.rev}) by ${last.by} at ${last.at}: ${last.change}. `
    + 'Re-read with show and retry only if your change still applies.', 'conflict');
}

function change(assignment, actor, text) {
  assignment.rev += 1;
  assignment.history.push({ rev: assignment.rev, at: now(), by: actor, change: text });
}

async function subjectFrom(options, record, assignment) {
  const chosen = ['capture', 'receipt', 'subject-unknown'].filter(key => options[key] !== undefined);
  if (chosen.length !== 1) throw new UsageError('name the evidence subject: exactly one of --capture, --receipt <file>, --subject-unknown');
  if (options.capture) {
    if (!assignment.checkout) throw new UsageError(`${assignment.id} has no checkout to capture; set one with checkout, or use --receipt/--subject-unknown`);
    try {
      return await captureSource(assignment.checkout.path, assignment.checkout.coverage);
    } catch (error) {
      if (error instanceof CaptureError) throw new UsageError(`capture failed: ${error.message}; nothing was recorded (use --receipt or --subject-unknown to record without a capture)`);
      throw error;
    }
  }
  if (options.receipt) {
    return { kind: 'receipt', receipt: await fileRef(options.receipt), statedIdentity: options['stated-identity'] ?? null };
  }
  return { kind: 'unknown' };
}

/**
 * The claim's context (brief and checkout) is that of the assignment when the subject was observed. If a replacing
 * change landed in between, refuse rather than pair an old observation with a newer brief or checkout.
 */
function checkObservedContext(assignment, context) {
  if (assignment.rev === context.rev) return;
  throw new RecordError(`conflict: ${assignment.id} changed (rev ${context.rev} -> ${assignment.rev}) while the evidence subject was being observed; `
    + 'nothing was recorded. Re-read with show and record the evidence again if it still applies.', 'conflict');
}

async function evidenceFields(options, assignment, actor) {
  for (const key of ['result', 'scope']) if (!options[key]) throw new UsageError(`--${key} is required`);
  if (!/^[A-Za-z][A-Za-z0-9-]{0,30}$/.test(options.result)) throw new UsageError('--result is one word, e.g. pass, fail, partial, blocked');
  return {
    result: options.result,
    scope: options.scope,
    environment: options.env ?? null,
    exclusions: options.exclusion ?? [],
    references: await Promise.all((options.ref ?? []).map(fileRef)),
    reportedBy: actor,
    reportedAt: now(),
    brief: assignment.brief ? { sha256: assignment.brief.sha256 } : null,
    observations: [],
  };
}

function nextEvidenceId(record) {
  return `E${Object.keys(record.evidence).length + 1}`;
}

async function resolveCommit(repo, rev) {
  try {
    const { stdout } = await promisify(execFile)('git', ['-C', repo, 'rev-parse', '--verify', '-q', `${rev}^{commit}`],
      { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    return stdout.trim();
  } catch { return null; }
}

// ---------------------------------------------------------------- write commands

const WRITES = {
  async init(record) { return 'created'; },

  async assign(record, { positional: [id], options }, actor) {
    if (!id || !ID.test(id)) throw new UsageError('assign needs an id of letters, digits, dot, dash or underscore');
    if (record.assignments[id]) throw new RecordError(`assignment ${id} already exists (rev ${record.assignments[id].rev})`, 'exists');
    if (!options.title || !options.accountable) throw new UsageError('assign needs --title and --accountable');
    if (options.parent && !record.assignments[options.parent]) throw new UsageError(`no parent assignment ${options.parent}`);
    const at = now();
    record.assignments[id] = {
      id, title: options.title, parent: options.parent ?? null,
      brief: options.brief ? { ...(await fileRef(options.brief)), recordedAt: at } : null,
      accountable: { actor: options.accountable, since: at },
      implementer: options.implementer ? { session: options.implementer, since: at } : null,
      checkout: null, status: null, dependencies: [], inputs: [],
      rev: 1, history: [{ rev: 1, at, by: actor, change: `created; ${options.accountable} accountable` }],
    };
    return `${id} rev 1`;
  },

  async update(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    const changes = [];
    if (options.title) { a.title = options.title; changes.push('title'); }
    if (options.brief) {
      const brief = await fileRef(options.brief);
      changes.push(a.brief && a.brief.sha256 !== brief.sha256 ? `brief changed (${short(a.brief.sha256)} -> ${short(brief.sha256)})` : 'brief set');
      a.brief = { ...brief, recordedAt: now() };
    }
    if (options.parent) {
      if (!record.assignments[options.parent] || options.parent === id) throw new UsageError(`no parent assignment ${options.parent}`);
      a.parent = options.parent; changes.push(`parent ${options.parent}`);
    }
    if (options['no-parent']) { a.parent = null; changes.push('parent removed'); }
    if (options['clear-status']) { a.status = null; changes.push('status cleared'); }
    if (options.status) {
      a.status = { text: options.status, ref: options['status-ref'] ? await fileRef(options['status-ref']) : null, by: actor, at: now() };
      changes.push(`status: ${options.status}`);
    }
    if (!changes.length) throw new UsageError('update needs something to change');
    change(a, actor, changes.join('; '));
    return `${id} rev ${a.rev}`;
  },

  async transfer(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    const role = options.role;
    if (!ROLES[role] || !options.to) throw new UsageError('transfer needs --role accountable|implementer|writer and --to');
    checkRev(a, needRev(options));
    const at = now();
    let from;
    if (role === 'accountable') { from = a.accountable.actor; a.accountable = { actor: options.to, since: at }; }
    if (role === 'implementer') { from = a.implementer?.session ?? 'none'; a.implementer = { session: options.to, since: at }; }
    if (role === 'writer') {
      if (!a.checkout) throw new UsageError(`${id} has no checkout; set one with checkout first`);
      from = a.checkout.writer; a.checkout = { ...a.checkout, writer: options.to, since: at };
    }
    change(a, actor, `${ROLES[role]} ${from} -> ${options.to}${options.note ? ` (${options.note})` : ''}`);
    return `${id} rev ${a.rev}`;
  },

  async checkout(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    if (!options.path || !options.cover) throw new UsageError('checkout needs --path and at least one --cover (use --cover . for the whole checkout)');
    const writer = options.writer ?? a.checkout?.writer;
    if (!writer) throw new UsageError('the first checkout needs --writer; later writer changes use transfer --role writer');
    if (options.writer && a.checkout && options.writer !== a.checkout.writer) throw new UsageError('change the writer with transfer --role writer');
    let path;
    try { path = await realpath(options.path); } catch (error) { throw new UsageError(`checkout path unreadable: ${options.path} (${error.code})`); }
    a.checkout = { path, coverage: [...options.cover].sort(), writer, since: a.checkout?.path === path ? a.checkout.since : now() };
    change(a, actor, `checkout ${path} covering ${a.checkout.coverage.join(', ')}; writer ${writer}`);
    return `${id} rev ${a.rev}`;
  },

  async depend(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    if (!options.on || !KINDS.includes(options.kind)) throw new UsageError(`depend needs --on and --kind ${KINDS.join('|')}`);
    if (a.dependencies.some(d => d.on === options.on && d.kind === options.kind)) throw new UsageError('that dependency is already recorded');
    a.dependencies.push({ on: options.on, kind: options.kind, note: options.note ?? null, assignment: !!record.assignments[options.on] });
    change(a, actor, `depends on ${options.on} (${options.kind})`);
    return `${id} rev ${a.rev}`;
  },

  async undepend(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    const index = a.dependencies.findIndex(d => d.on === options.on && d.kind === options.kind);
    if (index < 0) throw new UsageError('no such dependency');
    a.dependencies.splice(index, 1);
    change(a, actor, `no longer depends on ${options.on} (${options.kind})`);
    return `${id} rev ${a.rev}`;
  },

  async pin(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    if (!options.label) throw new UsageError('pin needs --label');
    if (a.inputs.some(input => input.label === options.label)) throw new UsageError(`input ${options.label} is already pinned; unpin it first`);
    let input;
    if (options.receipt && !options.commit) {
      input = { label: options.label, receipt: await fileRef(options.receipt) };
    } else if (options.commit && options.repo && !options.receipt) {
      const repo = await realpath(options.repo).catch(() => { throw new UsageError(`repo unreadable: ${options.repo}`); });
      const commit = await resolveCommit(repo, options.commit);
      if (!commit) throw new UsageError(`${options.commit} is not a commit in ${repo}`);
      input = { label: options.label, repo, commit, track: options.track ?? null };
    } else throw new UsageError('pin needs either --repo with --commit, or --receipt');
    input.note = options.note ?? null;
    input.pinnedBy = actor;
    input.pinnedAt = now();
    a.inputs.push(input);
    change(a, actor, `pinned input ${options.label} at ${input.commit ? short(input.commit) : `receipt ${short(input.receipt.sha256)}`}`);
    return `${id} rev ${a.rev}`;
  },

  async unpin(record, { positional: [id], options }, actor) {
    const a = getAssignment(record, id);
    checkRev(a, needRev(options));
    const index = a.inputs.findIndex(input => input.label === options.label);
    if (index < 0) throw new UsageError(`no pinned input ${options.label}`);
    a.inputs.splice(index, 1);
    change(a, actor, `unpinned input ${options.label}`);
    return `${id} rev ${a.rev}`;
  },

  // Evidence is append-only: no revision check, and nothing here changes an existing claim.
  async evidence(record, { positional: [id], options, subject, context }, actor) {
    const a = getAssignment(record, id);
    if (!options.check) throw new UsageError('evidence needs --check');
    checkObservedContext(a, context);
    const evidenceId = nextEvidenceId(record);
    record.evidence[evidenceId] = { id: evidenceId, assignment: id, check: options.check, ...(await evidenceFields(options, a, actor)), subject, reproduces: null };
    return evidenceId;
  },

  async inspect(record, { positional: [evidenceId], options }, actor) {
    const item = record.evidence[evidenceId];
    if (!item) throw new RecordError(`no evidence ${evidenceId}`, 'missing');
    item.observations.push({ kind: 'inspected', by: actor, at: now(), note: options.note ?? null });
    return `${evidenceId} inspected by ${actor}`;
  },

  async reproduce(record, { positional: [evidenceId], options, subject, context }, actor) {
    const original = record.evidence[evidenceId];
    if (!original) throw new RecordError(`no evidence ${evidenceId}`, 'missing');
    const a = getAssignment(record, original.assignment);
    checkObservedContext(a, context);
    const id = nextEvidenceId(record);
    record.evidence[id] = { id, assignment: a.id, check: original.check, ...(await evidenceFields(options, a, actor)), subject, reproduces: evidenceId };
    return id;
  },
};

// ---------------------------------------------------------------- views

/** Freshness facts computed at view time; nothing here is stored or upgrades a claim. */
class Observer {
  constructor() { this.captures = new Map(); }
  async capture(path, coverage) {
    const key = JSON.stringify([path, coverage]);
    if (!this.captures.has(key)) {
      this.captures.set(key, captureSource(path, coverage).catch(error => ({ failed: error.message })));
    }
    return this.captures.get(key);
  }
  async subjectStatus(item, assignment) {
    const s = item.subject;
    const notes = [];
    if (item.brief && assignment.brief && item.brief.sha256 !== assignment.brief.sha256) notes.push('brief changed since this evidence');
    if (!item.brief && assignment.brief) notes.push('recorded before any brief');
    if (s.kind === 'unknown') return { text: 'subject unknown', notes };
    if (s.kind === 'receipt') {
      const stated = s.statedIdentity ? `; reported identity "${s.statedIdentity}" (not captured here)` : '';
      return { text: `receipt ${s.receipt.path} ${await refStatus(s.receipt)}${stated}; source not compared`, notes };
    }
    const current = await this.capture(s.checkout, s.coverage);
    const base = `captured ${s.capturedAt} at ${short(s.head)}${s.observations === 'two-matched' ? '' : ' (source changed during capture)'}`;
    if (current.failed) return { text: `${base}; current source unknown (${current.failed})`, notes };
    const cmp = await compareCaptures(s, current);
    const gaps = cmp.gaps?.length ? `; not covered: ${cmp.gaps.join(', ')}` : '';
    if (assignment.checkout && assignment.checkout.path !== s.checkout) notes.push(`subject checkout ${s.checkout} is not the assignment's current checkout`);
    const texts = {
      'same': 'covered source unchanged since',
      'content-same-identity-changed': `covered content unchanged; ${cmp.identityChanges?.join(', ')}`,
      'content-differs': `evidence is for an earlier revision: ${cmp.changedPaths ? `changed ${cmp.changedPaths.join(', ') || '(paths unavailable)'}` : cmp.reason}`
        + `${cmp.identityChanges?.length ? `; ${cmp.identityChanges.join(', ')}` : ''}`,
      'uncertain': `comparison unknown: ${cmp.reason}`,
      'not-comparable': `comparison unknown: ${cmp.reason}`,
    };
    return { text: `${base}; ${texts[cmp.status]}${gaps} (within coverage ${s.coverage.join(', ')})`, notes };
  }
}

async function inputStatus(input) {
  if (input.receipt) return `receipt ${input.receipt.path} ${await refStatus(input.receipt)}`;
  let text = `${input.repo} @ ${short(input.commit)}`;
  if (input.track) {
    const now = await resolveCommit(input.repo, input.track);
    text += now === null ? `; ${input.track} unreadable now` : now === input.commit ? `; ${input.track} still there` : `; ${input.track} has moved to ${short(now)} (not included)`;
  }
  return text;
}

function checkoutConflicts(record, realPaths) {
  const byPath = new Map();
  for (const a of Object.values(record.assignments)) {
    if (!a.checkout) continue;
    const path = realPaths.get(a.id) ?? a.checkout.path;
    (byPath.get(path) ?? byPath.set(path, []).get(path)).push(a);
  }
  const conflicts = new Map();
  for (const [path, list] of byPath) {
    if (list.length < 2) continue;
    const text = `checkout ${path} is claimed by ${list.map(a => `${a.id} (writer ${a.checkout.writer})`).join(' and ')}`;
    for (const a of list) conflicts.set(a.id, text);
  }
  return conflicts;
}

async function currentRealPaths(record) {
  const paths = new Map();
  for (const a of Object.values(record.assignments)) {
    if (a.checkout) paths.set(a.id, await realpath(a.checkout.path).catch(() => a.checkout.path));
  }
  return paths;
}

function provenance(record, item) {
  const parts = [`reported ${item.result} by ${item.reportedBy} at ${item.reportedAt}`];
  for (const o of item.observations) parts.push(`${o.kind} by ${o.by} at ${o.at}${o.note ? ` (${o.note})` : ''}`);
  const reproductions = Object.values(record.evidence).filter(e => e.reproduces === item.id);
  for (const r of reproductions) parts.push(`reproduction ${r.id}: ${r.result} by ${r.reportedBy} on its own subject`);
  if (item.reproduces) parts.push(`reproduces ${item.reproduces}`);
  return parts.join('; ');
}

/** The checkout's current state within its coverage, observed now (not stored). */
async function checkoutState(a, observer) {
  if (!a.checkout) return null;
  const now = await observer.capture(a.checkout.path, a.checkout.coverage);
  if (now.failed) return { failed: now.failed };
  return {
    observedAt: now.capturedAt, head: now.head, branch: now.branch, inProgress: now.inProgress,
    indexDigest: now.index.digest, unmerged: now.index.unmerged, contentDigest: now.content.digest,
    changedFromHead: now.changes.map(c => c.path), untracked: now.content.untracked,
    gaps: [...now.gaps.submodules, ...now.gaps.unreadable.map(g => g.path)], observations: now.observations, notes: now.notes,
  };
}

function describeState(state, coverage) {
  if (!state) return 'no checkout';
  if (state.failed) return `unknown (${state.failed})`;
  const ops = Object.entries(state.inProgress).filter(([, v]) => v).map(([k]) => k);
  return [`HEAD ${short(state.head)} on ${state.branch ?? 'detached HEAD'}`,
    ops.length ? `in progress: ${ops.join(', ')}` : null,
    state.unmerged.length ? `unmerged: ${state.unmerged.join(', ')}` : null,
    state.changedFromHead.length ? `differs from HEAD: ${state.changedFromHead.join(', ')}` : 'no changes from HEAD',
    state.gaps.length ? `not covered: ${state.gaps.join(', ')}` : null,
    state.observations === 'two-matched' ? null : 'source changed during observation',
    ...state.notes].filter(Boolean).join('; ') + ` (within coverage ${coverage.join(', ')})`;
}

async function assignmentView(record, a, observer, conflicts) {
  const evidence = [];
  for (const item of Object.values(record.evidence).filter(e => e.assignment === a.id)) {
    const status = await observer.subjectStatus(item, a);
    evidence.push({ item, status });
  }
  const inputs = [];
  for (const input of a.inputs) inputs.push({ input, status: await inputStatus(input) });
  const brief = a.brief ? { ...a.brief, now: await refStatus(a.brief) } : null;
  return { a, evidence, inputs, brief, conflict: conflicts.get(a.id) ?? null, current: await checkoutState(a, observer) };
}

/** JSON of a view: the stored assignment and evidence, and separately what was observed now. */
function viewJson(record, v) {
  return {
    stored: { assignment: v.a, evidence: v.evidence.map(e => e.item) },
    live: {
      observedAt: now(),
      checkout: v.current,
      flags: v.conflict ? [v.conflict] : [],
      brief: v.brief ? v.brief.now : null,
      evidence: v.evidence.map(({ item, status }) => ({ id: item.id, subject: status.text, notes: status.notes })),
      inputs: v.inputs.map(({ input, status }) => ({ label: input.label, status })),
    },
  };
}

async function buildViews(record, ids) {
  const observer = new Observer();
  const conflicts = checkoutConflicts(record, await currentRealPaths(record));
  const views = [];
  for (const id of ids) views.push(await assignmentView(record, record.assignments[id], observer, conflicts));
  return views;
}

function renderAssignment(record, v, { heading = '##' } = {}) {
  const { a } = v;
  const lines = [`${heading} ${a.id}: ${a.title} (rev ${a.rev})`, ''];
  if (a.parent) lines.push(`- Parent: ${a.parent}`);
  lines.push(`- Accountable: ${a.accountable.actor} (since ${a.accountable.since})`);
  lines.push(`- Implementer: ${a.implementer ? `${a.implementer.session} (since ${a.implementer.since})` : 'none'}`);
  lines.push(`- Checkout: ${a.checkout ? `${a.checkout.path}, written by ${a.checkout.writer} (since ${a.checkout.since}); coverage ${a.checkout.coverage.join(', ')}` : 'none'}`);
  if (a.checkout) lines.push(`- Current source (observed now): ${describeState(v.current, a.checkout.coverage)}`);
  if (v.conflict) lines.push(`- Flag: ${v.conflict}`);
  lines.push(`- Brief: ${v.brief ? `${v.brief.path} (sha256 ${short(v.brief.sha256)}, ${v.brief.now})` : 'none recorded'}`);
  lines.push(`- Status: ${a.status ? `${a.status.text}${a.status.ref ? ` [${a.status.ref.path}]` : ''} (${a.status.by}, ${a.status.at})` : 'none'}`);
  for (const d of a.dependencies) lines.push(`- Dependency (${d.kind}): ${d.on}${d.assignment ? '' : ' (external)'}${d.note ? `: ${d.note}` : ''}`);
  for (const { input, status } of v.inputs) lines.push(`- Pinned input ${input.label}: ${status}${input.note ? `; ${input.note}` : ''}`);
  if (v.evidence.length) {
    lines.push('', 'Evidence (claims as reported and observed; not a readiness verdict):');
    for (const { item, status } of v.evidence) {
      lines.push(`- ${item.id} ${item.check}: ${item.result}. Scope: ${item.scope}${item.environment ? `; environment: ${item.environment}` : ''}`
        + `${item.exclusions.length ? `; excludes: ${item.exclusions.join('; ')}` : ''}.`);
      lines.push(`  - Provenance: ${provenance(record, item)}.`);
      lines.push(`  - Subject: ${status.text}.${status.notes.length ? ` ${status.notes.join('; ')}.` : ''}`);
      for (const ref of item.references) lines.push(`  - Reference: ${ref.path} (sha256 ${short(ref.sha256)})`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- brief restoration

/** Briefs are short; a larger one is pointed to rather than restored, so it is never cut silently. */
export const BRIEF_LIMIT = 12_000;

/** The recorded brief as it can be read now: only bytes whose hash matches the record are ever returned. */
async function briefState(brief) {
  if (!brief) return { state: 'none' };
  let bytes;
  try { bytes = await readFile(brief.path); } catch (error) { return { state: 'unreadable', code: error.code }; }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== brief.sha256) return { state: 'changed', sha256 };
  if (bytes.length > BRIEF_LIMIT) return { state: 'too-large', size: bytes.length };
  return { state: 'current', text: bytes.toString('utf8') };
}

function briefKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

/**
 * What an implementing session should hold as its current brief. The text restates the record; it adds no
 * requirement of its own and says that later corrections in the conversation take precedence.
 */
async function restoration(record, recordPath, id, session) {
  const sessions = session ? [session] : [];
  let a;
  if (id) {
    a = getAssignment(record, id);
  } else {
    if (!sessions.length) throw new UsageError('brief needs an assignment id or --session');
    const matches = Object.values(record.assignments).filter(x => x.implementer && sessions.includes(x.implementer.session));
    if (!matches.length) {
      return { status: 'none', assignment: null, key: briefKey(['none']),
        text: `No assignment in ${recordPath} names ${sessions.join(' or ')} as its implementer.` };
    }
    if (matches.length > 1) {
      const ids = matches.map(x => x.id).sort();
      return { status: 'ambiguous', assignment: null, key: briefKey(['ambiguous', ids]),
        text: `Several assignments in ${recordPath} name this session as implementer (${ids.join(', ')}). `
          + 'No brief is restored; ask the accountable orchestrator which one this session holds.' };
    }
    a = matches[0];
  }
  const accountable = a.accountable.actor;
  const implementer = a.implementer?.session ?? 'none';
  if (sessions.length && !sessions.includes(implementer)) {
    return { status: 'not-implementer', assignment: a.id, key: briefKey(['not-implementer', a.id, implementer]),
      text: `This session (${sessions[0]}) is not the recorded implementer of assignment ${a.id} (${a.title}): the record names ${implementer}`
        + `${a.implementer ? ` since ${a.implementer.since}` : ''}. Its brief is not restored here. `
        + `Do not continue that assignment as yours; ask ${accountable} (accountable) what this session should do.` };
  }
  const brief = await briefState(a.brief);
  const head = [`Assignment ${a.id}: ${a.title} (assignment rev ${a.rev}).`,
    `Accountable: ${accountable}. Implementer: ${implementer}.`];
  if (a.brief) head.push(`Brief: ${a.brief.path} (sha256 ${short(a.brief.sha256)}, recorded ${a.brief.recordedAt}).`);
  const body = {
    none: `No brief is recorded for this assignment. Its absence grants no permission and removes no constraint; ask ${accountable} for one.`,
    unreadable: `The recorded brief cannot be read now (${brief.code}), so it is not restored. That grants no permission and removes no constraint; ask ${accountable}.`,
    changed: `The brief file has changed since the assignment recorded it (now sha256 ${short(brief.sha256)}). `
      + 'The recorded version is not available here and the current file is not confirmed as this assignment\'s brief, '
      + `so neither is restored. That grants no permission and removes no constraint; ask ${accountable} which version holds.`,
    'too-large': `The brief is ${brief.size} bytes, over the ${BRIEF_LIMIT}-byte restoration limit, so it is not restored here. `
      + 'Read it at the path above; its hash still matches the record.',
    current: `The recorded brief follows verbatim. Later corrections from the user or ${accountable} in this conversation `
      + 'take precedence over it. Restating it does not show the work complies; at handoff, reconcile the result against it, '
      + 'including anything requested but not delivered.',
  }[brief.state];
  // The brief's text exactly as stored; a delimiter line follows on its own line.
  const shown = brief.state === 'current'
    ? `\n\n----- brief -----\n${brief.text}${brief.text.endsWith('\n') ? '' : '\n'}----- end of brief -----` : '';
  const text = [...head, '', body].join('\n') + shown;
  return {
    status: 'assigned', assignment: a.id, briefState: brief.state, briefPath: a.brief?.path ?? null,
    recordedSha256: a.brief?.sha256 ?? null,
    key: briefKey(['assigned', a.id, accountable, implementer, a.brief?.path ?? null, a.brief?.sha256 ?? null, brief.state, brief.sha256 ?? null]),
    text,
  };
}

const READS = {
  async brief(record, { positional: [id], options, path }) {
    const result = await restoration(record, path, id, options.session);
    return options.json ? JSON.stringify(result, null, 2) : result.text;
  },

  async show(record, { positional: [id], options }) {
    const a = getAssignment(record, id);
    const [view] = await buildViews(record, [id]);
    if (options.json) return JSON.stringify(viewJson(record, view), null, 2);
    const history = a.history.map(h => `- rev ${h.rev} ${h.at} ${h.by}: ${h.change}`);
    return [renderAssignment(record, view, { heading: '#' }), '', 'History:', ...history].join('\n');
  },

  async map(record, { options }) {
    const ids = Object.keys(record.assignments).sort();
    const views = await buildViews(record, ids);
    if (options.json) return JSON.stringify({ record: { schema: record.schema, rev: record.rev }, assignments: views.map(v => viewJson(record, v)) }, null, 2);
    const rows = views.map(({ a, conflict }) => `| ${a.id} | ${a.parent ?? ''} | ${a.accountable.actor} | ${a.implementer?.session ?? ''} | `
      + `${a.checkout ? `${a.checkout.writer} @ ${a.checkout.path}` : ''} | ${a.status?.text ?? ''} | ${a.dependencies.map(d => `${d.kind}:${d.on}`).join(', ')}`
      + `${conflict ? ' | FLAG' : ' |'}`);
    return ['# Coordination map', '', `Record rev ${record.rev}, generated ${now()}.`, '',
      '| Assignment | Parent | Accountable | Implementer | Checkout writer | Status | Dependencies | Flags |',
      '|---|---|---|---|---|---|---|---|', ...rows, '', ...views.map(v => renderAssignment(record, v))].join('\n');
  },

  async handoff(record, { positional: [id] }) {
    const a = getAssignment(record, id);
    const [view] = await buildViews(record, [id]);
    const children = Object.values(record.assignments).filter(child => child.parent === id).map(child => child.id);
    return [`# Handoff: ${a.title}`, '',
      `Generated from the coordination record (rev ${record.rev}) at ${now()}. The brief remains the authority for requirements; `
      + 'references point to the full receipts.', '',
      renderAssignment(record, view, { heading: '##' }),
      ...(children.length ? ['', `Child assignments: ${children.join(', ')}`] : [])].join('\n');
  },
};

// ---------------------------------------------------------------- main

export async function main(argv, env = process.env) {
  const { positional, options } = parseArgs(argv);
  const command = positional.shift();
  if (!command) throw new UsageError(USAGE);
  if (command === 'capture') {
    if (!options.path || !options.cover) throw new UsageError('capture needs --path and --cover');
    return JSON.stringify(await captureSource(options.path, options.cover), null, 2);
  }
  const recordOption = options.record ?? env.COORDINATION_RECORD;
  if (!recordOption) throw new UsageError('name the record with --record <file> or COORDINATION_RECORD');
  const path = await canonicalRecordPath(recordOption);
  if (command === 'unlock') {
    if (!options.token) throw new UsageError('unlock needs --token');
    await unlock(path, options.token);
    return 'unlocked';
  }
  if (READS[command]) return READS[command](await readRecord(path), { positional, options, path });
  if (!WRITES[command]) throw new UsageError(`unknown command ${command}\n${USAGE}`);
  const actor = options.as ?? env.COORDINATION_ACTOR;
  if (!actor) throw new UsageError('name yourself with --as <actor> or COORDINATION_ACTOR (self-reported)');
  const args = { positional, options };
  // Capture outside the lock (it reads files and can be slow); the claim is appended under it.
  if (command === 'evidence' || command === 'reproduce') {
    const peek = await readRecord(path);
    const assignment = command === 'evidence' ? getAssignment(peek, positional[0])
      : getAssignment(peek, peek.evidence[positional[0]]?.assignment ?? '');
    args.context = { rev: assignment.rev };
    args.subject = await subjectFrom(options, peek, assignment);
  }
  const { result, rev } = await updateRecord(path, record => WRITES[command](record, args, actor),
    { actor, command, create: command === 'init' });
  return `${result} (record rev ${rev})`;
}

const EXIT = { conflict: 3, locked: 4, malformed: 5, missing: 6, exists: 7, io: 8, location: 9 };

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`coordination-record: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : error instanceof RecordError ? EXIT[error.kind] ?? 1 : 1);
  }
}

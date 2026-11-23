// Deterministic checks behind the delivery guards (pi/extensions/delivery-guards.ts and
// scripts/delivery-check.mjs). Each check compares a claim or an action with the coordination record, GitHub or a
// delegate's transcript, and returns findings; deciding what to do with them stays with the caller.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { envelopeFromHead, readLinesBackwards, snapshotFor } from '../session-snapshot.mjs';

const run = promisify(execFile);
const short = sha => (sha ? sha.slice(0, 12) : 'none');
const CLOSED_STAGES = new Set(['landed', 'parked']);
/** A PR still in flight: any stage but landed or parked, including none yet. */
const isOpen = pr => !CLOSED_STAGES.has(pr.stage);

// ---------------------------------------------------------------- blocking waits

/** The command with heredoc bodies and quoted strings removed, keeping a quoted sleep duration. */
function shellCode(command) {
  let text = String(command).replace(/(["'])(sleep|watch|tail|gh)\1/g, '$2').replace(/\bsleep\s+(["'])([0-9.]+[smhd]?)\1/g, 'sleep $2');
  text = text.replace(/<<-?\s*(["']?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<heredoc');
  text = text.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return text.replace(/(^|(?<!\\)\s)#[^\n]*/g, '$1');
}

const SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };
export const SLEEP_LIMIT_SECONDS = 5;

/**
 * Why a shell command would hold the session in one long call, or null. Messages from the user and other sessions
 * arrive only between tool calls, so a long sleep, a sleep loop or a watch command keeps them back.
 */
export function blockingWaitReason(command) {
  const text = shellCode(command);
  // Only words in command position count: `echo sleep 30` passes, `command sleep 30` does not.
  const START = String.raw`(?:^|[;&|(\n])\s*(?:(?:do|then|else)\s+)?(?:(?:command|builtin|exec|nohup|time)\s+)*`;
  for (const match of text.matchAll(new RegExp(`${START}sleep\\s+([0-9.]+)([smhd]?)\\b`, 'g'))) {
    const seconds = Number(match[1]) * SECONDS[match[2] || 's'];
    if (seconds > SLEEP_LIMIT_SECONDS) return `sleep ${match[1]}${match[2]}`;
  }
  if (new RegExp(`${START}(while|until|for)\\b(?:(?![;&|\\n]\\s*done\\b)[\\s\\S])*?${START}sleep\\b`).test(text)) return 'a loop that sleeps';
  if (new RegExp(`${START}gh\\s+run\\s+watch\\b`).test(text)) return 'gh run watch';
  if (new RegExp(`${START}gh\\s+pr\\s+checks\\b[^\\n;|&]*--watch\\b`).test(text)) return 'gh pr checks --watch';
  if (new RegExp(`${START}watch\\s+\\S`).test(text)) return 'watch';
  if (new RegExp(`${START}tail\\s+(?:(?!--\\s)\\S+\\s+)*?(?:-[a-zA-Z]*[fF]\\b|--follow\\b)`).test(text)) return 'tail -f';
  return null;
}

// ---------------------------------------------------------------- PR references and claims

/** PR references in text: GitHub pull URLs (with repo) and #123 (without). */
export function prRefs(text) {
  const refs = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) {
    const key = `${m[1]}#${m[2]}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ repo: m[1], number: Number(m[2]) }); }
  }
  for (const m of String(text).matchAll(/(?:^|[\s(\[])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d{1,7})\b/g)) {
    const key = `${m[1]}#${m[2]}`;
    if (!seen.has(key)) { seen.add(key); refs.push({ repo: m[1], number: Number(m[2]) }); }
  }
  for (const m of String(text).matchAll(/(?:^|[^\w/&])#(\d{1,7})\b/g)) {
    const number = Number(m[1]);
    if (!refs.some(r => r.number === number)) refs.push({ repo: null, number });
  }
  return refs;
}

/** Assignments whose PR the references name; a bare #n matches every recorded repo with that number. */
export function assignmentsFor(record, refs) {
  const found = [];
  for (const ref of refs) {
    for (const a of Object.values(record.assignments)) {
      if (a.pr && a.pr.number === ref.number && (!ref.repo || ref.repo.toLowerCase() === a.pr.repo.toLowerCase()) && !found.includes(a)) found.push(a);
    }
  }
  return found;
}

const CLAIM = /\b(merge[- ]ready|ready to (?:merge|land)|ready for merg(?:e|ing)|can (?:now )?be merged|safe to merge)\b/i;
const NEGATION = /\b(not|isn't|aren't|isn’t|aren’t|no longer|never|neither|nor)\b/i;
const CONDITION = /\b(once|if|when|after|before|until|unless|whether|as soon as|pending|will|would|should|could|might)\b/i;
const CONDITION_AFTER = /\b(once|if|when|after|until|unless|as soon as|pending|provided)\b/i;

/**
 * PR references in sentences that claim readiness to merge now. Questions, conditional or future sentences and
 * claims negated within their clause are skipped: the guard checks assertions, not plans.
 */
export function mergeClaims(text) {
  const refs = [];
  for (const sentence of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    if (/\?\s*$/.test(sentence)) continue;
    for (const clause of sentence.split(/;|,\s*(?:but|and|while|whereas)\b|\s+but\s+/i)) {
      const match = CLAIM.exec(clause);
      if (!match) continue;
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + match[0].length);
      if (CONDITION.test(before) || CONDITION_AFTER.test(after) || NEGATION.test(before)) continue;
      for (const ref of prRefs(clause)) if (!refs.some(r => r.number === ref.number && r.repo === ref.repo)) refs.push(ref);
    }
  }
  return refs;
}

// ---------------------------------------------------------------- readiness

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number state isDraft headRefOid mergeStateStatus author{login}
latestOpinionatedReviews(first:100){pageInfo{hasNextPage} nodes{author{__typename login} state commit{oid}}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved isOutdated path comments(first:1){nodes{author{login} body url}} last:comments(last:1){nodes{author{login}}}}}
commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){pageInfo{hasNextPage} nodes{__typename
... on CheckRun{name status conclusion isRequired(pullRequestNumber:$number)}
... on StatusContext{context state isRequired(pullRequestNumber:$number)}}}}}}}}}}`;

/** The PR as GitHub reports it now, through `gh api graphql`. */
export async function fetchPr(repo, number, { gh = 'gh', env = process.env } = {}) {
  const [owner, name] = repo.split('/');
  const { stdout } = await run(gh, ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`, '-f', `query=${PR_QUERY}`],
    { env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  const pr = JSON.parse(stdout)?.data?.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub returned no pull request ${repo}#${number}`);
  return pr;
}

const severity = body => (/\bP1\b/.test(body) ? 'P1' : /\bP2\b/.test(body) ? 'P2' : /\b(P3|nit)\b/i.test(body) ? 'P3' : 'unmarked');

const isBot = author => author?.__typename === 'Bot' || /\[bot\]$/.test(author?.login ?? '');
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Whether two recorded commit ids name the same commit (either may be abbreviated). */
export const sameCommit = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

/**
 * Why the PR is not merge-ready on its current head, from GitHub's state and the record's PR entry. An empty list
 * means every checked condition holds. Whether a reply actually fixed a finding, and findings outside GitHub review
 * threads, are not established here; neither is a PR description's accuracy.
 */
export function readinessFindings(assignment, pr) {
  const findings = [];
  const head = pr.headRefOid;
  const label = `${assignment.pr.repo}#${assignment.pr.number}`;
  if (pr.state !== 'OPEN') findings.push(`${label} is ${pr.state.toLowerCase()}, not open`);
  if (pr.isDraft) findings.push(`${label} is a draft`);
  if (pr.mergeStateStatus === 'DIRTY') findings.push(`${label} has merge conflicts with its base`);
  if (pr.mergeStateStatus === 'BEHIND') findings.push(`${label} is behind its base: QA on the head does not cover the integrated result`);
  const reviews = (pr.latestOpinionatedReviews?.nodes ?? []).filter(r => !isBot(r.author));
  if (pr.latestOpinionatedReviews?.pageInfo?.hasNextPage) findings.push('more than 100 reviews: not all were checked');
  const approvals = reviews.filter(r => r.state === 'APPROVED');
  if (!approvals.some(r => r.commit?.oid === head)) {
    findings.push(approvals.length
      ? `no human approval on the current head ${short(head)}: approvals are on ${approvals.map(r => `${short(r.commit?.oid)} (${r.author?.login})`).join(', ')}`
      : `no human approval (head ${short(head)})`);
  }
  for (const r of reviews.filter(r => r.state === 'CHANGES_REQUESTED')) findings.push(`${r.author?.login} has requested changes`);
  // A thread is unanswered while its reviewer wrote the last comment; who replied, and whether the reply fixed it, are not judged.
  const open = (pr.reviewThreads?.nodes ?? []).filter(t => !t.isResolved
    && t.last?.nodes?.[0]?.author?.login === t.comments?.nodes?.[0]?.author?.login)
    .map(t => ({ severity: severity(t.comments?.nodes?.[0]?.body ?? ''), url: t.comments?.nodes?.[0]?.url, path: t.path, outdated: t.isOutdated }))
    .filter(t => t.severity !== 'P3');
  if (open.length) findings.push(`${open.length} review thread(s) with no reply: ${open.map(t => `${t.severity}${t.outdated ? ' (outdated)' : ''} ${t.url ?? t.path}`).join(', ')}`);
  if (pr.reviewThreads?.pageInfo?.hasNextPage) findings.push('more than 100 review threads: not all were checked');
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
  const contexts = rollup?.contexts?.nodes ?? [];
  const required = contexts.filter(c => c.isRequired);
  if (!rollup) findings.push('CI on the head is not reported');
  else if (required.length) {
    const failing = required.filter(c => !PASSING.has(c.conclusion ?? c.state ?? ''));
    if (failing.length) findings.push(`required checks not passing on the head: ${failing.map(c => `${c.name ?? c.context} (${(c.conclusion ?? c.state ?? c.status ?? 'pending').toLowerCase()})`).join(', ')}`);
  } else if (rollup.state !== 'SUCCESS') findings.push(`CI on the head is ${rollup.state.toLowerCase()} (no check is marked required)`);
  if (rollup?.contexts?.pageInfo?.hasNextPage) findings.push('more than 100 checks: required checks beyond them were not checked');
  const recorded = assignment.pr;
  if (recorded.head && !sameCommit(recorded.head, head)) {
    findings.push(`the landing map records head ${short(recorded.head)} but GitHub's head is ${short(head)}: update the map`);
  }
  if (!recorded.qa) findings.push(`no live QA recorded for ${label} (pr --qa-head)`);
  else if (!sameCommit(recorded.qa.head, head)) findings.push(`live QA is recorded on ${short(recorded.qa.head)}, not the head ${short(head)}`);
  return findings;
}

// ---------------------------------------------------------------- relay posts

/** Slack message coordinates from a permalink in text: channel, message ts and thread ts. */
export function slackPermalink(text) {
  const m = /https:\/\/[A-Za-z0-9.-]*slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?[^\s)"'<>]*)?/.exec(String(text));
  if (!m) return null;
  const thread = /thread_ts=(\d+\.\d+)/.exec(m[0]);
  return { permalink: m[0].replace(/[).,]+$/, ''), channel: m[1], ts: `${m[2]}.${m[3]}`, threadTs: thread ? thread[1] : null };
}

const REQUEST_WORDS = /\b(review|re-review|approv\w*|take a look|look at)\b/i;

/**
 * Whether a Slack post may go ahead. A post counts as a review request when it asks for review (or approval) and
 * names a PR in the landing map, or asks for review in the thread of a recorded request. Each such PR must have
 * live QA recorded on its current head; a PR already requested gets a new post only as a reply in the recorded
 * thread, in the same channel, once its head has changed. Returns the checked PRs with the head and thread checked.
 */
export function relayPostCheck(record, { message, channel, threadTs }) {
  const text = String(message);
  if (!REQUEST_WORDS.test(text)) return { checked: [], problems: [] };
  const named = assignmentsFor(record, prRefs(text));
  const inThread = !named.length && threadTs ? Object.values(record.assignments).filter(a => a.pr?.reviewRequest?.thread === threadTs) : [];
  const problems = [];
  const checked = [];
  if (inThread.length > 1) {
    return { checked: [], problems: [`this thread holds requests for ${inThread.map(a => `${a.pr.repo}#${a.pr.number}`).join(', ')}; name the PR the request is for`] };
  }
  for (const a of [...named, ...inThread]) {
    const { pr } = a;
    const label = `${pr.repo}#${pr.number} (${a.id})`;
    if (!pr.head) problems.push(`${label}: the landing map has no head for this PR; record the published head first (pr --head)`);
    else if (!pr.qa || !sameCommit(pr.qa.head, pr.head)) problems.push(`${label}: live QA is not recorded on the head ${short(pr.head)}${pr.qa ? ` (recorded on ${short(pr.qa.head)})` : ''}`);
    const request = pr.reviewRequest;
    if (request) {
      const where = slackPermalink(request.permalink);
      if (threadTs !== request.thread || (where && channel && where.channel !== channel)) {
        problems.push(`${label}: already requested in ${request.permalink}; post again only as a reply in that thread (channel ${where?.channel ?? 'as recorded'}, thread_ts ${request.thread})`);
      }
      if (pr.head && sameCommit(request.head, pr.head)) problems.push(`${label}: already requested at the head ${short(pr.head)}; post again only after a new commit, saying what changed (and that it is small, if it is)`);
    }
    checked.push({ id: a.id, repo: pr.repo, number: pr.number, head: pr.head, thread: request?.thread ?? null });
  }
  return { checked, problems };
}

// ---------------------------------------------------------------- stalls and quiet delegates

const SENT = /^Sent to session: (\S+)/m;

/**
 * A delegate's latest instruction and whether it has reported since, from its Pi transcript, following the persisted
 * parent chain from the newest entry. A report is a `ccmux send` whose result names one of `owners` (any recipient
 * when none are given), or a `submit_handoff` that Codex queued; attempts that failed do not count.
 */
export async function reportSince(transcriptPath, { owners = [], maxScanBytes } = {}) {
  const results = new Map();
  let expected;
  let reported = null;
  for await (const line of readLinesBackwards(transcriptPath, { maxScanBytes })) {
    let entry;
    if (line.oversized) {
      // Too large to parse: follow its envelope, so the path continues; its content (a tool's output) is not read.
      const env = envelopeFromHead(line.head);
      if (!env?.id) continue;
      entry = { id: env.id, parentId: env.parentId, type: env.type, timestamp: env.timestamp, message: { role: env.role === 'user' ? 'user' : 'oversized' } };
    } else {
      try { entry = JSON.parse(line.text); } catch { continue; }
    }
    if (!entry.id) continue;
    if (expected !== undefined && entry.id !== expected) continue;
    expected = entry.parentId ?? null;
    if (entry.type !== 'message') { if (expected === null) break; continue; }
    const m = entry.message ?? {};
    if (m.role === 'toolResult') results.set(m.toolCallId, m);
    if (m.role === 'user') return { instructionAt: entry.timestamp ?? null, reported };
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type !== 'toolCall') continue;
        const result = results.get(block.id);
        if (!result || result.isError) continue;
        const output = (result.content ?? []).map(b => b.text ?? '').join('');
        if (block.name === 'submit_handoff') reported ??= { at: entry.timestamp ?? null, via: 'submit_handoff' };
        if (block.name === 'bash' && /\bccmux\s+send\b/.test(block.arguments?.command ?? '')) {
          const to = SENT.exec(output)?.[1];
          if (to && (!owners.length || owners.includes(to))) reported ??= { at: entry.timestamp ?? null, via: `ccmux send to ${to}` };
        }
      }
    }
    if (expected === null) break;
  }
  return { instructionAt: null, reported };
}

/**
 * Delegates that are idle without having reported since their latest instruction. Only implementers of open PRs
 * the actor is accountable for are checked; sessions ccmux cannot see are reported as unknown, not quiet.
 */
export async function quietDelegates(record, { actor, owners = [], snapshot = snapshotFor } = {}) {
  const quiet = [];
  for (const a of Object.values(record.assignments)) {
    if (actor && a.accountable.actor !== actor) continue;
    if (!a.implementer || (a.pr && !isOpen(a.pr))) continue;
    let result;
    try { result = await snapshot(a.implementer.session, { replyChars: 0 }); } catch (error) { result = { error: error.message }; }
    if (result.error || !result.snapshot) { quiet.push({ assignment: a.id, session: a.implementer.session, state: 'unknown', detail: result.error ?? 'no snapshot' }); continue; }
    const snap = result.snapshot;
    if (snap.activity.status !== 'idle' || !snap.session.transcriptPath) continue;
    const transcriptId = snap.transcript?.sessionId ?? null;
    if (transcriptId !== a.implementer.session) {
      quiet.push({ assignment: a.id, session: a.implementer.session, state: 'unknown', detail: `the transcript ccmux names belongs to ${transcriptId ?? 'an unidentified session'}, not ${a.implementer.session}` });
      continue;
    }
    const since = await reportSince(snap.session.transcriptPath, { owners });
    if (since.reported) continue;
    if (!since.instructionAt) { quiet.push({ assignment: a.id, session: a.implementer.session, state: 'unknown', detail: 'idle, but no instruction was found on its transcript path' }); continue; }
    quiet.push({ assignment: a.id, session: a.implementer.session, ccmux: snap.session.id, state: 'quiet',
      instructionAt: since.instructionAt, verdict: snap.verdict,
      detail: `idle since ${snap.activity.statusChangedAt ?? 'an unknown time'} with no message to its owner since its latest instruction (${since.instructionAt ?? 'unknown time'}); pane verdict ${snap.verdict}` });
  }
  return quiet;
}

/** Landing-map entries that imply an action nobody is taking. Pure: quiet delegates are passed in. */
export function stallFindings(record, { actor, quiet = [] } = {}) {
  const findings = [];
  for (const a of Object.values(record.assignments).sort((x, y) => x.id.localeCompare(y.id))) {
    if (actor && a.accountable.actor !== actor) continue;
    const { pr } = a;
    if (!pr || !isOpen(pr)) continue;
    const label = `${a.id} (${pr.repo}#${pr.number}, ${pr.stage ?? 'no stage'})`;
    if (!pr.next) findings.push(`${label}: no next action with an owner`);
    if (pr.stage === 'awaiting-review') {
      if (!pr.reviewRequest) findings.push(`${label}: awaiting review but no review request is recorded`);
      else if (pr.head && !sameCommit(pr.reviewRequest.head, pr.head)) findings.push(`${label}: review was requested at ${short(pr.reviewRequest.head)}, not the head ${short(pr.head)}`);
    }
    if (pr.stage === null) findings.push(`${label}: no stage recorded`);
    if (['awaiting-review', 'merge-ready'].includes(pr.stage) && !pr.head) findings.push(`${label}: no head recorded, so neither QA nor the review request can be shown to cover it`);
    if (['awaiting-review', 'merge-ready'].includes(pr.stage) && pr.head && (!pr.qa || !sameCommit(pr.qa.head, pr.head))) {
      findings.push(`${label}: no live QA recorded on the head ${short(pr.head)}`);
    }
  }
  for (const q of quiet) {
    findings.push(q.state === 'quiet' ? `${q.assignment}: implementer ${q.ccmux ?? q.session} has gone quiet: ${q.detail}`
      : `${q.assignment}: implementer ${q.session} could not be checked (${q.detail})`);
  }
  return findings;
}

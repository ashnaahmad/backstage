#!/usr/bin/env node
// The delivery guards' checks from the shell, for Codex hooks or a manual look. Read-only: nothing here writes the
// record, posts or changes a session.
//
//   delivery-check.mjs stalls [--as <actor>] [--json]      landing-map stalls, including quiet delegates (via ccmux)
//   delivery-check.mjs quiet [--as <actor>] [--json]       delegates idle without a report since their instruction
//   delivery-check.mjs readiness <assignment|owner/name#n|#n> [--json]   merge readiness from GitHub and the record
//   delivery-check.mjs wait-check <command>                why a shell command would block the session, if it would
//
// Record: --record <file> or COORDINATION_RECORD. Actor: --as <name> or COORDINATION_ACTOR (filters to the
// assignments that actor is accountable for).
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { canonicalRecordPath, readRecord } from './lib/record-store.mjs';
import { assignmentsFor, blockingWaitReason, fetchPr, quietDelegates, readinessFindings, stallFindings } from './lib/delivery-checks.mjs';

class UsageError extends Error {}

function parse(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg.startsWith('--')) { options[arg.slice(2)] = argv[++i]; if (options[arg.slice(2)] === undefined) throw new UsageError(`${arg} needs a value`); }
    else positional.push(arg);
  }
  return { positional, options };
}

async function loadRecord(options, env) {
  const file = options.record ?? env.COORDINATION_RECORD;
  if (!file) throw new UsageError('name the record with --record <file> or COORDINATION_RECORD');
  return readRecord(await canonicalRecordPath(file));
}

/** The assignment a readiness reference names: an assignment id, owner/name#n or #n. */
export function resolveAssignment(record, ref) {
  if (record.assignments[ref]?.pr) return record.assignments[ref];
  const m = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#?(\d+)$/.exec(ref);
  if (!m) throw new UsageError(`${ref} is not an assignment with a PR, owner/name#n or #n`);
  const found = assignmentsFor(record, [{ repo: m[1] ?? null, number: Number(m[2]) }]);
  if (found.length !== 1) throw new UsageError(found.length ? `#${m[2]} matches several assignments (${found.map(a => a.id).join(', ')}); name the repo` : `no assignment's PR is ${ref}`);
  return found[0];
}

export async function readiness(record, ref, { gh, env } = {}) {
  const assignment = resolveAssignment(record, ref);
  const pr = await fetchPr(assignment.pr.repo, assignment.pr.number, { gh, env });
  const findings = readinessFindings(assignment, pr);
  return { assignment: assignment.id, pr: `${assignment.pr.repo}#${assignment.pr.number}`, head: pr.headRefOid, ready: findings.length === 0, findings };
}

export async function main(argv, env = process.env) {
  const { positional, options } = parse(argv);
  const command = positional.shift();
  const actor = options.as ?? env.COORDINATION_ACTOR;
  const out = (value, text) => (options.json ? JSON.stringify(value, null, 2) : text);
  if (command === 'wait-check') {
    const reason = blockingWaitReason(positional.join(' '));
    return out({ blocking: !!reason, reason }, reason ? `blocks the session: ${reason}` : 'does not block');
  }
  if (command === 'stalls' || command === 'quiet') {
    const record = await loadRecord(options, env);
    const quiet = await quietDelegates(record, { actor });
    if (command === 'quiet') return out(quiet, quiet.length ? quiet.map(q => `- ${q.assignment}: ${q.detail}`).join('\n') : 'no quiet delegates');
    const findings = stallFindings(record, { actor, quiet });
    return out(findings, findings.length ? findings.map(f => `- ${f}`).join('\n') : 'no stalls');
  }
  if (command === 'readiness') {
    if (!positional[0]) throw new UsageError('readiness needs an assignment, owner/name#n or #n');
    const result = await readiness(await loadRecord(options, env), positional[0], { env });
    return out(result, result.ready ? `${result.pr} at ${result.head.slice(0, 12)}: every checked condition holds`
      : `${result.pr} is not merge-ready:\n${result.findings.map(f => `- ${f}`).join('\n')}`);
  }
  throw new UsageError('usage: delivery-check.mjs stalls|quiet|readiness <ref>|wait-check <command> [--record <file>] [--as <actor>] [--json]');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    console.log(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(`delivery-check: ${error.message}`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}

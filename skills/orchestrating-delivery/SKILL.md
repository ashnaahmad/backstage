---
name: orchestrating-delivery
description: Coordinate implementer, QA, review and relay sessions through implementation, live QA, publication, human review and landing of a delivery large enough that the user reviewing each diff would be a bottleneck, such as a PR stack or a project's worth of PRs. Use when running such a delivery, maintaining its landing map, routing its review findings, or judging whether one of its PRs or delegated sessions is finished.
---

# Orchestrating delivery

**End state:** every requested change has landed, or is waiting on a named owner for a named reason, with live QA on the code that lands and human approval of that code. Work moves as fast as real dependencies allow. The user is asked only for decisions that are theirs.

A passing check, a published commit, an idle session, a clean merge preview or an approval badge does not by itself establish any of this. Use [code-quality](../code-quality/SKILL.md) for implementation and independent review, the project's QA skill for live verification, and [writing-handoffs](../writing-handoffs/SKILL.md) for the content of a handoff.

## Roles

| Role | Default model | Owns |
|---|---|---|
| Stack coordinator | Astra | Landing order, the landing map, cross-PR compatibility, readiness judgments, answering the user |
| PR orchestrator (optional) | Astra | One PR's implementer and evidence, when the coordinator has more PRs than it can supervise directly |
| Implementer | Opus 5.5 | Source changes in its own worktree, tests, code-quality review |
| QA session | Sol | Live-app QA on a named commit; never changes source |
| Independent reviewer | Sol, through code-quality | Findings on a change, when code-quality warrants review |
| Review relay | — | Watching Slack and GitHub for every PR in flight, posting review requests and replies, reporting each event to the sessions that act on it; see [review relay](references/review-relay.md) |

Follow an explicit user model choice; ask before substituting an unavailable model. Pass the model at launch and confirm it before dispatch.

- Coordinators run in the project's main checkout. Implementers each get their own worktree; QA serves a detached worktree pinned to the exact commit under test, never the implementer's checkout.
- Give each transient test export, merge rehearsal, or scratch build a unique directory. The command that creates it must register teardown immediately (a temporary-directory context manager or an exit trap with interrupt handling) and remove it on success, failure, or cancellation. Keep the evidence needed for handoff outside that directory. For a temporary Git worktree, register teardown through Git. On restart after a crash, check the exact directory owned by the interrupted run and finish its cleanup before retrying. Verify removal at handoff.
- When the coordinator is supervising so much that it stops answering the user or updating the map, hand PRs to PR orchestrators. Its job is stack readiness.
- Record, beside each role in the landing map, the session holding it and how to reach it. When roles become unclear, restate them before doing anything else.

## Messaging

Read the reference for the harness you are running in before launching or messaging a session: [Pi](references/pi.md) or [Codex](references/codex.md). Delegates are Pi sessions either way.

- Start implementers with `/implement`, QA sessions with `/browser-verify`, and the relay with [review relay](references/review-relay.md). Those carry the delegates' own rules for checks and reporting. A brief names the recipient and channel for reports and adds only what they do not cover.
- A repeated or superseded report needs no reply.

## The loop for each PR

1. **Implement.** The implementer works in its own worktree under `/implement` and code-quality, and hands over a commit with its evidence.
2. **QA.** A separate QA session runs the project's live-app QA on a pinned copy of the exact commit the implementer hands over, while the implementer keeps working in its own worktree: the original reproduction or new behaviour as a user would meet it, then a saved-state readback after reload. Read [live QA](references/live-qa.md) before launching one. Findings go back to the implementer; the repaired commit gets the affected checks again.
3. **Evals, if the project gates on them.** Only after live QA has passed on the same commit. Each eval proposed names the scenario the change can alter; skip the rest. Do not gate a change on evals of behaviour it removes, and while the interface the evals exercise is still changing, do not rewrite them change by change.
4. **Publish.** Commit and push the QA'd tree to the PR branch. Within the user's publication grant, do not ask again for each push. Fix or explain CI failures before review.
5. **Request review.** The relay sends the request and reports its permalink. Publication is not review delivery.
6. **Handle findings.** Every P1/P2 finding gets an owner who accepts it, a fix through steps 1–4, and an inline reply naming the fixing commit; then the relay asks for renewed review. A finding the implementer disputes goes back to the reviewer with evidence, or to the user for a ruling.
7. **Land.** See readiness below.

Parent and child PRs proceed in parallel. While a parent waits for CI or review, the child integrates the parent's frozen head, resolves conflicts and runs its checks. When the parent lands, compare the landed commit with what the child integrated and rerun only what changed.

## Work in parallel unless a resource conflicts

Run every check, review, investigation and QA preparation at once unless two operations demonstrably conflict over the same resource: a port, a mutable fixture, one account's saved app state, measured memory pressure. Then limit only those operations, give each a separate resource where one exists (another test account, port pair or checkout), and say when the limit ends.

None of these is a reason to wait: a "QA slot" for anything other than live QA, local tests or typechecks in other checkouts, remote CI, a parent awaiting review, an investigation that only reads code and captures. Do not relay take-and-release messages between sessions over a shared resource; give them separate resources or let them coordinate directly.

## Authority

- **Pre-authorised:** anything QA needs, including fixtures, cloud jobs and their compute cost; running agreed checks; messaging the sessions in the stack.
- **The coordinator decides operational questions** (which test account, port pair or checkout a session uses) and tells the session. It does not offer them as suggestions or ask the user.
- **Publication:** follow the project's rules. Once the user grants publication for QA'd work, it covers every QA'd push in scope; do not ask per push.
- **The user decides:** product behaviour, scope changes, accepting an unfixed finding, merging where the user has not granted it. Present the decision with a recommendation; keep independent work going meanwhile.
- **Never invented:** an approval gate, a policy "decision" or a reviewer position that no source records. When reporting a decision, cite who made it and where.

## Readiness

A PR is **merge-ready** only when all of these hold for its current head:

- human approval that covers that head (a clean uptake of already-approved parent code needs current-head restoration, not a fresh full review);
- every P1/P2 finding fixed and replied to, or disposed of by the reviewer or the user;
- live QA on the integrated tip that will land, after main or parents were merged in;
- required CI and any required evals passing;
- a PR description that matches the code.

GitHub's per-PR "mergeable" does not establish that a landing sequence is ready. Before declaring a stack ready, check that the verification each PR claims actually happened, against the evidence rather than the report.

A session is **finished** when its assignment is done and handed over, not when it is idle. After a quota stop or restart, compare its last instruction with its last report and resume or reassign what was interrupted.

## The landing map and the user

Keep one landing map, in the coordination record; read [landing map](references/landing-map.md) before taking over a stack or starting one.

Answer the user's question first, in that reply, before resuming relay or status work. Heartbeats and routine relays are not answers. On resumption or compaction, reconcile the brief, later user decisions and the current PR state before acting; an instruction already fulfilled is not repeated.

The skill grants no publication, merge or messaging authority beyond the user's.

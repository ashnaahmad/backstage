---
name: orchestrating-delivery
description: Coordinate implementers, QA, PR stacks and a Slack/GitHub human-review relay through repeated implementation and review cycles. Use when delegating delivery across sessions, maintaining a landing map, handling incoming review findings, or judging whether a PR or delegated session is finished.
---

# Orchestrating delivery

Deliver the requested changes through verification and human review, with a current landing order and an accountable owner for every unfinished step. A passing check, published commit, idle session or approval badge alone does not establish completion.

This skill owns the delivery loop. Use [code-quality](../code-quality/SKILL.md) for implementation and independent review, [writing-handoffs](../writing-handoffs/SKILL.md) for transfers, and the project's QA skill for live verification. It does not replace their judgement with additional compulsory review rounds.

## Establish the current assignment

Read the original request, subsequent user decisions, current landing map and relevant review threads. After compaction or resumption, reconcile those before acting: an older visible instruction may already be fulfilled or superseded. Confirm the next action against current source and PR state. Do not repeat a historical request merely because it appears last in restored context.

Keep requirements, proposed means, explicit deferrals and unresolved choices distinct. A reviewer calling a defect nonblocking does not mean the user accepted leaving it unfixed. Investigate technical questions; ask about genuine product choices without stopping independent work.

Use the existing coordination record and landing-map authority. Do not establish a second ledger or migrate live assignments without their owner's agreement. Read [operating the loop](references/operating-the-loop.md) before taking over an active stack or setting up its relay.

## Assign accountability

- **Stack coordinator:** owns dependency order, the current landing map, shared live-QA scheduling, cross-PR compatibility and the readiness judgment. Watches the PR owners and relay through the agreed outcome. Delegate direct implementation supervision when it competes with those responsibilities.
- **PR orchestrator:** supervises that PR's implementer, reconciles findings and scope, inspects verification evidence, and reports the next delivery action to the stack coordinator. This is the PR owner for delivery handoffs; when no separate PR orchestrator is assigned, the stack coordinator retains that responsibility. A small assignment may combine these two roles explicitly.
- **Implementer:** owns source changes in its worktree and follows the implementation/verification loop. Separate QA or review agents return evidence to this owner; they do not silently become competing implementers.
- **Slack/GitHub relay:** watches existing and new human feedback, routes it to the named implementer and PR orchestrator, posts authorised review requests and verified fix responses, and reports delivery and acceptance to the coordinator. It does not independently declare technical work complete.

Orchestrators run in the project's main checkout; implementers use worktrees. Preserve the main checkout's branch and source. Use the configured role models and session-launch rules. Record the durable session identity and current pane/window so a replacement pane is not mistaken for a different assignment.

When transferring work, distinguish delivery of the brief, acknowledgement and acceptance of ownership. Keep the previous owner accountable until the recipient accepts. If an implementer is unavailable or quota-interrupted, restore or explicitly reassign its unfinished work; idle is not completion.

## Run the delivery loop

1. **Implement and review.** The implementer uses code-quality, including independent review when requested or warranted by that skill. Focused investigations into redundant tests, duplicated functionality or another concrete concern remain available under its review guidance; they are not mandatory extra gates for every change. Group related findings by their governing rule instead of approving successive spot fixes.
2. **Verify the result.** Complete the applicable checks and project live-app QA, including saved-state/reload verification where required. QA findings return to implementation. Recheck affected behaviour after repairs and preserve evidence that still applies. Report the actual tested source and environment, not just a suite total.
3. **Publish.** Once implementation and QA pass, commit the verified work in logical chunks and push to the intended PR branch under the user's repository permissions. Carry existing authorisation forward within its scope; ask only for genuinely missing authority. If commits predate final QA, verify the published tree matches the tested result. A failed or stale CI result needs disposition before calling the PR ready for review.
4. **Request human review.** The PR owner hands the relay the published head, QA evidence, scope and any accepted exclusions. The relay verifies that handoff, posts the authorised human-review request to Slack, and records its permalink. Publication is not review delivery. The coordinator marks the PR awaiting human review, not merge-ready.
5. **Handle human findings.** The relay reads full review bodies and inline threads, including unanswered older findings on approved PRs. Route every P1/P2 to the implementer and PR orchestrator, confirm accepted ownership, and report it to the coordinator. Reopen the affected delivery state immediately. The implementer investigates and fixes confirmed findings through steps 1–3 again. A disputed finding needs evidence returned to the human reviewer for reconciliation, or an explicit user ruling; the implementer cannot settle it merely by disagreeing. Record who accepted the disposition and its basis. Continue independent repairs while that question remains open.
6. **Return the fixes to the reviewer.** After the repair has passed implementation checks and QA and is pushed, the relay replies under each addressed PR comment with the fixing commit(s), what changed and relevant verification. It reads back the replies and pings the reviewer in the existing Slack thread for renewed review. Do not post an unverified fix claim, silently resolve the reviewer's threads or substitute a stale message edit for a notification. The PR is awaiting renewed human review.
7. **Assess landing.** Merge-ready requires human approval applicable to the delivered change, settled P1/P2 dispositions, required checks and QA, and compatibility with the intended dependency order. New repairs are not covered merely by an old approval badge. Distinguish approval from merge permission; do not merge without authority. A child approved in isolation may still await parent integration and affected verification.

## Maintain the landing map while work happens

The stack coordinator updates the current map whenever an accepted finding, source change, dependency change, verification result, review request or approval changes the next action. Do this as reports arrive, not only when the user asks for status.

For each PR, make the current owner, implementer, source head, parents, delivery stage, applicable evidence, outstanding findings and next owner/action easy to find. Include review-request and human-approval links. Identify whether evidence is reported or inspected and what changed since it was obtained. Link details rather than pasting transcripts, logs and every historical permission into the map.

Replace superseded state. Retain historical receipts separately with source identities; remove expired grants and obsolete “next” actions from the operational view. If the coordination record is adopted, use it for roles/dependencies/evidence and link or generate those fields rather than maintaining competing values. A formatted map is not evidence: check consequential reports against the cited source.

Ordinary independent tests, typechecks, lint and source review may run in parallel. Serialize shared live-app QA or another demonstrated resource conflict, not all work merely because live QA has a queue. Name the concrete shared resource, holder and release condition when a limit is necessary; retire temporary limits when their reason ends. A waiting live-QA slot must not prevent independent repairs and checks.

Before closing a session, reconcile its assignment with all outstanding review findings, user decisions, interrupted work and dependency obligations. Preserve recoverable source and evidence and name who receives later feedback. “No new comments” does not settle old findings. Continue watching through the user's agreed outcome; report a real blocker or arrange an authorised continuation rather than silently leaving nobody accountable.

## Basis and limits

This loop follows the user's explicit delivery workflow and coordination corrections of 19 November 2026. Its role is to make the existing implementation, QA and human-review processes connect reliably. It introduces no automatic permission to publish, message others, change product scope, run parked evals or merge. Mechanical status tools can expose stale state and keep a session running; they do not certify the readiness judgment.

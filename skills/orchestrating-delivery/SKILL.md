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
- **QA session:** a session separate from the implementer and the coordinators. It runs the project's live-app QA on the exact source the PR owner names and reports the scenarios, served commit, results and evidence to the PR owner. Findings return to the implementer; the QA session does not change source.
- **Slack/GitHub relay:** watches existing and new human feedback, routes it to the named implementer and PR orchestrator, posts authorised review requests and verified fix responses, and reports delivery and acceptance to the coordinator. It does not independently declare technical work complete.

Default to Astra 6.2 (`openai/gpt-6.2-astra`) for coordination, Opus 5.5 (`claude-bridge/claude-opus-5-5`) for implementation and Sol 6.2 (`openai/gpt-6.2-sol`) for independent review through code-quality. Pass the role’s model explicitly at launch and verify it before dispatch. Use code-quality to decide when independent review is warranted; these defaults do not add a mandatory review round. Follow an explicit user model choice over these defaults, and ask before substituting an unavailable model.

Orchestrators run in the project's main checkout; implementers use worktrees. Preserve the main checkout's branch and source. Use the configured role models and session-launch rules. Record the durable session identity and current pane/window so a replacement pane is not mistaken for a different assignment.

### Bind roles to their channels

When starting or adopting this workflow, explicitly assign the stack coordinator. Beside each role in the existing landing map, record the session that holds it and how to reach it: a Pi session's ccmux id, or a Codex thread id. Record each separate PR orchestrator, QA session and relay the same way. Invoking this skill registers no role.

Which channel works depends on the direction:

- **Pi to Pi:** both ways, with `ccmux send --stdin <session>`, labelled with the sender. A Pi delegate reports to its Pi owner by messaging it, including the handoff itself. The message starts a new turn for the recipient, so neither side polls or writes a file merely to deliver a report.
- **Codex to Pi:** `ccmux send` delivers into the Pi session.
- **Pi to Codex:** ccmux cannot reach a Codex chat. The Pi session notifies its Codex owner through [handoff submission](../writing-handoffs/SKILL.md#submitting-to-a-codex-owner), so its brief gives the owner's Codex thread id for `ownerThreadId`. A Codex owner otherwise reads Pi replies with `ccmux last` or a session snapshot.

Each delegation brief names the immediate handoff recipient and its channel, and the stack coordinator's when different:

- Implementer and QA handoffs go to their PR orchestrator, or directly to the stack coordinator when it also owns that PR.
- A separate PR orchestrator assesses the handoff and sends the stack coordinator the tested source, evidence, disposition and next owner/action whenever the delivery state changes. It does not stop at receiving the handoff or updating its own notes.
- The relay sends review, publication and upstream-change reports to the responsible PR orchestrator and the stack coordinator as specified in the delivery loop.

The stack coordinator reads the reports and updates the landing map in place. A message reaches only its addressee; it does not notify an upstream coordinator. On an accepted ownership transfer, update the affected briefs' recipients as well as the map. Report again only when the source, material evidence, disposition, blocker or requested next action changes, as the [handoff submission guidance](../writing-handoffs/SKILL.md#submitting-to-a-codex-owner) describes.

When transferring work, distinguish delivery of the brief, acknowledgement and acceptance of ownership. Keep the previous owner accountable until the recipient accepts. If an implementer is unavailable or quota-interrupted, restore or explicitly reassign its unfinished work; idle is not completion.

## Run the delivery loop

These stages apply to each delivered change; they do not serialize the whole stack. While a parent awaits CI or human approval, child owners can integrate its frozen candidate locally, resolve conflicts, run affected checks and prepare QA within the existing assignment. Record the exact parent and keep the candidate recoverable. A parent waiting to land is not by itself a reason to hold child implementation.

When the parent lands, reconcile the actual landed commit with the prepared child and inspect the resulting tree and delta. Retain applicable evidence for unchanged code; repeat affected checks and any final-tip app QA the user requires. Landing order, publication permissions and real shared-resource conflicts still apply.

1. **Implement and review.** The implementer uses code-quality, including independent review when requested or warranted by that skill. Focused investigations into redundant tests, duplicated functionality or another concrete concern remain available under its review guidance; they are not mandatory extra gates for every change. Group related findings by their governing rule instead of approving successive spot fixes.
2. **Verify the result.** The implementer completes the applicable checks. A separate QA session then runs the project's live-app QA on the named source, including saved-state/reload verification where required. QA findings return to implementation. Recheck affected behaviour after repairs and preserve evidence that still applies. Report the actual tested source and environment, not just a suite total. **Live QA precedes model evals.** Before starting an eval warm-up or a scored run, the coordinator verifies that the applicable user flows passed in the running app on the candidate being evaluated. If integration or a repair changes those flows, repeat the affected live checks first. While live QA is pending, agents can prepare scenarios and run independent local checks.
3. **Publish.** Once implementation and QA pass, commit the verified work in logical chunks and push to the intended PR branch under the user's repository permissions. Carry existing authorisation forward within its scope; ask only for genuinely missing authority. If commits predate final QA, verify the published tree matches the tested result. A failed or stale CI result needs disposition before calling the PR ready for review.
4. **Request human review.** The PR owner hands the relay the published head, QA evidence, scope and any accepted exclusions. The relay verifies that handoff, posts the authorised human-review request to Slack, and records its permalink. Publication is not review delivery. The coordinator marks the PR awaiting human review, not merge-ready.
5. **Handle human findings.** The relay reads full review bodies and inline threads, including unanswered older findings on approved PRs. Route every P1/P2 to the implementer and PR orchestrator, confirm accepted ownership, and report it to the coordinator. Reopen the affected delivery state immediately. The implementer investigates and fixes confirmed findings through steps 1–3 again. A disputed finding needs evidence returned to the human reviewer for reconciliation, or an explicit user ruling; the implementer cannot settle it merely by disagreeing. Record who accepted the disposition and its basis. Continue independent repairs while that question remains open.
   Apply code-quality’s scope judgment before assigning repair work or extending a hold to another PR. Distinguish the observed incident, demonstrated mechanism and exposure introduced by this delivery. Preserve alternatives the reviewer explicitly accepts, including operational remedies; investigate and recommend the smallest adequate option before escalating a user decision. Return evidence for reconciliation rather than silently waiving an existing reviewer hold.

6. **Return the fixes to the reviewer.** After the repair has passed implementation checks and QA and is pushed, the relay replies under each addressed PR comment with the fixing commit(s), what changed and relevant verification. It reads back the replies and pings the reviewer for renewed review in the most recent Slack thread about this particular stack that the reviewer has replied to. Verify the reviewer’s participation before posting; an older per-PR or parent/child thread in the handoff does not override this choice. Do not post an unverified fix claim, silently resolve the reviewer's threads or substitute a stale message edit for a notification. The PR is awaiting renewed human review.
   Reply in each finding’s thread when its disposition is settled, including an accepted deferral, waiver or operational remedy. State the authority and what remains unfixed or unverified. When no code change is involved, these responses do not wait for publication.

7. **Assess landing.** Merge-ready requires human approval applicable to the delivered change, settled P1/P2 dispositions, required checks and QA, and compatibility with the intended dependency order. New repairs are not covered merely by an old approval badge. Distinguish approval from merge permission; do not merge without authority. A child approved in isolation may still need parent integration and affected verification before landing. Preserve applicable human approval through clean uptake of already-approved parent code; assess consequential new resolutions separately. If repository rules dismiss approval on a new push, request the required current-head restoration without automatically asking for a full substantive re-review.

Distinguish an accepted rollout condition from its execution: record when and by whom it must be fulfilled, without claiming it has happened or substituting it for required reviewer acceptance.

## Maintain the landing map while work happens

The stack coordinator updates the current map whenever an accepted finding, source change, dependency change, verification result, review request or approval changes the next action. Do this as reports arrive, not only when the user asks for status.

For each PR, make the current owner, implementer, source head, parents, delivery stage, applicable evidence, outstanding findings and next owner/action easy to find. Include review-request and human-approval links. Identify whether evidence is reported or inspected and what changed since it was obtained. Link details rather than pasting transcripts, logs and every historical permission into the map.

Replace superseded state. Retain historical receipts separately with source identities; remove expired grants and obsolete “next” actions from the operational view. If the coordination record is adopted, use it for roles/dependencies/evidence and link or generate those fields rather than maintaining competing values. A formatted map is not evidence: check consequential reports against the cited source.

## Schedule live QA without serializing ordinary work

The stack coordinator must not introduce a general “QA slot”, “light-check slot” or “compute GO” prerequisite for ordinary work. Implementers proceed with independent tests, typechecks, lint, builds, commit hooks and independent reviews in parallel under their existing assignment and permissions; they do not request a coordinator slot for each command. A live-app QA reservation does not by itself exclude those checks, and a local test run does not by itself prevent another PR from starting live QA.

Schedule shared live-app QA where it needs exclusive resources. Any further restriction requires a demonstrated conflict: identify the actual shared service, mutable data, port or measured resource pressure, the affected operations, and the release condition. Limit only those conflicting operations and allow independent work to continue. A past memory incident, the word “QA”, or a precaution carried forward from an old brief is not sufficient evidence for a machine-wide lock. Prefer isolated resources or bounded concurrency where they address the conflict.

When adopting this workflow, inspect outstanding grants and holds. Explicitly retire blanket ordinary-check restrictions in the current map and affected briefs, and tell their owners they may proceed; do not merely add a new permissive paragraph while leaving old “wait for GO” instructions active. Preserve genuine user-imposed limits and current resource conflicts, with their scope and basis. Reassess temporary restrictions when their reason ends.

## Follow through and close

Before closing a session, reconcile its assignment with all outstanding review findings, user decisions, interrupted work and dependency obligations. Preserve recoverable source and evidence and name who receives later feedback. “No new comments” does not settle old findings. Continue watching through the user's agreed outcome; report a real blocker or arrange an authorised continuation rather than silently leaving nobody accountable.

## Basis and limits

This loop follows the user's explicit delivery workflow and coordination corrections of 19–23 November 2026. Its role is to make the existing implementation, QA and human-review processes connect reliably. It introduces no automatic permission to publish, message others, change product scope, run parked evals or merge. Mechanical status tools can expose stale state and keep a session running; they do not certify the readiness judgment.

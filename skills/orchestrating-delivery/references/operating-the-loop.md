# Operating an existing delivery loop

## Take over without duplicating work

Read the current authority map and the user messages that changed scope, ownership or permissions. Inspect current sessions and PR state before dispatching anything. Name which roles you take over and which remain with their existing owners. A single actor may hold several roles, but each unfinished action needs one accountable owner.

Use the existing [coordination record](../../../SETUP.md#coordination-record) for adopted assignments, [session snapshots](../../../SETUP.md#session-snapshot) for Pi activity, and [handoffs](../../writing-handoffs/SKILL.md) for transfers. A snapshot showing a reply after a message proves ordering, not fulfilment. Read the reply and assess it against the current brief. Follow repository guidance for explicit model selection, visible Pi dispatch and Codex chat messaging authorisation.

Restore the current brief at resumption and compaction, then apply later corrections. Do not reopen a draft PR instruction that has already produced a ready-for-review PR, restart completed work because an old pane is idle, or inherit a resource grant for a different source/run. Preserve current decisions without treating an earlier agent's interpretation as a user ruling.

## Make relay handoffs executable

The PR owner gives the relay the PR/head, intended reviewer, delivery stage, verified QA evidence, accepted exclusions and the existing Slack request/thread. For repair rounds, include the finding identifiers and fixing commits with a short explanation and relevant verification. The relay checks that commits are actually published and the evidence describes the delivered change before posting.

On incoming feedback, inspect both the review body and inline threads. Notify the implementer and its PR orchestrator; track delivery separately from accepted repair ownership. Escalate an unaccepted assignment to the stack coordinator rather than repeatedly forwarding it or assuming it is handled. Preserve the reviewer's objection when grouping findings into one design problem.

Use one communication owner to prevent duplicate posts. For stack relay messages, use the most recent thread about that particular stack that the intended reviewer has replied to. Read the candidate thread to verify its stack and the reviewer’s reply; do not default to an older per-PR or parent/child thread merely because a handoff records it. A newer thread without a reviewer reply does not displace the most recent qualifying thread. If none exists, use the authorised initial review-request destination.

For renewed review, send a new reply there, notifying the reviewer as authorised. Editing a day-old message is not a new request. Read back the posted reply in that thread and return its thread-aware permalink. Record that destination for subsequent handoffs. Never claim a reviewer was notified until the post is verified. Do not post unresolved findings as though fixed or resolve threads on the reviewer’s behalf without authority.

The relay keeps monitoring after posting. Human approval is a new event for the coordinator to assess, not a reason to discard unresolved older findings. If a session is retired, route later feedback to its explicitly named successor.

## Keep evidence applicable

Associate checks, live QA and human review with the source they cover. When the branch or a parent moves, identify which behaviour changed and which evidence remains applicable; rerun affected checks rather than blindly repeating everything or carrying everything forward. Record accepted exclusions and their actual authority. A narrowly scoped independent review does not settle unrelated human objections.

A practical landing row can contain:

| PR/head and parents | PR owner / implementer | Current stage | Evidence and remaining findings | Next action / owner |
|---|---|---|---|---|
| Verified source identifiers | Current sessions | Repairing, QA, awaiting publication/review, or merge-ready | Links with scope | Executable next step |

The exact table is optional. Keep one current account, with separate evidence files for detail. The coordinator must be able to answer “what prevents this landing, and who acts next?” without reconstructing a timeline of grants and revocations.

## Check the workflow on representative failures

Use isolated hypothetical or copied public events, never mutate a live PR to test a skill. Reveal events chronologically and judge decisions, not use of vocabulary:

- A PR is approved but has unanswered P2s. Expected: inspect their dispositions and keep an owner; do not close merely on approval.
- A repair passes QA and is published after human findings. Expected: inline fix explanations and a renewed Slack request; await human approval.
- An older parent/child request has no reviewer reply, while a newer consolidated thread about the same stack has one. Expected: post the renewal in the consolidated thread and verify readback there, even if the handoff names the older thread.
- An old “open a draft PR” request reappears after compaction. Expected: recognise fulfilment and preserve current ready-for-review status.
- A reviewer withdraws approval and the user requests previously deferred findings be fixed. Expected: replace deferrals, reopen implementation and update the landing map.
- An implementer becomes idle at a quota limit. Expected: inspect unfinished work and restore or reassign it; do not infer completion.
- Live QA is occupied while another PR has independent tests, builds or review. Expected: proceed without requesting a light-check or compute slot unless an actual shared-resource conflict applies. Conversely, an ordinary test run does not itself block live QA.
- A restored brief says “all checks wait for root GO”, but that blanket restriction has been superseded. Expected: remove the stale hold from the operational map and briefs and notify affected owners; do not leave them waiting while merely documenting the new rule.
- A parent changes after a child's QA. Expected: identify the affected integration and verification; distinguish local approval from stack readiness.

A checklist replay demonstrates that the written procedure covers those cases. Claim improved behaviour only after observing agents make the right decisions in a realistic run; compare without the skill when attribution is unclear.

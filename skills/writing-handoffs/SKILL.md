---
name: writing-handoffs
description: Write or update a concise handoff when returning delegated work, handing over unfinished work, or moving an assignment to a fresh agent, session or VM. Use for handoff docs and continuation briefs; ordinary replies do not require a separate document.
---

# Writing handoffs

Give the recipient enough verified context to assess the result or continue the agreed work without reconstructing the conversation. A handoff transfers context; it does not change the user's requirements, grant access or certify completion.

For ongoing implementation, QA, publication and human-review cycles, use [orchestrating-delivery](../orchestrating-delivery/SKILL.md). A handoff is one transition within that loop.

## Orchestrator location

Run orchestrators in the repository’s main checkout, never in worktrees. Worktrees are for implementers. When delegating or handing off orchestration, start or resume the orchestrator in the main checkout and give it explicit paths to its implementers’ worktrees. Do not switch the main checkout’s branch or edit implementation sources as part of moving an orchestrator. Preserve the session transcript and verify the resumed process’s working directory. For Pi, `--session` retains the stored tool working directory even when launched elsewhere. To relocate an existing orchestrator, stop its old process and use `--fork <session-path>` from the main checkout; this preserves history in a new session with the correct tool directory. Verify both the process directory and session header before resuming work.

Choose the form for the recipient: a short reply can return completed delegated work; a durable document helps when work must survive a session or VM. Update an existing handoff to reflect the current state rather than appending a diary. Use the user's requested format and location.

Report meaningful checks and remaining gaps without scorecards. Include only what the recipient needs:

- **Outcome and constraints:** the original request, later user decisions and relevant boundaries. Distinguish accepted requirements from proposed means. Link governing sources rather than substituting your summary for them.
- **Current state:** changes or outputs, where they are, and whether the assignment is complete or unfinished. For code, identify the checkout, branch, commit and any uncommitted work needed to continue. For a remote run, identify relevant resources and their lifecycle state without including credentials.
- **Verification:** meaningful checks actually performed, their results and evidence locations. Separate inspected or tested facts from another agent's reports, assumptions and work still unverified.
- **Reconciliation:** when the assignment has a current brief (for example `coordination-record.mjs brief <id>`), compare the result with it and with later corrections: what was requested and delivered, what was excluded and left alone, which decisions remain open, and anything requested but not delivered. Say if the brief changed during the work.
- **Remaining work:** unresolved risks, objections or choices and the next action or decision needed. Preserve settled decisions with their basis; an agent's preferred interpretation is not a user ruling.

For completed work, lead with the result and any material limits. For unfinished work, make the next action executable from the preserved state. A settled assistant turn does not establish assignment completion. Before a VM or session disappears, check that referenced changes and evidence are available to the recipient outside it; a path on a terminated VM is not a recoverable artifact. Do not carry the previous conversation wholesale or include secrets or material outside the recipient's authorised scope.

Read back the handoff against the original request and the actual files or outputs. Could a fresh recipient find the work, understand which decisions hold, and take the next step without inventing missing context? Correct stale locations and unsupported completion claims. The receiving agent still inspects consequential code and evidence before accepting the result.

This consolidates the harness's delegated-session handoff guidance and its code-quality reporting principles. For implementation-specific stopping criteria or review briefs, use [code-quality](../code-quality/SKILL.md) and its applicable references; for broader prose revision, use [writing](../writing/SKILL.md).

## Submitting to a Codex owner

When your brief names the owner's Codex thread id, submit the handoff with `submit_handoff` once it states what you want the owner to act on, including QA pending, failed or blocked. Give its path, the QA state it reports and the thread id exactly as the brief gives it; if the brief names none, report the handoff through your existing channel instead. Writing the file or ending your reply does not submit it. A queued result means Codex accepted the notification, not that the owner has read or accepted the handoff; report an unconfirmed or not-sent result rather than assuming delivery. A `passed` QA state is your report, not permission to publish or merge.

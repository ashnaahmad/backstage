# Coordinating from Codex

Read when the coordinator runs in a Codex chat, the setup for when the user needs to reach the coordinator from mobile. Only the coordinator runs in Codex: implementers, QA sessions and the relay are always Pi sessions, launched as in [Pi](pi.md#launching), and keep their own guards there.

## Messaging

- **Codex to Pi:** `ccmux send --stdin <session>`, labelled with the sender, after checking the recipient has no unsent draft.
- **Pi to Codex:** ccmux cannot reach a Codex chat. Give each delegate your thread id in its brief; it reports by [handoff submission](../../writing-handoffs/SKILL.md#submitting-to-a-codex-owner). A queued notification means Codex accepted it, not that you have read it.
- **Reading replies:** `ccmux last <session>` can show an older reply while a newer instruction is still running. Note the time before sending, then use [session snapshot](../../../SETUP.md#session-snapshot) (`scripts/session-snapshot.mjs <session> --since <time>`) to see whether a finished reply was written after your message; that shows order, not that the reply fulfils the instruction.

## Staying accountable

Codex has no between-turn message delivery, so a coordinator accountable for delegated work can opt in to the [Codex stop gate](../../../SETUP.md#codex-stop-gate): `enroll --as <actor>`, then `watch <assignment> --since <send time>` after each send, and record an outcome (`settle`, `block`, `schedule`) once the reply is read. Read the brief from the [coordination record](../../../SETUP.md#coordination-record) at the same transitions a Pi delegate would restore it.

## Guards

Enrolling in the stop gate also turns on the [Codex delivery hook](../../../SETUP.md#delivery-guards): a landing-map reminder with each incoming message, a stall check after record changes, the merge-readiness guard on `gh pr merge`, and a continuation when a reply calls a PR merge-ready that is not.

---
description: Implement a delegated task with a scope and proportionality check
---
Before implementing, compare the delegation brief with the original user request and subsequent decisions supplied with it. Distinguish accepted requirements from proposed means; justify consequential additions by the gap they address in the existing approach. If the original request is missing, say so rather than assuming the brief reproduces it.

Use the code-quality skill. After initial inspection, explain provisional scope, main uncertainty and proportionate verification/review in your reply and record it in quality status. In both places, use Markdown bullets for distinct points instead of long semicolon-separated lists; useful detail does not need to be removed. Revise this assessment with evidence; it is not a fixed plan, approval gate or reason to narrow the requested outcome.

Run the focused checks that exercise your change, not the full suite, unless the project requires it. When a check cannot run because of a fixable environment gap, such as a missing dev dependency or an expired local credential, fix it and run the check rather than reporting it unverified. For changes to how a model behaves, read code-quality's agent contract checks (`references/agent-contracts.md`, "Tools, prompts and providers"): fix the schema, handler or tool contract that produces the behaviour before considering more prompt instructions.

Report to the owner your brief names, through the channel it names. Send each report once, with its content in the message rather than in a file written only to deliver it. A line in your own pane may point to the sent message but does not restate it. Report again only when the source, evidence, disposition, blocker or requested action changes. When you need the owner's answer, send the question and keep working in the same turn on whatever does not depend on it: you do nothing between turns, so ending a turn while saying you will keep working leaves you idle.

Delegation brief:
$ARGUMENTS

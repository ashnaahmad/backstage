# Select applicable contract and agent checks

## Shared behaviour and state

Enumerate actual callers, input classes, flags and providers rather than relying on an old inventory. Follow omitted, null, explicit and defaulted values through validation, storage and consumers. Verify save, independent reload and downstream use, including fresh records and updates that preserve other writers’ fields. Exercise each materially different affected flag path, including the unset/default case; identify tested revision and settings. A supported broken caller is not a completed migration. A successful response is not proof that a write took effect.

When new shapes or meanings become expressible, inspect existing predicates that consume them. Prefer an explicit unknown result over silently misclassifying an unfamiliar case when the consequence matters. Ensure every new executable branch has a producer in the delivered stage.

At delayed execution boundaries, carry the resolved target and needed context explicitly; revalidate permissions and staleness before effects. Do not silently choose a different target from changed ambient context. Produce shared representations once and normalise foreign vocabulary at its entry boundary.

## Guards, errors and recovery

Run checks at the earliest point their inputs exist, before unnecessary side effects. Compare a bound or estimate against actual behaviour, including both over-rejection and under-detection. An error's explanation must follow from the condition that raised it; distinguish different causes instead of collapsing them into one misleading message.

Execute a prescribed recovery route before blaming a model for not completing it. Inspect actual tool arguments and results. If the route answers a different question or cannot succeed, fix the route. If the route works but instructions are ambiguous, evaluate a targeted wording change; do not assume prose can never be the cause.

## Tools, prompts and providers

A repeated poor call may be encouraged by the schema, examples, prompt or handler defaults. Inspect those producers before adding another retry instruction. Honour named arguments or explicitly refuse them; distinguish filling an omitted value from substituting a supplied value.

Separate model-facing recovery instructions from user-facing explanations. Render user text from structured facts, not raw internal instructions. Check all provider adapters for shared guarantees and history fidelity: tool results and execution receipts must retain their meaning across model changes.

Each lens needs behavioural evidence appropriate to the change. Do not add universal runtime guards or scan unrelated subsystems merely because this reference contains them.

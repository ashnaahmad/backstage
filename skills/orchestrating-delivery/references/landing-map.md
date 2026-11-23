# Landing map

Read before taking over an active stack or starting a new one.

- The landing map is the harness [coordination record](../../../SETUP.md#coordination-record): one assignment per PR, with `pr <id>` holding the PR, head, stage, next action and its owner, live-QA head and review request, and `map` showing them. Do not keep a second map in prose.
- When taking over, read `map`, the sessions and the PR state before dispatching anything. If the stack has a prose map, move its current state into the record and stop updating the prose.
- Update the map when a message changes what it records. Each `pr` value replaces the last: the map holds the current state, not a log. Link evidence (`evidence`, `--qa-ref`) instead of pasting it.
- Every open PR has a next action with an owner; a PR awaiting review has a recorded request on its head.

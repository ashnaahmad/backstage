# Live QA

Read before launching a QA session. The project's QA skill governs how to run the app and the browser; this covers what the coordinator arranges and checks.

## Launching a QA session

- Launch a new Pi session on Sol with `/browser-verify` and a brief naming the exact commit to test, the scenarios and the recipient for its report. QA serves a detached worktree at that commit, never the implementer's checkout, so the implementer keeps investigating and changing its own worktree meanwhile.
- If the intended change is still in the working tree, have the implementer commit it on its branch and give QA that SHA. Keep unrelated work out of the commit.
- Scenarios come from the ticket's acceptance criteria and the implementer's handoff, phrased as what a user would do or type. A scenario that names internal functions or parameters skips the path users take.
- A QA session reporting an unexpected sign-in page has a setup problem: fix the setup rather than asking the user to sign in.

## Running several at once

- Assign each QA session its own port pair and its own test account, one with the permissions its scenarios need, checked against what the server grants rather than what the UI shows. Sessions sharing an account can collide on its saved app state; if they must share, follow the QA skill's rule for that.
- Give each session a ticket prefix for anything it creates, so sessions sharing an account can tell their data apart.

## What the coordinator checks before accepting QA

- The commit the servers actually served is the pinned commit, with no uncommitted changes in the QA worktree.
- Each scenario's result, with the saved state read back after a reload.
- The evidence files exist and show what the report says.
- The session's servers and browser are stopped and its ports are free.

QA on an earlier commit covers a later one only where the intervening change cannot affect the scenario; say which scenarios carried over and why. After main or a parent is merged in, QA the integrated tip before review or landing.

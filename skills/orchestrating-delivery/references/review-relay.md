# Review relay

Read before starting, briefing or acting as the relay.

**What the relay achieves:** nothing that happens in review goes unnoticed or unanswered, and nothing reaches a reviewer twice. One session owns all review traffic for the workstream, in Slack and on GitHub, from the first review request until the stack lands.

## Watching

- The relay keeps watching every PR in flight, without being asked each time, staying in its turn and waiting between checks as a coordinator does while its delegates work (in Pi, the `wait` tool, with a `gh` check command where useful): head changes, GitHub reviews, inline threads and general comments (including unanswered older findings on approved PRs), and replies in the PR's Slack review threads.
- Every event becomes a report to the implementer, its PR owner and the coordinator, naming the PR, head, event and link. GitHub and Slack changes reach the landing map this way, like any other report. When nothing has changed, it sends nothing.
- A P1/P2 needs an owner who accepts it; the relay tells the coordinator once one has. Group findings by the rule they concern, keeping each reviewer objection intact.
- An approval is an event for the coordinator to assess against readiness, not a reason to drop older findings.

## Posting

- **Requests:** the PR owner hands over the published head, QA evidence, scope and accepted exclusions; the relay confirms the head is published and the evidence covers it before posting. Make parent/child order clear so the reviewer knows what to review first.
- **Where:** the most recent Slack thread about this stack that the reviewer has replied to. A newer thread the reviewer has not replied to does not replace it; with none, use the agreed review channel.
- **Once:** no duplicate request for a PR already requested. Any new commit dismisses approval, so post again after any head change, as a new reply tagging the reviewer in the same thread as the previous request, never a new thread. Say what changed since the reviewer last looked; when it is small, say so, so the reviewer knows the re-review is quick. Do not rely on editing an earlier message: nobody is notified of an edit.
- **Fix replies:** after a fix passes checks and QA and is pushed, reply under each finding with the fixing commit, what changed and how it was verified, then request renewed review. A finding settled without a code change gets a reply naming who accepted it and what remains. Never resolve a reviewer's thread or describe an unfixed finding as fixed.
- Read every post back and send its permalink to the coordinator before reporting anyone as asked.

## Slack access from Pi

Pi reaches Slack through Slack's hosted MCP server, configured as the `slack` server in `~/.pi/agent/mcp.json`. It posts with the user's token, so **everything the relay posts appears as the user**. To set it up on another workspace or machine:

1. Create an internal (custom) Slack app from a manifest with the redirect URL `http://127.0.0.1:<port>/callback`, `pkce_enabled` and `is_mcp_enabled` set, and only the user scopes the relay needs: `search:read.public search:read.private search:read.users channels:history groups:history channels:read groups:read users:read chat:write`. Install it (an admin may need to approve).
2. Keep the client secret in the Keychain, entered through a masked prompt.
3. Add a deferred `slack` server to `~/.pi/agent/mcp.json` with `url` `https://mcp.slack.com/mcp` and `oauth` holding `clientId`, a `clientSecret` command that reads the Keychain, `callbackPort` and `scope` set to the scopes above. Without `scope`, Pi requests every scope the server offers and Slack refuses.
4. Sign in through `/mcp`; the tools appear in sessions started afterwards or after `/reload`.

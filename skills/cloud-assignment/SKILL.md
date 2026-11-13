---
name: cloud-assignment
description: Run a bounded Pi coding assignment on the harness AWS MicroVM runner, recover its results, and clean up the run. Use for cloud delegation and testing the runner, not ordinary AWS application deployment.
---

# Cloud assignments

Use the vendored `pi-cloud-agents` runner. Read the harness `SETUP.md` cloud section and the package's `README.md` before deployment. Keep the assignment's repository, account, credentials and permitted writes explicit; local access does not authorize copying them to a guest.

## Choose the input

Resolve the repository owner and remote, exact reachable commit, selected AWS profile/region/stack, and model account from the request and inspected configuration. Ask only for missing choices that affect access or cost. A branch name can move after launch; record the resolved commit and verify the guest starts there. Uncommitted or unpushed work is not part of a remote clone. Do not quietly publish it to make a launch work.

For personal-only trials, use an owned public repository without a GitHub token when possible. Select a separate stack and agent directory rather than reusing a bundle whose credentials or instructions came from another account. Set `PI_AGENT_DIR` and `PI_CODING_AGENT_DIR` consistently if both are present: the runner's configuration resolver gives `PI_AGENT_DIR` precedence.

Build the cloud profile deliberately: selected provider credentials, necessary model settings and task instructions only. Do not copy global auth, environment files, MCP configuration, conversation history or whole skill collections. Inspect any selected skill and its referenced resources before transferring them. `buildBundle` supports explicitly selected skill files; ordinary `sync` does not discover the local skill catalogue.

For ChatGPT subscription access, use a fresh Pi login in the selected profile. Do not share one rotating OAuth credential between active local and cloud processes. The runner reads its credential from Secrets Manager; do not assume refreshed credentials in a guest are written back. Verify renewal separately before relying on repeated or scheduled subscription runs.

## Launch and follow through

Use the installed `cloud_agent` tool for assignments. The standalone CLI manages setup/configuration; it is not a substitute for the assignment tool. Inspect the current tool schema rather than inventing flags. The older `/cloud attach` mirror adapter remains experimental; use durable result retrieval as the recovery path. Cross-VM `/cloud continue` is not a verified restore mechanism.

- Give the remote agent the outcome, constraints, permitted files and meaningful verification. Include enough context to work independently without sending the originating conversation wholesale.
- Bound runtime and concurrency. For live runner tests, follow the package's test-resource naming/tagging convention and hard maximum duration; select only the resources created by this trial for cleanup. Credits do not remove the need for a duration limit.
- Distinguish a settled agent turn from a terminated VM. An idle guest can still accept a follow-up. Check lifecycle status and durable output; a counter or successful launch is not an assignment result.
- Use `cloud_agent` result retrieval, then inspect the actual assistant reply and saved changes. Detach/reconnect tests should retrieve the same persisted session and result from a new client, without relying on the launcher's in-memory state.
- Preserve both agent-created commits and uncommitted changes. A clean worktree alone does not prove there is nothing to recover. Check the result's recovery reference and preservation error, then verify the downloaded bundle's digest and commit against its metadata. A recorded commit hash alone is not a recovered artifact. Push or PR creation needs authorization for that repository; set `autoPush: false` for an assignment that must not publish.

Stop a failed or finished test VM and verify its terminal state. Before deleting the trial's storage, retrieve the agreed artifacts and confirm they are readable. Delete only the trial's secrets, object versions, image and stacks; a global cleanup command may include another session's resources.

Report the source commit, image/runtime version, model account type, scenarios actually exercised, result location and cleanup state. Mark setup checks that did not execute a real assignment as unverified.

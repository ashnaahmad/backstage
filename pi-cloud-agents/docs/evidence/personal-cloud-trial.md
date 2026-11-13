# Personal cloud assignment trial

13 November 2026. Bounded assignment through the `cloud_agent` tool, using a dedicated personal ChatGPT login and a separate AWS test stack in `eu-north-1`. Only an owned public GitHub repository was supplied. No GitHub credential, global configuration bundle, employer code or employer resource access was transferred.

## Result

The assignment completed, its answer was retrieved from a new client before VM termination, automatic suspension and proxy-triggered resume worked, and a follow-up read back the saved file. After the VM was confirmed terminated, a new empty repository recovered the exact commit and file from the stored Git bundle. The remote work branch was absent.

- Source: `ashnaahmad/pi-cloud-agents` at `cf75c949b5e0c3fd6084773587ecf0ac8c888bf6`.
- Guest: ARM64, 2048 MiB, Pi 1.4.0, `openai/gpt-6.1-sol` through personal ChatGPT subscription access.
- Image version: `2.0`; runner image ZIP SHA-256: `ebe719e2151010a595d4ff3abc28d251ccad5664433a0dc6e0aba39c02bc36bf`.
- Runtime limits: AWS reported `maximumDurationInSeconds: 3600`; concurrency one; idle suspension after 120 seconds; no automatic Git push.
- Output commit: `c5022cdf4eccb5c998e646717c77503c9b95715d`, adding only `cloud-trial.txt` containing `personal-cloud-ok` and one newline.
- Recovery: 777,747-byte self-contained bundle, SHA-256 `564e72b2611f573bb33ee5ad06fff77c3e7b1a9046596e889d871a0d3ad1a7b7`. Downloaded bytes matched the digest; a fresh Git fetch/check-out matched the commit and exact file contents.
- Follow-up reply: `PERSONAL-CLOUD-READBACK-OK`, with the same commit.

AWS observations (UTC): first answer settled at 14:53:26; controller requested suspension at 14:56:07 after 161 seconds idle, with no controller errors; AWS reported `SUSPENDED` at 14:56:34; the resumed follow-up settled at 14:58:12; AWS reported `TERMINATED` at 14:59:44. Recovery ran after that terminal observation.

## Fixes and checks

Exact-revision checkout, real session-event mirroring, durable settled replies, lifecycle/attachment reporting, serialized storage writes, Git bundle preservation and explicit no-push configuration were exercised locally and in the cloud. OAuth parsing now retains the provider's renewal metadata. Image ownership matching and log/lifecycle IAM scopes were narrowed to the selected image/stack.

The live trial exposed a further reconnect bug: guest-written manifests omit the proxy endpoint. The shared status reader now resolves the endpoint from `GetMicrovm` without rewriting the guest manifest. Missing/stale-endpoint tests reproduced the bug, then passed; a new client finalized the live VM through the repaired reader.

- Final combined checks: 554 unit tests and two substantive integration tests passed, along with typechecking, lint, schema generation and runner/image/scheduled-helper builds. The final runner ZIP digest still matches the live-tested image above.
- Endpoint repair: both missing/stale-endpoint cases failed before the fix; 29 focused status/tool tests passed afterwards. The publishing agent independently repeated the endpoint mutation probe in the standalone port.
- Local real-Pi/mock-provider tests exercise two turns, session mirroring, attachment-aware idling and no-push behavior. Separate real-Git tests delete the workspace, seed and remote, then recover committed and dirty work solely from storage, including rejected pushes and preservation failures.
- Independent source review and a repair review found preservation/publication gaps and two reporting defects. Those were reproduced and fixed. Reviews used independent context on the authorized personal model account; they were not cross-provider reviews.
- Setup CLI dry-run retained the explicitly selected OpenAI provider, no-push policy and separate stack. The documentation no longer uses `--skip-providers` as if it preserved the provider selection.

Identity-policy simulation allowed the trial's storage, provider secret and logs while denying unrelated secret/log namespaces and Bedrock. The principal simulator returned an Organizations denial and was not treated as effective authorization evidence. The actual guest read its selected credential and wrote artifacts, and the controller successfully suspended the VM under the narrowed deployed policy. No unrelated secret was fetched to test denial.

## Cleanup

The VM is terminated and the answer, session and verified recovery bundle were downloaded privately. At 15:02:27 UTC, both test stacks, the image, versioned artifact bucket and copied provider secret were verified absent; no active trial VM remained. Trial controller logs were removed. Existing stacks and credentials are outside this trial.

## Setup cleanup

Removed the unused global AWS MCP registration and optional 24-skill AWS toolkit collection. The focused cloud-assignment skill remains installed. Removed the configuration targeting the deleted trial stack and the one-off login/probe scripts; personal logins and recovered artifacts remain private. Setup instructions now describe the CLI/SDK path actually exercised, without requiring broad AWS tooling.

## Remaining limits

This verifies a bounded assignment and fresh-client recovery, not the old `/cloud attach` TUI adapter or cross-VM `/cloud continue`. Those remain experimental. Guest OAuth refreshes are not persisted back to Secrets Manager; unattended or repeated subscription renewal remains unverified. Git bundles do not preserve ignored files, external LFS objects or submodule repositories. Very large histories and storage outages can exceed lifecycle-hook deadlines; preservation failures must remain visible. Manifest/session writes are ordered but are not a cross-object transaction.

The trial used separate test resources and a one-hour VM ceiling. No measured billing total is claimed; image/snapshot storage and supporting services can incur charges even while the VM is suspended.

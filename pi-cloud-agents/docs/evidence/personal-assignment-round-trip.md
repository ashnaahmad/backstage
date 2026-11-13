# Bounded personal assignment round-trip repair

## Scope and rationale
- Original user request (supplied in delegation): adapt harness cloud assignments and test only personally owned projects/resources. Do not migrate the current local QA session. Root owns skills/setup/AWS integration.
- The delegated means are not separate user requirements. Inspection confirmed exact-revision, durable result, idle and clean-tree checkpoint gaps in the existing runner. Preserve the accepted remote Pi loop/local mirror and existing storage/control plane.
- Root's independent review established that SHA bookkeeping plus optional push cannot preserve contents on no-push/failed-push termination. Root explicitly requested durable Git preservation independent of publication and a supported no-push launch policy.
- Git bundles address that gap without copying credential/config directories as a workspace archive. Bundles include committed repository content/history. They do not preserve external LFS objects, submodule repositories or ignored/uncommitted files excluded by Git's existing auto-commit policy.
- New launches record local HEAD's full SHA, including scheduled preparations. Legacy branch/tag payloads remain supported. Unpushed/unavailable SHAs fail provisioning rather than choosing another revision; there is no remote reachability preflight in this network-free implementation.

## Implementation
- Event notifications schedule mirroring of Pi's actual session file, not RPC frames. Settled/read-only turns flush independently of Git changes. Session/manifest writes are serialized, and every writer publishes session contents before idle/suspended/terminal manifests.
- A settled assistant turn becomes resumable idle only after checkpointing. The next agent_start returns to running. Suspend suggestions wait for this idle state and account for real SSE/WS mirror channels, not HTTP/controller polling sockets.
- Checkpoint ownership auto-commits dirty work, records actual HEAD, creates a bundle verified in an empty repository, uploads it under a SHA256-addressed per-run key, then advertises recovery key/commit/hash. Shallow sources are deepened by a bounded read-only fetch of the pinned source ref before bundle creation.
- Publication stays optional. cloud_agent accepts autoPush; /cloud config defaults.autoPush sets the default used by /cloud new. Precedence is per-run option, config, historical true. A no-push read-only turn never publishes HEAD. Push errors use existing manifest.error semantics with git_push stage.
- Preservation failure retains the earlier immutable reference and uses INTERNAL_ERROR with git_preservation stage. Explicit completed finalization becomes failed when preservation fails. Hypervisor termination remains terminated with the error. Result recovery.current prevents an old bundle being advertised as containing newer work.
- Durable result text, recovery URI and errors are available without contacting/resuming the VM. Scheduled results use the shared parser and recovery interpretation. Result state and lifecycle are distinct. Unmeasured result-report counter defaults were removed rather than presented as data.
- Pinned Pi 1.4.0 already contains openai/gpt-6.1-sol and direct ChatGPT OAuth. A synthetic-credential offline provider test resolves that combination. No evidence required a speculative version upgrade; real guest login/renewal is still unverified.

## Verification
- Isolated temporary HOME and XDG_CONFIG_HOME, no Pi-directory overrides, TMUX, AWS/model credentials or live tmux commands. Package dependencies installed from this checkout's lockfile. Unit concurrency two workers, integration one worker.
- Initial red evidence: clean settled persistence/idle, clean-tree agent self-commit push, exact HEAD payload, moved branch with shallow fetch all failed for intended reasons before repair.
- Independent reviewer reproduced loss of committed contents on no-push termination before bundle repair. The new restoration tests also caught a missing recovery-field merge through the real updateGit/storage path; repaired rather than mocked around.
- Actual Pi 1.4.0 with a fake provider and real RunnerServer hooks/API, LocalStorageSink and temporary Git proves pre-termination durable answer/recovery, a clean second turn, no-push behavior, event-driven mirroring and attached-mirror suspend suppression. The streaming notification probe simulates an event/file change after the real first turn; it is not a long-running live-model stream test.
- No-push and rejected-push restoration tests start from shallow history, preserve an agent-created commit and dirty work, terminate, delete workspace/seed/remote repositories, and restore the exact HEAD and file contents using only the stored bundle.
- Failed artifact upload test independently reloads manifest and bytes: old reference remains intact, newer HEAD is not claimed inside it, and explicit finalization reports failed.
- Persistence tests exercise overlapping session and manifest writes against local storage. Result tests exercise pending, settled, tool/error/abort/incomplete and terminal states, stale VM manifests, subsequent prompts and wait polling. Tool result tests verify recovery metadata and actual assistant text, not timeline reasons.
- Implementation-checkout checks passed: typecheck, lint, generated schemas, 549 unit tests (66 files), 3 integration tests, runner/image build and scheduled-helper build. The final combined source passed 554 unit tests and the two substantive integration tests after the empty scaffold was removed. Unit tests use --maxWorkers=2; integration uses --maxWorkers=1. Git diff --check is clean.
- Final regression additions verify the supported /cloud config command actually saves/reloads no-push policy, and a blocked preservation operation neither suggests suspend nor publishes idle over a newer working turn.

## Review and remaining limits

Independent source and repair reviews found preservation/publication gaps, stale-answer promotion after abrupt VM loss and missing-workspace preservation reporting. Each was reproduced and repaired at the shared owner. Earlier answer text and immutable bundles remain recoverable without being called current or complete. Final reporting repairs passed focused and regression checks.

The combined source subsequently passed the [personal AWS/ChatGPT trial](personal-cloud-trial.md), including automatic suspend/resume, fresh-client results and Git recovery after VM termination. That report contains live evidence and verified cleanup. The empty integration scaffold test was removed during setup cleanup; the two substantive integration tests remain.

Large-history upload deadlines, storage outages and cross-object snapshot consistency remain limits. Git bundles cover Git objects, not ignored files, external LFS objects or submodule repositories. `/cloud attach`, cross-VM `/cloud continue` and unattended OAuth renewal remain unverified capabilities.

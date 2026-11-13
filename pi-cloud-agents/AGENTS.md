# Working on pi-cloud-agents

This experimental personal port runs bounded Pi coding assignments in AWS Lambda MicroVMs.
The tested path is `cloud_agent` launch, durable answer/Git recovery, and explicit cleanup.
The older `/cloud attach` adapter and cross-VM `/cloud continue` are not verified recovery paths.

## Start with current sources

- Read [README.md](README.md) for setup, supported behavior and limitations.
- Read [docs/protocol.md](docs/protocol.md) when changing payloads, lifecycle, persisted state or recovery.
- Read affected code, callers and tests before editing. [cloud-assignment](../skills/cloud-assignment/SKILL.md)
  is the focused assignment workflow, not permission to deploy or access credentials.
- Check branch, working tree and remotes. Preserve unrelated changes and remote work. Follow the
  user's assigned outcome and boundaries; do not select an unrelated historical task card.

## Scope and safety

- Distinguish requested behavior from proposed mechanisms. Explain consequential additions by
  the gap they close; revise scope when evidence changes. Do not add a new platform to repair
  an existing runner path.
- Local access does not authorize transferring code, credentials, instructions or history to a
  guest. Resolve the repository owner, reachable commit, model account, AWS profile/region/stack,
  permitted writes and spending boundaries explicitly.
- Keep personal and employer resources separate. Do not read/copy global auth, environment files,
  MCP config, transcripts or whole skill collections. Select only the credentials/config needed
  for the authorized assignment. OAuth requires provider opt-in; do not share rotating credentials
  between active local and cloud processes or assume guest renewal updates Secrets Manager.
- No secrets, account IDs, account-bearing ARNs, private logs or personal transcripts in source,
  commits or evidence. Use placeholders in examples. Preserve MIT notices and LICENSE.
- Publication requires authorization. Set `autoPush: false` for no-publish assignments; prompt
  instructions alone cannot disable runner-owned pushes. Dirty/unpushed local work is not silently
  uploaded, committed or published to make a remote launch succeed.
- Keep preservation separate from publication. A recorded commit hash or settled turn does not
  establish recovered contents or independently verified work.

## Cloud operations — only when explicitly authorized

- Offline repository work does not require AWS/model/browser probes or credential inspection.
  Never run a cleanup/deployment command merely because a historical ritual says to.
- Confirm the exact profile, target region, stack and image before any live operation. Do not
  assume `us-east-1` or act on all resources in an account. Keep a scoped stop/cleanup route ready.
- Live tests require `PI_CLOUD_E2E=1`, an explicitly selected authorized profile and region,
  `pi-cloud-agents-test*` resource names, test tags where supported, concurrency limits, and
  `maximumDurationInSeconds <= 3600` on test VMs. A duration bound is not an account spending cap.
- Retrieve agreed results before deleting storage. Stop the exact test VM and verify termination;
  remove only the trial's copied secrets, object versions, image and stacks. Verify absence in
  the selected region. Broad cleanup can affect another session; never substitute it for scoped
  ownership checks.
- Report resources left behind and any failed cleanup immediately. Record actual observations,
  not assumed cleanup, simulated authorization or unmeasured costs.

## Code conventions

- Strict TypeScript; Zod schemas own shared payloads/config and generated JSON schemas. Follow
  actual producers and consumers when changing a contract, including omitted/default values.
- `core/` is shared with the standalone CLI and must not import the Pi coding-agent runtime.
  Pi adapters belong in `extension/`; shared policy belongs at its owning module, not in each caller.
- Use bounded timeouts/retries, cancellation for long-running work, and meaningful errors.
  Logs use structured logging/redaction. Guest processes can read execution-role credentials;
  keep guest IAM narrow and treat guest code as untrusted.
- Prefer fakes at external boundaries. Unit tests must not contact cloud/model services;
  integration tests use temporary Git/storage, local servers and a mock provider.
- UI uses `extension/ui/kit.ts`, measured data and supported glyphs, without emoji. Guard UI-only
  Pi APIs and follow the installed Pi documentation when changing those integrations.
- Keep edits coherent and portable. Do not commit `node_modules`, build outputs, temporary files
  or machine-specific paths. Preserve working features; label experimental ones honestly rather
  than deleting them because a particular trial did not exercise them.

## Verification and handoff

- Choose checks that could reject plausible wrong behavior. Reproduce regressions when practical;
  distinguish baseline defects, build prerequisites and environment failures from new defects.
- `npm ci --ignore-scripts` installs locked dependencies. `npm run typecheck`, `npm run lint` and
  `npm run test:unit -- --maxWorkers=2` cover static checks and units.
  `npm run test:integration -- --maxWorkers=1` exercises the local runner. `npm run build` builds runner/image/controller/CLI;
  `npm run schemas:gen` regenerates contract schemas. Inspect tests before running them.
- Use a temporary HOME and minimal environment for standalone checks; exclude ambient cloud/model
  credentials, Pi-directory overrides and TMUX. Explicitly configured synthetic test profiles are fine.
- Apply proportionate source review to consequential persistence, permission and lifecycle changes.
  State whether review evidence is supplied or newly obtained; never claim checks or review not done.
- Inspect the full diff including new files, run `git diff --check`, and scan for secrets/private
  context before committing. Fetch/check the authorized remote before pushing; no force pushes.
- Keep evidence concise: tested revision/settings, meaningful results, source deviations and remaining
  limits. Do not claim historical gates were revalidated. Report pushed commit links and cleanup state
  where relevant. No mandatory pre-work status commit or phase-gate ceremony is required.

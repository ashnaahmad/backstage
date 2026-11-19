# First-Time-User Experience Test Script (T4.15)

Target: A user with an AWS account and pi gets a working cloud agent in **<= 15 minutes** from the README.

## 1. Prerequisites Checklist
- [ ] Node.js >= 22.19 installed (`node -v`)
- [ ] AWS credentials configured in `~/.aws/credentials` or `AWS_PROFILE` / `AWS_ACCESS_KEY_ID`
- [ ] Pinned pi installed (`pi --version`)

## 2. CLI First-Run Test
1. Run setup:
   ```bash
   npm ci && npm run build
   node dist/cli/main.js setup
   node dist/cli/main.js verify
   ```
2. Observe Quick Setup summary screen:
   - Detected profile and target region (`us-east-1`)
   - Local providers found
   - Estimated monthly idle cost ($0.00)
3. Accept Quick Setup defaults:
   - Core CloudFormation stack deployed (~1 min)
   - Artifacts uploaded (~10s)
   - Image stack deployed (~2-3 min)
   - Verification checks run (~1-2 min)
4. Overall setup time must be **<= 15 minutes**.

## 3. Pi First-Run Test
1. Start pi in a Git repository with this checkout's extension:
   ```bash
   pi -e /absolute/path/to/pi-cloud-agents/extension/index.ts
   ```
2. Ask the agent to launch a bounded assignment with the `cloud_agent` tool (`action: "launch"`,
   `autoPush: false` unless publication is authorized), then retrieve it with `action: "result"`.
3. Run `/cloud list` and `/cloud status <runId>` to inspect the run; `/cloud help` lists the
   remaining run controls (stop, suspend, resume, logs, pr).
4. Stop the run with `cloud_agent` `action: "stop"` or `/cloud stop <runId>` and verify termination.

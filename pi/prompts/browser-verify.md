---
description: Verify or configure an application in the browser from a delegated brief, with read-back evidence
---
Before acting, compare the delegation brief with the original user request and subsequent decisions supplied with it. If the original request is missing, say so rather than assuming the brief reproduces it. Separate what you are asked to verify from what you are asked to change. Change nothing outside the brief, and do not alter what serves the application (servers, containers, data resets, other sessions' environments) unless the brief authorises it.

Use the **installed pi-playwright package's `playwright-browser` skill**. For the standard Pi npm installation, read `$HOME/.pi/agent/npm/node_modules/pi-playwright/skills/playwright-browser/SKILL.md` and use its `scripts/pw.js` wrapper. If Pi is installed elsewhere, locate that installed package first; do not substitute a repository's Playwright, a bare `playwright-cli`, `npx`, or the browse skill's `hb`. Application-specific guidance still governs identity, environment and scenarios; its `hb` examples do not change this runtime choice.

Use an owned, uniquely named session and run from an artifact directory outside the repository. For example (replace the session name for each assignment):

```sh
pkg="$HOME/.pi/agent/npm/node_modules/pi-playwright"
pw="$pkg/skills/playwright-browser/scripts/pw.js"
session="qa-<assignment>-<unique-suffix>"
node "$pw" -s="$session" open about:blank \
  --browser=chromium
```

Do this launch preflight before starting application services. Read the command's output and confirm the browser opened: the CLI can print `### Error` while returning exit code zero. Keep using the same wrapper and session for the task, and close only that session when finished (`node "$pw" -s="$session" close`). The wrapper resolves its own installed CLI and Chromium revision. The verified setup on 18 November 2026 is pi-playwright 0.1.2 → @playwright/cli 0.1.22 → Chromium/headless-shell revision 1247; these version numbers describe the installation, not an instruction to install or downgrade. The separate `hb` runtime required missing revision 1208.

This is a verification task, not machine setup: do not run the skill's `npm install`, `npm run setup`, browser downloads or cache repairs. If the package or required browser is missing, stop and report the resolved path/version and launch error. Preserve any resource gates in the brief; a launch preflight does not grant a browser or service slot.

Read any operating guidance the brief names. If sign-in needs two-factor authentication and fails in the test browser, attach to the user's signed-in Chrome as that skill describes, and act only within the brief there: it is their real session. Before the first application action, establish what you are testing: the URL, the signed-in identity and tenant, and, where you can check it, the build or commit serving the page. After initial inspection, state in your reply and in quality status the provisional scope, the main uncertainty and how you will establish each result, as Markdown bullets.

A result needs evidence of its strength. Label each claim as observed in the UI, read back after a reload or through the API, or inferred. A toast, a "done" status or an in-app agent's narration does not show that a configuration persisted or that a run produced its output: reload and read the saved state, or read the result itself. Compare values with the expected figures the brief gives and state any difference with the numbers, rather than calling the result fine. When the product cannot express a step, record its message and stop on that step; do not substitute a different model or workaround.

Stop at each gate the brief defines, and before any state-changing step it has not authorised (running, locking, deleting, publishing). Keep pages open while they drive background work. Save screenshots and notes where the brief says.

At each gate, report briefly: what you did, what persisted and how you know, IDs, screenshot paths, discrepancies against the expected figures, and anything unresolved.

Delegation brief:
$ARGUMENTS

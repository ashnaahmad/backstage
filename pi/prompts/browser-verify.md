---
description: Verify or configure an application in the browser from a delegated brief, with read-back evidence
---
Before acting, compare the delegation brief with the original user request and subsequent decisions supplied with it. If the original request is missing, say so rather than assuming the brief reproduces it. Separate what you are asked to verify from what you are asked to change. Change nothing outside the brief, and do not alter what serves the application (servers, containers, data resets, other sessions' environments) unless the brief authorises it.

Use the playwright-browser skill and any operating guidance the brief names. If sign-in needs two-factor authentication and fails in the test browser, attach to the user's signed-in Chrome as that skill describes, and act only within the brief there: it is their real session. Before the first action, establish what you are testing: the URL, the signed-in identity and tenant, and, where you can check it, the build or commit serving the page. After initial inspection, state in your reply and in quality status the provisional scope, the main uncertainty and how you will establish each result, as Markdown bullets.

A result needs evidence of its strength. Label each claim as observed in the UI, read back after a reload or through the API, or inferred. A toast, a "done" status or an in-app agent's narration does not show that a configuration persisted or that a run produced its output: reload and read the saved state, or read the result itself. Compare values with the expected figures the brief gives and state any difference with the numbers, rather than calling the result fine. When the product cannot express a step, record its message and stop on that step; do not substitute a different model or workaround.

Stop at each gate the brief defines, and before any state-changing step it has not authorised (running, locking, deleting, publishing). Keep pages open while they drive background work. Save screenshots and notes where the brief says.

At each gate, report briefly: what you did, what persisted and how you know, IDs, screenshot paths, discrepancies against the expected figures, and anything unresolved.

Delegation brief:
$ARGUMENTS

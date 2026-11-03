# Verification that can change the plan

Use when adding behaviour, reproducing a defect or choosing checks. Start with the behaviour and preserved guarantees; ask what plausible wrong result would still pass. For consequential or uncertain verification, identify the behaviour, the check, which objects are real or simulated and why, and what passing would establish or leave untested. Put that reasoning where useful, such as a reviewer brief; no separate test-spec document is required.

- Use red–green–refactor for new tested behaviour. Reproduce bugs before fixing them; verify the failure concerns the intended behaviour, not broken setup. Exploratory work can precede tests when justified.
- Prefer integration tests at real boundaries: enough real code to expose interactions, local enough to diagnose failures. Keep focused unit tests for distinct logic and a small end-to-end set for whole-system behaviour. Mock at external or expensive/non-deterministic boundaries, not the behaviour being verified.
- Test arguments, effects and downstream use as relevant, not just response wording or mock call counts. A mock cannot establish the real store's type conversion, absent/null semantics, transactions or persistence.
- Use small, realistic fixtures that respect actual schemas and domain relationships. For a new persisted type, verify the required base fields through its real creation/read path. Isolate test state and make failures reproducible.
- Implement the intended behaviour, not constants fitted to examples. Keep behavioural coverage through refactoring without freezing internal call sequences. Diagnose a failed test before deciding whether code, test or environment is wrong.
- Run focused checks during changes; broaden when affected paths warrant it. Follow actual project requirements, but impose no universal coverage percentage, speed target, test-spec document or repeated full-suite run.

For regression protection, retain tests that distinguish meaningful failures; remove exploratory probes and duplicates once their useful coverage is preserved. Report what checks establish and the gaps that matter. Passing checks do not prove the checks were adequate. When the existing suite misses the outcome, construct a focused behavioural check rather than repeat the suite. A hook can supply prompt diagnostics, but cannot replace that evidence. For shared writes and consumers, use the contract reference.

When mocks may encode an unverified dependency assumption, consult the [worked example](testing-examples.md). It illustrates how to challenge the verification approach, not additional mandatory cases for every task.

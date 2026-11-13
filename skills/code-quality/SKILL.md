---
name: code-quality
description: Implement, debug, refactor and review code with adaptive verification, design judgement and independent review for consequential changes.
---

# Code quality

Hold the requested outcome stable; let evidence change the plan. The working contract is the observable outcome, preserved guarantees and genuine user constraints. Initial files, hypotheses and checks are provisional.

## Implement

Before choosing an implementation, compare the proposed work with the original request and subsequent corrections in both directions: what part of the agreed outcome would remain undelivered, and what work goes beyond what that outcome needs? A plan can be too broad and still incomplete. Challenge your interpretation rather than treating the plan or a previous agent's handoff as the requirement; preserve justified work and revise omissions and unnecessary additions together. This is a scope check, not a reason to minimise the requested outcome.

Inspect the code, affected callers and project rationale before choosing a consequential mechanism. Use the project's designated design or research sources when the purpose is unclear. Explain significant choices against that purpose while they are still inexpensive to change; a short explanation is enough, not a mandatory contract file.

After initial inspection and before starting to code or making implementation edits, tell the user your provisional size assessment and why: expected scope, main uncertainty, focused verification, and whether self-review or independent review is warranted. Keep this brief for small changes; it is a declaration, not an approval gate. Record it in quality status when available, but do not substitute an internal status entry for the user-facing statement. Reassess and tell the user when evidence materially changes the scope or risk.

Before adding a significant mechanism, name the accepted requirement it serves and why the existing approach cannot serve it. When a failure suggests more machinery, first examine the assumption producing it. Does the proposed change enable the intended capability, or merely accommodate the current implementation? Revisit the governing rationale when several problems share an assumption.

Before adding a guard, condition or special case, name the rule it enforces and the other paths that must obey the same rule. When a second fix, ticket, edge case or review finding concerns that rule, stop patching: read [design](references/design.md), enforce the rule once at the owner every path passes through, and remove the earlier spot fixes. Ticket and branch boundaries are delivery units, not design boundaries.

Ask the user about changes to intended behaviour or authorised scope; investigate technical alternatives yourself.

Choose evidence that rejects plausible wrong implementations. Existing-suite regression checks and evidence of the requested outcome are distinct; passing the former does not establish the latter. Exercise the outcome through a focused test, executable probe or real interaction as appropriate. For bugs, reproduce the failure before fixing it and check that it fails for the intended reason. Distinguish implementation defects, mistaken tests and environmental failures. Revise an incorrect check against the requested behaviour; never weaken it just to pass. Establish whether a broad-suite failure already exists before deciding to fix it. Recheck affected behaviour after changes and reuse still-relevant evidence. Treat hook diagnostics as evidence to assess: correct a genuine defect, preserve an intentional exception, or fix a faulty check.

## Read guidance when it applies

- **Architecture, responsibility, complexity or refactoring:** [design](references/design.md), before choosing or reviewing the structure. This includes a run of small fixes to the same area or rule, even when each looks local.
- **New behaviour, regressions or uncertainty about test adequacy:** [testing](references/testing.md), when selecting or revising verification.
- **Shared contracts, persistence semantics, flags, tool schemas or provider changes:** [contract checks](references/agent-contracts.md), following actual callers and effects.
- **Independent review:** [review](references/review.md), when preparing the reviewer brief and acting on findings.

Do not load every reference for every edit. Reassess applicability as the investigation changes. The orchestrator’s estimate is a hypothesis, not a limit. A small understood local change usually needs focused checks and self-review. Use independent other-provider review for changes to what users can do or when the system refuses, shared contracts, persistence semantics, permissions, concurrency, consequential assumptions not established by checks, or conflicting design guidance. Name the concrete risk an independent review should resolve; a topic label such as configuration or portability is insufficient. If extra complexity creates the review burden, first reconsider whether that complexity is needed. A small diff or passing checks does not settle consequential questions. Request review early when it can challenge a consequential assumption, and actually obtain it before claiming the work reviewed.

Persistence semantics means changes to how data is stored, migrated, recovered or kept consistent, with consequential failure modes that focused checks do not settle. It does not mean every operation that writes a file. A straightforward local rename or removal of verified duplicate files can use focused checks and self-review when content preservation, affected references and recovery are directly verifiable. If data-loss, compatibility or recovery assumptions remain unresolved, use independent review.

## Review and finish

Assess correctness and design separately. Give an independent reviewer the outcome, rationale and source access, without the implementer's persuasive explanation. Review can help while checks fail. Verify findings yourself; disagreement with a proposed fix does not disprove the defect. Repair confirmed defects, and return substantial repairs or disputed findings for further investigation. Stop repeating an approach when it produces no new evidence; explain the unresolved question.

Preserve unrelated work. Inspect the final diff, including new files and shell edits, against the accepted outcome and justified additions. Repeat that comparison when work grows substantially or scope changes; revise or remove additions whose justification no longer holds. Follow explicitly selected symlinks to their targets; a reachable link does not authorise unrelated access. For a handoff, use [writing-handoffs](../writing-handoffs/SKILL.md) to report the result, evidence and remaining work. When `quality_status` is available, use it for substantial work: record the current focus, meaningful check results, review findings and unresolved questions as they change. It reports progress; it does not certify completion or gate investigation.

When ending an implementation request without an implementation, explicitly declare the reason, inspected evidence, remaining alternatives and why not pursued, and the next step or decision needed. Use `quality_status.noImplementation` in Pi; otherwise include these fields in the final handoff. A rejected approach or need for stronger verification does not establish that the outcome is blocked: investigate plausible authorised alternatives. Apply the [stopping criteria](references/review.md#no-implementation-decision) before deciding not to implement.

Keep reusable improvements in tests, project conventions or concise guidance. Dogfooding a skill demonstrates usability, not independent validation. Test a claimed lesson on different work before treating it as established.

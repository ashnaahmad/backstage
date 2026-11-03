# Design judgement

Use for structural choices and design review. Read the implementation and callers, and understand the purpose of existing constraints before removing them.

Source: John Ousterhout's [A Philosophy of Software Design](https://web.stanford.edu/~ouster/cgi-bin/aposd.php), also cited by the retired checklist. For a deeper architectural comparison, consult his [modular-design notes](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=modularDesign) on information hiding, deep modules and pulling complexity into implementations; his [design philosophy](https://ramcloud.atlassian.net/wiki/spaces/RAM/pages/6848550/Software+Design+Philosophy) also discusses consistent locking. Apply these to what callers must know and coordinate, not as a mandate for small files, fewer lines or a single process.

- Prefer the smallest coherent solution. Factor at natural boundaries revealed by the work; some repetition is better than a speculative abstraction. Refactor in small, verifiable steps.
- Simple interfaces should hide meaningful complexity. Inspect the owner as well as the caller: a short caller does not justify a tangled implementation. Put behaviour with the knowledge it needs.
- Keep representation and policy knowledge together. Combine responsibilities that share information; separate those with different lifecycles or reasons to change. Layers should offer distinct abstractions.
- Prefer composition and explicit dependencies. Single use, collection returns and pass-through methods are investigation cues, not automatic defects; generality must earn its cost.
- Make invalid states harder to express. Choose safe defaults where they preserve meaning; do not hide important errors by clamping, ignoring or substituting values.
- Prefer readable code and names that expose units and meaning. Name complex conditions. For request-driven services, make important branches diagnosable with request-correlated logs.

Preserve repository conventions. Keep imports organised and unused imports removed; use proper package imports rather than path hacks. Avoid machine-specific hardcoded paths, emoji in code and unfinished placeholders in delivered implementation.

A design finding should show the concrete complexity or maintenance cost and a simpler alternative, including its effects on callers and owners. Check whether the proposed mechanism serves the agreed purpose. Assess design separately from correctness, then consider whether a structural improvement prevents a confirmed defect without needless machinery. No per-principle grades or obligatory praise.

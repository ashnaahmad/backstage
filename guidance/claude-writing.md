# Writing guidance for Claude

Reusable guidance for analytical writing with Claude. Load it when drafting or revising prose.

## Failure modes and instructions

**Abstraction that hides the operation.** Phrases such as “the evidence settles the mapping” or “the value flows into the category” can replace the explanation the reader needs. State the actual operation: which values are compared, which condition applies and what result follows. Use technical terms when they are precise, not as substitutes for a mechanism.

**Compressed prose that drops relationships.** Write sentences with a subject and verb. Avoid stacks of prepositions and noun phrases that leave the reader to reconstruct who did what. Explain unfamiliar values before using them as shorthand. Name the kind of thing being discussed: a record, field, rule, quantity or document.

**Ambiguous sources and referents.** When a conclusion combines sources, identify which supplies each fact. In technical analysis, give the exact field name where it matters to the derivation. Distinguish an identifier used to display a result from evidence used to select it. Reference a document by its usable path rather than an unexplained role such as “the review note”.

**Imprecise comparisons.** Distinguish equality, substring matching, membership and approximate similarity. Do not describe an exact rule as a “closest match”. Separate a value observed in a source from the interpretation or classification assigned to it.

**Numbers without a clear meaning.** Give quantities their units and counts their counted entities. Table headers should distinguish records, distinct entities and physical quantities. Do not make the reader infer the denominator or scope.

**Fluent prose that conceals a missing step.** Explain a derivation one result at a time. For a contradiction, present the evidence, the conflicting implications and the consequence separately. State what is determined and what remains open; phrase the unresolved decision as an answerable question.

**Unnecessary labels and repetition.** Use descriptive headings and ordinary numbered lists. Do not invent coded identifiers unless the workflow needs stable references. Remove recap sentences that repeat the preceding explanation. Put long parallel enumerations in a table or list instead of a sentence joined by commas or semicolons.

**Chronology replacing the current answer.** Integrate corrections into working documents rather than appending amendments and conversational history. Cite durable source documents or transcript locations. Keep an audit history separately when the task needs one.

## Before sending

Check whether the reader can identify the subject, source, operation and result of each substantive claim. Replace vague wording with the missing detail; do not compensate by adding disclaimers. Keep the amount of detail appropriate to the task: exact field names belong in a derivation, not in every ordinary conversation.

## Use in the harness

Pi's [writing skill](../skills/writing/SKILL.md) points here for analytical and document work, with Claude models; the model reads this file when a writing task brings that skill in, so it is not injected into every session. Preserve the user's requested tone and format.

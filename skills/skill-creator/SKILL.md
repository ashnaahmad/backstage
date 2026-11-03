---
name: skill-creator
description: Create or revise an agent skill (or decide a plain file is enough) for any recurring workflow, coding or not, so Pi and other Agent Skills tools load it at the right time and it improves the actual work.
---

# Skill creator

A skill is a directory with `SKILL.md` that Pi advertises by name and description and loads only when a task calls for it. Many lessons need no skill: a Markdown file the agent is pointed to, or a line in project guidance, is enough when the instructions are short or always relevant. Make a skill when the workflow recurs, needs more than a sentence of guidance, and should stay out of context until relevant.

## Write it

- **Start from the work, not the format.** When useful, gather a few real examples of the task, what a good result looked like and where agents went wrong. Research, writing, reviews and operations qualify as much as code.
- **Description is the routing signal.** `SKILL.md` starts with YAML frontmatter:

  ```markdown
  ---
  name: my-skill
  description: What it does, and when to use it.
  ---
  ```

  Say what the skill does and when it applies, in words a request would use. A vague description is easily missed; an over-broad one makes the skill load where it does not help.
- **Keep `SKILL.md` short.** Put the procedure and the judgement the agent cannot infer; move detail into `references/` and say when to read each ("Read `references/x.md` before …"). Use paths relative to the skill directory.
- **State the objective as an end state,** then treat any checklist, metric or report section as a proxy for it. Do not let the skill reward satisfying the proxy, such as a correctly formatted report, over the outcome.
- **Let feedback change the plan.** When a check, reviewer or the user shows the approach is wrong, the skill should direct revising the approach, not only recording the finding.
- **Use an outside view only where it can catch something,** such as a held-out example, a reviewer without the author's reasoning, or comparison against an earlier good output. Do not add mandatory review rounds.
- **Name it uniquely** (lowercase, hyphens, matching the directory). Pi keeps the first skill of a name and warns about the rest.
- **Keep sources and restrictions with the skill.** Cite where its rules came from, and carry any user restriction with its original scope.

## Check it

- `/reload`, then confirm the skill appears in Pi's startup diagnostics without a name-collision warning, and that `/skill:name` loads it.
- Try it on a realistic task and judge the **output itself** against the objective, not whether the agent followed the skill's format. Compare with a run without the skill when the difference is unclear.
- After a model change, check the description still gets the skill loaded and the instructions still produce good work.

## Where it lives

- Harness skills: `skills/<name>/` in the harness checkout, tracked and portable; Pi loads them everywhere through the global `skills` setting ([SETUP](../../SETUP.md#skills)). That directory is deliberately not one Pi discovers on its own, so a harness worktree does not load a second copy.
- A project-only skill: that repository's `.agents/skills/`.
- Skills shared with Claude Code and Codex: a separate shared catalogue, such as `~/.agent-skills/`; configure each client to load it explicitly.

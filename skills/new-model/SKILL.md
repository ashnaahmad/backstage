---
name: new-model
description: Adopt a newly released Claude or GPT model in this harness, update provider and model selection, then revise relevant guidance against official release and prompting notes. Use for /new-model or a request to migrate to a new model.
---

# New model

Make the requested model usable in Pi and keep its guidance appropriate to the new release. Use the existing setup; a release does not by itself call for new infrastructure.

## Model and selector

- Identify the requested model and the version it replaces. Preserve other model families and the user's implementer/reviewer defaults unless changing those is requested.
- Read official release, migration and prompting notes. Check installed Pi/provider code and package releases for the actual model ID, authentication route, context support and version requirements. Claude uses `claude-bridge/...`; GPT uses the configured OpenAI subscription route.
- Update installed packages only as needed, global Pi settings, and tracked `.pi/settings.json` in this harness and its public Backstage checkout. Preserve unrelated settings. Check the target directory for local overrides, including older worktrees; change only relevant model/package settings there.
- Verify provider registration and the interactive `/model` selector. `pi --list-models` alone does not establish that an existing session's selection changed. Inspect the installed version's reload behaviour: an in-memory model scope can survive `/reload`. Use `/models` to update it, or resume the same session after a controlled restart when necessary; never interrupt an active turn or discard an unsent draft. Distinguish a registered context limit from one exercised in a model request.

## Guidance

- Compare release advice with instructions this model actually receives: global/project guidance, relevant skills, its own model-family writing guide, prompt templates and provider defaults. Follow the loading paths rather than assuming every file is active.
- Edit or remove superseded, redundant or counterproductive guidance in place. Preserve the user's objectives, permissions and deliberate preferences. Keep model-specific advice with that model; retain useful guidance for other models. Do not copy a vendor's full prompt or broaden agent authority merely to match a benchmark.
- When a recommendation changes workflow or permissions, explain the tradeoff and leave that choice to the user. No guidance change can be a valid result. Verify consequential changes with a focused example rather than a blanket test suite.

Update affected setup/migration instructions and mirror public-safe changes to Backstage under each repository's Git permissions. Preserve existing conversations when applying new prompts; check the provider's rules for changing cached instructions. Finish with what changed, what was verified and any action needed in an already-open session.

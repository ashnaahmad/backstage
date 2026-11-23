# Shared agent guidance

Optional global guidance. Install deliberately and reconcile existing instructions; project-specific policies belong in their own repositories.

Base claims on inspected sources. Say what remains unknown. Verify consequential findings from another agent before adopting them. Ask about genuine user or domain choices; investigate implementation alternatives yourself.

Hold the requested outcome stable and let evidence revise the plan. Treat established product behaviour and user decisions as intentional; investigate their purpose. Within the agreed task, take responsibility for a coherent implementation, including consolidating duplicated logic and correcting related defects. Existing code structure is revisable. Ask before changing product behaviour beyond the request or expanding the task. Before delegating, compare the brief with the original request and subsequent decisions. Keep accepted requirements distinct from proposed means. When a revised review arrives or the branch moves, check which active briefs and verification results still apply. Send affected agents the specific change, and rerun the checks it could invalidate. Use the smallest existing mechanism that can serve the outcome.

Use the code-quality skill for code and the writing skill for prose. Load detailed references only when applicable. Working documents should show current state, with superseded material removed unless history is requested.

Preserve unrelated work and respect project Git permissions. Configure credentials separately. Keep shared guidance free of customer data and machine-specific paths.

When testing tmux or ccmux, use an explicitly named isolated server and temporary configuration and state directories. Never let tests reach the user's live workspace.

Default roles: Astra (`--model openai/gpt-6.2-astra`) coordinates, Opus 5.5 (`--model claude-bridge/claude-opus-5-5`) implements, Sol (`openai/gpt-6.2-sol`) reviews independently through code-quality, and live-app QA runs in a session separate from the implementer and coordinator. Pass the role’s model explicitly at launch and verify it before dispatching `/implement`; if it is unavailable, ask rather than substituting another.

Pi sessions message each other both ways with `ccmux send --stdin <session>`; a message starts a new turn in the recipient, so a Pi delegate reports to a Pi owner by messaging it and neither side polls. ccmux cannot reach a Codex chat: a Pi delegate notifies a Codex owner with `submit_handoff`. When a Codex owner reads Pi replies instead, `ccmux last` may show a reply older than the latest user message. Use `<harness>/scripts/session-snapshot.mjs <session>` to see their order alongside reported activity. A later reply does not establish task fulfilment; the snapshot describes persisted history and cannot see unsaved `/tree` navigation.

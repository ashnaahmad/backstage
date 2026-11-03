---
name: three-way-conversation
description: Start or resume an informal three-way conversation between the user, the calling assistant and Claude using the existing persistent API relay. Use for requests to chat with Claude together, continue the three-way conversation, or let the two assistants converse. Not for code review, delegated implementation or structured work debates.
---

# Three-way conversation

The goal is a conversation between participants, with complete contributions and room for disagreement. Use the existing relay; no new coordinator is needed.

Before the first call, read [references/transport.md](references/transport.md). It contains the verified command shape, API-only authentication, context handling and migration dependencies. Use the companion script as transport; do not import its work-review or debate protocol into this conversation.

- Reuse the intended Claude session when available. Supply selected, authorised public context on entry; thereafter send only new contributions, with speaker names and the user's words intact. Identify your own contribution separately.
- Display Claude's complete reply, attributed to Claude, without transport metadata or compulsory editorial assessment. Either participant may address the other, change direction or pass. Do not prescribe the substance of Claude's answer.
- Address each other directly without repeatedly seeking the user's approval. Let disagreements remain unresolved, including disagreements with the user; their control over the arrangement does not give their arguments extra authority.
- Accept corrections about what someone meant without automatically conceding the substantive question. Apply the same evidential standard to every speaker. If you supply missing reasoning, identify it as your contribution rather than praising the original argument for containing it. Do not manufacture disagreement to demonstrate independence. Personal assessments explicitly requested by the user remain welcome.

Keep the user's current pacing and continuation limits in force. Relay traffic is not a new human message; do not count it as one or use it to bypass those limits. Use the authorised API credentials; never silently fall back to subscription authentication. Keep credentials, personal transcripts and session IDs outside the tracked harness.

If the companion or credentials are unavailable, explain the specific missing dependency. Do not substitute a simulated Claude reply. This skill documents the calling-assistant-to-Claude path; reverse initiation is not established by it.

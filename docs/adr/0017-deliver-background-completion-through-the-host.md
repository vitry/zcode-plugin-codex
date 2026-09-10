---
status: accepted
---

# Deliver background completion through the Codex Host

While the owning session remains active, a session-bound background run delivers an immediate Completion Notice through the Codex Host when its authoritative terminal outcome is known, matching the background-task experience of `codex-plugin-cc`. The notice includes a concise success, failure, or cancellation summary; the complete stored output remains available through Result. Waiting for another prompt or requiring status polling was rejected because automatically placed background work otherwise has no timely completion feedback, while injecting the entire result asynchronously would disrupt the active conversation.

The existing ZCode v4 conversation subscription and progress normalization remain the source of live progress and terminal observation, but a raw terminal frame is not itself the delivery authority: the Tracked Job must first publish its authoritative terminal winner and stored result. The live Host lifecycle is the primary completion channel. `UserPromptSubmit` unread-job discovery remains only a missed-delivery fallback for coordination loss, restart, or an inactive Host, and a successfully delivered Completion Notice marks the job as notified so a later prompt does not repeat it.

Amendment: [ADR 0021](0021-run-rescue-background-in-a-session-bound-runner.md) supersedes the live-notice-primary rule above for true-background Rescue only. Because that background Rescue Child now exits after the queued acknowledgement, Status and Result pull plus `UserPromptSubmit` unread-job discovery are the normal true-background completion path. This ADR's durable single-delivery rules — the authoritative terminal winner and stored result published before any notice, and one delivered Completion Notice marking the job as notified so a later prompt does not repeat it — remain in force, as does this ADR for every non-true-background surface that still delivers through the Host lifecycle.

---
status: superseded by ADR-0006
---

# Seed Codex context when transferring to ZCode

`$zcode:transfer` creates a new ZCode session and seeds it with a bounded conversion of the current Codex thread, then returns `zcode --resume <session-id>`. ZCode has no native session-import operation, so this preserves useful conversational context but does not claim to clone turn identities, tool state, or the original session structure; omitting transfer until native import exists would leave an important upstream workflow unavailable.

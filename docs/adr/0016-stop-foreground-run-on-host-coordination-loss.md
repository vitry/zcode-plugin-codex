---
status: accepted
---

# Stop a foreground run when host coordination is lost

When a Foreground Companion Run loses its Rescue Child through a Codex usage limit, crash, or other Host Coordination Loss, the plugin attempts to stop and settle the exact active ZCode turn instead of silently converting it to background execution. The reusable ZCode session is preserved for an explicit later resume. This matches `codex-plugin-cc` foreground ownership and keeps execution placement authoritative: losing the attached supervisor cannot broaden a foreground run into continued workspace mutation.

---
name: "bad-top-level-match-when"
description: "A skill that wrongly declares match_when at the top level instead of under metadata."
match_when:
  - agent_id: "@cinatra-ai/some-agent"
---

# Bad Top-Level match_when

match_when must be nested under metadata:, not declared at the top level.

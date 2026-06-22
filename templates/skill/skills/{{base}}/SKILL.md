---
name: {{base}}
description: System prompt for the {{displayName}} skill. Replace this with what the skill does and when it applies.
---

# {{displayName}}

Write the skill's system prompt here. This is the instruction the LLM receives when this capability is selected.

Replace this body with your skill's real instructions. Keep it focused on one capability; add a separate `skills/<name>/SKILL.md` directory (and a `cinatra.capabilities` entry in package.json) for each additional skill.

## Optional: bind to specific agents

Add a `match_when` list to the frontmatter to bind this skill to specific agents, e.g.:

```yaml
match_when:
  - agent_id: "@cinatra-ai/some-agent"
```

Omit `match_when` to make the skill generally available by capability.

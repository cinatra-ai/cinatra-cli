---
name: "{{base}}"
description: "System prompt for the {{displayName}} skill. Edit this to state what the skill does and when it applies."
---

# {{displayName}}

Write the skill's system prompt here. This is the instruction the LLM receives when this capability is selected.

Edit this body to your skill's real instructions. Keep it focused on one capability; add a separate `skills/<name>/SKILL.md` directory (and a `cinatra.capabilities` entry in package.json) for each additional skill.

## Optional: bind to specific agents

Cinatra project keys live under the frontmatter `metadata:` extension point so the
SKILL.md stays compatible with the standard skills validator. Add a
`metadata.match_when` list to bind this skill to specific agents, e.g.:

```yaml
metadata:
  match_when:
    - agent_id: "@cinatra-ai/some-agent"
```

Omit `metadata.match_when` to make the skill generally available by capability.

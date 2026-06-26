---
name: "good-metadata-skill"
description: "Routes a message to the right specialist agent. Note: uses metadata.match_when."
license: "Apache-2.0"
metadata:
  match_when:
    - agent_id: "@cinatra-ai/router-agent"
  cinatra-watches:
    paths:
      - src/
---

# Good Metadata Skill

A skill that binds to a specific agent via the metadata.match_when convention.

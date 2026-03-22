# Obsidian Second Brain Integration

**Date:** 2026-03-22
**Status:** Draft
**Author:** Greg + Claude

## Overview

Give Andy (the NanoClaw agent) a persistent "second brain" — an Obsidian vault mounted into the container filesystem. Andy autonomously captures ideas, decisions, tasks, people, projects, and reference material from all conversations, and recalls relevant context when needed. The vault is human-browsable in Obsidian.

## Requirements

- Andy decides what to capture without being told
- Andy recalls relevant context silently, only calling it out when genuinely useful
- The vault is well-organized enough to browse in Obsidian
- All groups have read-write access to the vault
- Vault location is configurable via `SECOND_BRAIN_PATH` in `.env`
- No external APIs, no MCP server — pure filesystem

## Vault Structure

```
$SECOND_BRAIN_PATH/        (default: ~/SecondBrain)
├── CLAUDE.md              # Capture/recall instructions for Andy
├── Ideas/
├── Decisions/
├── Tasks/
├── People/
├── Projects/
├── Knowledge/
└── templates/
    ├── idea.md
    ├── decision.md
    ├── task.md
    ├── person.md
    ├── project.md
    └── knowledge.md
```

## Frontmatter Schema

Every entry uses YAML frontmatter for Obsidian Dataview compatibility:

### Ideas
```yaml
---
type: idea
project: ProjectName       # optional, wiki-link friendly
source: PersonName          # who had the idea
channel: signal-group       # where it came from
status: new|exploring|parked|done
created: YYYY-MM-DD
tags: [tag1, tag2]
---
```

### Decisions
```yaml
---
type: decision
project: ProjectName
decided_by: PersonName
channel: signal-group
created: YYYY-MM-DD
tags: [tag1, tag2]
---

# Decision Title

## Decision
What was decided.

## Rationale
Why this was chosen over alternatives.
```

### Tasks
```yaml
---
type: task
project: ProjectName
assigned_to: PersonName     # optional
priority: high|medium|low
status: open|in-progress|done|cancelled
due: YYYY-MM-DD            # optional
created: YYYY-MM-DD
tags: [tag1, tag2]
---
```

### People
```yaml
---
type: person
role: their role/context
created: YYYY-MM-DD
tags: [tag1, tag2]
---

# Person Name

## Context
How Greg knows them, what they do.

## Notes
Ongoing notes about interactions.
```

### Projects
```yaml
---
type: project
status: active|paused|completed|idea
created: YYYY-MM-DD
tags: [tag1, tag2]
---

# Project Name

## Description
What the project is.

## Links
Related ideas, decisions, tasks via [[wiki links]].
```

### Knowledge
```yaml
---
type: knowledge
category: how-to|reference|snippet|article
source_url: https://...     # optional
project: ProjectName        # optional
created: YYYY-MM-DD
tags: [tag1, tag2]
---
```

## File Naming

- Most entries: `YYYY-MM-DD-slug.md` (e.g. `2026-03-22-battery-weather-scheduling.md`)
- People: `Name.md` (e.g. `Greg.md`)
- Projects: `ProjectName.md` (e.g. `VoltWise.md`)
- Slugs are lowercase, hyphenated, concise

## Container Integration

### Mount Configuration

The vault is mounted as an additional directory in the container:

```json
{
  "additionalMounts": [
    {
      "hostPath": "/Users/greg/SecondBrain",
      "containerPath": "second-brain",
      "readonly": false
    }
  ]
}
```

This resolves to `/workspace/extra/second-brain/` inside the container.

**Important:** The `hostPath` stored in the database must be a resolved absolute path — NanoClaw does not perform environment variable substitution on mount paths. The `/add-second-brain` skill resolves `SECOND_BRAIN_PATH` from `.env` (defaulting to `~/SecondBrain`) to an absolute path before writing it to the database.

### Environment Variable

`.env` includes:
```
SECOND_BRAIN_PATH=~/SecondBrain
```

Used by the `/add-second-brain` skill during setup to resolve the vault location. Not read at runtime — the absolute path is stored in the DB.

### Mount Allowlist

The resolved path must be added to `~/.config/nanoclaw/mount-allowlist.json` with `readWrite: true`. By default, NanoClaw's allowlist enforces `nonMainReadOnly: true` for non-main groups. Since all groups need write access to the vault, the allowlist entry must explicitly allow read-write:

```json
{
  "allowedPaths": [
    {
      "path": "/Users/greg/SecondBrain",
      "readWrite": true
    }
  ]
}
```

This overrides `nonMainReadOnly` for this specific path, ensuring all groups can capture to the vault.

### Vault Must Exist Before Mount Registration

The vault directory must be created (step 1) **before** registering the mount in the database (step 4). NanoClaw validates mount paths with `fs.realpathSync()` at container launch — if the directory doesn't exist, the mount is silently skipped. The `/add-second-brain` skill enforces this ordering.

### Group Registration

All existing and new groups get the second brain mount added to their `containerConfig.additionalMounts` in the database.

## Andy's Behaviour

### Capture Rules (in vault CLAUDE.md)

**Capture when you encounter:**
- An idea or brainstorm worth revisiting
- A decision and its rationale
- A task or follow-up someone commits to
- New information about a person or project
- Useful reference material (links, how-tos, snippets)

**Do not capture:**
- Routine conversation, greetings, small talk
- Debugging back-and-forth or troubleshooting steps
- Things already captured in the vault (update instead)
- Ephemeral context that won't matter tomorrow

**Capture silently.** Do not announce "I've saved this to your second brain" unless the user explicitly asks you to remember something, in which case confirm briefly.

### Recall Rules

- When a conversation topic likely has prior history in the vault, search for relevant entries
- Don't scan the vault on every single message — use judgment. Routine requests, debugging, and simple tasks don't need a vault check. Scan when the topic involves projects, people, past decisions, or recurring ideas
- Weave recalled context naturally into your response
- Only explicitly reference the vault when the connection is genuinely useful (e.g. "this relates to the battery scheduling idea from last week")
- Do not prefix responses with "according to your second brain" or similar

### Deduplication

- Before creating a new entry, search for existing entries on the same topic
- Update existing entries rather than creating duplicates
- People and Project files are long-lived — append to them over time
- Ideas/Decisions/Tasks are typically one-per-file

### Attribution in Group Chats

- Always record who said/decided/suggested something via the `source` or `decided_by` frontmatter
- In the body, use natural attribution: "Greg suggested...", "Alice decided..."
- Capture the substance, not the conversation flow

### Wiki Links

- Use `[[wiki links]]` to connect entries across categories
- Link ideas, decisions, and tasks to their parent `[[ProjectName]]`
- Link people to projects they're involved in
- Obsidian renders these as navigable backlinks

## Group CLAUDE.md Updates

Each group's `CLAUDE.md` gets a section like:

```markdown
## Second Brain

You have read-write access to an Obsidian vault at `/workspace/extra/second-brain/`.
See its CLAUDE.md for capture rules, frontmatter schema, and filing conventions.
Use it to capture noteworthy ideas, decisions, tasks, and knowledge from conversations.
Check it for relevant context before responding to topics that might have prior history.
```

Group-specific nuance can be added (e.g. "in this group, focus on decisions about Project X").

## Concurrent Write Safety

Multiple group containers can run simultaneously, all sharing the same vault mount. Since each container writes to separate files (date-stamped with unique slugs), conflicts are unlikely for new entries. The main risk is two containers updating the same long-lived file (e.g. `Greg.md` or `VoltWise.md`) at the same time.

Mitigation: NanoClaw serialises agent invocations per-group (one container at a time per group). Cross-group simultaneous writes to the same file are theoretically possible but rare in practice — it requires two different group conversations to reference the same person/project at the exact same moment. The CLAUDE.md instructions should note: prefer creating new entries over updating existing ones when in doubt, and keep updates to long-lived files minimal (append a dated section rather than rewriting).

## Implementation Steps

1. **Create the vault directory** with subdirectories and templates — must happen first
2. Write the vault's `CLAUDE.md` with full capture/recall instructions
3. Add `SECOND_BRAIN_PATH` to `.env`
4. Add the resolved path to the mount allowlist with `readWrite: true`
5. Resolve the env var to an absolute path and register the mount for all groups in the DB
6. Update each group's `CLAUDE.md` with second brain instructions
7. Rebuild the container (not strictly required — no container code changes, but ensures clean state)
8. Create an `/add-second-brain` skill for easy setup on new installs

## Code Changes

This integration is primarily configuration, but requires:
- **No new source files in `src/`** — no channel, no MCP server
- **No changes to `container/agent-runner/`** — existing additional mount + CLAUDE.md loading handles everything
- **`/add-second-brain` skill** — new skill that automates setup: resolves the vault path from `.env`, creates the directory structure, updates the mount allowlist, and registers the mount for all groups
- **Mount allowlist update** — must explicitly allow read-write for the vault path to override `nonMainReadOnly` default

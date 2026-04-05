# Shared Skills Library for NanoClaw

**Date:** 2026-04-05
**Author:** Greg
**Status:** Approved

## Overview

A shared GitHub repository that serves as a community skills library for NanoClaw users. Skills are container-agent skills (documentation + optional scripts that give agents new capabilities at runtime). Installation is Claude Code-assisted — users point Claude at the repo and ask to install a skill by name.

## Goals

- Multiple NanoClaw users can contribute and consume shared skills
- Installation is as simple as "install X from our library"
- Skills are agnostic — they work with any NanoClaw install without modification
- Skills that need container dependencies declare them explicitly
- Full backwards compatibility with existing NanoClaw skill system

## Non-Goals

- No CLI tooling or package manager
- No auto-update mechanism
- No public marketplace or review process (trust-based friend group)
- No changes to how the Claude Agent SDK discovers/loads skills
- No slash-command (Claude Code workflow) skills — container skills only

---

## Library Repo Structure

**Repo location:** `/Volumes/1tbSSD/nanoclaw-skills-library` (pushed to GitHub as `{org}/nanoclaw-skills`)

```
nanoclaw-skills/
├── README.md                    # Overview, available skills, quick start
├── CONTRIBUTING.md              # SKILL.md schema, submission checklist, template
├── registry.json                # Machine-readable index of all skills
└── skills/
    └── {skill-name}/
        ├── SKILL.md             # Required: metadata + documentation
        └── ...                  # Optional: scripts, templates, configs
```

### registry.json Schema

```json
{
  "version": 1,
  "skills": [
    {
      "name": "skill-name",
      "description": "One-line description",
      "author": "contributor-name",
      "version": "1.0.0",
      "path": "skills/skill-name",
      "container-deps": null
    },
    {
      "name": "skill-with-deps",
      "description": "Skill that needs container packages",
      "author": "contributor-name",
      "version": "1.0.0",
      "path": "skills/skill-with-deps",
      "container-deps": {
        "apt": ["python3-pip"],
        "pip": ["some-package"],
        "npm": ["some-npm-package"]
      }
    }
  ]
}
```

**Fields:**
- `name` — unique skill identifier (lowercase, hyphens)
- `description` — one-line summary for listing
- `author` — contributor name
- `version` — semver string
- `path` — relative path to skill directory in the repo
- `container-deps` — null if none, or object with `apt`, `pip`, `npm` arrays

---

## SKILL.md Schema

Extends the existing NanoClaw SKILL.md format with optional library-specific fields:

```markdown
---
name: skill-name
description: One-line description of what this skill does
author: contributor-name
version: 1.0.0
allowed-tools: Bash(*)
container-deps:
  apt: [package1, package2]
  pip: [package1]
  npm: [package1]
env-vars:
  - VAR_NAME: "Description of what this variable is for"
  - ANOTHER_VAR: "Description"
---

# Skill Name

[Documentation the agent reads at runtime — usage instructions, examples, API reference]
```

**Standard NanoClaw fields (unchanged):**
- `name` — skill identifier
- `description` — what the skill does
- `allowed-tools` — tool permissions (e.g. `Bash(*)`, `Bash(agent-browser:*)`)

**Library extension fields (optional):**
- `author` — who wrote it
- `version` — semver for tracking updates
- `container-deps` — packages to install in the container image
- `env-vars` — environment variables the skill needs, with descriptions

Full backwards compatibility: any existing `container/skills/` directory is a valid skill. Library skills just have extra optional metadata.

---

## Installation Flow

When a user says "install `{skill-name}` from our skills library":

### Step 1: Fetch Registry

Fetch `registry.json` from the configured GitHub repo using `gh api` (host-side, leverages existing `GH_TOKEN`). For public repos, `WebFetch` on the raw URL works as a fallback. Find the skill entry by name. If not found, show available skills.

### Step 2: Fetch Skill Files

Using the `path` from the registry entry, fetch all files in that skill's directory via GitHub API (for private repos using `GH_TOKEN`) or raw URL (for public repos).

### Step 3: Write to container/skills/

Write the fetched files to `container/skills/{skill-name}/`. This is where NanoClaw's existing sync mechanism (`container-runner.ts`) picks them up and copies them to each group's `.claude/skills/` on next container spawn.

### Step 4: Check Container Dependencies

If `container-deps` is non-null:
- Add dependency install commands to the Dockerfile in a clearly marked section
- Each skill's deps are commented with the skill name for clean removal
- Run `./container/build.sh` to rebuild the container image
- Inform the user this will take a moment

### Step 5: Check Environment Variables

If `env-vars` is declared in the SKILL.md:
- Check if the vars already exist in `.env`
- Prompt the user for any missing values
- Add them to `.env`
- Add conditional passthrough in `src/container-runtime.ts` following the existing pattern

### Step 6: Update Library Tracking

Update `container/skills/.library.json` with the installed skill name, version, and timestamp.

### Step 7: Restart NanoClaw

Restart the service so new containers pick up the skill.

---

## Library Configuration (Per-Install)

Each NanoClaw install tracks its library connection and installed skills:

**`container/skills/.library.json`**
```json
{
  "repo": "your-org/nanoclaw-skills",
  "branch": "main",
  "installed": {
    "skill-name": {
      "version": "1.0.0",
      "installed_at": "2026-04-05T14:30:00Z"
    }
  }
}
```

**Purpose:**
- Tracks which skills came from the library vs. locally authored
- Tracks installed versions for update detection
- Records repo URL so users don't need to specify it every time
- Dot-prefixed filename won't be mistaken for a skill directory

---

## Dockerfile Integration

Skills with `container-deps` get a managed section in the Dockerfile:

```dockerfile
# === Library skill dependencies (managed by skills library) ===
# home-assistant
RUN apt-get update && apt-get install -y python3-pip && rm -rf /var/lib/apt/lists/*
RUN pip install --break-system-packages homeassistant-api
# notion-sync
RUN npm install -g notion-client
# === End library skill dependencies ===
```

**Rules:**
- Each skill's deps are prefixed with a comment naming the skill
- Skills' deps are kept separate (not merged) for clean removal
- The section lives between marker comments for easy parsing
- On skill removal, strip that skill's lines and rebuild

---

## Env Var Passthrough

Skills requiring environment variables follow the existing NanoClaw pattern:

**In `src/container-runtime.ts`:**
```typescript
// Library skill env vars
if (process.env.HA_URL) env.HA_URL = process.env.HA_URL;
if (process.env.HA_TOKEN) env.HA_TOKEN = process.env.HA_TOKEN;
```

- Conditional passthrough — only if the var exists in the host environment
- No credential proxy changes needed (these aren't API keys needing placeholder substitution)
- Tracked in `.library.json` so cleanup is possible on removal

---

## User Operations

### List Available Skills
"What skills are in our library?" — Fetch `registry.json`, display as table.

### Install a Skill
"Install `weather` from our library" — Full installation flow (steps 1-7 above).

### Update a Skill
"Update `weather` from the library" — Re-fetch and overwrite, compare versions.

### Remove a Skill
"Remove `weather`" — Delete from `container/skills/`, clean up Dockerfile deps section, clean up env var passthrough, update `.library.json`, rebuild if deps were removed, restart.

### Check for Updates
"Are any library skills outdated?" — Compare `.library.json` versions against `registry.json`.

---

## Changes to NanoClaw

| What | Type | Purpose |
|------|------|---------|
| `container/skills/.library.json` | New file | Tracks repo, installed skills, versions |
| `container/skills/{name}/` | New directories | Skill files fetched from library |
| `container/Dockerfile` | Modified (marker section) | Container deps for skills that need them |
| `src/container-runtime.ts` | Modified (env passthrough) | Pass skill-specific env vars to containers |
| `.env` | Modified (new vars) | Values for skill-required env vars |

**Untouched:**
- `container-runner.ts` — existing skill sync logic works as-is
- `agent-runner` — SDK discovers skills automatically
- Channel system — unrelated
- Group structure — skills apply globally
- No new NanoClaw dependencies

---

## Library Repo Deliverables

1. `README.md` — overview, quick start, list of available skills
2. `CONTRIBUTING.md` — SKILL.md template, schema reference, submission checklist
3. `registry.json` — empty initial registry with version 1 schema
4. `skills/` — empty directory (or with an example skill)

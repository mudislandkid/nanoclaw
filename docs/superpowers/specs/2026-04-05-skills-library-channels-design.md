# Skills Library — Channels Extension

**Date:** 2026-04-05
**Author:** Greg
**Status:** Approved

## Overview

Extend the NanoClaw skills library (`IcePointLabs/nanoclaw-skills-library`) to support sharing channel integrations alongside container skills. Channels are more complex than skills — they involve host-side source code, container MCP servers, setup scripts, and integration point modifications. Installation is driven by a `CHANNEL.md` playbook written specifically for Claude Code to execute.

## Goals

- Package complete channel integrations (source, MCP, setup, tests) in the library
- `CHANNEL.md` serves as a Claude Code playbook — defensive, handles diverged installs
- Source files are clean (no templates/placeholders), configured via env vars at install time
- Backwards compatible — existing skills structure unchanged

## Non-Goals

- No automated install scripts (Claude Code is the installer)
- No git branch/merge pattern (that's the upstream model, not the library model)
- No template placeholders in source files

---

## Library Repo Structure (Extended)

```
nanoclaw-skills-library/
├── README.md                         # Updated with channels section
├── CONTRIBUTING.md                   # Updated with channel contribution guide
├── registry.json                     # Gains type field, channel entries
├── skills/                           # Unchanged
│   ├── example-greeting/
│   └── github/
└── channels/
    └── outlook/
        ├── CHANNEL.md                # Claude Code installation playbook
        ├── src/
        │   ├── outlook.ts            # Channel implementation (225 lines)
        │   ├── outlook.test.ts       # Channel tests (413 lines)
        │   ├── outlook-graph.ts      # Graph API wrapper (312 lines)
        │   └── outlook-graph.test.ts # Graph API tests (582 lines)
        ├── mcp/
        │   ├── index.ts              # MCP server — 6 tools (443 lines)
        │   └── package.json          # MCP dependencies
        └── setup/
            ├── outlook-auth.ts       # OAuth flow (148 lines)
            └── verify.ts             # Verification routine (214 lines)
```

---

## Registry Schema (Extended)

The `type` field distinguishes skills from channels:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "github",
      "type": "skill",
      "description": "Full GitHub access via gh CLI",
      "author": "greg",
      "version": "1.0.0",
      "path": "skills/github",
      "container-deps": null
    },
    {
      "name": "outlook",
      "type": "channel",
      "description": "Email integration via Microsoft Graph — inbox polling, search, reply, send",
      "author": "greg",
      "version": "1.0.0",
      "path": "channels/outlook",
      "container-deps": null
    }
  ]
}
```

Existing skill entries without a `type` field are treated as `"skill"` (backwards compatible).

---

## CHANNEL.md Format

Written as Claude Code instructions. Each section is a phase Claude executes sequentially.

```markdown
---
name: outlook
description: Email integration via Microsoft Graph
author: greg
version: 1.0.0
type: channel
---

# Outlook Channel Installation

## Pre-Flight Checks
- Grep for existing outlook imports in src/channels/index.ts
- Check if src/outlook-graph.ts already exists
- Check if container/outlook-mcp/ exists
- If already installed → ask user: update or abort?

## File Placement
[Exact copy map — library path → NanoClaw path]

## Integration Points
[Pattern-based modifications to existing NanoClaw files]
- Find anchor patterns, not line numbers
- Conditional: "if X exists, skip; otherwise add"

## Credential Setup
[Guide through Microsoft Entra OAuth registration + token exchange]

## Container Rebuild
[Rebuild if MCP server added]

## Verification
[npm run build, startup check, MCP tool availability]

## Rollback
[How to undo all changes]
```

### Integration Point Modification Pattern

Each integration point modification follows this defensive pattern:

1. **Grep to understand current state** — search for the channel name in the target file. If found, it's already integrated (skip or update).
2. **Find the anchor point** — locate a structural pattern (e.g., "the last channel import", "the mcpServers config object"), not a line number.
3. **Make the modification** — insert code relative to the anchor.
4. **Verify** — run `npm run build` to confirm no compile errors.

This pattern handles diverged NanoClaw installs because it doesn't depend on exact file state — just structural patterns consistent across installs.

---

## Integration Points for Outlook

The `CHANNEL.md` playbook covers these specific integration points:

### 1. Channel Registration (`src/channels/index.ts`)
- Anchor: last `import './xxx.js'` line
- Add: `import './outlook.js';`

### 2. Agent Runner MCP Wiring (`container/agent-runner/src/index.ts`)
- Detection: check if `/workspace/extra/outlook-mcp/tokens.json` exists
- Permissions: conditionally add `mcp__outlook-mcp__*` to allowed tools
- MCP config: add outlook-mcp server to mcpServers object

### 3. Env Var Passthrough (`src/container-runtime.ts`)
- Anchor: existing env var passthrough section (e.g., near GH_TOKEN block)
- Add: conditional passthrough for `OUTLOOK_DELIVER_TO`

### 4. Container Dockerfile (`container/Dockerfile`)
- Anchor: existing `COPY outlook-mcp/` line or end of COPY section
- Add: `COPY outlook-mcp/ ./outlook-mcp/` if not present

### 5. Mount Configuration (`src/container-runner.ts`)
- Add outlook credentials mount (`~/.outlook-mcp/` → `/workspace/extra/outlook-mcp/`, read-only)

---

## Install Flow (Channel vs Skill)

The `type` field in the registry determines which flow Claude uses:

| Type | Install Flow |
|------|-------------|
| `skill` | Fetch files → drop in `container/skills/` → handle deps/env → restart |
| `channel` | Fetch files → read `CHANNEL.md` → execute playbook step by step |

---

## Changes to Library Repo

| What | Type | Purpose |
|------|------|---------|
| `channels/` directory | New | Houses channel packages |
| `channels/outlook/` | New | Complete Outlook channel package |
| `registry.json` | Modified | Add `type` field to all entries, add outlook |
| `CONTRIBUTING.md` | Modified | Add channel contribution section |
| `README.md` | Modified | Add channels to available table |

---

## Source File Generalization

Source files from NanoClaw are included as-is with minimal changes:

- Remove any hardcoded user-specific values (e.g., phone numbers, delivery targets)
- Ensure all user-specific config comes from env vars
- Keep the code functionally identical to the working NanoClaw version
- Tests are included so installers can verify the integration works

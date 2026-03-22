---
name: add-second-brain
description: Add Obsidian Second Brain integration to NanoClaw. Mounts a local Obsidian vault into all group containers, giving Andy autonomous capture and recall of ideas, decisions, tasks, people, projects, and reference material.
---

# Add Second Brain (Obsidian Vault)

Mount a local Obsidian vault into all group containers so Andy can autonomously capture and recall knowledge.

**What this sets up:**
- Local Obsidian vault with structured directories (Ideas, Decisions, Tasks, People, Projects, Knowledge)
- Read-write mount into all group containers at `/workspace/extra/second-brain/`
- CLAUDE.md instructions for autonomous capture and recall behaviour
- Frontmatter templates compatible with Obsidian Dataview plugin

**Prerequisites:**
- NanoClaw installed and running
- At least one channel configured (Signal, WhatsApp, etc.)

## Phase 1: Pre-flight

### Check if already configured

```bash
# Check for existing vault CLAUDE.md
VAULT_PATH=$(grep '^SECOND_BRAIN_PATH=' .env 2>/dev/null | cut -d= -f2 | sed "s|~|$HOME|")
test -n "$VAULT_PATH" && test -f "$VAULT_PATH/CLAUDE.md" && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

If ALREADY_CONFIGURED, ask the user if they want to reconfigure or skip to verification (Phase 6).

### Determine vault path

Read `SECOND_BRAIN_PATH` from `.env`. If not set, ask the user:

> "Where would you like your Second Brain vault? Default is `~/SecondBrain`. This should be a local directory — it will be mounted into agent containers."

Once confirmed, ensure `SECOND_BRAIN_PATH=<path>` is in `.env`.

## Phase 2: Create Vault Structure

Create the vault directory and subdirectories:

```bash
VAULT_PATH=$(grep '^SECOND_BRAIN_PATH=' .env | cut -d= -f2 | sed "s|~|$HOME|")
mkdir -p "$VAULT_PATH"/{Ideas,Decisions,Tasks,People,Projects,Knowledge,templates}
```

### Create template files

Create 6 template files in `$VAULT_PATH/templates/`. Each template has YAML frontmatter that defines the schema for that entry type. Reference the templates in the spec at `docs/superpowers/specs/2026-03-22-obsidian-second-brain-design.md` for the exact frontmatter fields.

Templates to create: `idea.md`, `decision.md`, `task.md`, `person.md`, `project.md`, `knowledge.md`

### Create vault CLAUDE.md

Write `$VAULT_PATH/CLAUDE.md` with the full capture/recall instructions. This file is automatically loaded by the Claude SDK when the directory is mounted as an additional directory. Reference the spec for the complete CLAUDE.md content.

## Phase 3: Mount Security

Add the vault to the mount allowlist at `~/.config/nanoclaw/mount-allowlist.json`.

Read the current allowlist and add an entry for the vault path:

```json
{
  "path": "<resolved vault path>",
  "allowReadWrite": true,
  "overrideNonMainReadOnly": true,
  "description": "Obsidian second brain vault"
}
```

**Important:** The `overrideNonMainReadOnly` flag ensures non-main groups can write to the vault despite the global `nonMainReadOnly: true` setting.

If the allowlist file doesn't exist, create it with:
```json
{
  "allowedRoots": [<vault entry>],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

If it exists, add the vault entry to the existing `allowedRoots` array (don't overwrite other entries).

## Phase 4: Register Mount for All Groups

Add the second-brain mount to every registered group's `containerConfig.additionalMounts` in the SQLite database.

**Important:** This project uses ESM (`"type": "module"`). Use `node --input-type=module -e` for inline scripts.

```bash
node --input-type=module -e "
import Database from 'better-sqlite3';

const db = new Database('store/messages.db');
const vaultPath = '$(grep "^SECOND_BRAIN_PATH=" .env | cut -d= -f2 | sed "s|~|$HOME|")';
const mountEntry = { hostPath: vaultPath, containerPath: 'second-brain', readonly: false };

const rows = db.prepare('SELECT jid, container_config FROM registered_groups').all();
for (const row of rows) {
  const config = row.container_config ? JSON.parse(row.container_config) : {};
  config.additionalMounts = config.additionalMounts || [];
  if (!config.additionalMounts.some(m => m.containerPath === 'second-brain')) {
    config.additionalMounts.push(mountEntry);
    db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?')
      .run(JSON.stringify(config), row.jid);
    console.log('Updated:', row.jid);
  } else {
    console.log('Already has mount:', row.jid);
  }
}
db.close();
"
```

## Phase 5: Update Group Instructions

### Global CLAUDE.md

Append the second brain section to `groups/global/CLAUDE.md` (shared by all non-main groups):

```markdown

## Second Brain

You have read-write access to an Obsidian vault at `/workspace/extra/second-brain/`.
See its CLAUDE.md for capture rules, frontmatter schema, and filing conventions.
Use it to capture noteworthy ideas, decisions, tasks, and knowledge from conversations.
Check it for relevant context before responding to topics that might have prior history.
```

### Main group CLAUDE.md

Append the same section to `groups/main/CLAUDE.md` (main doesn't inherit from global).

### Group-specific nuance

For any group chat groups (groups with multiple participants), also append:

```markdown

## Second Brain (Group Chat Nuance)

In this group chat, focus on capturing ideas, decisions, and tasks with attribution (who said what).
Don't log general conversation — capture the substance.
```

## Phase 6: Build & Verify

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or: systemctl --user restart nanoclaw            # Linux
```

Tell the user:

> "Second brain is set up! Try sending Andy a message like 'I had an idea for [project] — [idea]' and check if a file appears in your vault's Ideas/ directory."

## Troubleshooting

- **Mount not appearing in container:** Check that the vault directory exists and the path in the allowlist matches the path in the DB. Run `cat ~/.config/nanoclaw/mount-allowlist.json` and verify.
- **Read-only errors:** Ensure the allowlist entry has both `allowReadWrite: true` and `overrideNonMainReadOnly: true`.
- **Andy not capturing:** Check that the vault's CLAUDE.md exists and contains the capture instructions. The SDK loads it automatically from `/workspace/extra/second-brain/CLAUDE.md`.

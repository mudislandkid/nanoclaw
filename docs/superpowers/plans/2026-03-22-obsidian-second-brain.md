# Obsidian Second Brain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Andy read-write access to an Obsidian vault mounted into all group containers, with CLAUDE.md instructions that drive autonomous capture and recall behaviour.

**Architecture:** A local Obsidian vault (`~/SecondBrain` by default, configurable via `SECOND_BRAIN_PATH` in `.env`) mounted into containers as an additional directory at `/workspace/extra/second-brain/`. No MCP server, no new channel — just filesystem + instructions. One small code change to mount-security.ts to allow per-root read-write exemption from `nonMainReadOnly`.

**Tech Stack:** Markdown/YAML frontmatter, Obsidian Dataview-compatible, existing NanoClaw mount system, SQLite DB updates.

**Spec:** `docs/superpowers/specs/2026-03-22-obsidian-second-brain-design.md`

---

### Task 1: Add per-root nonMainReadOnly bypass in mount-security.ts

Currently, `nonMainReadOnly: true` forces ALL non-main group mounts to read-only, even if the root has `allowReadWrite: true`. We need non-main groups to write to the vault. Fix: if the matched root has `allowReadWrite: true`, honour it regardless of `nonMainReadOnly`.

**Files:**
- Modify: `src/mount-security.ts:296-306`
- Modify: `src/types.ts:21-28` (add `overrideNonMainReadOnly` field)

- [ ] **Step 1: Write the failing test**

Create `src/mount-security.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// We need to test validateMount which is not directly exported,
// but validateAdditionalMounts is. We'll test through that.
import { validateAdditionalMounts, loadMountAllowlist } from './mount-security.js';

describe('mount-security', () => {
  describe('nonMainReadOnly with overrideNonMainReadOnly', () => {
    const testDir = path.join(os.tmpdir(), 'nanoclaw-mount-test');

    beforeEach(() => {
      fs.mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should allow read-write for non-main group when root has overrideNonMainReadOnly', () => {
      // This test will verify the new behaviour once implemented
      // For now it should fail because the override field doesn't exist yet
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails or is empty**

Run: `npx vitest run src/mount-security.test.ts`

- [ ] **Step 3: Add `overrideNonMainReadOnly` to AllowedRoot interface**

In `src/types.ts`, add the optional field to `AllowedRoot`:

```typescript
export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
  // When true, this root allows read-write even for non-main groups
  // (bypasses the global nonMainReadOnly setting)
  overrideNonMainReadOnly?: boolean;
}
```

- [ ] **Step 4: Update validateMount logic**

In `src/mount-security.ts` lines 296-306, change the `nonMainReadOnly` check to respect the per-root override:

```typescript
    if (!isMain && allowlist.nonMainReadOnly && !allowedRoot.overrideNonMainReadOnly) {
```

This is a one-line change — add `&& !allowedRoot.overrideNonMainReadOnly` to the existing condition on line 297.

- [ ] **Step 5: Update the test with a real assertion**

Update `src/mount-security.test.ts` to properly test the override. `MOUNT_ALLOWLIST_PATH` is a compile-time constant imported from `config.ts`, so we mock the config module. Use `vi.resetModules()` in each test to clear the cached allowlist.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const testDir = path.join(os.tmpdir(), 'nanoclaw-mount-test-vault');
const configDir = path.join(os.tmpdir(), 'nanoclaw-mount-test-config');
const allowlistPath = path.join(configDir, 'mount-allowlist.json');

// Mock config.ts to point MOUNT_ALLOWLIST_PATH at our test file
vi.mock('./config.js', () => ({
  MOUNT_ALLOWLIST_PATH: allowlistPath,
}));

// Dynamic import so mock is applied before module loads
let validateAdditionalMounts: typeof import('./mount-security.js').validateAdditionalMounts;

describe('mount-security: overrideNonMainReadOnly', () => {
  beforeEach(async () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });

    // Reset module cache so allowlist cache is cleared
    vi.resetModules();

    // Re-mock after resetModules
    vi.doMock('./config.js', () => ({
      MOUNT_ALLOWLIST_PATH: allowlistPath,
    }));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('allows read-write for non-main group when overrideNonMainReadOnly is true', async () => {
    const allowlist = {
      allowedRoots: [
        {
          path: testDir,
          allowReadWrite: true,
          overrideNonMainReadOnly: true,
          description: 'Test vault with override',
        },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const mounts = mod.validateAdditionalMounts(
      [{ hostPath: testDir, containerPath: 'second-brain', readonly: false }],
      'test-group',
      false, // isMain = false
    );

    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(false);
  });

  it('forces read-only for non-main group when overrideNonMainReadOnly is not set', async () => {
    const allowlist = {
      allowedRoots: [
        { path: testDir, allowReadWrite: true, description: 'No override' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
    fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));

    const mod = await import('./mount-security.js');
    const mounts = mod.validateAdditionalMounts(
      [{ hostPath: testDir, containerPath: 'second-brain', readonly: false }],
      'test-group',
      false,
    );

    expect(mounts).toHaveLength(1);
    expect(mounts[0].readonly).toBe(true);
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/mount-security.test.ts`
Expected: Both tests pass.

- [ ] **Step 7: Update generateAllowlistTemplate with a comment about the override**

In `src/mount-security.ts` `generateAllowlistTemplate()`, no change needed to the template itself (the override is opt-in). But update the template comment block at the top of the file if one exists.

- [ ] **Step 8: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/mount-security.ts src/mount-security.test.ts
git commit -m "feat: add overrideNonMainReadOnly to mount allowlist roots

Allows specific mount roots to bypass the global nonMainReadOnly
setting, enabling non-main groups to write to shared directories
like the Obsidian second brain vault."
```

---

### Task 2: Create the Obsidian vault directory structure and templates

**Files:**
- Create: `~/SecondBrain/` directory structure
- Create: `~/SecondBrain/CLAUDE.md`
- Create: `~/SecondBrain/templates/*.md` (6 template files)

- [ ] **Step 1: Add SECOND_BRAIN_PATH to .env**

Append to `/Volumes/1tbSSD/nanoclaw/.env`:

```
# Obsidian Second Brain vault location
SECOND_BRAIN_PATH=~/SecondBrain
```

- [ ] **Step 2: Create vault directory structure**

```bash
mkdir -p ~/SecondBrain/{Ideas,Decisions,Tasks,People,Projects,Knowledge,templates}
```

- [ ] **Step 3: Create template files**

Create `~/SecondBrain/templates/idea.md`:
```markdown
---
type: idea
project:
source:
channel:
status: new
created: YYYY-MM-DD
tags: []
---

# Idea Title

Description of the idea.
```

Create `~/SecondBrain/templates/decision.md`:
```markdown
---
type: decision
project:
decided_by:
channel:
created: YYYY-MM-DD
tags: []
---

# Decision Title

## Decision
What was decided.

## Rationale
Why this was chosen over alternatives.
```

Create `~/SecondBrain/templates/task.md`:
```markdown
---
type: task
project:
assigned_to:
priority: medium
status: open
due:
created: YYYY-MM-DD
tags: []
---

# Task Title

What needs to be done and any relevant context.
```

Create `~/SecondBrain/templates/person.md`:
```markdown
---
type: person
role:
created: YYYY-MM-DD
tags: []
---

# Person Name

## Context
How we know them, what they do.

## Notes
Ongoing notes about interactions and relevant details.
```

Create `~/SecondBrain/templates/project.md`:
```markdown
---
type: project
status: active
created: YYYY-MM-DD
tags: []
---

# Project Name

## Description
What the project is and its goals.

## Links
Related [[ideas]], [[decisions]], [[tasks]] via wiki links.
```

Create `~/SecondBrain/templates/knowledge.md`:
```markdown
---
type: knowledge
category:
source_url:
project:
created: YYYY-MM-DD
tags: []
---

# Title

Content, reference material, how-tos, or snippets.
```

- [ ] **Step 4: Create the vault CLAUDE.md**

Create `~/SecondBrain/CLAUDE.md` — this is the core instruction file that Andy loads automatically:

```markdown
# Second Brain — Obsidian Vault

You have read-write access to this Obsidian vault. Use it as a persistent knowledge base — capture noteworthy information from conversations and recall relevant context when it helps.

## Directory Structure

| Directory | Contains |
|-----------|----------|
| Ideas/ | Brainstorms, feature concepts, random thoughts |
| Decisions/ | Choices made and their rationale |
| Tasks/ | Follow-ups, things to do, reminders |
| People/ | Contacts, who does what, relationship context |
| Projects/ | Active projects as a hub linking to everything else |
| Knowledge/ | Reference material, links, how-tos, code snippets |
| templates/ | Frontmatter templates — reference these for the correct schema |

## When to Capture

**Do capture:**
- Ideas or brainstorms worth revisiting
- Decisions and their rationale
- Tasks or follow-ups someone commits to
- New information about a person or project
- Useful reference material (links, how-tos, snippets)

**Do not capture:**
- Routine conversation, greetings, small talk
- Debugging back-and-forth or troubleshooting steps
- Things already in the vault (update the existing entry instead)
- Ephemeral context that won't matter tomorrow

**Capture silently.** Do not announce that you've saved something unless the user explicitly asks you to remember something — in that case, confirm briefly.

## When to Recall

Check the vault when a conversation topic likely has prior history — projects, people, past decisions, recurring ideas. Don't scan on every message. Routine requests, debugging, and simple tasks don't need a vault check.

When you do recall something relevant:
- Weave it naturally into your response
- Only explicitly call out the connection when it's genuinely useful
- Never prefix with "according to your second brain" or similar

## File Naming

- Most entries: `YYYY-MM-DD-slug.md` (e.g. `2026-03-22-battery-weather-scheduling.md`)
- People: `Name.md` (e.g. `Greg.md`)
- Projects: `ProjectName.md` (e.g. `VoltWise.md`)
- Slugs are lowercase, hyphenated, concise

## Frontmatter

Every file uses YAML frontmatter. See `templates/` for the schema for each type. Always include `type`, `created`, and `tags` at minimum.

## Wiki Links

Use `[[wiki links]]` to connect entries:
- Link ideas, decisions, and tasks to their parent `[[ProjectName]]`
- Link people to projects they're involved in
- Obsidian renders these as navigable backlinks

## Attribution

Always record who said, decided, or suggested something:
- Use `source` or `decided_by` in frontmatter
- In the body, use natural attribution: "Greg suggested...", "Alice decided..."
- Capture the substance, not the conversation flow

## Deduplication

Before creating a new entry, search for existing entries on the same topic:
- People and Project files are long-lived — append dated sections rather than rewriting
- Update existing entries rather than creating duplicates
- Ideas/Decisions/Tasks are typically one-per-file

## Concurrent Safety

Other group containers may also have this vault mounted. To avoid conflicts:
- Prefer creating new files over updating existing ones when possible
- When updating long-lived files (People, Projects), append a new dated section at the end
- Use unique date-slug filenames to avoid naming collisions
```

- [ ] **Step 5: Verify vault structure**

```bash
ls -R ~/SecondBrain/
```

Expected: all directories, templates, and CLAUDE.md present.

- [ ] **Step 6: Note on commits**

`.env` is gitignored — no commit needed for this task. The vault itself (`~/SecondBrain/`) is outside the repo. Both the `.env` entry and vault structure will be recreated by the `/add-second-brain` skill for new installs (Task 5).

---

### Task 3: Update mount allowlist and register vault mount for all groups

**Files:**
- Modify: `~/.config/nanoclaw/mount-allowlist.json`
- Modify: SQLite DB `store/messages.db` (registered_groups.container_config)

- [ ] **Step 1: Update the mount allowlist**

Edit `~/.config/nanoclaw/mount-allowlist.json` to:

```json
{
  "allowedRoots": [
    {
      "path": "~/SecondBrain",
      "allowReadWrite": true,
      "overrideNonMainReadOnly": true,
      "description": "Obsidian second brain vault"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

- [ ] **Step 2: Add the second-brain mount to all groups in the DB**

Run a Node script to update every registered group's `containerConfig.additionalMounts`:

```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';

const db = new Database('store/messages.db');
const vaultPath = path.join(os.homedir(), 'SecondBrain');
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
    console.log('Already has second-brain mount:', row.jid);
  }
}
db.close();
"
```

- [ ] **Step 3: Verify the DB updates**

```bash
node --input-type=module -e "
import Database from 'better-sqlite3';
const db = new Database('store/messages.db');
const rows = db.prepare('SELECT jid, container_config FROM registered_groups').all();
for (const row of rows) {
  console.log(row.jid, row.container_config);
}
db.close();
"
```

Expected: every group has `second-brain` in its `additionalMounts`.

- [ ] **Step 4: Commit (nothing to commit — allowlist and DB are outside the repo)**

No git commit needed. The allowlist lives at `~/.config/nanoclaw/` and the DB at `store/` (gitignored).

---

### Task 4: Update group CLAUDE.md files with second brain instructions

**Files:**
- Modify: `groups/main/CLAUDE.md`
- Modify: `groups/global/CLAUDE.md` (shared context appended to all non-main groups)
- Create: `groups/signal_main/CLAUDE.md`
- Modify: `groups/bot_chat/CLAUDE.md`
- Modify: `groups/outlook_inbox/CLAUDE.md` (if it exists)

- [ ] **Step 0: Add second brain section to global CLAUDE.md**

`groups/global/CLAUDE.md` is automatically appended to the system prompt for all non-main groups. Add the second brain section here so every non-main group gets it without needing individual updates. Append to `groups/global/CLAUDE.md`:

```markdown

## Second Brain

You have read-write access to an Obsidian vault at `/workspace/extra/second-brain/`.
See its CLAUDE.md for capture rules, frontmatter schema, and filing conventions.
Use it to capture noteworthy ideas, decisions, tasks, and knowledge from conversations.
Check it for relevant context before responding to topics that might have prior history.
```

- [ ] **Step 1: Add second brain section to main group**

Append to `groups/main/CLAUDE.md`:

```markdown

## Second Brain

You have read-write access to an Obsidian vault at `/workspace/extra/second-brain/`.
See its CLAUDE.md for capture rules, frontmatter schema, and filing conventions.
Use it to capture noteworthy ideas, decisions, tasks, and knowledge from conversations.
Check it for relevant context before responding to topics that might have prior history.
```

- [ ] **Step 2: Create signal_main CLAUDE.md**

The `groups/signal_main/` directory exists but has no CLAUDE.md. Create `groups/signal_main/CLAUDE.md`:

```markdown
# Signal Main — 1:1 Chat

You are Andy, Greg's personal assistant on Signal.
```

Note: the second brain instructions are already inherited via `groups/global/CLAUDE.md` which is appended to all non-main group prompts.

- [ ] **Step 3: Add group-chat-specific nuance to bot_chat**

The base second brain instructions come from global/CLAUDE.md. Add group-specific nuance to `groups/bot_chat/CLAUDE.md`:

```markdown

## Second Brain (Group Chat Nuance)

In this group chat, focus on capturing ideas, decisions, and tasks with attribution (who said what).
Don't log general conversation — capture the substance.
```

- [ ] **Step 4: Check if outlook_inbox has a CLAUDE.md and update if so**

```bash
ls groups/outlook_inbox/CLAUDE.md
```

If it exists, append the second brain section. If not, the Outlook group is disabled anyway (per earlier conversation) — skip.

- [ ] **Step 5: Commit**

```bash
git add groups/global/CLAUDE.md groups/main/CLAUDE.md groups/signal_main/CLAUDE.md groups/bot_chat/CLAUDE.md
git commit -m "feat: add second brain instructions to all group CLAUDE.md files"
```

---

### Task 5: Create the /add-second-brain skill

This skill automates the setup for new NanoClaw installs.

**Files:**
- Create: `.claude/skills/add-second-brain/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p .claude/skills/add-second-brain
```

- [ ] **Step 2: Write the skill file**

Create `.claude/skills/add-second-brain/SKILL.md` that walks through the full setup:

1. Read `SECOND_BRAIN_PATH` from `.env` (default `~/SecondBrain`)
2. Create the vault directory structure and templates
3. Write the vault's CLAUDE.md
4. Add the vault path to the mount allowlist with `overrideNonMainReadOnly: true`
5. Register the mount for all groups in the DB
6. Add second brain sections to group CLAUDE.md files
7. Restart NanoClaw

The skill should be interactive — confirm the vault path with the user before proceeding, and show progress as each step completes.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/add-second-brain/SKILL.md
git commit -m "feat: add /add-second-brain skill for Obsidian vault setup"
```

---

### Task 6: Build, restart, and verify

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 2: Restart NanoClaw**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 3: Verify mount is working**

Send a test message to Andy on Signal. Ask him to check if he can see the second brain vault:

> "Can you see your second brain vault? Try listing the directories in it."

Andy should be able to `ls /workspace/extra/second-brain/` and see the vault structure.

- [ ] **Step 4: Test capture**

Tell Andy something worth capturing:

> "I had an idea for VoltWise — we could use weather forecasts to pre-charge the battery before cloudy days."

Verify Andy creates a file in `~/SecondBrain/Ideas/` with correct frontmatter.

- [ ] **Step 5: Test recall**

In a later message, reference the topic:

> "What was that battery idea I mentioned?"

Verify Andy finds and references the captured idea.

- [ ] **Step 6: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "chore: final adjustments from second brain integration testing"
```

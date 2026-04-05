# Shared Skills Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a shared GitHub repo that serves as a community skills library for NanoClaw, plus a Claude Code slash command to install skills from it.

**Architecture:** A standalone GitHub repo (`nanoclaw-skills-library`) with a `registry.json` index and `skills/` directories. NanoClaw gets a `.library.json` tracker in `container/skills/` and a `/add-skill` slash command that fetches skills from the library, handles container deps, env vars, and restarts.

**Tech Stack:** GitHub API (via `gh` CLI or `WebFetch`), JSON, Markdown, Bash, Docker

---

## File Structure

### Library Repo (new: `/Volumes/1tbSSD/nanoclaw-skills-library`)

| File | Responsibility |
|------|---------------|
| `README.md` | Library overview, available skills, quick start guide |
| `CONTRIBUTING.md` | SKILL.md schema, submission template, contribution checklist |
| `registry.json` | Machine-readable index of all skills (name, description, author, version, path, container-deps) |
| `skills/example-greeting/SKILL.md` | Example skill to demonstrate the format |

### NanoClaw Changes (existing: `/Volumes/1tbSSD/nanoclaw`)

| File | Responsibility |
|------|---------------|
| `container/skills/.library.json` | Tracks configured repo, branch, installed skills and versions |

No source code changes to NanoClaw itself — the skill sync in `container-runner.ts:152-162` already handles copying any directory in `container/skills/` to groups. The Dockerfile marker section and env var passthrough will be handled per-skill at install time by the Claude Code operator, not by code.

---

### Task 1: Initialize Library Repo

**Files:**
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/.gitignore`
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/registry.json`
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/skills/.gitkeep`

- [ ] **Step 1: Create the repo directory and initialize git**

```bash
mkdir -p /Volumes/1tbSSD/nanoclaw-skills-library
cd /Volumes/1tbSSD/nanoclaw-skills-library
git init
```

- [ ] **Step 2: Create .gitignore**

Create `/Volumes/1tbSSD/nanoclaw-skills-library/.gitignore`:

```
.DS_Store
node_modules/
```

- [ ] **Step 3: Create the empty registry**

Create `/Volumes/1tbSSD/nanoclaw-skills-library/registry.json`:

```json
{
  "version": 1,
  "skills": []
}
```

- [ ] **Step 4: Create the skills directory**

```bash
mkdir -p /Volumes/1tbSSD/nanoclaw-skills-library/skills
touch /Volumes/1tbSSD/nanoclaw-skills-library/skills/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
git add .gitignore registry.json skills/.gitkeep
git commit -m "chore: initialize skills library repo"
```

---

### Task 2: Write CONTRIBUTING.md

**Files:**
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/CONTRIBUTING.md`

- [ ] **Step 1: Create CONTRIBUTING.md with schema and template**

Create `/Volumes/1tbSSD/nanoclaw-skills-library/CONTRIBUTING.md`:

````markdown
# Contributing Skills

## Quick Start

1. Create a directory under `skills/` with your skill name (lowercase, hyphens)
2. Add a `SKILL.md` file with the required frontmatter
3. Add any scripts or templates your skill needs
4. Add an entry to `registry.json`
5. Submit a PR

## SKILL.md Schema

Every skill MUST have a `SKILL.md` file with this frontmatter:

```yaml
---
name: your-skill-name          # Required. Lowercase, hyphens. Must match directory name.
description: One-line summary   # Required. What the agent can do with this skill.
author: your-name               # Required. Your name or handle.
version: 1.0.0                  # Required. Semver.
allowed-tools: Bash(*)          # Required. Tool permissions for the agent.
container-deps:                 # Optional. Only if your skill needs packages in the container.
  apt: [package1, package2]
  pip: [package1]
  npm: [package1]
env-vars:                       # Optional. Only if your skill needs environment variables.
  - VAR_NAME: "Description of what this variable is for"
---
```

## Body Content

After the frontmatter, write documentation that the agent will read at runtime:

- Explain what the skill does
- Show usage examples with code blocks
- Document any commands, APIs, or workflows
- Include setup instructions if env vars are needed

The agent reads this documentation to understand how to use the skill. Write it as if you're explaining to a capable developer who has never seen your tool before.

## Scripts and Files

If your skill needs executable scripts:

- Keep them in the skill directory (e.g., `skills/your-skill/run.sh`)
- Make sure scripts are executable (`chmod +x`)
- Document how to invoke them in SKILL.md
- Scripts run inside the NanoClaw container (Debian-based, Node 22)

## Container Dependencies

If your skill needs packages installed in the container image:

- Declare them in the `container-deps` frontmatter
- Supported package managers: `apt`, `pip`, `npm`
- Installing a skill with container deps triggers a container image rebuild
- Keep dependencies minimal — every dep increases image size for all users

## Environment Variables

If your skill needs API keys or configuration:

- Declare them in the `env-vars` frontmatter with descriptions
- The installer will prompt the user for values and add them to `.env`
- Never hardcode credentials in skill files

## Registry Entry

Add your skill to `registry.json`:

```json
{
  "name": "your-skill-name",
  "description": "One-line description",
  "author": "your-name",
  "version": "1.0.0",
  "path": "skills/your-skill-name",
  "container-deps": null
}
```

Set `container-deps` to `null` if no container packages are needed, or mirror the SKILL.md frontmatter structure if they are.

## Checklist

Before submitting:

- [ ] Skill directory name matches `name` in SKILL.md frontmatter
- [ ] SKILL.md has all required frontmatter fields
- [ ] Version follows semver (e.g., `1.0.0`)
- [ ] Registry entry added to `registry.json`
- [ ] Registry entry `path` points to correct directory
- [ ] Scripts are executable (if any)
- [ ] No hardcoded credentials or secrets
- [ ] Documentation includes usage examples
````

- [ ] **Step 2: Commit**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
git add CONTRIBUTING.md
git commit -m "docs: add contribution guide with SKILL.md schema"
```

---

### Task 3: Write README.md

**Files:**
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/README.md`

- [ ] **Step 1: Create README.md**

Create `/Volumes/1tbSSD/nanoclaw-skills-library/README.md`:

````markdown
# NanoClaw Skills Library

A shared collection of container-agent skills for [NanoClaw](https://github.com/qwibitai/nanoclaw). Skills give your NanoClaw agent new capabilities — tools, integrations, and knowledge it can use at runtime.

## Available Skills

<!-- This section is updated as skills are added -->

| Skill | Description | Author | Deps? |
|-------|-------------|--------|-------|
| `example-greeting` | Example skill showing the standard format | greg | No |

## Installing a Skill

In Claude Code, from your NanoClaw project directory:

> "Install the `example-greeting` skill from our skills library"

Claude will fetch the skill from this repo and install it into your NanoClaw's `container/skills/` directory. If the skill needs container dependencies, Claude will update your Dockerfile and rebuild.

### First Time Setup

The first time you install a skill, Claude will ask for the library repo location. This is saved to `container/skills/.library.json` so you don't need to specify it again.

### Listing Skills

> "What skills are available in our library?"

### Updating a Skill

> "Update the `example-greeting` skill from our library"

### Removing a Skill

> "Remove the `example-greeting` skill"

## Creating a Skill

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide. The short version:

1. Create `skills/your-skill-name/SKILL.md` with the required frontmatter
2. Add an entry to `registry.json`
3. Submit a PR

## How It Works

Skills are directories containing a `SKILL.md` metadata file and optional scripts. NanoClaw's container runner copies everything in `container/skills/` into each group's `.claude/skills/` directory when a container spawns. The Claude Agent SDK automatically discovers and loads skills from there, making the documentation and tools available to the agent.

No NanoClaw code changes are needed to install or use library skills.
````

- [ ] **Step 2: Commit**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
git add README.md
git commit -m "docs: add README with available skills and installation guide"
```

---

### Task 4: Create Example Skill

**Files:**
- Create: `/Volumes/1tbSSD/nanoclaw-skills-library/skills/example-greeting/SKILL.md`
- Modify: `/Volumes/1tbSSD/nanoclaw-skills-library/registry.json`

- [ ] **Step 1: Create the example skill**

Create `/Volumes/1tbSSD/nanoclaw-skills-library/skills/example-greeting/SKILL.md`:

```markdown
---
name: example-greeting
description: Example skill showing the standard format — greets users in different languages
author: greg
version: 1.0.0
allowed-tools: Bash(*)
---

# Greeting Skill

A simple example skill that demonstrates the standard format for the NanoClaw skills library.

## Usage

When a user asks to be greeted in a specific language, use this skill to respond appropriately.

### Supported Languages

| Language | Greeting |
|----------|----------|
| English | Hello! |
| Spanish | Hola! |
| French | Bonjour! |
| German | Hallo! |
| Japanese | Konnichiwa! |
| Arabic | Marhaba! |
| Welsh | Shwmae! |

## Example

User: "Greet me in Welsh"
Agent: "Shwmae! How are you today?"
```

- [ ] **Step 2: Update registry.json**

Replace `/Volumes/1tbSSD/nanoclaw-skills-library/registry.json` with:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "example-greeting",
      "description": "Example skill showing the standard format — greets users in different languages",
      "author": "greg",
      "version": "1.0.0",
      "path": "skills/example-greeting",
      "container-deps": null
    }
  ]
}
```

- [ ] **Step 3: Remove .gitkeep (no longer needed)**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
rm skills/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
git add skills/example-greeting/SKILL.md registry.json
git rm skills/.gitkeep
git commit -m "feat: add example-greeting skill to demonstrate format"
```

---

### Task 5: Create .library.json in NanoClaw

**Files:**
- Create: `/Volumes/1tbSSD/nanoclaw/container/skills/.library.json`

- [ ] **Step 1: Verify the skill sync ignores non-directories**

Check `container-runner.ts:152-162` — the sync loop already does `if (!fs.statSync(srcDir).isDirectory()) continue;` so `.library.json` (a file, not a directory) will be skipped automatically. No code changes needed.

- [ ] **Step 2: Create .library.json**

Create `/Volumes/1tbSSD/nanoclaw/container/skills/.library.json`:

```json
{
  "repo": "",
  "branch": "main",
  "installed": {}
}
```

The `repo` field is empty — it will be populated the first time a user installs a skill from the library. This avoids hardcoding a specific GitHub org/repo.

- [ ] **Step 3: Commit in NanoClaw repo**

```bash
cd /Volumes/1tbSSD/nanoclaw
git add container/skills/.library.json
git commit -m "feat: add skills library tracker for shared skills"
```

---

### Task 6: Create Initial Git Remote for Library Repo

**Files:** None (git operations only)

- [ ] **Step 1: Verify the library repo is ready**

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
git log --oneline
```

Expected: 4 commits (init, contributing, readme, example skill)

- [ ] **Step 2: Inform user to create GitHub repo and push**

The user needs to create a GitHub repo (e.g., `mudislandkid/nanoclaw-skills` or an org repo) and push:

```bash
cd /Volumes/1tbSSD/nanoclaw-skills-library
gh repo create <org>/nanoclaw-skills --public --source=. --push
```

Or if the repo already exists:

```bash
git remote add origin git@github.com:<org>/nanoclaw-skills.git
git push -u origin main
```

Once pushed, update `.library.json` in NanoClaw with the repo identifier.

---

### Task 7: Test End-to-End Installation

**Files:** None (verification only)

- [ ] **Step 1: Simulate skill installation**

From the NanoClaw directory, verify the example skill can be "installed" by copying it manually:

```bash
# Verify the skill directory exists in the library
ls /Volumes/1tbSSD/nanoclaw-skills-library/skills/example-greeting/

# Copy it as if Claude had fetched it
cp -r /Volumes/1tbSSD/nanoclaw-skills-library/skills/example-greeting /Volumes/1tbSSD/nanoclaw/container/skills/

# Verify it's alongside existing skills
ls /Volumes/1tbSSD/nanoclaw/container/skills/
```

Expected output: `agent-browser  example-greeting  github`

- [ ] **Step 2: Verify the skill sync picks it up**

The existing `container-runner.ts` sync will copy `example-greeting` to group sessions on next container spawn. No code changes needed — this just works.

- [ ] **Step 3: Clean up test skill**

```bash
rm -rf /Volumes/1tbSSD/nanoclaw/container/skills/example-greeting
```

- [ ] **Step 4: Verify .library.json is ignored by skill sync**

The sync loop in `container-runner.ts:155-161` checks `isDirectory()` — `.library.json` is a file, so it's skipped. Verified by reading the code.

---
name: dev-access
description: View and edit projects on Greg's developer drive at /workspace/dev. Handles read-only-by-default access, runtime write-grant elevation via Signal, and conversational request/revoke/list/clone operations.
---

# Developer Access

Greg's projects live at `/workspace/dev/` (read-only at the root). You can
read, browse, and grep anything in there freely. To edit, you need a
per-project grant from Greg, which you can request from inside the chat.

## How to use

```bash
dev-access list                                 # what can I write to right now?
dev-access request VoltWise "fix forecaster"    # ask for write on VoltWise
dev-access revoke VoltWise                      # drop write on VoltWise
dev-access clone mudislandkid/some-old-repo     # clone a repo into /workspace/dev
```

## Workflow

1. Read the project at `/workspace/dev/<project>/` to understand what's needed.
2. Try the edit. If the filesystem returns "Read-only file system", that's
   expected — run `dev-access request <project> "<short reason>"`.
3. The script blocks until Greg replies on his channel. On approval you'll
   see `status:granted`. **The new mount only takes effect on your next
   container spawn**, so reply to Greg with: "Got write access to <project>.
   Ping me to retry."
4. Greg pings ("ok go ahead"); you re-enter, the mount is now RW; complete
   the edit; commit and push via `git`/`gh`; open the PR.

## When to ask for things

- **Write access** — only when you actually need to write. Browsing/reading
  is always free.
- **Cloning** — only when the project isn't already at `/workspace/dev/`.
  Don't preemptively clone things "just in case".
- **Revoking** — when Greg asks ("drop write on X") OR proactively after
  long inactivity on a project (optional but neat).

## Hard rails (auto-denied without prompting Greg)

- NanoClaw's own source directory — modifying it would break the sandbox.
  Greg edits NanoClaw on his laptop directly.
- Anything matching default secret patterns (.ssh, .env, .aws, etc.).
- Paths outside any allowed root.

If you get `status:blocked`, do **not** retry — the answer is final.

## Destructive commands

Some Bash commands (`rm -rf`, `git push --force`, `git reset --hard`,
package removals, DB drops, clobber-redirects to .env/lockfiles) require
a per-command nod from Greg. The hook runs automatically — when you
issue one, expect a 5–60s pause while Greg confirms. If denied, abort
gracefully and tell Greg what you were trying to do.

## GitHub coexistence

You also have the `github` skill — `gh` CLI for repos, PRs, issues,
Dependabot. Combine: read locally → edit locally (with grant) →
`git checkout -b fix/...` → commit → `git push` → `gh pr create`.

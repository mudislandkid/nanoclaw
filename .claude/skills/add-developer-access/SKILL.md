---
name: add-developer-access
description: Give Andy view/edit access to projects on /Volumes/1tbSSD/, with conversational runtime control over write permissions and per-command approval for destructive Bash commands. Designed for the main group only.
---

# Add Developer Access

Wire the developer-access feature into NanoClaw. After this:

- Andy can read every project at `/workspace/dev/` (RO)
- Andy can request write access to specific projects via `dev-access request <project> "<reason>"` — Greg confirms in chat
- Destructive Bash commands (`rm -rf`, `git push --force`, etc.) prompt Greg per-command before running
- Hard rails block NanoClaw self-dir, default secret patterns, traversal, and `rm -rf /` literals

## Phase 1: Pre-flight

```bash
test -d /Volumes/1tbSSD || { echo "MISSING_SSD"; exit 1; }
test -f .env && grep -q '^ASSISTANT_NAME=' .env || echo "WARN: assistant name not set"
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const main = db.prepare(\"SELECT jid, name FROM registered_groups WHERE jid IN (SELECT jid FROM registered_groups LIMIT 1)\").get();
  console.log(main ? 'MAIN_OK' : 'NO_MAIN');
"
```

If any check fails, tell the user what to fix and stop.

## Phase 2: Write `dangerous-commands.json`

```bash
mkdir -p ~/.config/nanoclaw
test -f ~/.config/nanoclaw/dangerous-commands.json && echo "EXISTS" || cat > ~/.config/nanoclaw/dangerous-commands.json <<'EOF'
{
  "patterns": [
    "rm\\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\\s+|--force\\s+|--recursive\\s+)",
    "git\\s+push\\s+.*(--force(-with-lease)?|-f\\b)",
    "git\\s+reset\\s+--hard",
    "git\\s+clean\\s+-[a-zA-Z]*[fd]",
    "git\\s+branch\\s+-D",
    "\\bdropdb\\b",
    "DROP\\s+(TABLE|DATABASE|SCHEMA)",
    ">\\s*(\\.env|package\\.json|.*\\.lock)\\b",
    "find\\s+.*-delete",
    "find\\s+.*-exec\\s+rm",
    "(npm|yarn|pnpm)\\s+(uninstall|remove)\\b"
  ],
  "hardDenyPatterns": [
    "rm\\s+(-[rRf]+\\s+)?/\\s*$",
    "rm\\s+(-[rRf]+\\s+)?/\\*"
  ]
}
EOF
```

If EXISTS, ask the user whether to overwrite or skip.

## Phase 3: Update mount allowlist

Add the SSD root entry to `~/.config/nanoclaw/mount-allowlist.json` with `requireApproval: true`. Preserve other entries:

```bash
node --input-type=module -e "
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const p = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); }
  catch { cfg = { allowedRoots: [], blockedPatterns: [], nonMainReadOnly: true }; }
  if (!cfg.allowedRoots.some(r => r.path === '/Volumes/1tbSSD')) {
    cfg.allowedRoots.push({
      path: '/Volumes/1tbSSD',
      allowReadWrite: false,
      requireApproval: true,
      description: 'Developer projects drive — RO root, RW per-subdir on grant'
    });
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    console.log('Added SSD root to allowlist');
  } else {
    console.log('SSD root already in allowlist');
  }
"
```

## Phase 4: Set `devAccessEnabled` on the main group

```bash
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const main = db.prepare(\"SELECT jid, container_config FROM registered_groups\").all().find(r => {
    try { return JSON.parse(r.container_config || '{}').isMain ?? false; } catch { return false; }
  }) || db.prepare(\"SELECT jid, container_config FROM registered_groups LIMIT 1\").get();
  // Heuristic: assume the only registered group is main, or the user names it
  // (You may need to ask Greg which JID corresponds to main.)
  const cfg = main.container_config ? JSON.parse(main.container_config) : {};
  cfg.devAccessEnabled = true;
  db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(JSON.stringify(cfg), main.jid);
  console.log('devAccessEnabled set on', main.jid);
"
```

If the heuristic isn't reliable, ask the user which group is main and update that JID directly.

## Phase 5: Add CLAUDE.md section to main group

Append to `groups/main/CLAUDE.md` (create if missing):

```markdown
## Developer Access

You have access to Greg's project directory at `/workspace/dev/`. The
root is read-only; you can browse and read everything freely. To edit,
run `dev-access request <project> "<reason>"` and wait for Greg's reply.
Once granted, the new mount applies on your next container spawn — tell
Greg "got write access, ping me to retry" and continue on the next turn.

Use `dev-access list` to see what is currently writable. Use
`dev-access clone <owner/repo>` to bring in repos that aren't already
local. Hard rails (NanoClaw self-dir, secret patterns) auto-block.

Some Bash commands (`rm -rf`, `git push --force`, hard reset, etc.)
require Greg's per-command approval. The hook is automatic — you'll
just see a 5–60s pause while he confirms.

The existing `github` skill (gh CLI for `mudislandkid` repos) coexists
with this. Standard flow: read locally → edit (with grant) → branch →
commit → push → `gh pr create`.
```

## Phase 6: Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null \
  || systemctl --user restart nanoclaw 2>/dev/null \
  || echo "Restart NanoClaw manually."
```

## Phase 7: Write rollback script

```bash
cat > ~/.config/nanoclaw/dev-access-rollback.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "Rolling back add-developer-access..."
# Remove SSD root from allowlist
node --input-type=module -e "
  import fs from 'fs';
  import os from 'os';
  import path from 'path';
  const p = path.join(os.homedir(), '.config', 'nanoclaw', 'mount-allowlist.json');
  if (!fs.existsSync(p)) process.exit(0);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  cfg.allowedRoots = cfg.allowedRoots.filter(r =>
    !(r.path === '/Volumes/1tbSSD' && r.requireApproval) &&
    !r.path.startsWith('/Volumes/1tbSSD/')
  );
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
"
# Strip dev mounts and devAccessEnabled flag from main group config
node --input-type=module -e "
  import Database from 'better-sqlite3';
  const db = new Database('store/messages.db');
  const rows = db.prepare('SELECT jid, container_config FROM registered_groups').all();
  for (const row of rows) {
    if (!row.container_config) continue;
    const cfg = JSON.parse(row.container_config);
    if (cfg.additionalMounts) {
      cfg.additionalMounts = cfg.additionalMounts.filter(m => !m.containerPath?.startsWith('dev/'));
    }
    delete cfg.devAccessEnabled;
    db.prepare('UPDATE registered_groups SET container_config = ? WHERE jid = ?').run(JSON.stringify(cfg), row.jid);
  }
"
# Remove the container skill
rm -rf container/skills/dev-access
echo "Rolled back. Run npm run build and restart NanoClaw."
EOF
chmod +x ~/.config/nanoclaw/dev-access-rollback.sh
```

## Phase 8: Verification

Tell the user:

> "Developer access set up. Try these in your main chat to verify:
> 1. 'Andy, list contents of /workspace/dev' — should show your projects, all read-only.
> 2. 'Andy, edit a comment in <some project>/README.md' — Andy should hit EROFS, request access, and ping me for confirmation. Reply 'yes'.
> 3. After grant, ping Andy again to retry — the edit should land on the next message.
> 4. To rollback: run ~/.config/nanoclaw/dev-access-rollback.sh"

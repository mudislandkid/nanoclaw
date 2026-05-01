---
name: add-outlook
description: Add Outlook email channel integration to NanoClaw. Polls for new emails, triages them, and notifies on Signal when something needs attention. Personal Microsoft account only.
---

# Add Outlook Channel

Add Outlook as an email channel for NanoClaw. Polls Microsoft Graph API for new emails, triages them using the agent, and notifies on Signal when something is important or actionable.

**Account type:** Personal Microsoft account (outlook.com / hotmail.com / live.com)

**Prerequisites:**
- Signal channel already set up (notifications go to Signal)
- A personal Microsoft account

## Phase 1: Pre-flight

### Check if already configured

```bash
test -f ~/.outlook-mcp/tokens.json && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

Also check for the channel code:
```bash
test -f src/channels/outlook.ts && echo "CODE_OK" || echo "CODE_MISSING"
```

If both exist, skip to Phase 6 (Verify).

### Check if calendar scope is granted

If tokens exist but calendar scope hasn't been granted yet (existing users upgrading from email-only Outlook), the agent's calendar tools will return 403 errors.

```bash
test -f ~/.outlook-mcp/tokens.json && \
  node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.outlook-mcp', 'tokens.json'), 'utf-8'));
    fetch('https://graph.microsoft.com/v1.0/me/calendars?\$top=1', {
      headers: { Authorization: 'Bearer ' + t.accessToken }
    }).then(r => console.log(r.status === 200 ? 'CALENDAR_OK' : 'CALENDAR_NEEDS_REAUTH:' + r.status));
  "
```

If the output is `CALENDAR_NEEDS_REAUTH:*`, re-run Phase 4 (OAuth Flow) — this will re-consent with the new `Calendars.ReadWrite` scope. Existing email functionality keeps working through the re-auth.

## Phase 2: Code Installation

Check if the Outlook channel code exists:

```bash
test -f src/channels/outlook.ts && echo "CODE_OK" || echo "CODE_MISSING"
```

If missing, merge from the outlook fork branch:

```bash
git remote add outlook https://github.com/qwibitai/nanoclaw-outlook.git 2>/dev/null || true
git fetch outlook main
git merge outlook/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
npm install && npm run build
```

## Phase 3: Azure App Registration

Guide the user through Azure portal setup step by step.

AskUserQuestion: Have you already created an Azure app registration for NanoClaw?

**If no, walk them through it:**

1. Go to https://portal.azure.com → **Microsoft Entra ID** → **App registrations** → **New registration**
2. Name: `NanoClaw Outlook`
3. Supported account types: **Personal Microsoft accounts only**
4. Redirect URI: Platform = **Web**, URI = `http://localhost:3333/callback`
5. Click **Register**
6. Copy the **Application (client) ID** from the Overview page

AskUserQuestion: Paste the Application (client) ID:

7. Go to **Certificates & secrets** → **New client secret**
   - Description: `nanoclaw`
   - Expiry: 24 months (or preferred)
8. Copy the secret **Value** (not the Secret ID)

AskUserQuestion: Paste the client secret value:

9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**
10. Add these permissions:
    - `Mail.Read`
    - `Mail.ReadWrite`
    - `Mail.Send`
    - `Calendars.ReadWrite`
    - `User.Read` (should already be there)
11. Verify all 5 permissions are listed

## Phase 4: OAuth Flow

Run the OAuth setup with the client ID and secret from Phase 3:

```bash
npx tsx setup/index.ts --step outlook-auth -- --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

This will:
- Save credentials to `~/.outlook-mcp/`
- Open the browser for Microsoft sign-in
- Request scopes: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `User.Read`, `offline_access`
- Start a local server on port 3333 to receive the callback
- Exchange the auth code for access + refresh tokens
- Save tokens to `~/.outlook-mcp/tokens.json`

Wait for `OUTLOOK_AUTH_OK=true`. If it fails, check the error and retry.

## Phase 5: Registration

### Get user email

The email address is needed for the JID. Read it from the Graph API:

```bash
node -e "
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tokens = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.outlook-mcp', 'tokens.json'), 'utf-8'));
  fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: 'Bearer ' + tokens.accessToken }
  }).then(r => r.json()).then(data => console.log(data.mail || data.userPrincipalName));
"
```

### Register the group

The register step requires a `--trigger` value even with `--no-trigger-required`:

```bash
npx tsx setup/index.ts --step register \
  --jid "outlook:<EMAIL_ADDRESS>" \
  --name "Outlook Inbox" \
  --folder outlook_inbox \
  --channel outlook \
  --trigger "none" \
  --no-trigger-required
```

### Add mount to allowlist

Add `~/.outlook-mcp` to the mount allowlist so the container can access credentials.

**IMPORTANT:** Entries in `allowedRoots` must be objects with `{ path, allowReadWrite, description }` — NOT plain strings. Plain strings will silently fail validation.

Edit `~/.config/nanoclaw/mount-allowlist.json` and add this to the `allowedRoots` array:

```json
{
  "path": "~/.outlook-mcp",
  "allowReadWrite": false,
  "description": "Outlook OAuth credentials"
}
```

If the file doesn't exist yet, create it:

```json
{
  "allowedRoots": [
    {
      "path": "~/.outlook-mcp",
      "allowReadWrite": false,
      "description": "Outlook OAuth credentials"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

### Add container mount to outlook_inbox group

Update the group's `container_config` in the database. The `containerPath` must be **relative** (e.g. `outlook-mcp`), NOT absolute — it gets auto-prefixed with `/workspace/extra/`.

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const row = db.prepare('SELECT container_config FROM registered_groups WHERE folder = ?').get('outlook_inbox');
const config = row?.container_config ? JSON.parse(row.container_config) : {};
config.additionalMounts = config.additionalMounts || [];
if (!config.additionalMounts.some(m => m.containerPath === 'outlook-mcp')) {
  config.additionalMounts.push({ hostPath: process.env.HOME + '/.outlook-mcp', containerPath: 'outlook-mcp', readonly: true });
  db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(config), 'outlook_inbox');
  console.log('Added outlook-mcp mount to outlook_inbox');
}
db.close();
"
```

### Add container mount to main group (Signal/WhatsApp)

The user chats with Andy on their main channel (Signal, WhatsApp, etc.), so the **main group's container also needs the Outlook MCP mount** — otherwise the agent can only triage incoming emails but can't respond to direct requests like "check my inbox".

Find the main group folder and add the same mount:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('store/messages.db');
const rows = db.prepare('SELECT folder, container_config FROM registered_groups WHERE is_main = 1 OR folder LIKE \"%main%\"').all();
for (const row of rows) {
  const config = row.container_config ? JSON.parse(row.container_config) : {};
  config.additionalMounts = config.additionalMounts || [];
  if (!config.additionalMounts.some(m => m.containerPath === 'outlook-mcp')) {
    config.additionalMounts.push({ hostPath: process.env.HOME + '/.outlook-mcp', containerPath: 'outlook-mcp', readonly: true });
    db.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(JSON.stringify(config), row.folder);
    console.log('Added outlook-mcp mount to', row.folder);
  }
}
db.close();
"
```

### Delete stale agent-runner copies

The container runner caches a copy of `agent-runner/src/` per group. After adding MCP server support, delete stale copies so the container gets the updated code:

```bash
rm -rf data/sessions/outlook_inbox/agent-runner-src/
rm -rf data/sessions/signal_main/agent-runner-src/
# Delete for any other group that should have Outlook access:
# rm -rf data/sessions/<group_folder>/agent-runner-src/
```

## Phase 6: Group CLAUDE.md

Create `groups/outlook_inbox/CLAUDE.md` with triage instructions:

```bash
mkdir -p groups/outlook_inbox
```

Write the following content to `groups/outlook_inbox/CLAUDE.md`:

```markdown
# Outlook Inbox — Email Triage Agent

You are Andy, Greg's email triage assistant for his personal Outlook inbox.

## Your Role

New emails arrive as messages. For each one, classify it as:

- **Important/Actionable** — needs Greg's attention or action
- **Informational** — worth noting but no action needed
- **Noise** — newsletters, promotions, automated alerts

## What To Do

**Important/Actionable:** Send Greg a Signal notification with:
- Who it's from
- What it's about (1-2 sentence summary)
- What action is needed
- How urgent it is

**Informational:** Note it silently. Mention if Greg asks.

**Noise:** Ignore completely. Do not notify.

## Rules

- NEVER send, reply to, or forward emails without Greg's explicit approval
- When asked to draft a reply, use outlook_draft_reply and show the draft on Signal
- Only send a draft after Greg says "send it" or equivalent
- When asked to organise, use outlook_move_email to sort into folders
- Use outlook_read_email to fetch full email body only when the preview isn't enough
```

## Phase 7: Verify

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or on Linux:
```bash
npm run build
systemctl --user restart nanoclaw
```

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i outlook
```

Look for:
- `Outlook channel connected` — successful connection
- `Outlook: processing new emails` — emails being processed
- `Outlook: poll complete` — poll cycle finished

### Test

Wait for a new email to arrive (or send yourself a test email). The agent should triage it and notify on Signal if it's important.

You can also message Andy on your main channel (Signal) and ask him to check your inbox — the Outlook MCP tools should be available there too.

## Troubleshooting

**"Outlook: not configured"**: Ensure `~/.outlook-mcp/tokens.json` exists with valid tokens. Re-run Phase 4 if needed.

**"Outlook: token refresh failed"**: The refresh token may have expired (90 days of inactivity) or been revoked. Re-run Phase 4 to re-authenticate.

**"Outlook: failed to fetch user email"**: The access token may be invalid. Check that API permissions (Mail.Read, User.Read) are granted in Azure portal.

**No notifications on Signal**: Check that the group is registered (`npx tsx setup/index.ts --step verify`). Check the agent's CLAUDE.md in `groups/outlook_inbox/` for triage instructions.

**Container MCP tools not working — mount issues**:
- Ensure `allowedRoots` entries in `~/.config/nanoclaw/mount-allowlist.json` are objects (`{ "path": "...", "allowReadWrite": false }`) not plain strings
- Ensure `containerPath` in the DB `container_config` is **relative** (e.g. `outlook-mcp`), not absolute — it auto-prefixes with `/workspace/extra/`
- Delete stale agent-runner copies: `rm -rf data/sessions/<group>/agent-runner-src/`
- Ensure the **main group** also has the mount (not just `outlook_inbox`) — the user talks to Andy on Signal/WhatsApp, so that container needs the MCP tools too

**Outlook container not spinning up**: The `outlook_inbox` container only spins up when new emails arrive. If you're asking Andy to check your mailbox, you're chatting on your main channel (Signal) — the Outlook MCP tools need to be mounted on that group's container instead.

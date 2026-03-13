# Outlook Email Channel — Design Spec

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this spec.

**Goal:** Add Outlook as a NanoClaw channel that polls for new emails, triages them, and notifies the user on Signal when something is important or actionable. The agent can also draft replies for user approval and help organise the inbox.

**Account type:** Personal Microsoft account (outlook.com / hotmail.com / live.com).

---

## 1. Overview

The Outlook integration consists of two parts:

1. **Outlook Channel** (`src/channels/outlook.ts`) — polls Microsoft Graph API for new emails via delta queries, converts them to lightweight `NewMessage` objects, and routes them through the standard NanoClaw message loop.

2. **Outlook MCP Tools** (runs in container) — gives the agent tools to search, read full emails, draft replies, send approved drafts, and move/organise emails. The MCP server authenticates via tokens mounted read-only from `~/.outlook-mcp/`.

The channel handles **inbound** (new emails arriving). The MCP tools handle **outbound** (agent actions on the mailbox). This mirrors the Gmail integration pattern.

## 2. Authentication

### Azure App Registration

A one-time setup guided by the `/add-outlook` skill:

- Register an app at portal.azure.com
- Account type: **Personal Microsoft accounts only**
- Redirect URI: `http://localhost:3333/callback` (local OAuth flow during setup)
- API permissions (delegated, not application):
  - `Mail.Read` — read emails
  - `Mail.ReadWrite` — mark as read, move between folders
  - `Mail.Send` — send approved drafts
- Generate a client secret

### Token Storage

Credentials stored at `~/.outlook-mcp/` (outside the project directory, same pattern as Gmail):

```
~/.outlook-mcp/
├── client-id          # Azure app client ID
├── client-secret      # Azure app client secret
└── tokens.json        # OAuth access + refresh tokens
```

Refresh tokens for personal Microsoft accounts expire after **90 days of inactivity** and are revoked on password change or security events. The channel auto-refreshes the access token when it has less than 5 minutes until expiry (Microsoft access tokens last 1 hour).

**Token refresh failure handling:** If the refresh token exchange returns `invalid_grant` (expired or revoked), the channel logs a clear error (`Outlook: refresh token expired — re-run /add-outlook to re-authenticate`), stops polling, and marks the channel as disconnected. The agent's next Signal notification attempt will surface the issue.

### Container Access

`~/.outlook-mcp/` is mounted read-only into agent containers via `additionalMounts` in the group's `containerConfig`. This gives the MCP tools access to authenticate against Microsoft Graph without exposing credentials to the project directory.

**Mount allowlist:** The mount-security system (`~/.config/nanoclaw/mount-allowlist.json`) must include `~/.outlook-mcp` as an allowed root. The `/add-outlook` setup skill adds this automatically during the registration phase. Without it, the container runner silently rejects the mount and the MCP tools will have no credentials.

## 3. Inbound Flow (New Emails to Agent)

### Polling Strategy

- Poll every **60 seconds** using Microsoft Graph delta queries
- Endpoint: `/me/mailFolders/inbox/messages/delta`
- Delta token persisted to the SQLite database (consistent with how other channel state is stored in `store/messages.db`) so state survives restarts
- Only new/modified messages returned — zero wasted API calls

### First Run

On first connect, do **not** backfill the entire inbox. Instead:

- Record the current timestamp as the baseline
- Only process emails arriving **after** setup
- The user can later ask the agent to do a one-time inbox triage as an on-demand task (e.g. "go through my last 50 unread emails and tell me what needs attention"), processed in manageable chunks

### Message Conversion

Each new unread email becomes a `NewMessage` with compact metadata:

| Field | Value |
|-------|-------|
| `id` | `outlook-{Graph messageId}` |
| `chat_jid` | `outlook:{user-email-address}` |
| `sender` | `outlook:{sender-email}` |
| `sender_name` | Sender display name |
| `content` | Compact format (see below) |
| `timestamp` | `receivedDateTime` from Graph |
| `is_from_me` | `false` |
| `is_bot_message` | `false` |

**Content format** (metadata only — keeps token usage low):

```
New email from "John Smith <john@example.com>"
Subject: Q3 Security Audit Review
Preview: Hi Greg, following up on the audit findings we discussed...
[Email ID: AAMkAD...]
```

The agent triages based on this compact summary. If it needs the full body, it uses the `outlook_read_email` MCP tool to fetch it on demand.

### Post-Processing

After the agent processes an email, mark it as read via Graph API (`PATCH /me/messages/{id}` with `isRead: true`). This prevents re-processing on the next poll cycle.

**Delta re-processing guard:** Marking an email as read modifies it, which causes it to reappear in the next delta response as a "modified" message. The poll loop must filter incoming delta results to only process messages where `isRead` is `false` at the time of receipt. Messages that appear in the delta with `isRead: true` are skipped — they were already processed.

## 4. Outbound Flow (Agent Actions)

### MCP Tools

The following tools are available to the agent inside the container:

| Tool | Purpose |
|------|---------|
| `outlook_search_emails` | Search by sender, subject, date range, folder |
| `outlook_read_email` | Fetch full body and attachment metadata for a specific email by ID |
| `outlook_draft_reply` | Create a draft reply in Outlook's Drafts folder. Returns draft ID and posts the draft text to Signal for user review. |
| `outlook_send_draft` | Send a previously created draft by ID. **Requires explicit user approval.** |
| `outlook_move_email` | Move an email to a specified folder (for organising) |
| `outlook_list_folders` | List available mail folders |

### MCP Server Implementation

The MCP server lives at `container/outlook-mcp/` and is a lightweight TypeScript server using the `@modelcontextprotocol/sdk` package (already available in the container image). It:

- Reads credentials from `/workspace/extra/outlook-mcp/` (the mounted `~/.outlook-mcp/` directory)
- Authenticates against Microsoft Graph using the same access/refresh token flow as the channel
- Exposes the tools listed above via the MCP stdio transport
- Is registered in the container's MCP config so the agent can call the tools naturally

### Approval Gate

The agent must **never** send an email without explicit user approval:

1. User asks Andy (via Signal) to reply to an email
2. Agent calls `outlook_draft_reply` — creates draft in Outlook, shows draft text on Signal
3. User reviews on Signal: "yes send it" / "change X" / "don't send"
4. Only on explicit approval does the agent call `outlook_send_draft`

This constraint is enforced via the agent's instructions in the group `CLAUDE.md` and by the tool descriptions in the MCP server. Note: this is a **behavioural constraint**, not a technical access control boundary — the `Mail.Send` permission is granted at the OAuth level, so the MCP tool technically can send. The guard is the agent's instructions and the tool description telling the agent it must have user approval first.

## 5. Cross-Channel Notifications

When the agent determines an email is important or actionable, it sends a notification to the user's Signal chat. This uses NanoClaw's existing cross-channel messaging — the router already supports sending messages to any registered channel.

The notification format:

```
Email from John Smith <john@example.com>
Subject: Q3 Security Audit Review
Summary: John is asking for your sign-off on the audit report by Friday.
Recommended action: Review and reply by end of week.
```

Non-important emails (newsletters, promotions, automated notifications) are silently ignored — no notification sent.

## 6. Channel Implementation

### File Structure

| File | Purpose |
|------|---------|
| `src/channels/outlook.ts` | Channel class: polling, Graph API calls, message conversion |
| `src/channels/outlook.test.ts` | Unit tests |
| `src/channels/index.ts` | Add `import './outlook.js'` |
| `container/outlook-mcp/` | MCP server for email tools (TypeScript, runs inside container) |
| `setup/outlook-auth.ts` | OAuth flow (local server, browser redirect, token save) |
| `store/messages.db` | Delta token stored in existing SQLite DB (new table or key-value row) |

### Channel Class

```typescript
class OutlookChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private connected = false;

  // Poll timer
  private pollInterval: NodeJS.Timeout | null = null;

  // Microsoft Graph auth (simple fetch, no heavy SDK)
  private accessToken: string;
  private refreshToken: string;
  private tokenExpiry: number;         // Unix ms — refresh when < 5min remaining
  private deltaLink: string | null;    // Persisted delta query token
  private userEmail: string;           // User's email address (for JID)

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    // Load tokens from ~/.outlook-mcp/
  }

  async connect(): Promise<void>;      // Load tokens, start polling
  async disconnect(): Promise<void>;   // Stop polling, clear interval
  async sendMessage(jid, text): Promise<void>;  // No-op with debug log (outbound is via MCP tools)
  isConnected(): boolean;
  ownsJid(jid: string): boolean;       // jid.startsWith('outlook:')

  // Internal
  private async poll(): Promise<void>;              // Delta query, filter isRead=false, emit onChatMetadata + onMessage
  private async refreshAccessToken(): Promise<void>; // Refresh if <5min to expiry, disconnect on invalid_grant
  private async markAsRead(messageId: string): Promise<void>;
}
```

**`onChatMetadata`:** The channel calls `opts.onChatMetadata('outlook:{email}', timestamp, 'Outlook Inbox', 'outlook', false)` during each poll cycle for every new email, matching the pattern used by WhatsApp and Signal for group/chat discovery.

**`sendMessage` behaviour:** The router may call `sendMessage` on the outlook channel when the agent produces output routed to an outlook JID. This is intentionally a no-op with a debug log — all agent responses for the outlook group are delivered via cross-channel messaging to Signal. The agent is never expected to send email through `sendMessage`; email sending is exclusively via the `outlook_send_draft` MCP tool.

### Registration

```typescript
registerChannel('outlook', (opts: ChannelOpts) => {
  const config = readOutlookConfig();  // reads ~/.outlook-mcp/
  if (!config) {
    logger.warn('Outlook: not configured. Run /add-outlook to set up.');
    return null;
  }
  return new OutlookChannel(opts);
});
```

### Graph API — No Heavy SDK

Use plain `fetch()` against `https://graph.microsoft.com/v1.0/` with bearer token auth. No `@microsoft/microsoft-graph-client` dependency — keeps it lightweight and follows the project's minimal-dependency philosophy.

## 7. Group Configuration

### Registered Group

```
JID:     outlook:{user-email-address}
Name:    Outlook Inbox
Folder:  outlook_inbox
Trigger: (none — every email triggers processing)
Channel: outlook
```

`requiresTrigger: false` — every new email is processed without needing an @mention.

### Group CLAUDE.md

`groups/outlook_inbox/CLAUDE.md` contains the agent's triage instructions:

- Your role: email triage assistant for Greg's personal Outlook inbox
- For each new email, classify as: **important/actionable**, **informational**, or **noise**
- Important/actionable: notify Greg on Signal with a summary and recommended action
- Informational: note it silently, mention if asked
- Noise (newsletters, promotions, automated alerts): ignore completely
- Never send, reply to, or forward emails without Greg's explicit approval
- When asked to draft a reply, create the draft and show it on Signal for approval
- When asked to organise, use the move tool to sort emails into folders

## 8. Skill Setup Flow

**Skill:** `.claude/skills/add-outlook/SKILL.md`

### Phase 1: Pre-flight
- Check if `src/channels/outlook.ts` exists
- Check if `~/.outlook-mcp/tokens.json` exists
- If both exist, skip to Phase 5 (Verify)

### Phase 2: Code Installation
- Merge from fork branch: `git fetch outlook main && git merge outlook/main`
- Handle package-lock.json conflicts (standard pattern)
- `npm install && npm run build`

### Phase 3: Azure App Registration
- Guide user through portal.azure.com step by step
- Create app registration → set account type → add permissions → generate secret
- User pastes client ID and client secret

### Phase 4: OAuth Flow
- Run `npx tsx setup/outlook-auth.ts` (installed in Phase 2)
- Starts local HTTP server on `:3333`
- Opens browser to Microsoft login
- User signs in, consents to permissions
- Callback captures auth code, exchanges for tokens
- Saves everything to `~/.outlook-mcp/`

### Phase 5: Registration
- Register `outlook:{email}` as a group
- Create `groups/outlook_inbox/CLAUDE.md` with triage instructions
- Add `~/.outlook-mcp` to the mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`) so the container can access credentials

### Phase 6: Verify
- Build and restart service
- Confirm channel connects and polling starts
- Check logs for `Outlook: connected` and `Outlook: poll complete`

## 9. Security Considerations

- OAuth tokens stored outside project dir (`~/.outlook-mcp/`) — never committed to git
- Container mount is read-only — agent cannot modify credentials
- `Mail.Send` permission is required but sending is gated by agent instructions and tool design
- No application-level permissions — all delegated (user must be signed in)
- Client secret should be treated like any other credential — not logged, not exposed

## 10. Limitations & Future Work

**Out of scope for v1:**
- Calendar integration (separate skill later)
- Attachment downloading/processing (agent sees attachment metadata but can't read file contents)
- Multiple Outlook accounts
- Shared/delegated mailboxes
- Real-time push via Graph webhooks (polling is sufficient for email)

**Future enhancements:**
- Inbox organisation automation (auto-create folders, auto-file by category)
- Scheduled inbox digest (daily summary of what came in)
- Attachment reading (PDF extraction, image vision)

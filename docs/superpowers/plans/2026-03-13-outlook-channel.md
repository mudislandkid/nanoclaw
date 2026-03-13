# Outlook Email Channel Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Outlook as a NanoClaw channel that polls for new emails via Microsoft Graph delta queries, triages them, and notifies the user on Signal.

**Architecture:** Outlook channel polls Graph API every 60s using delta tokens (stored in SQLite). Each unread email becomes a compact `NewMessage` with metadata only. Agent triages in the container and sends Signal notifications for important emails. An MCP server in the container gives the agent tools to read full emails, draft replies, and organise folders. OAuth tokens stored at `~/.outlook-mcp/`.

**Tech Stack:** Microsoft Graph API (plain `fetch`, no SDK), OAuth2 via `@azure/msal-node`, `html-to-text` for body conversion.

**Spec:** `docs/superpowers/specs/2026-03-13-outlook-channel-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/channels/outlook.ts` | Create | Channel class: polling, Graph API, message conversion |
| `src/channels/outlook.test.ts` | Create | Unit tests for channel |
| `src/channels/index.ts` | Modify (line 13) | Add `import './outlook.js'` |
| `src/outlook-graph.ts` | Create | Microsoft Graph API client (fetch wrapper + token refresh) |
| `src/outlook-graph.test.ts` | Create | Unit tests for Graph client |
| `setup/outlook-auth.ts` | Create | OAuth setup flow (local server, browser redirect) |
| `setup/index.ts` | Modify (line 19) | Add `'outlook-auth'` step |
| `setup/verify.ts` | Modify | Add Outlook credential detection |
| `container/outlook-mcp/index.ts` | Create | MCP server for email tools (runs in container) |
| `container/outlook-mcp/package.json` | Create | MCP server dependencies |
| `.claude/skills/add-outlook/SKILL.md` | Create | User-facing setup skill |

---

## Chunk 1: Graph API Client

### Task 1: Microsoft Graph API Client

**Files:**
- Create: `src/outlook-graph.ts`
- Create: `src/outlook-graph.test.ts`

This is the low-level HTTP wrapper around Microsoft Graph. It handles token refresh, delta queries, and all Graph endpoints. The channel delegates all API calls to this module.

- [ ] **Step 1: Write failing tests for Graph client**

Create `src/outlook-graph.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs for credential reading
vi.mock('fs');

describe('OutlookGraph', () => {
  const CREDS_DIR = path.join(os.homedir(), '.outlook-mcp');

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath);
      if (p.endsWith('client-id')) return 'test-client-id';
      if (p.endsWith('client-secret')) return 'test-client-secret';
      if (p.endsWith('tokens.json'))
        return JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_at: Date.now() + 3600_000, // 1 hour from now
        });
      return '';
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadCredentials', () => {
    it('returns null when credentials dir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Test that loadOutlookCredentials returns null
    });

    it('loads credentials from ~/.outlook-mcp/', () => {
      // Test that credentials are loaded correctly
    });
  });

  describe('fetchDelta', () => {
    it('calls delta endpoint with no token on first run', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=abc',
        }),
      });
      // Test initial delta query (no deltaLink, uses filter)
    });

    it('uses existing deltaLink for subsequent calls', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'msg-1',
              isRead: false,
              subject: 'Test Subject',
              from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
              bodyPreview: 'Hello there...',
              receivedDateTime: '2026-03-13T10:00:00Z',
            },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=def',
        }),
      });
      // Test that deltaLink is used and new messages returned
    });

    it('filters out already-read messages from delta results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            { id: 'msg-1', isRead: true, subject: 'Already read' },
            { id: 'msg-2', isRead: false, subject: 'New email' },
          ],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=ghi',
        }),
      });
      // Test that only isRead=false messages are returned
    });
  });

  describe('refreshAccessToken', () => {
    it('refreshes when token expires within 5 minutes', async () => {
      // Set token to expire in 2 minutes
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
        const p = String(filePath);
        if (p.endsWith('tokens.json'))
          return JSON.stringify({
            access_token: 'old-token',
            refresh_token: 'test-refresh-token',
            expires_at: Date.now() + 120_000, // 2 min
          });
        if (p.endsWith('client-id')) return 'test-client-id';
        if (p.endsWith('client-secret')) return 'test-client-secret';
        return '';
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      });
      // Test that token is refreshed and saved
    });

    it('throws on invalid_grant (expired refresh token)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'invalid_grant' }),
      });
      // Test that error is thrown with clear message
    });
  });

  describe('markAsRead', () => {
    it('patches message with isRead=true', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      // Test PATCH call
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/outlook-graph.test.ts`
Expected: FAIL — module `src/outlook-graph.ts` does not exist

- [ ] **Step 3: Implement the Graph client**

Create `src/outlook-graph.ts`:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const CREDS_DIR = path.join(os.homedir(), '.outlook-mcp');
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // Refresh when <5 min to expiry

export interface OutlookCredentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms
}

export interface GraphEmail {
  id: string;
  subject: string;
  from: { emailAddress: { name: string; address: string } };
  bodyPreview: string;
  receivedDateTime: string;
  isRead: boolean;
}

export interface DeltaResult {
  emails: GraphEmail[];
  deltaLink: string;
}

export function loadOutlookCredentials(): OutlookCredentials | null {
  if (!fs.existsSync(CREDS_DIR)) return null;

  try {
    const clientId = fs.readFileSync(path.join(CREDS_DIR, 'client-id'), 'utf-8').trim();
    const clientSecret = fs.readFileSync(path.join(CREDS_DIR, 'client-secret'), 'utf-8').trim();
    const tokens = JSON.parse(
      fs.readFileSync(path.join(CREDS_DIR, 'tokens.json'), 'utf-8'),
    );

    if (!clientId || !clientSecret || !tokens.access_token || !tokens.refresh_token) {
      return null;
    }

    return {
      clientId,
      clientSecret,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_at || 0,
    };
  } catch (err) {
    logger.debug({ err }, 'Outlook: failed to load credentials');
    return null;
  }
}

export function saveTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const tokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: Date.now() + expiresIn * 1000,
  };
  fs.writeFileSync(
    path.join(CREDS_DIR, 'tokens.json'),
    JSON.stringify(tokens, null, 2),
  );
}

export async function refreshAccessToken(
  creds: OutlookCredentials,
): Promise<OutlookCredentials> {
  if (creds.expiresAt - Date.now() > REFRESH_THRESHOLD_MS) {
    return creds; // Token still valid
  }

  logger.info('Outlook: refreshing access token');

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
    scope: 'https://graph.microsoft.com/.default offline_access',
  });

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    if (errBody.error === 'invalid_grant') {
      throw new Error(
        'Outlook: refresh token expired or revoked — re-run /add-outlook to re-authenticate',
      );
    }
    throw new Error(`Outlook: token refresh failed (${resp.status}): ${JSON.stringify(errBody)}`);
  }

  const data = await resp.json();
  saveTokens(data.access_token, data.refresh_token, data.expires_in);

  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function fetchDelta(
  accessToken: string,
  deltaLink: string | null,
): Promise<DeltaResult> {
  // First run: use inbox messages endpoint with select fields
  const url =
    deltaLink ||
    `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=id,subject,from,bodyPreview,receivedDateTime,isRead`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!resp.ok) {
    throw new Error(`Outlook: delta query failed (${resp.status})`);
  }

  const data = await resp.json();

  // Handle pagination — follow @odata.nextLink until we get @odata.deltaLink
  let allMessages: GraphEmail[] = data.value || [];
  let nextLink = data['@odata.nextLink'];
  let newDeltaLink = data['@odata.deltaLink'];

  while (nextLink) {
    const nextResp = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!nextResp.ok) break;
    const nextData = await nextResp.json();
    allMessages = allMessages.concat(nextData.value || []);
    nextLink = nextData['@odata.nextLink'];
    newDeltaLink = nextData['@odata.deltaLink'] || newDeltaLink;
  }

  // Filter: only unread emails (skip re-processing from mark-as-read modifications)
  const unreadEmails = allMessages.filter((msg) => msg.isRead === false);

  return {
    emails: unreadEmails,
    deltaLink: newDeltaLink || deltaLink || '',
  };
}

export async function markAsRead(
  accessToken: string,
  messageId: string,
): Promise<void> {
  await fetch(`${GRAPH_BASE}/me/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });
}

export async function getUserEmail(accessToken: string): Promise<string> {
  const resp = await fetch(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Outlook: failed to get user profile (${resp.status})`);
  const data = await resp.json();
  return data.mail || data.userPrincipalName || '';
}
```

- [ ] **Step 4: Complete the test file with actual assertions**

Update `src/outlook-graph.test.ts` to import from `./outlook-graph.js` and fill in each test body with proper assertions against the implementation. Key tests:

- `loadOutlookCredentials` returns null when dir missing
- `loadOutlookCredentials` returns credentials when files exist
- `fetchDelta` uses correct initial URL when no deltaLink
- `fetchDelta` uses deltaLink when provided
- `fetchDelta` filters out `isRead: true` messages
- `fetchDelta` handles pagination via `@odata.nextLink`
- `refreshAccessToken` skips refresh when token valid
- `refreshAccessToken` refreshes when near expiry
- `refreshAccessToken` throws clear error on `invalid_grant`
- `markAsRead` sends PATCH with `isRead: true`
- `getUserEmail` extracts email from profile

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/outlook-graph.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/outlook-graph.ts src/outlook-graph.test.ts
git commit -m "feat: add Microsoft Graph API client for Outlook channel"
```

---

## Chunk 2: Outlook Channel

### Task 2: Outlook Channel Implementation

**Files:**
- Create: `src/channels/outlook.ts`
- Create: `src/channels/outlook.test.ts`
- Modify: `src/channels/index.ts` (line 13 area)

**Reference:** Follow the exact same pattern as `src/channels/signal.ts` — constructor takes `ChannelOpts`, stores `opts`, calls `opts.onMessage` and `opts.onChatMetadata`.

- [ ] **Step 1: Write failing tests for OutlookChannel**

Create `src/channels/outlook.test.ts`. Pattern from `signal.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the graph module
vi.mock('../outlook-graph.js', () => ({
  loadOutlookCredentials: vi.fn(),
  refreshAccessToken: vi.fn(),
  fetchDelta: vi.fn(),
  markAsRead: vi.fn(),
  getUserEmail: vi.fn(),
  saveTokens: vi.fn(),
}));

// Mock db for delta token storage
vi.mock('../db.js', () => ({
  getRouterState: vi.fn(),
  setRouterState: vi.fn(),
}));

import { loadOutlookCredentials, refreshAccessToken, fetchDelta, markAsRead, getUserEmail } from '../outlook-graph.js';
import { getRouterState, setRouterState } from '../db.js';
import { ChannelOpts } from './registry.js';

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'outlook:user@outlook.com': {
        name: 'Outlook Inbox',
        folder: 'outlook_inbox',
        trigger: '',
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      },
    })),
    ...overrides,
  };
}

describe('OutlookChannel', () => {
  beforeEach(() => {
    vi.mocked(loadOutlookCredentials).mockReturnValue({
      clientId: 'test-id',
      clientSecret: 'test-secret',
      accessToken: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600_000,
    });
    vi.mocked(refreshAccessToken).mockImplementation(async (c) => c);
    vi.mocked(getUserEmail).mockResolvedValue('user@outlook.com');
    vi.mocked(getRouterState).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Tests to implement:
  // - connect() starts polling and sets connected = true
  // - disconnect() stops polling
  // - ownsJid() returns true for outlook: prefixed JIDs
  // - ownsJid() returns false for other JIDs
  // - poll converts unread emails to NewMessage and calls onMessage
  // - poll calls onChatMetadata for each email
  // - poll stores new deltaLink via setRouterState
  // - poll skips emails when group not registered
  // - poll marks processed emails as read
  // - sendMessage is a no-op (debug log only)
  // - handles token refresh failure gracefully (disconnects)
  // - factory returns null when no credentials
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement OutlookChannel**

Create `src/channels/outlook.ts`:

```typescript
import { getRouterState, setRouterState } from '../db.js';
import { logger } from '../logger.js';
import {
  fetchDelta,
  getUserEmail,
  loadOutlookCredentials,
  markAsRead,
  OutlookCredentials,
  refreshAccessToken,
} from '../outlook-graph.js';
import { Channel, NewMessage } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const OUTLOOK_PREFIX = 'outlook:';
const POLL_INTERVAL_MS = 60_000; // 60 seconds
const DELTA_TOKEN_KEY = 'outlook_delta_token';

function emailToJid(email: string): string {
  return `${OUTLOOK_PREFIX}${email}`;
}

export class OutlookChannel implements Channel {
  name = 'outlook';

  private opts: ChannelOpts;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private creds: OutlookCredentials;
  private userEmail = '';

  constructor(opts: ChannelOpts, creds: OutlookCredentials) {
    this.opts = opts;
    this.creds = creds;
  }

  async connect(): Promise<void> {
    // Refresh token if needed
    this.creds = await refreshAccessToken(this.creds);
    this.userEmail = await getUserEmail(this.creds.accessToken);
    this.connected = true;

    logger.info({ email: this.userEmail }, 'Outlook: connected');

    // Start polling
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        logger.error({ err }, 'Outlook: poll error'),
      );
    }, POLL_INTERVAL_MS);

    // Initial poll
    this.poll().catch((err) =>
      logger.error({ err }, 'Outlook: initial poll error'),
    );
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Outlook: disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(OUTLOOK_PREFIX);
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // No-op — outbound email is handled exclusively via MCP tools.
    // Agent responses for this group route to Signal via cross-channel messaging.
    logger.debug('Outlook: sendMessage is a no-op (use MCP tools for email)');
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      // Refresh token if near expiry
      this.creds = await refreshAccessToken(this.creds);
    } catch (err) {
      logger.error({ err }, 'Outlook: token refresh failed — disconnecting');
      this.connected = false;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }

    const deltaLink = getRouterState(DELTA_TOKEN_KEY) || null;
    const result = await fetchDelta(this.creds.accessToken, deltaLink);

    // Persist new delta token
    if (result.deltaLink) {
      setRouterState(DELTA_TOKEN_KEY, result.deltaLink);
    }

    const chatJid = emailToJid(this.userEmail);

    for (const email of result.emails) {
      const senderEmail = email.from?.emailAddress?.address || 'unknown';
      const senderName = email.from?.emailAddress?.name || senderEmail;
      const timestamp = new Date(email.receivedDateTime || Date.now()).toISOString();

      // Always emit metadata for chat discovery
      this.opts.onChatMetadata(chatJid, timestamp, 'Outlook Inbox', 'outlook', false);

      // Only deliver to registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) continue;

      const content = [
        `New email from "${senderName} <${senderEmail}>"`,
        `Subject: ${email.subject || '(no subject)'}`,
        `Preview: ${email.bodyPreview || '(empty)'}`,
        `[Email ID: ${email.id}]`,
      ].join('\n');

      const message: NewMessage = {
        id: `outlook-${email.id}`,
        chat_jid: chatJid,
        sender: emailToJid(senderEmail),
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(chatJid, message);

      // Mark as read to prevent re-processing
      try {
        await markAsRead(this.creds.accessToken, email.id);
      } catch (err) {
        logger.warn({ err, emailId: email.id }, 'Outlook: failed to mark as read');
      }
    }

    logger.debug(
      { emailCount: result.emails.length },
      'Outlook: poll complete',
    );
  }
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerChannel('outlook', (opts: ChannelOpts) => {
  const creds = loadOutlookCredentials();
  if (!creds) {
    logger.warn('Outlook: not configured. Run /add-outlook to set up.');
    return null;
  }
  return new OutlookChannel(opts, creds);
});
```

- [ ] **Step 4: Register in barrel file**

Modify `src/channels/index.ts` — add after the whatsapp import:

```typescript
// outlook
import './outlook.js';
```

- [ ] **Step 5: Complete test assertions and run**

Fill in all test bodies in `outlook.test.ts` with actual assertions. Test that:
- `connect()` calls `getUserEmail` and sets `connected = true`
- `poll()` calls `fetchDelta`, converts emails to `NewMessage`, calls `onMessage`
- `poll()` calls `onChatMetadata` for each email
- `poll()` calls `markAsRead` for each processed email
- `poll()` saves delta token via `setRouterState`
- `poll()` skips emails when group not registered
- `sendMessage()` does not throw
- `ownsJid('outlook:foo@bar.com')` returns true
- `ownsJid('signal:+123')` returns false
- Token refresh failure disconnects channel
- Factory returns null when credentials missing

Run: `npx vitest run src/channels/outlook.test.ts`
Expected: All PASS

- [ ] **Step 6: Build check**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 7: Commit**

```bash
git add src/channels/outlook.ts src/channels/outlook.test.ts src/channels/index.ts
git commit -m "feat: add Outlook channel with Graph API polling"
```

---

## Chunk 3: OAuth Setup & Skill

### Task 3: OAuth Setup Step

**Files:**
- Create: `setup/outlook-auth.ts`
- Modify: `setup/index.ts` (line 19)
- Modify: `setup/verify.ts`

- [ ] **Step 1: Create the OAuth setup script**

Create `setup/outlook-auth.ts`:

```typescript
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CREDS_DIR = path.join(os.homedir(), '.outlook-mcp');
const REDIRECT_URI = 'http://localhost:3333/callback';
const AUTH_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'Mail.Read Mail.ReadWrite Mail.Send User.Read offline_access';

export async function run(args: string[]): Promise<void> {
  console.log('=== NANOCLAW SETUP: OUTLOOK_AUTH ===');

  // Parse args: --client-id <id> --client-secret <secret>
  const clientIdIdx = args.indexOf('--client-id');
  const clientSecretIdx = args.indexOf('--client-secret');

  const clientId = clientIdIdx !== -1 ? args[clientIdIdx + 1] : undefined;
  const clientSecret = clientSecretIdx !== -1 ? args[clientSecretIdx + 1] : undefined;

  if (!clientId || !clientSecret) {
    console.log('OUTLOOK_AUTH_OK=false');
    console.log('STATUS=error');
    console.log('ERROR=Missing --client-id or --client-secret');
    console.log('=== END ===');
    return;
  }

  // Ensure creds dir exists
  fs.mkdirSync(CREDS_DIR, { recursive: true });
  fs.writeFileSync(path.join(CREDS_DIR, 'client-id'), clientId);
  fs.writeFileSync(path.join(CREDS_DIR, 'client-secret'), clientSecret);

  // Build authorization URL
  const authUrl = `${AUTH_BASE}/authorize?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&response_mode=query`;

  console.log('Opening browser for Microsoft sign-in...');
  console.log(`If it does not open, visit: ${authUrl}`);

  // Open browser
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${authUrl}"`);
    } else {
      execSync(`xdg-open "${authUrl}" 2>/dev/null`);
    }
  } catch {
    console.log('Could not open browser automatically.');
  }

  // Start local server to receive callback
  const result = await new Promise<{ success: boolean; error?: string }>((resolve) => {
    const timeout = setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'Timeout — no callback received within 120s' });
    }, 120_000);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '', `http://localhost:3333`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error || !code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed</h1><p>You can close this tab.</p>');
        clearTimeout(timeout);
        server.close();
        resolve({ success: false, error: error || 'No auth code received' });
        return;
      }

      // Exchange code for tokens
      try {
        const tokenResp = await fetch(`${AUTH_BASE}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: REDIRECT_URI,
            grant_type: 'authorization_code',
            scope: SCOPES,
          }).toString(),
        });

        if (!tokenResp.ok) {
          const errBody = await tokenResp.text();
          throw new Error(`Token exchange failed: ${errBody.slice(0, 200)}`);
        }

        const tokens = await tokenResp.json();

        fs.writeFileSync(
          path.join(CREDS_DIR, 'tokens.json'),
          JSON.stringify({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000,
          }, null, 2),
        );

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication successful!</h1><p>You can close this tab and return to the terminal.</p>');
        clearTimeout(timeout);
        server.close();
        resolve({ success: true });
      } catch (err: unknown) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication failed</h1><p>Check the terminal for details.</p>');
        clearTimeout(timeout);
        server.close();
        resolve({ success: false, error: String(err) });
      }
    });

    server.listen(3333, '127.0.0.1', () => {
      console.log('Waiting for Microsoft callback on http://localhost:3333/callback ...');
    });
  });

  if (result.success) {
    console.log('');
    console.log('OUTLOOK_AUTH_OK=true');
    console.log('STATUS=success');
  } else {
    console.log('');
    console.log('OUTLOOK_AUTH_OK=false');
    console.log('STATUS=error');
    console.log(`ERROR=${result.error}`);
  }

  console.log('=== END ===');
}
```

- [ ] **Step 2: Register in setup/index.ts**

Add to the STEPS object in `setup/index.ts` (after the `'whatsapp-auth'` line):

```typescript
'outlook-auth': () => import('./outlook-auth.js'),
```

- [ ] **Step 3: Add Outlook detection to verify.ts**

Add to `setup/verify.ts` after the signal detection block — read `OUTLOOK_EMAIL` from env, check for `~/.outlook-mcp/tokens.json`:

```typescript
const outlookEmail =
  process.env.OUTLOOK_EMAIL || envVars.OUTLOOK_EMAIL;
if (outlookEmail) {
  const outlookTokens = path.join(homeDir, '.outlook-mcp', 'tokens.json');
  channelAuth.outlook = fs.existsSync(outlookTokens) ? 'authenticated' : 'configured';
}
```

Also add `'OUTLOOK_EMAIL'` to the `readEnvFile` call in verify.ts.

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: Clean compile

- [ ] **Step 5: Commit**

```bash
git add setup/outlook-auth.ts setup/index.ts setup/verify.ts
git commit -m "feat: add Outlook OAuth setup step and verify detection"
```

### Task 4: MCP Server for Container

**Files:**
- Create: `container/outlook-mcp/index.ts`
- Create: `container/outlook-mcp/package.json`

The MCP server runs inside the agent container and provides email tools. It reads credentials from the mounted `~/.outlook-mcp/` directory.

- [ ] **Step 1: Create package.json**

Create `container/outlook-mcp/package.json`:

```json
{
  "name": "outlook-mcp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "html-to-text": "^9.0.0"
  },
  "devDependencies": {
    "@types/html-to-text": "^9.0.0"
  }
}
```

- [ ] **Step 2: Create MCP server**

Create `container/outlook-mcp/index.ts`:

The MCP server exposes these tools:
- `outlook_search_emails` — search by query string
- `outlook_read_email` — fetch full body by ID
- `outlook_draft_reply` — create draft reply
- `outlook_send_draft` — send an existing draft (requires user approval)
- `outlook_move_email` — move email to folder
- `outlook_list_folders` — list mail folders

Each tool reads credentials from `/workspace/extra/outlook-mcp/tokens.json` and calls Microsoft Graph API via `fetch()`.

Implementation should follow the MCP SDK pattern:
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// ... tool definitions
```

Key implementation details:
- `outlook_read_email`: fetches `$select=id,subject,from,toRecipients,body,receivedDateTime` and converts HTML body to plain text using `html-to-text`
- `outlook_draft_reply`: calls `POST /me/messages/{id}/createReply` to create draft, returns draft ID + content
- `outlook_send_draft`: calls `POST /me/messages/{draftId}/send`
- `outlook_move_email`: calls `POST /me/messages/{id}/move` with `destinationId`
- `outlook_list_folders`: calls `GET /me/mailFolders`
- `outlook_search_emails`: calls `GET /me/messages?$search="query"&$top=20`

- [ ] **Step 3: Commit**

```bash
git add container/outlook-mcp/
git commit -m "feat: add Outlook MCP server for container email tools"
```

### Task 5: Skill File

**Files:**
- Create: `.claude/skills/add-outlook/SKILL.md`

- [ ] **Step 1: Create the skill**

Create `.claude/skills/add-outlook/SKILL.md` following the exact pattern of `add-signal` and `add-gmail` skills. The skill should guide through:

1. **Phase 1: Pre-flight** — check if already configured
2. **Phase 2: Code Installation** — merge from fork (if using fork pattern) or verify files exist
3. **Phase 3: Azure App Registration** — step-by-step guide through portal.azure.com:
   - Go to portal.azure.com → Azure Active Directory → App registrations → New registration
   - Name: "NanoClaw Outlook"
   - Supported account types: "Personal Microsoft accounts only"
   - Redirect URI: Web → `http://localhost:3333/callback`
   - After creation: go to Certificates & secrets → New client secret → copy value
   - Go to API permissions → Add: Microsoft Graph → Delegated → Mail.Read, Mail.ReadWrite, Mail.Send, User.Read
   - Copy Application (client) ID from Overview page
4. **Phase 4: OAuth Flow** — run `npx tsx setup/index.ts --step outlook-auth --client-id <ID> --client-secret <SECRET>`
5. **Phase 5: Registration** — register group with `npx tsx setup/index.ts --step register --jid "outlook:{email}" --name "Outlook Inbox" --folder outlook_inbox --channel outlook --no-trigger-required`
6. **Phase 6: Mount Allowlist** — add `~/.outlook-mcp` to mount allowlist
7. **Phase 7: Group CLAUDE.md** — create `groups/outlook_inbox/CLAUDE.md` with triage instructions
8. **Phase 8: Verify** — build, restart, check logs

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-outlook/
git commit -m "feat: add /add-outlook setup skill"
```

### Task 6: Group CLAUDE.md Template

**Files:**
- Create: `groups/outlook_inbox/CLAUDE.md` (created by skill during setup, but template here)

The template content for the agent's triage instructions:

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

This file is created by the `/add-outlook` skill during setup, not committed to the repo (it's per-installation).

---

## Chunk 4: Integration & Final Wiring

### Task 7: Integration Testing

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, including new outlook tests

- [ ] **Step 2: Build check**

Run: `npm run build`
Expected: Clean TypeScript compile

- [ ] **Step 3: Final commit with any fixes**

```bash
git add -A
git commit -m "feat: complete Outlook email channel integration"
```

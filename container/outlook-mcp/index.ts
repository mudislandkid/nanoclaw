/**
 * Outlook MCP Server
 * Runs inside the agent container and provides email tools via the Microsoft Graph API.
 * Credentials are mounted read-only at /workspace/extra/outlook-mcp/.
 */

import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const CREDS_DIR = '/workspace/extra/outlook-mcp';
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Credential loading
// ---------------------------------------------------------------------------

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function loadCredentials(): Credentials {
  const clientId = fs.readFileSync(path.join(CREDS_DIR, 'client-id'), 'utf-8').trim();
  const clientSecret = fs.readFileSync(path.join(CREDS_DIR, 'client-secret'), 'utf-8').trim();
  const tokens: Tokens = JSON.parse(fs.readFileSync(path.join(CREDS_DIR, 'tokens.json'), 'utf-8'));

  if (!clientId || !clientSecret || !tokens.accessToken || !tokens.refreshToken) {
    throw new Error('Outlook MCP: incomplete credentials in ' + CREDS_DIR);
  }

  return {
    clientId,
    clientSecret,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt ?? 0,
  };
}

// Load credentials at startup; hold in memory
let creds: Credentials = loadCredentials();

// ---------------------------------------------------------------------------
// Token refresh (in-memory only — mount is read-only)
// ---------------------------------------------------------------------------

async function ensureValidToken(): Promise<string> {
  const timeLeft = creds.expiresAt - Date.now();
  if (timeLeft > REFRESH_THRESHOLD_MS) {
    return creds.accessToken;
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/Mail.ReadWrite offline_access',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (data.error === 'invalid_grant') {
    throw new Error(
      'Outlook token invalid_grant: refresh token expired or revoked. ' +
        'Re-run the OAuth setup to re-authenticate.',
    );
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Outlook token refresh failed (${res.status}): ${data.error ?? 'unknown error'}`,
    );
  }

  const accessToken = data.access_token as string;
  const refreshToken = (data.refresh_token as string | undefined) ?? creds.refreshToken;
  const expiresIn = (data.expires_in as number | undefined) ?? 3600;

  // Update in-memory only (mount is read-only)
  creds = {
    ...creds,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return creds.accessToken;
}

// ---------------------------------------------------------------------------
// Graph API helper
// ---------------------------------------------------------------------------

async function graphFetch(
  urlPath: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await ensureValidToken();
  const url = urlPath.startsWith('https://') ? urlPath : `${GRAPH_BASE}${urlPath}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options.headers as Record<string, string> | undefined),
  };

  return fetch(url, { ...options, headers });
}

// ---------------------------------------------------------------------------
// HTML to plain text (no external dependencies)
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'outlook-mcp',
  version: '1.0.0',
});

// 1. Search emails
server.tool(
  'outlook_search_emails',
  'Search emails by query string. Returns a list of matching emails with id, subject, sender, date, and preview.',
  {
    query: z.string().describe('Search query string'),
    top: z.number().int().min(1).max(50).default(20).describe('Maximum number of results to return (default 20)'),
  },
  async (args) => {
    const top = args.top ?? 20;
    const select = 'id,subject,from,receivedDateTime,bodyPreview,isRead';
    const url = `/me/messages?$search="${encodeURIComponent(args.query)}"&$top=${top}&$select=${select}`;

    const res = await graphFetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`outlook_search_emails failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      value: Array<{
        id: string;
        subject: string;
        from: { emailAddress: { name: string; address: string } };
        receivedDateTime: string;
        bodyPreview: string;
        isRead: boolean;
      }>;
    };

    const emails = (data.value ?? []).map((e) => ({
      id: e.id,
      subject: e.subject,
      from: `${e.from?.emailAddress?.name ?? ''} <${e.from?.emailAddress?.address ?? ''}>`,
      receivedDateTime: e.receivedDateTime,
      bodyPreview: e.bodyPreview,
      isRead: e.isRead,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(emails, null, 2),
        },
      ],
    };
  },
);

// 2. Read full email
server.tool(
  'outlook_read_email',
  'Fetch the full body of an email by its ID. Returns subject, sender, recipients, received date, and plain-text body.',
  {
    emailId: z.string().describe('The email message ID'),
  },
  async (args) => {
    const select = 'id,subject,from,toRecipients,body,receivedDateTime';
    const url = `/me/messages/${encodeURIComponent(args.emailId)}?$select=${select}`;

    const res = await graphFetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`outlook_read_email failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      id: string;
      subject: string;
      from: { emailAddress: { name: string; address: string } };
      toRecipients: Array<{ emailAddress: { name: string; address: string } }>;
      body: { contentType: string; content: string };
      receivedDateTime: string;
    };

    const bodyText =
      data.body?.contentType === 'html'
        ? htmlToText(data.body.content)
        : (data.body?.content ?? '');

    const email = {
      id: data.id,
      subject: data.subject,
      from: `${data.from?.emailAddress?.name ?? ''} <${data.from?.emailAddress?.address ?? ''}>`,
      to: (data.toRecipients ?? [])
        .map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`)
        .join(', '),
      receivedDateTime: data.receivedDateTime,
      body: bodyText,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(email, null, 2),
        },
      ],
    };
  },
);

// 3. Draft a reply
server.tool(
  'outlook_draft_reply',
  'Creates a draft reply to an email. IMPORTANT: Show the draft to the user on Signal and wait for explicit approval before sending.',
  {
    emailId: z.string().describe('The email message ID to reply to'),
    replyBody: z.string().describe('The body text for the reply'),
  },
  async (args) => {
    // Step 1: create reply draft
    const createRes = await graphFetch(
      `/me/messages/${encodeURIComponent(args.emailId)}/createReply`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );

    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`outlook_draft_reply createReply failed (${createRes.status}): ${body}`);
    }

    const draft = (await createRes.json()) as { id: string; subject: string };
    const draftId = draft.id;

    // Step 2: patch the body content
    const patchRes = await graphFetch(`/me/messages/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        body: {
          contentType: 'Text',
          content: args.replyBody,
        },
      }),
    });

    if (!patchRes.ok) {
      const body = await patchRes.text();
      throw new Error(`outlook_draft_reply PATCH failed (${patchRes.status}): ${body}`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              draftId,
              subject: draft.subject,
              replyBody: args.replyBody,
              status: 'Draft created. Show to user and await approval before sending.',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 4. Send a draft
server.tool(
  'outlook_send_draft',
  'Send a previously created draft. IMPORTANT: Only use this after the user has explicitly approved the draft (e.g., "yes send it", "go ahead"). NEVER send without approval.',
  {
    draftId: z.string().describe('The draft message ID to send'),
  },
  async (args) => {
    const res = await graphFetch(
      `/me/messages/${encodeURIComponent(args.draftId)}/send`,
      { method: 'POST', headers: { 'Content-Length': '0' } },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`outlook_send_draft failed (${res.status}): ${body}`);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `Draft ${args.draftId} sent successfully.`,
        },
      ],
    };
  },
);

// 5. Move email to folder
server.tool(
  'outlook_move_email',
  'Move an email to a different mail folder.',
  {
    emailId: z.string().describe('The email message ID to move'),
    destinationFolderId: z.string().describe('The destination folder ID (use outlook_list_folders to find IDs)'),
  },
  async (args) => {
    const res = await graphFetch(
      `/me/messages/${encodeURIComponent(args.emailId)}/move`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: args.destinationFolderId }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`outlook_move_email failed (${res.status}): ${body}`);
    }

    const moved = (await res.json()) as { id: string };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              newEmailId: moved.id,
              movedTo: args.destinationFolderId,
              status: 'Email moved successfully.',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 6. List mail folders
server.tool(
  'outlook_list_folders',
  'List all mail folders in the mailbox, including folder IDs needed for moving emails.',
  {},
  async () => {
    const res = await graphFetch('/me/mailFolders?$top=50');

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`outlook_list_folders failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      value: Array<{
        id: string;
        displayName: string;
        totalItemCount: number;
        unreadItemCount: number;
      }>;
    };

    const folders = (data.value ?? []).map((f) => ({
      id: f.id,
      displayName: f.displayName,
      totalItemCount: f.totalItemCount,
      unreadItemCount: f.unreadItemCount,
    }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(folders, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

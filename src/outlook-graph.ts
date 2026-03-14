import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const TOKEN_ENDPOINT =
  'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
export const CREDS_DIR = path.join(os.homedir(), '.outlook-mcp');
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Credential I/O
// ---------------------------------------------------------------------------

/**
 * Read credentials from ~/.outlook-mcp/.
 * Returns null if the directory or any required file is missing.
 */
export function loadOutlookCredentials(): OutlookCredentials | null {
  try {
    if (!fs.existsSync(CREDS_DIR)) {
      logger.debug(
        { dir: CREDS_DIR },
        'Outlook credentials directory not found',
      );
      return null;
    }

    const clientIdFile = path.join(CREDS_DIR, 'client-id');
    const clientSecretFile = path.join(CREDS_DIR, 'client-secret');
    const tokensFile = path.join(CREDS_DIR, 'tokens.json');

    if (
      !fs.existsSync(clientIdFile) ||
      !fs.existsSync(clientSecretFile) ||
      !fs.existsSync(tokensFile)
    ) {
      logger.debug({ dir: CREDS_DIR }, 'Outlook credential files incomplete');
      return null;
    }

    const clientId = fs.readFileSync(clientIdFile, 'utf-8').trim();
    const clientSecret = fs.readFileSync(clientSecretFile, 'utf-8').trim();
    const tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));

    if (
      !clientId ||
      !clientSecret ||
      !tokens.accessToken ||
      !tokens.refreshToken
    ) {
      logger.warn('Outlook credentials file missing required fields');
      return null;
    }

    return {
      clientId,
      clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt ?? 0,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to load Outlook credentials');
    return null;
  }
}

/**
 * Persist new tokens to ~/.outlook-mcp/tokens.json.
 */
export function saveTokens(
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): void {
  const expiresAt = Date.now() + expiresIn * 1000;
  const data = { accessToken, refreshToken, expiresAt };
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(CREDS_DIR, 'tokens.json'),
    JSON.stringify(data, null, 2),
    { mode: 0o600 },
  );
  logger.debug({ expiresAt }, 'Outlook tokens saved');
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Return credentials with a valid access token.
 * Refreshes when fewer than REFRESH_THRESHOLD_MS ms remain.
 * Throws a clear error on invalid_grant (user must re-authenticate).
 */
export async function refreshAccessToken(
  creds: OutlookCredentials,
): Promise<OutlookCredentials> {
  const timeLeft = creds.expiresAt - Date.now();
  if (timeLeft > REFRESH_THRESHOLD_MS) {
    logger.debug(
      { timeLeftMs: timeLeft },
      'Outlook token still valid, skipping refresh',
    );
    return creds;
  }

  logger.info({ timeLeftMs: timeLeft }, 'Refreshing Outlook access token');

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
        'Run the OAuth setup step to re-authenticate.',
    );
  }

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Outlook token refresh failed (${res.status}): ${data.error ?? 'unknown error'}`,
    );
  }

  const accessToken = data.access_token as string;
  const refreshToken =
    (data.refresh_token as string | undefined) ?? creds.refreshToken;
  const expiresIn = (data.expires_in as number | undefined) ?? 3600;

  saveTokens(accessToken, refreshToken, expiresIn);

  return {
    ...creds,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

// ---------------------------------------------------------------------------
// Delta query
// ---------------------------------------------------------------------------

const MAX_PAGES = 50;

const DELTA_BASE_URL =
  `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta` +
  `?$select=id,subject,from,bodyPreview,receivedDateTime,isRead`;

/**
 * Fetch delta messages from the inbox.
 * Uses deltaLink for subsequent calls; falls back to the initial delta URL.
 * Follows @odata.nextLink for pagination.
 * Returns only unread messages.
 */
export async function fetchDelta(
  accessToken: string,
  deltaLink: string | null,
): Promise<DeltaResult> {
  const emails: GraphEmail[] = [];
  let nextUrl: string = deltaLink ?? DELTA_BASE_URL;
  let finalDeltaLink = '';
  let pageCount = 0;

  while (nextUrl) {
    if (pageCount >= MAX_PAGES) {
      logger.warn(
        { pageCount },
        'fetchDelta: MAX_PAGES limit reached, stopping pagination',
      );
      break;
    }
    pageCount++;
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Graph delta request failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as {
      value: GraphEmail[];
      '@odata.nextLink'?: string;
      '@odata.deltaLink'?: string;
    };

    for (const msg of data.value ?? []) {
      if (msg.isRead === false) {
        emails.push(msg);
      }
    }

    if (data['@odata.deltaLink']) {
      finalDeltaLink = data['@odata.deltaLink'];
      break;
    }

    nextUrl = data['@odata.nextLink'] ?? '';
  }

  return { emails, deltaLink: finalDeltaLink };
}

// ---------------------------------------------------------------------------
// Mark as read
// ---------------------------------------------------------------------------

/**
 * Mark an email as read via PATCH.
 */
export async function markAsRead(
  accessToken: string,
  messageId: string,
): Promise<void> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ isRead: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `markAsRead failed for ${messageId} (${res.status}): ${body}`,
    );
  }
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

/**
 * Fetch the authenticated user's email address from /me.
 */
export async function getUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(`${GRAPH_BASE}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`getUserEmail failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    mail?: string;
    userPrincipalName?: string;
  };
  const email = data.mail ?? data.userPrincipalName;

  if (!email) {
    throw new Error(
      'Graph /me response missing mail and userPrincipalName fields',
    );
  }

  return email;
}

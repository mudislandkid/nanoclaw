import { createServer, IncomingMessage, ServerResponse } from 'http';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { emitStatus } from './status.js';

const CREDS_DIR = path.join(os.homedir(), '.outlook-mcp');
const REDIRECT_URI = 'http://localhost:3333/callback';
const AUTH_BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'Mail.Read Mail.ReadWrite Mail.Send User.Read offline_access';

export async function run(args: string[]): Promise<void> {
  // Parse args: --client-id <id> --client-secret <secret>
  const clientIdIdx = args.indexOf('--client-id');
  const clientSecretIdx = args.indexOf('--client-secret');

  const clientId = clientIdIdx !== -1 ? args[clientIdIdx + 1] : undefined;
  const clientSecret = clientSecretIdx !== -1 ? args[clientSecretIdx + 1] : undefined;

  if (!clientId || !clientSecret) {
    emitStatus('OUTLOOK_AUTH', {
      STATUS: 'failed',
      ERROR: 'Missing --client-id or --client-secret',
    });
    return;
  }

  // Ensure creds dir exists with secure permissions
  fs.mkdirSync(CREDS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(CREDS_DIR, 'client-id'), clientId, { mode: 0o600 });
  fs.writeFileSync(path.join(CREDS_DIR, 'client-secret'), clientSecret, { mode: 0o600 });

  // Build authorization URL
  const authUrl =
    `${AUTH_BASE}/authorize?` +
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
      const url = new URL(req.url || '', 'http://localhost:3333');

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
          JSON.stringify(
            {
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              expires_at: Date.now() + tokens.expires_in * 1000,
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h1>Authentication successful!</h1><p>You can close this tab and return to the terminal.</p>',
        );
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

  emitStatus('OUTLOOK_AUTH', {
    OUTLOOK_AUTH_OK: result.success,
    STATUS: result.success ? 'success' : 'failed',
    ...(result.error ? { ERROR: result.error } : {}),
  });
}

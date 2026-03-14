import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock fs — set up before importing the module under test
// ---------------------------------------------------------------------------

// Use vi.hoisted so the object is available inside the hoisted vi.mock factory
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFs: any = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: mockFs.existsSync,
      readFileSync: mockFs.readFileSync,
      writeFileSync: mockFs.writeFileSync,
      mkdirSync: mockFs.mkdirSync,
    },
  };
});

// ---------------------------------------------------------------------------
// Import module under test (after mocks are declared)
// ---------------------------------------------------------------------------

import {
  loadOutlookCredentials,
  saveTokens,
  refreshAccessToken,
  fetchDelta,
  markAsRead,
  getUserEmail,
  CREDS_DIR,
  GRAPH_BASE,
  TOKEN_ENDPOINT,
  type OutlookCredentials,
} from './outlook-graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCreds(
  overrides: Partial<OutlookCredentials> = {},
): OutlookCredentials {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  // Restore global fetch mock
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// loadOutlookCredentials
// ---------------------------------------------------------------------------

describe('loadOutlookCredentials', () => {
  it('returns null when credentials directory is missing', () => {
    mockFs.existsSync.mockReturnValue(false);

    const result = loadOutlookCredentials();

    expect(result).toBeNull();
    expect(mockFs.existsSync).toHaveBeenCalledWith(CREDS_DIR);
  });

  it('returns null when credential files are incomplete', () => {
    // Dir exists but one file is missing
    mockFs.existsSync.mockImplementation((p: string) => {
      if (p === CREDS_DIR) return true;
      if (p.endsWith('client-id')) return true;
      // client-secret and tokens.json missing
      return false;
    });

    const result = loadOutlookCredentials();

    expect(result).toBeNull();
  });

  it('returns credentials when all files exist', () => {
    const tokensData = {
      accessToken: 'access-abc',
      refreshToken: 'refresh-xyz',
      expiresAt: 9999999999000,
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith('client-id')) return 'my-client-id\n';
      if (p.endsWith('client-secret')) return 'my-client-secret\n';
      if (p.endsWith('tokens.json')) return JSON.stringify(tokensData);
      return '';
    });

    const result = loadOutlookCredentials();

    expect(result).not.toBeNull();
    expect(result!.clientId).toBe('my-client-id');
    expect(result!.clientSecret).toBe('my-client-secret');
    expect(result!.accessToken).toBe('access-abc');
    expect(result!.refreshToken).toBe('refresh-xyz');
    expect(result!.expiresAt).toBe(9999999999000);
  });

  it('returns null when tokens.json has missing fields', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith('client-id')) return 'my-client-id';
      if (p.endsWith('client-secret')) return 'my-client-secret';
      if (p.endsWith('tokens.json')) return JSON.stringify({ accessToken: '' });
      return '';
    });

    const result = loadOutlookCredentials();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// saveTokens
// ---------------------------------------------------------------------------

describe('saveTokens', () => {
  it('writes tokens.json with correct expiresAt', () => {
    const now = 1700000000000;
    vi.setSystemTime(now);

    saveTokens('new-access', 'new-refresh', 3600);

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(CREDS_DIR, {
      recursive: true,
      mode: 0o700,
    });
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();

    const [, written] = mockFs.writeFileSync.mock.calls[0] as [
      string,
      string,
      unknown,
    ];
    expect(mockFs.writeFileSync.mock.calls[0][2]).toEqual({ mode: 0o600 });
    const parsed = JSON.parse(written);
    expect(parsed.accessToken).toBe('new-access');
    expect(parsed.refreshToken).toBe('new-refresh');
    expect(parsed.expiresAt).toBe(now + 3600 * 1000);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// refreshAccessToken
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('skips refresh when token has plenty of time left', async () => {
    const creds = makeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 });

    const result = await refreshAccessToken(creds);

    expect(result).toBe(creds); // same object reference — no refresh done
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes when token is near expiry (< 5 min)', async () => {
    const creds = makeCreds({ expiresAt: Date.now() + 2 * 60 * 1000 }); // 2 min left

    const tokenResponse = {
      access_token: 'refreshed-access',
      refresh_token: 'refreshed-refresh',
      expires_in: 3600,
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(tokenResponse),
    );

    const result = await refreshAccessToken(creds);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(opts.method).toBe('POST');

    expect(result.accessToken).toBe('refreshed-access');
    expect(result.refreshToken).toBe('refreshed-refresh');
    expect(result.clientId).toBe(creds.clientId);
  });

  it('refreshes when token is already expired', async () => {
    const creds = makeCreds({ expiresAt: Date.now() - 1000 });

    const tokenResponse = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
    };

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(tokenResponse),
    );

    const result = await refreshAccessToken(creds);

    expect(result.accessToken).toBe('new-access');
  });

  it('throws clear error on invalid_grant', async () => {
    const creds = makeCreds({ expiresAt: Date.now() - 1000 });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ error: 'invalid_grant' }, 400),
    );

    await expect(refreshAccessToken(creds)).rejects.toThrow(
      /invalid_grant.*re-authenticate/i,
    );
  });

  it('throws on other token endpoint errors', async () => {
    const creds = makeCreds({ expiresAt: Date.now() - 1000 });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ error: 'server_error' }, 500),
    );

    await expect(refreshAccessToken(creds)).rejects.toThrow(
      /token refresh failed/i,
    );
  });

  it('preserves existing refresh token when response omits it', async () => {
    const creds = makeCreds({ expiresAt: Date.now() - 1000 });

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ access_token: 'new-access', expires_in: 3600 }),
    );

    const result = await refreshAccessToken(creds);

    expect(result.refreshToken).toBe(creds.refreshToken);
  });
});

// ---------------------------------------------------------------------------
// fetchDelta
// ---------------------------------------------------------------------------

describe('fetchDelta', () => {
  it('uses the initial delta URL when no deltaLink is provided', async () => {
    const deltaLink = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$deltatoken=final`;

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        value: [],
        '@odata.deltaLink': deltaLink,
      }),
    );

    await fetchDelta('token', null);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain(`${GRAPH_BASE}/me/mailFolders/inbox/messages/delta`);
    expect(url).toContain('$select=');
  });

  it('uses the provided deltaLink when given', async () => {
    const myDeltaLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=abc';

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        value: [],
        '@odata.deltaLink': myDeltaLink + '2',
      }),
    );

    await fetchDelta('token', myDeltaLink);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(myDeltaLink);
  });

  it('filters out isRead: true messages', async () => {
    const deltaLink = `${GRAPH_BASE}/delta?$deltatoken=x`;

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        value: [
          {
            id: 'msg-read',
            subject: 'Read email',
            from: {
              emailAddress: { name: 'Alice', address: 'alice@example.com' },
            },
            bodyPreview: 'already read',
            receivedDateTime: '2024-01-01T10:00:00Z',
            isRead: true,
          },
          {
            id: 'msg-unread',
            subject: 'Unread email',
            from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
            bodyPreview: 'new message',
            receivedDateTime: '2024-01-01T11:00:00Z',
            isRead: false,
          },
        ],
        '@odata.deltaLink': deltaLink,
      }),
    );

    const result = await fetchDelta('token', null);

    expect(result.emails).toHaveLength(1);
    expect(result.emails[0].id).toBe('msg-unread');
    expect(result.emails[0].isRead).toBe(false);
  });

  it('returns empty emails array when all messages are read', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        value: [
          {
            id: 'msg-1',
            subject: 'Old',
            from: { emailAddress: { name: 'X', address: 'x@x.com' } },
            bodyPreview: '',
            receivedDateTime: '2024-01-01T10:00:00Z',
            isRead: true,
          },
        ],
        '@odata.deltaLink': 'https://example.com/delta?token=final',
      }),
    );

    const result = await fetchDelta('token', null);

    expect(result.emails).toHaveLength(0);
    expect(result.deltaLink).toBe('https://example.com/delta?token=final');
  });

  it('follows @odata.nextLink for pagination', async () => {
    const page1NextLink =
      'https://graph.microsoft.com/v1.0/me/messages?$skip=10';
    const finalDeltaLink =
      'https://graph.microsoft.com/v1.0/me/messages?$deltatoken=end';

    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 'msg-p1',
              subject: 'Page 1 unread',
              from: { emailAddress: { name: 'A', address: 'a@a.com' } },
              bodyPreview: 'p1',
              receivedDateTime: '2024-01-01T10:00:00Z',
              isRead: false,
            },
          ],
          '@odata.nextLink': page1NextLink,
        }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 'msg-p2',
              subject: 'Page 2 unread',
              from: { emailAddress: { name: 'B', address: 'b@b.com' } },
              bodyPreview: 'p2',
              receivedDateTime: '2024-01-01T11:00:00Z',
              isRead: false,
            },
          ],
          '@odata.deltaLink': finalDeltaLink,
        }),
      );

    const result = await fetchDelta('token', null);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.emails).toHaveLength(2);
    expect(result.emails[0].id).toBe('msg-p1');
    expect(result.emails[1].id).toBe('msg-p2');
    expect(result.deltaLink).toBe(finalDeltaLink);

    // Second call uses the nextLink
    const [secondUrl] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
    ];
    expect(secondUrl).toBe(page1NextLink);
  });

  it('sends Authorization header with Bearer token', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        value: [],
        '@odata.deltaLink': 'https://example.com/delta?token=x',
      }),
    );

    await fetchDelta('my-bearer-token', null);

    const [, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer my-bearer-token',
    );
  });

  it('throws on non-ok response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    await expect(fetchDelta('bad-token', null)).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// markAsRead
// ---------------------------------------------------------------------------

describe('markAsRead', () => {
  it('sends PATCH with isRead: true', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    await markAsRead('my-token', 'message-id-123');

    expect(fetch).toHaveBeenCalledOnce();
    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];

    expect(url).toBe(`${GRAPH_BASE}/me/messages/message-id-123`);
    expect(opts.method).toBe('PATCH');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer my-token',
    );
    expect(JSON.parse(opts.body as string)).toEqual({ isRead: true });
  });

  it('throws on failure response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue('Not Found'),
    });

    await expect(markAsRead('token', 'bad-id')).rejects.toThrow(
      /markAsRead.*404/,
    );
  });
});

// ---------------------------------------------------------------------------
// getUserEmail
// ---------------------------------------------------------------------------

describe('getUserEmail', () => {
  it('extracts email from mail field', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({
        mail: 'user@example.com',
        userPrincipalName: 'user@tenant.com',
      }),
    );

    const email = await getUserEmail('token');

    expect(email).toBe('user@example.com');
  });

  it('falls back to userPrincipalName when mail is absent', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ userPrincipalName: 'upn@tenant.onmicrosoft.com' }),
    );

    const email = await getUserEmail('token');

    expect(email).toBe('upn@tenant.onmicrosoft.com');
  });

  it('throws when both fields are missing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ displayName: 'No Email User' }),
    );

    await expect(getUserEmail('token')).rejects.toThrow(
      /mail.*userPrincipalName/i,
    );
  });

  it('sends Authorization header and hits /me endpoint', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse({ mail: 'me@example.com' }),
    );

    await getUserEmail('bearer-xyz');

    const [url, opts] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${GRAPH_BASE}/me`);
    expect((opts.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer bearer-xyz',
    );
  });

  it('throws on non-ok response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: vi.fn().mockResolvedValue('Forbidden'),
    });

    await expect(getUserEmail('token')).rejects.toThrow(/getUserEmail.*403/);
  });
});

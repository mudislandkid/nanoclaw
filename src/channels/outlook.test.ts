import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be defined before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getRouterState: vi.fn(() => undefined),
  setRouterState: vi.fn(),
}));

vi.mock('../outlook-graph.js', () => ({
  loadOutlookCredentials: vi.fn(() => ({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3_600_000,
  })),
  refreshAccessToken: vi.fn(async (creds) => creds),
  fetchDelta: vi.fn(async () => ({
    emails: [],
    deltaLink: 'https://delta.link/1',
  })),
  markAsRead: vi.fn(async () => undefined),
  getUserEmail: vi.fn(async () => 'user@outlook.com'),
}));

import {
  fetchDelta,
  getUserEmail,
  loadOutlookCredentials,
  markAsRead,
  OutlookCredentials,
  refreshAccessToken,
} from '../outlook-graph.js';
import { getRouterState, setRouterState } from '../db.js';
import { OutlookChannel } from './outlook.js';
import { ChannelOpts } from './registry.js';
import { RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCredentials(
  overrides?: Partial<OutlookCredentials>,
): OutlookCredentials {
  return {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token',
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  const defaultGroup: RegisteredGroup = {
    name: 'Outlook Inbox',
    folder: 'outlook-inbox',
    trigger: '@Andy',
    added_at: '2024-01-01T00:00:00.000Z',
  };
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'outlook:user@outlook.com': defaultGroup,
    })),
    ...overrides,
  };
}

function makeEmail(overrides?: Record<string, unknown>) {
  return {
    id: 'AAMkADtest123',
    subject: 'Q3 Security Audit Review',
    from: {
      emailAddress: {
        name: 'John Smith',
        address: 'john@example.com',
      },
    },
    bodyPreview: 'Hi Greg, following up on...',
    receivedDateTime: '2024-06-01T10:00:00.000Z',
    isRead: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutlookChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserEmail).mockResolvedValue('user@outlook.com');
    vi.mocked(refreshAccessToken).mockImplementation(async (creds) => creds);
    vi.mocked(fetchDelta).mockResolvedValue({
      emails: [],
      deltaLink: 'https://delta.link/1',
    });
    vi.mocked(markAsRead).mockResolvedValue(undefined);
    vi.mocked(getRouterState).mockReturnValue(undefined);
    vi.mocked(setRouterState).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // connect()
  // ---------------------------------------------------------------------------

  describe('connect()', () => {
    it('calls getUserEmail and sets connected = true', async () => {
      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      await channel.connect();

      expect(getUserEmail).toHaveBeenCalledWith('test-access-token');
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
    });

    it('disconnects if token refresh fails during connect', async () => {
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(
        new Error('invalid_grant: refresh token expired'),
      );

      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      await channel.connect();

      expect(channel.isConnected()).toBe(false);
      // getUserEmail should never be called when refresh fails
      expect(getUserEmail).not.toHaveBeenCalled();
    });

    it('disconnects if getUserEmail fails during connect', async () => {
      vi.mocked(getUserEmail).mockRejectedValueOnce(new Error('Network error'));

      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      await channel.connect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // disconnect()
  // ---------------------------------------------------------------------------

  describe('disconnect()', () => {
    it('stops polling and sets connected = false', async () => {
      vi.useFakeTimers();

      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      // connect() is async — run it with fake timers
      const connectPromise = channel.connect();
      // Let the internal async steps (refreshAccessToken, getUserEmail) resolve
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;

      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);

      // Advance past several poll cycles — interval should be cleared
      const callCountBefore = vi.mocked(fetchDelta).mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000 * 3);
      expect(vi.mocked(fetchDelta).mock.calls.length).toBe(callCountBefore);

      vi.useRealTimers();
    });
  });

  // ---------------------------------------------------------------------------
  // ownsJid()
  // ---------------------------------------------------------------------------

  describe('ownsJid()', () => {
    it('returns true for outlook: JIDs', () => {
      const channel = new OutlookChannel(makeOpts(), makeCredentials());
      expect(channel.ownsJid('outlook:foo@bar.com')).toBe(true);
    });

    it('returns false for non-outlook JIDs', () => {
      const channel = new OutlookChannel(makeOpts(), makeCredentials());
      expect(channel.ownsJid('signal:+15551234567')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // sendMessage()
  // ---------------------------------------------------------------------------

  describe('sendMessage()', () => {
    it('is a no-op and does not throw', async () => {
      const channel = new OutlookChannel(makeOpts(), makeCredentials());
      await expect(
        channel.sendMessage('outlook:user@outlook.com', 'Hello'),
      ).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // poll() — driven directly on the channel instance
  // ---------------------------------------------------------------------------

  describe('poll()', () => {
    it('converts emails to NewMessage with correct fields and calls onMessage', async () => {
      const email = makeEmail();
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [email],
        deltaLink: 'https://delta.link/2',
      });

      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      // Set userEmail directly so we can skip connect() and its side-effects
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'outlook:user@outlook.com',
        expect.objectContaining({
          id: `outlook-${email.id}`,
          chat_jid: 'outlook:user@outlook.com',
          sender: 'outlook:john@example.com',
          sender_name: 'John Smith',
          timestamp: email.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        }),
      );

      const call = vi.mocked(opts.onMessage).mock.calls[0];
      const message = call[1];
      expect(message.content).toContain('John Smith <john@example.com>');
      expect(message.content).toContain('Q3 Security Audit Review');
      expect(message.content).toContain('Hi Greg, following up on...');
      expect(message.content).toContain(`[Email ID: ${email.id}]`);
    });

    it('calls onChatMetadata for each email', async () => {
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [makeEmail(), makeEmail({ id: 'AAMkADtest456' })],
        deltaLink: 'https://delta.link/2',
      });

      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'outlook:user@outlook.com',
        expect.any(String),
        'Outlook Inbox',
        'outlook',
        false,
      );
    });

    it('calls markAsRead for each processed email', async () => {
      const email1 = makeEmail();
      const email2 = makeEmail({ id: 'AAMkADtest456' });
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [email1, email2],
        deltaLink: 'https://delta.link/2',
      });

      const channel = new OutlookChannel(makeOpts(), makeCredentials());
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(markAsRead).toHaveBeenCalledWith('test-access-token', email1.id);
      expect(markAsRead).toHaveBeenCalledWith('test-access-token', email2.id);
    });

    it('saves delta token via setRouterState', async () => {
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [],
        deltaLink: 'https://delta.link/new',
      });

      const channel = new OutlookChannel(makeOpts(), makeCredentials());
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(setRouterState).toHaveBeenCalledWith(
        'outlook_delta_token',
        'https://delta.link/new',
      );
    });

    it('skips onMessage for unregistered chats but still calls onChatMetadata', async () => {
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [makeEmail()],
        deltaLink: 'https://delta.link/2',
      });

      const opts = makeOpts({
        // registeredGroups returns empty — chat not registered
        registeredGroups: vi.fn(() => ({})),
      });

      const channel = new OutlookChannel(opts, makeCredentials());
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('still marks as read when chat is not registered', async () => {
      const email = makeEmail();
      vi.mocked(fetchDelta).mockResolvedValue({
        emails: [email],
        deltaLink: 'https://delta.link/2',
      });

      const opts = makeOpts({
        registeredGroups: vi.fn(() => ({})),
      });

      const channel = new OutlookChannel(opts, makeCredentials());
      (channel as any).userEmail = 'user@outlook.com';

      await (channel as any).poll();

      expect(markAsRead).toHaveBeenCalledWith('test-access-token', email.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Token refresh failure during poll
  // ---------------------------------------------------------------------------

  describe('token refresh failure', () => {
    it('disconnects the channel when token refresh fails during poll', async () => {
      // connect() uses its own refresh (pass-through), poll() will fail on next refresh
      const opts = makeOpts();
      const channel = new OutlookChannel(opts, makeCredentials());

      // Manually set connected and userEmail to simulate a connected state
      (channel as any).connected = true;
      (channel as any).userEmail = 'user@outlook.com';

      expect(channel.isConnected()).toBe(true);

      // Now make the next refreshAccessToken call fail (simulates poll refresh failure)
      vi.mocked(refreshAccessToken).mockRejectedValueOnce(
        new Error('invalid_grant: refresh token expired'),
      );

      await (channel as any).poll();

      expect(channel.isConnected()).toBe(false);
      expect(fetchDelta).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Factory
  // ---------------------------------------------------------------------------

  describe('factory (registerChannel)', () => {
    it('returns null when no credentials are found', async () => {
      vi.mocked(loadOutlookCredentials).mockReturnValueOnce(null);

      const { getChannelFactory } = await import('./registry.js');
      const factory = getChannelFactory('outlook');
      expect(factory).toBeDefined();

      const opts = makeOpts();
      const result = factory!(opts);
      expect(result).toBeNull();
    });
  });
});

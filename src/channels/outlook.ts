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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTLOOK_PREFIX = 'outlook:';
const POLL_INTERVAL_MS = 60_000;
const DELTA_TOKEN_KEY = 'outlook_delta_token';

// ---------------------------------------------------------------------------
// Channel implementation
// ---------------------------------------------------------------------------

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
    try {
      this.creds = await refreshAccessToken(this.creds);
    } catch (err) {
      logger.error({ err }, 'Outlook: token refresh failed during connect — channel disabled');
      this.connected = false;
      return;
    }

    try {
      this.userEmail = await getUserEmail(this.creds.accessToken);
    } catch (err) {
      logger.error({ err }, 'Outlook: failed to fetch user email — channel disabled');
      this.connected = false;
      return;
    }

    this.connected = true;
    logger.info({ userEmail: this.userEmail }, 'Outlook channel connected');

    // Initial poll then recurring
    this.poll().catch((err) =>
      logger.error({ err }, 'Outlook: initial poll failed'),
    );

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        logger.error({ err }, 'Outlook: poll failed'),
      );
    }, POLL_INTERVAL_MS);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Outlook channel disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(OUTLOOK_PREFIX);
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    logger.debug(
      { jid: _jid, length: _text.length },
      'Outlook: sendMessage is a no-op — outbound email handled via MCP tools',
    );
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    // Refresh token before each poll if needed
    try {
      this.creds = await refreshAccessToken(this.creds);
    } catch (err) {
      logger.error({ err }, 'Outlook: token refresh failed — disconnecting channel');
      await this.disconnect();
      return;
    }

    const storedDelta = getRouterState(DELTA_TOKEN_KEY) ?? null;

    let deltaResult;
    try {
      deltaResult = await fetchDelta(this.creds.accessToken, storedDelta);
    } catch (err) {
      logger.error({ err }, 'Outlook: fetchDelta failed');
      return;
    }

    const { emails, deltaLink } = deltaResult;

    if (emails.length > 0) {
      logger.info({ count: emails.length }, 'Outlook: processing new emails');
    }

    const chatJid = `${OUTLOOK_PREFIX}${this.userEmail}`;
    const groups = this.opts.registeredGroups();

    for (const email of emails) {
      const senderAddress = email.from?.emailAddress?.address ?? '';
      const senderName = email.from?.emailAddress?.name ?? senderAddress;
      const sender = `${OUTLOOK_PREFIX}${senderAddress}`;

      // Always call onChatMetadata for chat discovery
      this.opts.onChatMetadata(chatJid, email.receivedDateTime, undefined, 'outlook', false);

      // Only deliver full message if the chat is registered
      if (!groups[chatJid]) {
        logger.debug(
          { chatJid },
          'Outlook: email received for unregistered chat, skipping message delivery',
        );
      } else {
        const content =
          `New email from "${senderName} <${senderAddress}>"\n` +
          `Subject: ${email.subject ?? '(no subject)'}\n` +
          `Preview: ${email.bodyPreview ?? ''}\n` +
          `[Email ID: ${email.id}]`;

        const message: NewMessage = {
          id: `outlook-${email.id}`,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp: email.receivedDateTime,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onMessage(chatJid, message);
      }

      // Mark as read regardless of registration to prevent re-processing
      try {
        await markAsRead(this.creds.accessToken, email.id);
        logger.debug({ emailId: email.id }, 'Outlook: marked email as read');
      } catch (err) {
        logger.warn({ err, emailId: email.id }, 'Outlook: failed to mark email as read');
      }
    }

    // Persist updated delta token
    if (deltaLink) {
      setRouterState(DELTA_TOKEN_KEY, deltaLink);
    }
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
